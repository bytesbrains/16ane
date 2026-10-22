// Owner-signed actions a relayer submits and pays gas for, so an owner never needs ETH (#77, ADR-0006):
// a tANE transfer (EIP-3009, also how a vault is funded), a vault policy (setPolicyWithSig), a revocation
// (revokeWithSig) and a vault creation. The first three are checked by the contracts; createVault needs no
// signature on-chain, so its signature is checked by the relay server only, to stop anyone spending the
// relayer's budget on vaults for addresses that didn't ask for one.
import { abiBytesTail, abiWordAddress, abiWordBytes32, abiWordUint, encodeCallWithTrailingBytes, functionSelector } from "./abi.ts";
import type { AneClient } from "./client.ts";
import { hashEip712Domain, hashTypedDataDigest, type SpendIntent, type TransferWithAuthorization } from "./crypto.ts";
import { keccak256, keccak256Utf8 } from "./keccak.ts";
import type { SecretKey } from "./secret.ts";
import { recoverAddress, toChecksumAddress } from "./secp256k1.ts";
import { BUDGET_MODE, type BudgetModeName } from "./types.ts";

export const SET_POLICY_TYPEHASH = keccak256Utf8(
  "SetPolicy(address vault,address agentSigner,uint256 maxTotalSpend,uint256 maxPerTx,uint256 dailyLimit,uint64 expiry,uint8 budgetMode,uint256 revolvingTreasuryCeiling,uint64 expectedPolicyVersion,uint256 deadline)",
);
export const REVOKE_TYPEHASH = keccak256Utf8("Revoke(address vault,uint64 expectedPolicyVersion,uint256 deadline)");
export const CREATE_VAULT_TYPEHASH = keccak256Utf8("CreateVault(address owner,bytes32 salt,uint256 deadline)");

export interface DelegatePolicyInput {
  mode?: BudgetModeName;
  allowanceCap: bigint | string;
  perTxLimit: bigint | string;
  dailyLimit?: bigint | string;
  expiry: number;
  revolvingTreasuryCeiling?: bigint | string;
}

/** The vault's PolicyInput, field for field. */
export interface PolicyFields {
  agentSigner: string;
  maxTotalSpend: bigint;
  maxPerTx: bigint;
  dailyLimit: bigint;
  expiry: number;
  budgetMode: number;
  revolvingTreasuryCeiling: bigint;
}

// The defaults OwnerWallet.delegateSession has always applied, shared so the signed and direct paths agree.
export function toPolicyFields(sessionAddress: string, policy: DelegatePolicyInput): PolicyFields {
  return {
    agentSigner: toChecksumAddress(sessionAddress),
    maxTotalSpend: BigInt(policy.allowanceCap),
    maxPerTx: BigInt(policy.perTxLimit),
    dailyLimit: BigInt(policy.dailyLimit ?? policy.allowanceCap),
    expiry: policy.expiry,
    budgetMode: policy.mode === "REVOLVING" ? BUDGET_MODE.REVOLVING : BUDGET_MODE.FIXED,
    revolvingTreasuryCeiling: BigInt(policy.revolvingTreasuryCeiling ?? policy.allowanceCap),
  };
}

export function policyTupleArg(p: PolicyFields): string {
  return `(${p.agentSigner},${p.maxTotalSpend},${p.maxPerTx},${p.dailyLimit},${p.expiry},${p.budgetMode},${p.revolvingTreasuryCeiling})`;
}

export interface SignedTransfer extends TransferWithAuthorization {
  signature: string;
}

export interface SignedPolicy {
  vault: string;
  policy: PolicyFields;
  expectedPolicyVersion: number;
  deadline: number;
  signature: string;
}

export interface SignedRevoke {
  vault: string;
  expectedPolicyVersion: number;
  deadline: number;
  signature: string;
}

export interface SignedVaultCreation {
  owner: string;
  salt: string;
  deadline: number;
  signature: string;
}

const vaultDomain = (chainId: number | bigint, vault: string) =>
  hashEip712Domain({ name: "AneAgentVault", version: "1", chainId, verifyingContract: vault });

export function hashSetPolicy(
  chainId: number | bigint,
  vault: string,
  p: PolicyFields,
  expectedPolicyVersion: number,
  deadline: number,
): string {
  const structHash = keccak256(
    "0x" +
      abiWordBytes32(SET_POLICY_TYPEHASH) +
      abiWordAddress(vault) +
      abiWordAddress(p.agentSigner) +
      abiWordUint(p.maxTotalSpend) +
      abiWordUint(p.maxPerTx) +
      abiWordUint(p.dailyLimit) +
      abiWordUint(p.expiry) +
      abiWordUint(p.budgetMode) +
      abiWordUint(p.revolvingTreasuryCeiling) +
      abiWordUint(expectedPolicyVersion) +
      abiWordUint(deadline),
  );
  return hashTypedDataDigest(vaultDomain(chainId, vault), structHash);
}

export function hashRevoke(chainId: number | bigint, vault: string, expectedPolicyVersion: number, deadline: number): string {
  const structHash = keccak256(
    "0x" + abiWordBytes32(REVOKE_TYPEHASH) + abiWordAddress(vault) + abiWordUint(expectedPolicyVersion) + abiWordUint(deadline),
  );
  return hashTypedDataDigest(vaultDomain(chainId, vault), structHash);
}

// Bound to the factory and chain, like the vault messages are bound to their vault.
export function hashVaultCreation(chainId: number | bigint, factory: string, owner: string, salt: string, deadline: number): string {
  const domain = hashEip712Domain({ name: "16ane Relay", version: "1", chainId, verifyingContract: factory });
  const structHash = keccak256(
    "0x" + abiWordBytes32(CREATE_VAULT_TYPEHASH) + abiWordAddress(owner) + abiWordBytes32(salt) + abiWordUint(deadline),
  );
  return hashTypedDataDigest(domain, structHash);
}

// ---- calldata, for a relay to simulate (eth_call) a submission before paying for it -------------------------

export const TRANSFER_WITH_AUTHORIZATION_SIG =
  "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)";
export const SET_POLICY_WITH_SIG_SIG =
  "setPolicyWithSig((address,uint256,uint256,uint256,uint64,uint8,uint256),uint64,uint256,bytes)";
export const REVOKE_WITH_SIG_SIG = "revokeWithSig(uint64,uint256,bytes)";
export const CREATE_VAULT_SIG = "createVault(address,bytes32)";

export function transferCalldata(t: SignedTransfer): string {
  return encodeCallWithTrailingBytes(
    TRANSFER_WITH_AUTHORIZATION_SIG,
    [
      abiWordAddress(t.from),
      abiWordAddress(t.to),
      abiWordUint(t.value),
      abiWordUint(t.validAfter),
      abiWordUint(t.validBefore),
      abiWordBytes32(t.nonce),
    ],
    t.signature,
  );
}

export function setPolicyCalldata(s: SignedPolicy): string {
  const p = s.policy;
  return encodeCallWithTrailingBytes(
    SET_POLICY_WITH_SIG_SIG,
    [
      abiWordAddress(p.agentSigner),
      abiWordUint(p.maxTotalSpend),
      abiWordUint(p.maxPerTx),
      abiWordUint(p.dailyLimit),
      abiWordUint(p.expiry),
      abiWordUint(p.budgetMode),
      abiWordUint(p.revolvingTreasuryCeiling),
      abiWordUint(s.expectedPolicyVersion),
      abiWordUint(s.deadline),
    ],
    s.signature,
  );
}

export function revokeCalldata(r: SignedRevoke): string {
  return encodeCallWithTrailingBytes(
    REVOKE_WITH_SIG_SIG,
    [abiWordUint(r.expectedPolicyVersion), abiWordUint(r.deadline)],
    r.signature,
  );
}

export function createVaultCalldata(owner: string, salt: string): string {
  return functionSelector(CREATE_VAULT_SIG) + abiWordAddress(owner) + abiWordBytes32(salt);
}

export const SETTLE_PAYMENT_SIG =
  "settlePayment((address,address,uint256,bytes32,bytes32,uint256,uint256,bytes32,uint64),bytes)";

// The intent tuple holds only static fields, so it is encoded inline in the head (no tuple offset);
// the signature follows as the trailing bytes argument.
export function settlePaymentCalldata(intent: SpendIntent, signatureHex: string): string {
  const tuple = [
    abiWordAddress(intent.vault),
    abiWordAddress(intent.merchant),
    abiWordUint(intent.amount),
    abiWordBytes32(intent.quoteId),
    abiWordBytes32(intent.serviceIdHash),
    abiWordUint(intent.validAfter),
    abiWordUint(intent.validBefore),
    abiWordBytes32(intent.nonce),
    abiWordUint(intent.policyVersion),
  ].join("");
  const head = tuple + abiWordUint(tuple.length / 2 + 32);
  return functionSelector(SETTLE_PAYMENT_SIG) + head + abiBytesTail(signatureHex);
}

// ---- submitting (the relayer pays the gas) ----------------------------------------------------------------

// The factory accepts createVault from anyone, so the check that the owner asked for this vault happens here,
// before any gas is spent, and every relay built on this helper gets it.
export async function relayCreateVault(
  client: AneClient,
  relayerKey: SecretKey,
  creation: SignedVaultCreation,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<{ txHash: string; blockNumber: number; vaultAddress: string }> {
  const { aneVaultFactory } = await client.resolveContracts();
  if (!Number.isSafeInteger(creation.deadline) || creation.deadline <= nowSec) {
    throw new Error("Vault creation refused: the signature's deadline has passed");
  }
  const digest = hashVaultCreation(client.chainId, aneVaultFactory, creation.owner, creation.salt, creation.deadline);
  let signer: string;
  try {
    signer = recoverAddress(digest, creation.signature);
  } catch {
    throw new Error("Vault creation refused: the signature is invalid");
  }
  if (signer.toLowerCase() !== creation.owner.toLowerCase()) {
    throw new Error("Vault creation refused: not signed by the owner");
  }
  const vaultAddress = await client.computeVaultAddress(creation.owner, creation.salt);
  const res = await client.sendContractTx(relayerKey, aneVaultFactory, CREATE_VAULT_SIG, [
    toChecksumAddress(creation.owner),
    creation.salt,
  ]);
  return { txHash: res.txHash, blockNumber: res.blockNumber, vaultAddress };
}

export async function relaySetPolicy(
  client: AneClient,
  relayerKey: SecretKey,
  signed: SignedPolicy,
): Promise<{ txHash: string; blockNumber: number }> {
  const res = await client.sendContractTx(
    relayerKey,
    signed.vault,
    SET_POLICY_WITH_SIG_SIG,
    [policyTupleArg(signed.policy), String(signed.expectedPolicyVersion), String(signed.deadline), signed.signature],
  );
  return { txHash: res.txHash, blockNumber: res.blockNumber };
}

export async function relayRevoke(
  client: AneClient,
  relayerKey: SecretKey,
  signed: SignedRevoke,
): Promise<{ txHash: string; blockNumber: number }> {
  const res = await client.sendContractTx(relayerKey, signed.vault, REVOKE_WITH_SIG_SIG, [
    String(signed.expectedPolicyVersion),
    String(signed.deadline),
    signed.signature,
  ]);
  return { txHash: res.txHash, blockNumber: res.blockNumber };
}

export async function relayTransfer(
  client: AneClient,
  relayerKey: SecretKey,
  signed: SignedTransfer,
): Promise<{ txHash: string; blockNumber: number }> {
  return client.settleExactAuthorizationOnChain(relayerKey, signed, signed.signature);
}
