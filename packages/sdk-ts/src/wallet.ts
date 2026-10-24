import util from "node:util";
import { normalizeSaltBytes32, type AneClient } from "./client.ts";
import { hashTransferWithAuthorization, randomBytes32Hex } from "./crypto.ts";
import { REDACTED_PRIVATE_KEY, SecretKey } from "./secret.ts";
import { privateKeyToAddress, signDigest, toChecksumAddress } from "./secp256k1.ts";
import {
  type DelegatePolicyInput,
  hashRevoke,
  hashSetPolicy,
  hashVaultCreation,
  policyTupleArg,
  type SignedPolicy,
  type SignedRevoke,
  type SignedTransfer,
  type SignedVaultCreation,
  toPolicyFields,
} from "./signed-actions.ts";

// Signatures for a relayer to submit (#77) are short-lived: 10 minutes unless the caller says otherwise.
const DEFAULT_SIGNATURE_TTL_SECONDS = 600;
const deadlineFromNow = (seconds = DEFAULT_SIGNATURE_TTL_SECONDS) => Math.floor(Date.now() / 1000) + seconds;

export class OwnerWallet {
  readonly client: AneClient;
  readonly address: string;
  #secretKey: SecretKey;

  constructor(client: AneClient, privateKey: string | SecretKey) {
    this.client = client;
    this.#secretKey = privateKey instanceof SecretKey ? privateKey : new SecretKey(privateKey);
    this.address = privateKeyToAddress(this.#secretKey);
  }

  toJSON(): Record<string, unknown> {
    return { address: this.address, secretKey: REDACTED_PRIVATE_KEY };
  }

  [util.inspect.custom](): string {
    return `OwnerWallet(address=${this.address}, secretKey=${REDACTED_PRIVATE_KEY})`;
  }

  /** Deploys this owner's vault for `salt` if needed; pass another asset's `vaultFactory` for a vault in that asset. */
  async ensureVaultDeployed(
    salt: bigint | number | string = 0n,
    options: { vaultFactory?: string } = {},
  ): Promise<{ vaultAddress: string; txHash?: string }> {
    const saltB32 = normalizeSaltBytes32(salt);
    const factory = options.vaultFactory ?? (await this.client.resolveContracts()).aneVaultFactory;
    const vaultAddress = await this.client.computeVaultAddress(this.address, saltB32, factory);
    const deployed = await this.client.isContractDeployed(vaultAddress);
    if (deployed) {
      return { vaultAddress };
    }
    const res = await this.client.sendContractTx(
      this.#secretKey,
      factory,
      "createVault(address,bytes32)",
      [this.address, saltB32],
    );
    return { vaultAddress, txHash: res.txHash };
  }

  async fundVault(
    vaultAddress: string,
    amount: bigint | string,
  ): Promise<{ approveTxHash: string; depositTxHash: string }> {
    // The vault's own token, which is tANE only for a vault from the tANE factory.
    const asset = await this.client.getVaultAsset(vaultAddress);
    const approveRes = await this.client.sendContractTx(
      this.#secretKey,
      asset,
      "approve(address,uint256)",
      [vaultAddress, amount.toString()],
    );
    const depositRes = await this.client.sendContractTx(
      this.#secretKey,
      vaultAddress,
      "fund(uint256)",
      [amount.toString()],
    );
    return {
      approveTxHash: approveRes.txHash,
      depositTxHash: depositRes.txHash,
    };
  }

  async delegateSession(
    vaultAddress: string,
    sessionAddress: string,
    policy: DelegatePolicyInput,
  ): Promise<{ txHash: string }> {
    const res = await this.client.sendContractTx(
      this.#secretKey,
      vaultAddress,
      "setPolicy((address,uint256,uint256,uint256,uint64,uint8,uint256))",
      [policyTupleArg(toPolicyFields(sessionAddress, policy))],
    );
    return { txHash: res.txHash };
  }

  async revokeSession(vaultAddress: string): Promise<{ txHash: string }> {
    const res = await this.client.sendContractTx(
      this.#secretKey,
      vaultAddress,
      "revoke()",
      [],
    );
    return { txHash: res.txHash };
  }

  async revokeAndSweep(
    vaultAddress: string,
    _sessionAddress: string,
    recipient: string,
  ): Promise<{ txHash: string }> {
    const res = await this.client.sendContractTx(
      this.#secretKey,
      vaultAddress,
      "revokeAndSweep(address)",
      [toChecksumAddress(recipient)],
    );
    return { txHash: res.txHash };
  }

  async withdrawPrincipal(
    vaultAddress: string,
    to: string,
    amount: bigint | string,
  ): Promise<{ txHash: string }> {
    const res = await this.client.sendContractTx(
      this.#secretKey,
      vaultAddress,
      "withdraw(uint256,address)",
      [BigInt(amount).toString(), toChecksumAddress(to)],
    );
    return { txHash: res.txHash };
  }

  // ---- signed for a relayer to submit, so this wallet needs no ETH (#77) ---------------------------------

  /** An EIP-3009 transfer of tANE from this wallet. Funding a vault is a transfer to the vault's address. */
  async signTransfer(
    to: string,
    value: bigint | string,
    options: { validBefore?: number; nonce?: string } = {},
  ): Promise<SignedTransfer> {
    const { aneTestToken } = await this.client.resolveContracts();
    const auth = {
      from: this.address,
      to: toChecksumAddress(to),
      value: BigInt(value),
      validAfter: 0,
      validBefore: options.validBefore ?? deadlineFromNow(),
      nonce: options.nonce ?? randomBytes32Hex(),
    };
    const { digest } = hashTransferWithAuthorization(this.client.chainId, aneTestToken, auth);
    return { ...auth, signature: signDigest(digest, this.#secretKey).serialized };
  }

  /** setPolicyWithSig for the vault's current policy version, so the signature can be used once. */
  async signPolicy(
    vaultAddress: string,
    sessionAddress: string,
    policy: DelegatePolicyInput,
    options: { deadline?: number } = {},
  ): Promise<SignedPolicy> {
    const vault = toChecksumAddress(vaultAddress);
    const fields = toPolicyFields(sessionAddress, policy);
    const expectedPolicyVersion = await this.client.getPolicyVersion(vault);
    const deadline = options.deadline ?? deadlineFromNow();
    const digest = hashSetPolicy(this.client.chainId, vault, fields, expectedPolicyVersion, deadline);
    return { vault, policy: fields, expectedPolicyVersion, deadline, signature: signDigest(digest, this.#secretKey).serialized };
  }

  /** revokeWithSig for the vault's current policy version. */
  async signRevoke(vaultAddress: string, options: { deadline?: number } = {}): Promise<SignedRevoke> {
    const vault = toChecksumAddress(vaultAddress);
    const expectedPolicyVersion = await this.client.getPolicyVersion(vault);
    const deadline = options.deadline ?? deadlineFromNow();
    const digest = hashRevoke(this.client.chainId, vault, expectedPolicyVersion, deadline);
    return { vault, expectedPolicyVersion, deadline, signature: signDigest(digest, this.#secretKey).serialized };
  }

  /** Asks a relay server to create this wallet's vault (checked by the server; the factory needs no signature). */
  async signVaultCreation(
    salt: bigint | number | string = 0n,
    options: { deadline?: number } = {},
  ): Promise<SignedVaultCreation> {
    const { aneVaultFactory } = await this.client.resolveContracts();
    const saltB32 = normalizeSaltBytes32(salt);
    const deadline = options.deadline ?? deadlineFromNow();
    const digest = hashVaultCreation(this.client.chainId, aneVaultFactory, this.address, saltB32, deadline);
    return { owner: this.address, salt: saltB32, deadline, signature: signDigest(digest, this.#secretKey).serialized };
  }
}
