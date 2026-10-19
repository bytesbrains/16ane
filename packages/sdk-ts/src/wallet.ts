import util from "node:util";
import { normalizeSaltBytes32, type AneClient } from "./client.ts";
import { REDACTED_PRIVATE_KEY, SecretKey } from "./secret.ts";
import { privateKeyToAddress, toChecksumAddress } from "./secp256k1.ts";
import { BUDGET_MODE, type BudgetModeName } from "./types.ts";

export interface DelegatePolicyInput {
  mode?: BudgetModeName;
  allowanceCap: bigint | string;
  perTxLimit: bigint | string;
  dailyLimit?: bigint | string;
  expiry: number;
  revolvingTreasuryCeiling?: bigint | string;
}

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

  async ensureVaultDeployed(
    salt: bigint | number | string = 0n,
  ): Promise<{ vaultAddress: string; txHash?: string }> {
    const saltB32 = normalizeSaltBytes32(salt);
    const vaultAddress = await this.client.computeVaultAddress(this.address, saltB32);
    const deployed = await this.client.isContractDeployed(vaultAddress);
    if (deployed) {
      return { vaultAddress };
    }
    const { aneVaultFactory } = await this.client.resolveContracts();
    const res = await this.client.sendContractTx(
      this.#secretKey,
      aneVaultFactory,
      "createVault(address,bytes32)",
      [this.address, saltB32],
    );
    return { vaultAddress, txHash: res.txHash };
  }

  async fundVault(
    vaultAddress: string,
    amount: bigint | string,
  ): Promise<{ approveTxHash: string; depositTxHash: string }> {
    const { aneTestToken } = await this.client.resolveContracts();
    const approveRes = await this.client.sendContractTx(
      this.#secretKey,
      aneTestToken,
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
    const modeEnum = policy.mode === "REVOLVING" ? BUDGET_MODE.REVOLVING : BUDGET_MODE.FIXED;
    const maxTotal = BigInt(policy.allowanceCap).toString();
    const maxPerTx = BigInt(policy.perTxLimit).toString();
    const dailyLimit = BigInt(policy.dailyLimit ?? policy.allowanceCap).toString();
    const revolvingCeiling = BigInt(
      policy.revolvingTreasuryCeiling ?? policy.allowanceCap,
    ).toString();
    const tupleArg = `(${toChecksumAddress(sessionAddress)},${maxTotal},${maxPerTx},${dailyLimit},${policy.expiry},${modeEnum},${revolvingCeiling})`;
    const res = await this.client.sendContractTx(
      this.#secretKey,
      vaultAddress,
      "setPolicy((address,uint256,uint256,uint256,uint64,uint8,uint256))",
      [tupleArg],
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
}
