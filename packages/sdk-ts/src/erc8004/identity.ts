// Optional ERC-8004 agent identity (#22, REQ-202, ADR-0018). An agent's owner registers it in the canonical
// ERC-8004 Identity Registry with a registration file that points at its A2A agent card and names its
// AneAgentVault. The registry cannot check that claim (the vault has no ERC-1271), so readers verify it
// themselves: the vault must come from the 16ane factory and be owned by the identity's owner.
import { abiReadBytes, abiReadString, abiReadWord, abiWordAddress, abiWordBytes32, abiWordUint, functionSelector } from "../abi.ts";
import type { AneClient } from "../client.ts";
import { hashEip712Domain, hashTypedDataDigest } from "../crypto.ts";
import { keccak256, keccak256Utf8 } from "../keccak.ts";
import type { SecretKey } from "../secret.ts";
import { signDigest, toChecksumAddress } from "../secp256k1.ts";

/**
 * The canonical ERC-8004 v2.0.0 registries on Base Sepolia (github.com/erc-8004/erc-8004-contracts, checked
 * 2026-10-24). Third-party, upgradeable proxies: ADR-0018 records what that means for 16ane.
 */
export const ERC8004_BASE_SEPOLIA = {
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
} as const;

export interface Erc8004Registries {
  identityRegistry: string;
  reputationRegistry: string;
}

export const ERC8004_REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
/** On-chain metadata key naming the agent's AneAgentVault, as a CAIP-10 account (`eip155:<chain>:<vault>`). */
export const ERC8004_VAULT_METADATA_KEY = "16ane.vault";
export const AGENT_WALLET_SET_TYPEHASH = keccak256Utf8(
  "AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)",
);
/** The registry refuses an agentWallet signature whose deadline is further out than this. */
export const MAX_AGENT_WALLET_DEADLINE_SECONDS = 5 * 60;
/** Registration and feedback files larger than this are not read. */
export const MAX_ERC8004_FILE_BYTES = 64 * 1024;

export const REGISTER_AGENT_SIG = "register(string,(string,bytes)[])";
export const SET_AGENT_URI_SIG = "setAgentURI(uint256,string)";
export const SET_AGENT_WALLET_SIG = "setAgentWallet(uint256,address,uint256,bytes)";
const REGISTERED_TOPIC = keccak256Utf8("Registered(uint256,string,address)");

export interface Erc8004Service {
  name: string;
  endpoint: string;
  version?: string;
}

/** The ERC-8004 registration file. Everything in one read from a URI is the publisher's claim, not a fact. */
export interface Erc8004Registration {
  type: string;
  name: string;
  description: string;
  image?: string;
  services: Erc8004Service[];
  x402Support: boolean;
  active: boolean;
  registrations: Array<{ agentId: number; agentRegistry: string }>;
  supportedTrust?: string[];
  "16ane"?: { vault?: string; serviceManifest?: string };
}

export interface AgentRegistrationParams {
  name: string;
  description: string;
  image?: string;
  /** The agent's A2A card, normally `https://<host>/.well-known/agent-card.json`. */
  agentCardUrl: string;
  a2aVersion?: string;
  /** The signed 16ane service manifest, if the agent sells services (ADR-0007). */
  serviceManifestUrl?: string;
  /** The agent's AneAgentVault; its owner must be the key that registers. */
  vault?: string;
}

/** A CAIP-10 account id, the form ERC-8004 uses for registries and wallets: `eip155:<chainId>:<address>`. */
export function caip10(chainId: bigint | number, address: string): string {
  return `eip155:${chainId}:${toChecksumAddress(address)}`;
}

export function parseCaip10(id: string): { chainId: number; address: string } | null {
  const m = /^eip155:(\d+):(0x[0-9a-fA-F]{40})$/.exec(id.trim());
  return m ? { chainId: Number(m[1]), address: toChecksumAddress(m[2]) } : null;
}

export function buildAgentRegistration(
  chainId: bigint | number,
  identityRegistry: string,
  params: AgentRegistrationParams,
  agentId?: bigint | number,
): Erc8004Registration {
  const services: Erc8004Service[] = [
    { name: "A2A", endpoint: params.agentCardUrl, ...(params.a2aVersion ? { version: params.a2aVersion } : {}) },
  ];
  if (params.serviceManifestUrl) services.push({ name: "16ane-service", endpoint: params.serviceManifestUrl });
  const ext: { vault?: string; serviceManifest?: string } = {};
  if (params.vault) ext.vault = caip10(chainId, params.vault);
  if (params.serviceManifestUrl) ext.serviceManifest = params.serviceManifestUrl;
  return {
    type: ERC8004_REGISTRATION_TYPE,
    name: params.name,
    description: params.description,
    ...(params.image ? { image: params.image } : {}),
    services,
    x402Support: true,
    active: true,
    registrations:
      agentId === undefined ? [] : [{ agentId: Number(agentId), agentRegistry: caip10(chainId, identityRegistry) }],
    supportedTrust: ["reputation"],
    ...(Object.keys(ext).length ? { "16ane": ext } : {}),
  };
}

/** A self-contained `data:` URI: nothing to host, and the chain holds the whole file. */
export function toJsonDataUri(value: unknown): string {
  return "data:application/json;base64," + Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/** Decodes a `data:` URI's payload, or returns null for any other scheme. */
export function decodeDataUri(uri: string): Uint8Array | null {
  const m = /^data:([^,]*),(.*)$/s.exec(uri);
  if (!m) return null;
  return m[1].endsWith(";base64")
    ? new Uint8Array(Buffer.from(m[2], "base64"))
    : new Uint8Array(Buffer.from(decodeURIComponent(m[2]), "utf8"));
}

/** Fetches a non-`data:` URI's bytes. The SDK never fetches on its own: the caller decides which hosts to trust. */
export type UriFetcher = (uri: string) => Promise<Uint8Array>;

export async function loadUri(uri: string, fetchUri?: UriFetcher): Promise<Uint8Array> {
  const bytes = decodeDataUri(uri) ?? (fetchUri ? await fetchUri(uri) : null);
  if (!bytes) throw new Error(`Cannot read ${uri.slice(0, 40)}: only data: URIs are read without a fetchUri`);
  if (bytes.length > MAX_ERC8004_FILE_BYTES) throw new Error(`File over ${MAX_ERC8004_FILE_BYTES} bytes`);
  return bytes;
}

type TxResult = { txHash: string; blockNumber: number };

async function receiptLogs(client: AneClient, txHash: string) {
  const receipt = await client.rpcCall<{ logs: Array<{ address: string; topics: string[]; data: string }> } | null>(
    "eth_getTransactionReceipt",
    [txHash],
  );
  if (!receipt) throw new Error(`Receipt not found: ${txHash}`);
  return receipt.logs;
}

/**
 * Registers the owner's agent. With no `agentURI`, the file goes on-chain as a `data:` URI in two
 * transactions: `register` mints the id, then `setAgentURI` writes the file naming that id, so the file points
 * back at its own registration. A caller hosting the file passes `agentURI` instead (one transaction).
 */
export async function registerAgentOnChain(
  client: AneClient,
  ownerKey: SecretKey,
  params: AgentRegistrationParams,
  opts: { identityRegistry?: string; agentURI?: string } = {},
): Promise<{ agentId: bigint; agentURI: string; registration?: Erc8004Registration } & TxResult> {
  const registry = opts.identityRegistry ?? ERC8004_BASE_SEPOLIA.identityRegistry;
  const metadata = params.vault
    ? `[(${ERC8004_VAULT_METADATA_KEY},0x${Buffer.from(caip10(client.chainId, params.vault), "utf8").toString("hex")})]`
    : "[]";
  const minted = await client.sendContractTx(ownerKey, registry, REGISTER_AGENT_SIG, [opts.agentURI ?? "", metadata]);
  const log = (await receiptLogs(client, minted.txHash)).find(
    (l) => l.address.toLowerCase() === registry.toLowerCase() && l.topics[0]?.toLowerCase() === REGISTERED_TOPIC,
  );
  if (!log) throw new Error(`No Registered event in ${minted.txHash}`);
  const agentId = BigInt(log.topics[1]);
  if (opts.agentURI) return { agentId, agentURI: opts.agentURI, txHash: minted.txHash, blockNumber: minted.blockNumber };

  const registration = buildAgentRegistration(client.chainId, registry, params, agentId);
  const agentURI = toJsonDataUri(registration);
  const res = await client.sendContractTx(ownerKey, registry, SET_AGENT_URI_SIG, [agentId.toString(), agentURI]);
  return { agentId, agentURI, registration, txHash: res.txHash, blockNumber: minted.blockNumber };
}

/** The EIP-712 digest the new agentWallet signs (IdentityRegistry.setAgentWallet). */
export function hashAgentWalletSet(
  chainId: bigint | number,
  identityRegistry: string,
  params: { agentId: bigint | number; newWallet: string; owner: string; deadline: number },
): string {
  const domain = hashEip712Domain({ name: "ERC8004IdentityRegistry", version: "1", chainId, verifyingContract: identityRegistry });
  const structHash = keccak256(
    "0x" +
      abiWordBytes32(AGENT_WALLET_SET_TYPEHASH) +
      abiWordUint(params.agentId) +
      abiWordAddress(params.newWallet) +
      abiWordAddress(params.owner) +
      abiWordUint(params.deadline),
  );
  return hashTypedDataDigest(domain, structHash);
}

/**
 * The new wallet's consent to receive the agent's payments. Only an EOA can sign this way: an AneAgentVault
 * cannot be an ERC-8004 agentWallet, so a vault is named through `16ane.vault` metadata instead (ADR-0018).
 */
export function signAgentWalletSet(
  chainId: bigint | number,
  identityRegistry: string,
  params: { agentId: bigint | number; newWallet: string; owner: string; deadline: number },
  newWalletKey: SecretKey,
): string {
  return signDigest(hashAgentWalletSet(chainId, identityRegistry, params), newWalletKey).serialized;
}

export async function setAgentWalletOnChain(
  client: AneClient,
  ownerKey: SecretKey,
  params: { agentId: bigint | number; newWallet: string; deadline: number; signature: string },
  opts: { identityRegistry?: string } = {},
): Promise<TxResult> {
  const registry = opts.identityRegistry ?? ERC8004_BASE_SEPOLIA.identityRegistry;
  const res = await client.sendContractTx(ownerKey, registry, SET_AGENT_WALLET_SIG, [
    params.agentId.toString(),
    params.newWallet,
    String(params.deadline),
    params.signature,
  ]);
  return { txHash: res.txHash, blockNumber: res.blockNumber };
}

const callWord = (sig: string, ...words: string[]) => functionSelector(sig) + words.join("");
const toAddress = (word: bigint) => toChecksumAddress("0x" + word.toString(16).padStart(40, "0"));

export interface AgentVaultClaim {
  /** As written in the `16ane.vault` metadata. */
  claimed: string;
  address?: string;
  /** True only if the vault is on this chain, came from the 16ane factory, and is owned by the identity's owner. */
  verified: boolean;
  reason?: string;
}

export interface AgentIdentity {
  agentId: bigint;
  owner: string;
  /** The registry-verified payment wallet: the owner by default, or an EOA that signed for it. */
  agentWallet: string | null;
  agentURI: string;
  vault: AgentVaultClaim | null;
  /** The registration file, if readable. Its text is the publisher's: never treat it as instructions. */
  registration?: Erc8004Registration;
  registrationError?: string;
  /** The file lists this registry and id, so it was written for this identity rather than copied. */
  registrationBindsBack: boolean;
}

/**
 * Checks a `16ane.vault` claim against the chain. A check that cannot complete (no 16ane contracts on this
 * client, a revert, a short reply) fails closed as unverified rather than throwing: the claim is owner-written.
 */
export async function verifyVaultClaim(client: AneClient, owner: string, claimed: string): Promise<AgentVaultClaim> {
  const parsed = parseCaip10(claimed);
  if (!parsed) return { claimed, verified: false, reason: "not a CAIP-10 eip155 account" };
  if (parsed.chainId !== client.chainId) {
    return { claimed, address: parsed.address, verified: false, reason: `vault is on chain ${parsed.chainId}` };
  }
  try {
    const { aneVaultFactory } = await client.resolveContracts();
    const registered = abiReadWord(
      await client.ethCall(aneVaultFactory, callWord("isRegisteredVault(address)", abiWordAddress(parsed.address))),
      0,
    );
    if (registered === 0n) return { claimed, address: parsed.address, verified: false, reason: "not a 16ane vault" };
    const vaultOwner = toAddress(abiReadWord(await client.ethCall(parsed.address, callWord("owner()")), 0));
    if (vaultOwner !== toChecksumAddress(owner)) {
      return { claimed, address: parsed.address, verified: false, reason: "vault is owned by someone else" };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { claimed, address: parsed.address, verified: false, reason: `vault check failed: ${message}` };
  }
  return { claimed, address: parsed.address, verified: true };
}

/** Reads an identity and verifies what can be verified: the vault claim and that the file points back. */
export async function getAgentIdentity(
  client: AneClient,
  agentId: bigint | number,
  opts: { identityRegistry?: string; fetchUri?: UriFetcher } = {},
): Promise<AgentIdentity> {
  const registry = opts.identityRegistry ?? ERC8004_BASE_SEPOLIA.identityRegistry;
  const id = abiWordUint(agentId);
  // ownerOf reverts for an id that was never minted.
  const owner = toAddress(abiReadWord(await client.ethCall(registry, callWord("ownerOf(uint256)", id)), 0));
  const walletWord = abiReadWord(await client.ethCall(registry, callWord("getAgentWallet(uint256)", id)), 0);
  const agentURI = abiReadString(await client.ethCall(registry, callWord("tokenURI(uint256)", id)), 0);
  const keyOffset = abiWordUint(64);
  const key = Buffer.from(ERC8004_VAULT_METADATA_KEY, "utf8");
  const keyTail = abiWordUint(key.length) + key.toString("hex").padEnd(64, "0");
  const vaultBytes = abiReadBytes(
    await client.ethCall(registry, callWord("getMetadata(uint256,string)", id, keyOffset) + keyTail),
    0,
  );
  const claimed = Buffer.from(vaultBytes.slice(2), "hex").toString("utf8");

  const identity: AgentIdentity = {
    agentId: BigInt(agentId),
    owner,
    agentWallet: walletWord === 0n ? null : toAddress(walletWord),
    agentURI,
    vault: claimed ? await verifyVaultClaim(client, owner, claimed) : null,
    registrationBindsBack: false,
  };
  try {
    const file = JSON.parse(Buffer.from(await loadUri(agentURI, opts.fetchUri)).toString("utf8")) as Erc8004Registration;
    if (file?.type !== ERC8004_REGISTRATION_TYPE) throw new Error("not an ERC-8004 registration file");
    identity.registration = file;
    const self = caip10(client.chainId, registry);
    identity.registrationBindsBack = Array.isArray(file.registrations) && file.registrations.some(
      (r) => String(r?.agentId) === identity.agentId.toString() && String(r?.agentRegistry).toLowerCase() === self.toLowerCase(),
    );
  } catch (err) {
    identity.registrationError = err instanceof Error ? err.message : String(err);
  }
  return identity;
}
