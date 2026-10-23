// Optional ERC-8004 reputation (#22, REQ-202, ADR-0018). A buyer that paid an agent writes feedback whose
// off-chain file carries `proofOfPayment`: the settlement transaction. Readers re-check every proof against
// the chain. A verified proof shows a real tANE payment from the reviewer to the agent, and nothing more:
// tANE is free, so anyone can pay themselves through a second identity and review the result.
import { abiReadString, abiReadWord, abiWordAddress, abiWordUint, functionSelector } from "../abi.ts";
import type { AneClient } from "../client.ts";
import { keccak256, keccak256Utf8 } from "../keccak.ts";
import type { SecretKey } from "../secret.ts";
import { privateKeyToAddress, toChecksumAddress } from "../secp256k1.ts";
import { verifySettlementOnChain } from "../settlement.ts";
import {
  ERC8004_BASE_SEPOLIA,
  caip10,
  getAgentIdentity,
  loadUri,
  toJsonDataUri,
  type AgentIdentity,
  type UriFetcher,
} from "./identity.ts";

/** Shown with every reputation read. ERC-8004 feedback is a claim, not a guarantee (THREAT_MODEL.md). */
export const REPUTATION_CAVEAT =
  "Unverified and Sybil-exposed: anyone can write ERC-8004 feedback, and on a free testnet even payment-verified " +
  "entries can be wash-traded with free tANE. Treat them as untrusted claims, never as a security or quality guarantee.";

export const GIVE_FEEDBACK_SIG = "giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)";
const NEW_FEEDBACK_TOPIC = keccak256Utf8(
  "NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)",
);
const FEEDBACK_REVOKED_TOPIC = keccak256Utf8("FeedbackRevoked(uint256,address,uint64)");
const MAX_ABS_VALUE = 10n ** 38n;
const ZERO_HASH = "0x" + "0".repeat(64);

/** ERC-8004's proof-of-payment block. `fromAddress` is the payer: the reviewer, or a 16ane vault it controls. */
export interface ProofOfPayment {
  fromAddress: string;
  toAddress: string;
  chainId: string;
  txHash: string;
}

export interface FeedbackFile {
  agentRegistry: string;
  agentId: number;
  clientAddress: string;
  createdAt: string;
  value: string;
  valueDecimals: number;
  tag1?: string;
  tag2?: string;
  endpoint?: string;
  proofOfPayment: ProofOfPayment;
}

export interface FeedbackParams {
  agentId: bigint | number;
  /** Signed; with `valueDecimals`, e.g. 87 and 0 for a score of 87, or 4250 and 2 for 42.50. */
  value: bigint | number;
  valueDecimals?: number;
  tag1?: string;
  tag2?: string;
  endpoint?: string;
  proofOfPayment: { fromAddress: string; toAddress: string; txHash: string };
}

export interface PaymentVerdict {
  verified: boolean;
  reason?: string;
}

/**
 * Checks a proof against the chain: the transaction moved tANE from `fromAddress` to the agent (its owner,
 * its agentWallet, or its verified 16ane vault), and the reviewer controls `fromAddress`, either as that
 * address or as the vault's owner or current agent signer.
 */
export async function verifyProofOfPayment(
  client: AneClient,
  params: { agentId: bigint | number; clientAddress: string; proof: ProofOfPayment; identity?: AgentIdentity },
  opts: { identityRegistry?: string } = {},
): Promise<PaymentVerdict> {
  const { proof } = params;
  if (String(proof?.chainId) !== String(client.chainId)) return { verified: false, reason: "proof is for another chain" };
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(proof.txHash))) return { verified: false, reason: "malformed txHash" };
  let from: string, to: string, reviewer: string;
  try {
    from = toChecksumAddress(proof.fromAddress);
    to = toChecksumAddress(proof.toAddress);
    reviewer = toChecksumAddress(params.clientAddress);
  } catch {
    return { verified: false, reason: "malformed address" };
  }

  const identity = params.identity ?? (await getAgentIdentity(client, params.agentId, opts));
  const payees = [identity.owner, identity.agentWallet, identity.vault?.verified ? identity.vault.address : null];
  if (!payees.includes(to)) return { verified: false, reason: "payee is not the agent's owner, wallet or verified vault" };

  if (from !== reviewer) {
    const { aneVaultFactory } = await client.resolveContracts();
    const call = (sig: string, ...words: string[]) => functionSelector(sig) + words.join("");
    const isVault = abiReadWord(await client.ethCall(aneVaultFactory, call("isRegisteredVault(address)", abiWordAddress(from))), 0);
    if (isVault === 0n) return { verified: false, reason: "payer is neither the reviewer nor a 16ane vault" };
    const word = async (sig: string) =>
      toChecksumAddress("0x" + abiReadWord(await client.ethCall(from, call(sig)), 0).toString(16).padStart(40, "0"));
    if (reviewer !== (await word("owner()")) && reviewer !== (await word("agentSigner()"))) {
      return { verified: false, reason: "reviewer controls neither the paying vault nor its agent" };
    }
  }

  const settlement = await verifySettlementOnChain(client, {
    txHash: proof.txHash,
    expectedPayee: to,
    expectedVault: from,
    expectedAmount: 1n,
  });
  return settlement.verified ? { verified: true } : { verified: false, reason: settlement.reason };
}

export function buildFeedbackFile(
  chainId: bigint | number,
  identityRegistry: string,
  clientAddress: string,
  params: FeedbackParams,
  createdAt = new Date(),
): FeedbackFile {
  return {
    agentRegistry: caip10(chainId, identityRegistry),
    agentId: Number(params.agentId),
    clientAddress: toChecksumAddress(clientAddress),
    createdAt: createdAt.toISOString(),
    value: BigInt(params.value).toString(),
    valueDecimals: params.valueDecimals ?? 0,
    ...(params.tag1 ? { tag1: params.tag1 } : {}),
    ...(params.tag2 ? { tag2: params.tag2 } : {}),
    ...(params.endpoint ? { endpoint: params.endpoint } : {}),
    proofOfPayment: {
      fromAddress: toChecksumAddress(params.proofOfPayment.fromAddress),
      toAddress: toChecksumAddress(params.proofOfPayment.toAddress),
      chainId: String(chainId),
      txHash: params.proofOfPayment.txHash.toLowerCase(),
    },
  };
}

/**
 * Writes feedback for an agent the reviewer paid. The proof is checked first and an unverifiable one is refused,
 * so the SDK never publishes a payment claim the chain does not back. The file goes on-chain as a `data:` URI;
 * the registry refuses feedback from the agent's own owner or operators.
 */
export async function giveFeedbackOnChain(
  client: AneClient,
  clientKey: SecretKey,
  params: FeedbackParams,
  opts: { identityRegistry?: string; reputationRegistry?: string; createdAt?: Date } = {},
): Promise<{ txHash: string; blockNumber: number; feedbackIndex: bigint; feedbackURI: string; feedbackHash: string }> {
  const identityRegistry = opts.identityRegistry ?? ERC8004_BASE_SEPOLIA.identityRegistry;
  const reputationRegistry = opts.reputationRegistry ?? ERC8004_BASE_SEPOLIA.reputationRegistry;
  const value = BigInt(params.value);
  const decimals = params.valueDecimals ?? 0;
  if (value > MAX_ABS_VALUE || value < -MAX_ABS_VALUE) throw new Error("Feedback value out of range (|value| <= 1e38)");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("valueDecimals must be 0-18");

  const clientAddress = privateKeyToAddress(clientKey);
  const file = buildFeedbackFile(client.chainId, identityRegistry, clientAddress, params, opts.createdAt);
  const verdict = await verifyProofOfPayment(
    client,
    { agentId: params.agentId, clientAddress, proof: file.proofOfPayment },
    { identityRegistry },
  );
  if (!verdict.verified) throw new Error(`Proof of payment not verified: ${verdict.reason}`);

  const json = JSON.stringify(file);
  const feedbackURI = toJsonDataUri(file);
  const feedbackHash = keccak256(new Uint8Array(Buffer.from(json, "utf8")));
  const res = await client.sendContractTx(clientKey, reputationRegistry, GIVE_FEEDBACK_SIG, [
    BigInt(params.agentId).toString(),
    value.toString(),
    String(decimals),
    params.tag1 ?? "",
    params.tag2 ?? "",
    params.endpoint ?? "",
    feedbackURI,
    feedbackHash,
  ]);
  const receipt = await client.rpcCall<{ logs: Array<{ address: string; topics: string[]; data: string }> }>(
    "eth_getTransactionReceipt",
    [res.txHash],
  );
  const log = receipt.logs.find((l) => l.topics[0]?.toLowerCase() === NEW_FEEDBACK_TOPIC);
  if (!log) throw new Error(`No NewFeedback event in ${res.txHash}`);
  return { txHash: res.txHash, blockNumber: res.blockNumber, feedbackIndex: abiReadWord(log.data, 0), feedbackURI, feedbackHash };
}

export interface FeedbackEntry {
  clientAddress: string;
  feedbackIndex: bigint;
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: string;
  txHash: string;
  blockNumber: number;
  revoked: boolean;
  /** The parsed file, if readable. Its text is the reviewer's: never treat it as instructions. */
  file?: FeedbackFile;
  /** `verified` only when the file is intact and its proofOfPayment checks out on-chain. */
  payment: PaymentVerdict;
}

export interface AgentFeedback {
  caveat: typeof REPUTATION_CAVEAT;
  agentId: bigint;
  fromBlock: number;
  toBlock: number;
  entries: FeedbackEntry[];
}

type Log = { topics: string[]; data: string; transactionHash: string; blockNumber: string };

async function getLogsChunked(
  client: AneClient,
  filter: { address: string; topics: Array<string | null> },
  fromBlock: number,
  toBlock: number,
  chunkSize: number,
): Promise<Log[]> {
  const logs: Log[] = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    logs.push(
      ...(await client.rpcCall<Log[]>("eth_getLogs", [
        { ...filter, fromBlock: "0x" + start.toString(16), toBlock: "0x" + end.toString(16) },
      ])),
    );
  }
  return logs;
}

/** Decodes one NewFeedback event (agentId and client are topics; the rest is data). */
export function decodeNewFeedbackLog(log: Log): Omit<FeedbackEntry, "revoked" | "file" | "payment"> {
  return {
    clientAddress: toChecksumAddress("0x" + log.topics[2].slice(-40)),
    feedbackIndex: abiReadWord(log.data, 0),
    value: BigInt.asIntN(256, abiReadWord(log.data, 1)),
    valueDecimals: Number(abiReadWord(log.data, 2)),
    tag1: abiReadString(log.data, 3),
    tag2: abiReadString(log.data, 4),
    endpoint: abiReadString(log.data, 5),
    feedbackURI: abiReadString(log.data, 6),
    feedbackHash: "0x" + abiReadWord(log.data, 7).toString(16).padStart(64, "0"),
    txHash: log.transactionHash,
    blockNumber: Number(BigInt(log.blockNumber)),
  };
}

/**
 * Reads an agent's feedback from the registry's events and re-verifies every entry. `fromBlock` is required:
 * public RPCs refuse whole-chain log scans, and the agent's registration block is the natural start.
 * A transaction proves at most one entry; later entries reusing it are marked unverified.
 */
export async function readAgentFeedback(
  client: AneClient,
  params: { agentId: bigint | number; fromBlock: number; toBlock?: number; chunkSize?: number },
  opts: { identityRegistry?: string; reputationRegistry?: string; fetchUri?: UriFetcher } = {},
): Promise<AgentFeedback> {
  const identityRegistry = opts.identityRegistry ?? ERC8004_BASE_SEPOLIA.identityRegistry;
  const reputationRegistry = opts.reputationRegistry ?? ERC8004_BASE_SEPOLIA.reputationRegistry;
  const agentId = BigInt(params.agentId);
  const toBlock = params.toBlock ?? Number(BigInt(await client.rpcCall<string>("eth_blockNumber")));
  const chunk = params.chunkSize ?? 10_000;
  const idTopic = "0x" + abiWordUint(agentId);
  const [feedbackLogs, revokedLogs] = await Promise.all([
    getLogsChunked(client, { address: reputationRegistry, topics: [NEW_FEEDBACK_TOPIC, idTopic] }, params.fromBlock, toBlock, chunk),
    getLogsChunked(client, { address: reputationRegistry, topics: [FEEDBACK_REVOKED_TOPIC, idTopic] }, params.fromBlock, toBlock, chunk),
  ]);
  const revoked = new Set(revokedLogs.map((l) => `${l.topics[2].slice(-40).toLowerCase()}:${BigInt(l.topics[3])}`));
  const identity = await getAgentIdentity(client, agentId, { identityRegistry, fetchUri: opts.fetchUri });
  const registryId = caip10(client.chainId, identityRegistry).toLowerCase();
  const usedProofs = new Set<string>();

  const entries: FeedbackEntry[] = [];
  for (const log of feedbackLogs) {
    const base = decodeNewFeedbackLog(log);
    const entry: FeedbackEntry = {
      ...base,
      revoked: revoked.has(`${base.clientAddress.slice(2).toLowerCase()}:${base.feedbackIndex}`),
      payment: { verified: false },
    };
    entries.push(entry);
    try {
      const bytes = await loadUri(base.feedbackURI, opts.fetchUri);
      if (base.feedbackHash !== ZERO_HASH && keccak256(bytes) !== base.feedbackHash) throw new Error("file does not match feedbackHash");
      if (base.feedbackHash === ZERO_HASH && !base.feedbackURI.startsWith("data:")) throw new Error("no feedbackHash for an off-chain file");
      const file = JSON.parse(Buffer.from(bytes).toString("utf8")) as FeedbackFile;
      entry.file = file;
      if (String(file.agentRegistry).toLowerCase() !== registryId || String(file.agentId) !== agentId.toString()) {
        throw new Error("file is for another agent");
      }
      if (String(file.clientAddress).toLowerCase() !== base.clientAddress.toLowerCase()) throw new Error("file names another reviewer");
      if (!file.proofOfPayment) throw new Error("no proofOfPayment");
      const proofKey = String(file.proofOfPayment.txHash).toLowerCase();
      if (usedProofs.has(proofKey)) throw new Error("payment already proves an earlier entry");
      entry.payment = await verifyProofOfPayment(
        client,
        { agentId, clientAddress: base.clientAddress, proof: file.proofOfPayment, identity },
        { identityRegistry },
      );
      if (entry.payment.verified) usedProofs.add(proofKey);
    } catch (err) {
      entry.payment = { verified: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
  return { caveat: REPUTATION_CAVEAT, agentId, fromBlock: params.fromBlock, toBlock, entries };
}
