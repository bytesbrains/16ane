// Asynchronous tasks through AneTaskEscrow (#21, REQ-201, ADR-0009). A buyer's agent locks tANE for a task
// by signing an ordinary SpendIntent whose merchant is the escrow and whose quoteId commits to the task's
// terms (seller, deadline, spec), so the vault's policy bounds every lock. The buyer (agent or owner) pays
// the seller in milestones by signing delivery receipts for a cumulative amount; after the deadline anyone
// can return the rest to the vault, which restores the vault's budget.
import { abiWordAddress, abiWordBytes32, abiWordUint, functionSelector } from "./abi.ts";
import type { AneClient } from "./client.ts";
import { computePaymentId, hashEip712Domain, hashTypedDataDigest, type SpendIntent } from "./crypto.ts";
import { keccak256, keccak256Utf8 } from "./keccak.ts";
import type { SecretKey } from "./secret.ts";
import { signDigest, toChecksumAddress } from "./secp256k1.ts";
import type { AgentSession } from "./session.ts";

export const TASK_TERMS_TYPEHASH = keccak256Utf8("TaskTerms(address escrow,address seller,uint64 deadline,bytes32 specHash)");
export const TASK_RELEASE_TYPEHASH = keccak256Utf8("Release(bytes32 taskId,uint256 cumulativeAmount,bytes32 deliveryHash)");
/** The longest a task may hold a vault's funds, counted from the lock (AneTaskEscrow.MAX_TASK_DURATION). */
export const MAX_TASK_DURATION_SECONDS = 30 * 24 * 60 * 60;

export const OPEN_TASK_SIG =
  "openTask((address,address,uint256,bytes32,bytes32,uint256,uint256,bytes32,uint64),bytes,address,uint64,bytes32)";
export const RELEASE_TASK_SIG = "release(bytes32,uint256,bytes32,bytes)";
export const RECLAIM_TASK_SIG = "reclaim(bytes32)";
export const CANCEL_TASK_SIG = "cancel(bytes32)";

/** What the buyer's agent agrees to. `specHash` identifies the job and must differ between otherwise identical tasks. */
export interface TaskTerms {
  seller: string;
  /** Unix seconds; on or before it the buyer can release, after it anyone can return the rest. */
  deadline: number;
  specHash: string;
}

export interface EscrowTask {
  vault: string;
  seller: string;
  amount: bigint;
  released: bigint;
  deadline: number;
  specHash: string;
  closed: boolean;
}

export interface TaskRelease {
  taskId: string;
  /** The total the seller has been paid once this receipt is used, not the increment. */
  cumulativeAmount: bigint | string;
  /** What was delivered, for the record (for example, the hash of the result). */
  deliveryHash: string;
}

export interface SignedTaskLock {
  intent: SpendIntent;
  signature: string;
  terms: TaskTerms;
  taskId: string;
}

/** The SpendIntent quoteId that commits a lock to these terms (AneTaskEscrow.taskQuoteId). */
export function computeTaskQuoteId(escrow: string, terms: TaskTerms): string {
  return keccak256(
    "0x" +
      abiWordBytes32(TASK_TERMS_TYPEHASH) +
      abiWordAddress(escrow) +
      abiWordAddress(terms.seller) +
      abiWordUint(terms.deadline) +
      abiWordBytes32(terms.specHash),
  );
}

/** A task's id is the vault's paymentId for its lock. */
export function computeTaskId(chainId: bigint | number, vault: string, escrow: string, quoteId: string, nonce: string): string {
  return computePaymentId(chainId, vault, escrow, quoteId, nonce);
}

/** The EIP-712 digest of a delivery receipt (AneTaskEscrow.releaseDigest). */
export function hashTaskRelease(chainId: bigint | number, escrow: string, release: TaskRelease): string {
  const domainSeparator = hashEip712Domain({ name: "AneTaskEscrow", version: "1", chainId, verifyingContract: escrow });
  const structHash = keccak256(
    "0x" +
      abiWordBytes32(TASK_RELEASE_TYPEHASH) +
      abiWordBytes32(release.taskId) +
      abiWordUint(release.cumulativeAmount) +
      abiWordBytes32(release.deliveryHash),
  );
  return hashTypedDataDigest(domainSeparator, structHash);
}

/**
 * Signs a delivery receipt. The key must be the vault owner's, or the vault's agent while its delegation is
 * active: the escrow refuses anyone else, and revoking the agent voids receipts it signed.
 */
export function signTaskRelease(chainId: bigint | number, escrow: string, release: TaskRelease, key: SecretKey): string {
  return signDigest(hashTaskRelease(chainId, escrow, release), key).serialized;
}

/**
 * The agent signs a lock of `amount` for a task. Nothing moves until someone submits it with
 * `openTaskOnChain`; the vault then checks the signature and its whole policy, as for any payment.
 */
export async function signTaskLock(
  session: AgentSession,
  escrow: string,
  params: { amount: bigint | string; terms: TaskTerms; serviceIdHash: string; validBefore: number; nonce?: string },
): Promise<SignedTaskLock> {
  const terms = { ...params.terms, seller: toChecksumAddress(params.terms.seller) };
  const policyVersion = await session.client.getPolicyVersion(session.vaultAddress);
  const { intent, signature, paymentId } = session.signSpendIntent({
    merchant: escrow,
    amount: params.amount,
    quoteId: computeTaskQuoteId(escrow, terms),
    serviceIdHash: params.serviceIdHash,
    validBefore: params.validBefore,
    nonce: params.nonce,
    policyVersion,
  });
  return { intent, signature, terms, taskId: paymentId };
}

type TxResult = { txHash: string; blockNumber: number };

/** Submits a signed lock. Anyone may: the seller, a relayer, or the buyer. */
export async function openTaskOnChain(client: AneClient, submitter: SecretKey, escrow: string, lock: SignedTaskLock): Promise<TxResult> {
  const i = lock.intent;
  const tupleArg = `(${i.vault},${i.merchant},${i.amount.toString()},${i.quoteId},${i.serviceIdHash},${i.validAfter.toString()},${i.validBefore.toString()},${i.nonce},${i.policyVersion.toString()})`;
  const res = await client.sendContractTx(submitter, escrow, OPEN_TASK_SIG, [
    tupleArg,
    lock.signature,
    lock.terms.seller,
    String(lock.terms.deadline),
    lock.terms.specHash,
  ]);
  return { txHash: res.txHash, blockNumber: res.blockNumber };
}

/**
 * Pays the seller up to `release.cumulativeAmount`. With a receipt signature anyone may submit it (usually
 * the seller); with none, the sender must be the vault owner or its active agent.
 */
export async function releaseTaskOnChain(
  client: AneClient,
  submitter: SecretKey,
  escrow: string,
  release: TaskRelease,
  signature = "0x",
): Promise<TxResult> {
  const res = await client.sendContractTx(submitter, escrow, RELEASE_TASK_SIG, [
    release.taskId,
    release.cumulativeAmount.toString(),
    release.deliveryHash,
    signature,
  ]);
  return { txHash: res.txHash, blockNumber: res.blockNumber };
}

/** After the deadline, returns what was not released to the buyer's vault. Anyone may call it. */
export async function reclaimTaskOnChain(client: AneClient, submitter: SecretKey, escrow: string, taskId: string): Promise<TxResult> {
  const res = await client.sendContractTx(submitter, escrow, RECLAIM_TASK_SIG, [taskId]);
  return { txHash: res.txHash, blockNumber: res.blockNumber };
}

/** The seller gives up the task and returns what was not released, at any time. */
export async function cancelTaskOnChain(client: AneClient, seller: SecretKey, escrow: string, taskId: string): Promise<TxResult> {
  const res = await client.sendContractTx(seller, escrow, CANCEL_TASK_SIG, [taskId]);
  return { txHash: res.txHash, blockNumber: res.blockNumber };
}

/** Reads a task; an unknown id comes back with the zero address as its vault. */
export async function getEscrowTask(client: AneClient, escrow: string, taskId: string): Promise<EscrowTask> {
  const out = await client.ethCall(escrow, functionSelector("tasks(bytes32)") + abiWordBytes32(taskId));
  const hex = out.startsWith("0x") ? out.slice(2) : out;
  const word = (n: number) => hex.slice(n * 64, (n + 1) * 64).padStart(64, "0");
  return {
    vault: toChecksumAddress("0x" + word(0).slice(-40)),
    seller: toChecksumAddress("0x" + word(1).slice(-40)),
    amount: BigInt("0x" + word(2)),
    released: BigInt("0x" + word(3)),
    deadline: Number(BigInt("0x" + word(4))),
    specHash: "0x" + word(5),
    closed: BigInt("0x" + word(6)) !== 0n,
  };
}
