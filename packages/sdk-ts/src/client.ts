import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { abiWordAddress, abiWordBytes32, abiWordUint, functionSelector } from "./abi.ts";
import {
  hashServiceManifest,
  type ServiceManifestPayload,
  type SpendIntent,
  type TransferWithAuthorization,
} from "./crypto.ts";
import { keccak256Utf8 } from "./keccak.ts";
import { withTemporaryKeystore } from "./keystore.ts";
import { redactSecrets, SecretKey } from "./secret.ts";
import { recoverAddress, signDigest, toChecksumAddress } from "./secp256k1.ts";
import {
  BUDGET_MODE,
  type AneClientOptions,
  type AneContractAddresses,
  type PaymentRecordView,
  type VaultAccountingSummary,
} from "./types.ts";

const execFileAsync = promisify(execFile);

// Load-balanced public RPCs (e.g. sepolia.base.org) can lag for a moment after a transaction confirms: the
// next `cast send` gets a stale nonce and is rejected with "nonce too low", or with "replacement transaction
// underpriced" by a node still holding the confirmed transaction as pending. Each send waits for its receipt,
// so a rejected transaction was never broadcast, and retrying after a short wait cannot send it twice.
const STALE_NONCE = /nonce too low|replacement transaction underpriced/i;
const NONCE_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

function splitWords(hexData: string): string[] {
  const clean = hexData.startsWith("0x") ? hexData.slice(2) : hexData;
  const words: string[] = [];
  for (let i = 0; i + 64 <= clean.length; i += 64) {
    words.push(clean.slice(i, i + 64));
  }
  return words;
}

function wordToBigInt(word: string | undefined): bigint {
  return BigInt("0x" + (word || "0"));
}

function wordToAddress(word: string | undefined): string {
  return toChecksumAddress("0x" + (word || "0".repeat(64)).slice(-40));
}

export function normalizeSaltBytes32(salt: bigint | number | string = 0n): string {
  if (typeof salt === "string" && salt.startsWith("0x") && salt.length === 66) {
    return salt;
  }
  return "0x" + abiWordUint(salt);
}

export class AneClient {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly facilitatorUrl?: string;
  private registryAddress?: string;
  private cachedContracts?: AneContractAddresses;

  constructor(options: AneClientOptions) {
    this.rpcUrl = options.rpcUrl;
    this.chainId = options.chainId ?? 84532;
    this.registryAddress = options.registryAddress;
    this.facilitatorUrl = options.facilitatorUrl;
    if (
      options.contracts?.aneTestToken &&
      options.contracts?.aneVaultFactory &&
      options.contracts?.aneFaucet &&
      options.contracts?.aneServiceDirectory
    ) {
      this.cachedContracts = {
        registry:
          options.contracts.registry ??
          options.registryAddress ??
          "0x0000000000000000000000000000000000000000",
        aneTestToken: toChecksumAddress(options.contracts.aneTestToken),
        aneVaultFactory: toChecksumAddress(options.contracts.aneVaultFactory),
        aneFaucet: toChecksumAddress(options.contracts.aneFaucet),
        aneServiceDirectory: toChecksumAddress(options.contracts.aneServiceDirectory),
      };
    }
  }

  async rpcCall<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) {
      throw new Error(`RPC HTTP error ${res.status}: ${await res.text()}`);
    }
    const payload = (await res.json()) as {
      result?: T;
      error?: { code: number; message: string };
    };
    if (payload.error) {
      throw new Error(`RPC error (${payload.error.code}): ${payload.error.message}`);
    }
    return payload.result as T;
  }

  async ethCall(to: string, data: string): Promise<string> {
    return this.rpcCall<string>("eth_call", [{ to, data }, "latest"]);
  }

  async resolveContracts(): Promise<AneContractAddresses> {
    if (this.cachedContracts) {
      return this.cachedContracts;
    }
    if (!this.registryAddress) {
      throw new Error("Neither contract addresses nor registryAddress configured on AneClient");
    }
    const sel = functionSelector("getDeployment()");
    const out = await this.ethCall(this.registryAddress, sel);
    const words = splitWords(out);
    this.cachedContracts = {
      registry: toChecksumAddress(this.registryAddress),
      aneTestToken: wordToAddress(words[0]),
      aneVaultFactory: wordToAddress(words[1]),
      aneFaucet: wordToAddress(words[2]),
      aneServiceDirectory: wordToAddress(words[3]),
    };
    return this.cachedContracts;
  }

  async getTokenBalance(account: string): Promise<bigint> {
    const { aneTestToken } = await this.resolveContracts();
    const sel = functionSelector("balanceOf(address)");
    const out = await this.ethCall(aneTestToken, sel + abiWordAddress(account));
    return wordToBigInt(splitWords(out)[0]);
  }

  async computeVaultAddress(owner: string, salt: bigint | number | string = 0n): Promise<string> {
    const { aneVaultFactory } = await this.resolveContracts();
    const sel = functionSelector("predictVaultAddress(address,bytes32)");
    const saltB32 = normalizeSaltBytes32(salt);
    const out = await this.ethCall(
      aneVaultFactory,
      sel + abiWordAddress(owner) + abiWordBytes32(saltB32),
    );
    return wordToAddress(splitWords(out)[0]);
  }

  async isContractDeployed(address: string): Promise<boolean> {
    const code = await this.rpcCall<string>("eth_getCode", [address, "latest"]);
    return Boolean(code && code !== "0x" && code !== "0x0");
  }

  async getAccountingSummary(vaultAddress: string): Promise<VaultAccountingSummary> {
    const sel = functionSelector("getAccountingSummary()");
    const out = await this.ethCall(vaultAddress, sel);
    const w = splitWords(out);
    const modeNum = Number(wordToBigInt(w[12]));
    return {
      owner: wordToAddress(w[0]),
      agentSigner: wordToAddress(w[1]),
      tokenBalance: wordToBigInt(w[2]),
      ownerPrincipalDeposited: wordToBigInt(w[3]),
      maxTotalSpend: wordToBigInt(w[4]),
      cumulativeSpent: wordToBigInt(w[5]),
      authorizedRemaining: wordToBigInt(w[6]),
      spendableNow: wordToBigInt(w[7]),
      verifiedRevenue: wordToBigInt(w[8]),
      unallocatedBalance: wordToBigInt(w[9]),
      policyVersion: Number(wordToBigInt(w[10])),
      expiry: Number(wordToBigInt(w[11])),
      budgetMode: modeNum === BUDGET_MODE.REVOLVING ? "REVOLVING" : "FIXED",
      revolvingTreasuryCeiling: wordToBigInt(w[13]),
      active: wordToBigInt(w[14]) !== 0n,
    };
  }

  async getPolicyVersion(vaultAddress: string): Promise<number> {
    const sel = functionSelector("policyVersion()");
    const out = await this.ethCall(vaultAddress, sel);
    return Number(wordToBigInt(splitWords(out)[0]));
  }

  async getAvailableToSpend(vaultAddress: string): Promise<bigint> {
    const sel = functionSelector("spendableBalance()");
    const out = await this.ethCall(vaultAddress, sel);
    return wordToBigInt(splitWords(out)[0]);
  }

  async isQuoteSettled(vaultAddress: string, quoteId: string): Promise<boolean> {
    const sel = functionSelector("quoteSettled(bytes32)");
    const out = await this.ethCall(vaultAddress, sel + abiWordBytes32(quoteId));
    return wordToBigInt(splitWords(out)[0]) !== 0n;
  }

  async getPaymentRecord(vaultAddress: string, paymentId: string): Promise<PaymentRecordView> {
    const sel = functionSelector("payments(bytes32)");
    const out = await this.ethCall(vaultAddress, sel + abiWordBytes32(paymentId));
    const w = splitWords(out);
    return {
      merchant: wordToAddress(w[0]),
      amountPaid: wordToBigInt(w[1]),
      amountRefunded: wordToBigInt(w[2]),
      settledAt: Number(wordToBigInt(w[3])),
    };
  }

  /**
   * Executes a state-changing contract call using `cast send`. The key never appears in `cast`'s arguments:
   * it reaches `cast` as a temporary encrypted keystore (#67), and it is redacted from error messages.
   */
  async sendContractTx(
    signer: SecretKey,
    to: string,
    signature: string,
    args: string[] = [],
  ): Promise<{ txHash: string; blockNumber: number; status: number }> {
    const rawKey = signer.unsafeUnwrap();
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#castSend(rawKey, to, signature, args);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const delay = NONCE_RETRY_DELAYS_MS[attempt];
        if (STALE_NONCE.test(msg) && delay !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw new Error(redactSecrets(msg, [rawKey]));
      }
    }
  }

  async #castSend(
    rawKey: string,
    to: string,
    signature: string,
    args: string[],
  ): Promise<{ txHash: string; blockNumber: number; status: number }> {
    // "--" ends cast's options: a contract argument such as "--value=1ether" must stay an argument, never
    // become an option that changes the transaction (it would send ETH from the signer).
    const cmdArgs = ["send", "--rpc-url", this.rpcUrl, "--json", "--", to, signature, ...args];
    const { stdout } = await withTemporaryKeystore(rawKey, (keystoreEnv) => {
      // Signer settings inherited from the caller's shell would override or conflict with the keystore.
      const { ETH_KEYSTORE_ACCOUNT: _account, ETH_FROM: _from, ...inherited } = process.env;
      return execFileAsync("cast", cmdArgs, {
        env: { ...inherited, ...keystoreEnv, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" },
      });
    });
    const parsed = JSON.parse(stdout.trim()) as {
      transactionHash: string;
      blockNumber: string | number;
      status: string | number;
    };
    const blockNumber =
      typeof parsed.blockNumber === "string"
        ? Number(BigInt(parsed.blockNumber))
        : parsed.blockNumber;
    const status =
      typeof parsed.status === "string" ? Number(BigInt(parsed.status)) : parsed.status;
    if (status !== 1) {
      throw new Error(`Transaction reverted: ${parsed.transactionHash}`);
    }
    return {
      txHash: parsed.transactionHash,
      blockNumber,
      status,
    };
  }

  async settleSpendIntentOnChain(
    relayerKey: SecretKey,
    intent: SpendIntent,
    signatureHex: string,
  ): Promise<{ txHash: string; blockNumber: number }> {
    const tupleArg = `(${intent.vault},${intent.merchant},${intent.amount.toString()},${intent.quoteId},${intent.serviceIdHash},${intent.validAfter.toString()},${intent.validBefore.toString()},${intent.nonce},${intent.policyVersion.toString()})`;
    const res = await this.sendContractTx(
      relayerKey,
      intent.vault,
      "settlePayment((address,address,uint256,bytes32,bytes32,uint256,uint256,bytes32,uint64),bytes)",
      [tupleArg, signatureHex],
    );
    return { txHash: res.txHash, blockNumber: res.blockNumber };
  }

  async settleExactAuthorizationOnChain(
    relayerKey: SecretKey,
    auth: TransferWithAuthorization,
    signatureHex: string,
  ): Promise<{ txHash: string; blockNumber: number }> {
    const { aneTestToken } = await this.resolveContracts();
    const res = await this.sendContractTx(
      relayerKey,
      aneTestToken,
      "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)",
      [
        auth.from,
        auth.to,
        auth.value.toString(),
        auth.validAfter.toString(),
        auth.validBefore.toString(),
        auth.nonce,
        signatureHex,
      ],
    );
    return { txHash: res.txHash, blockNumber: res.blockNumber };
  }

  async refundPaymentOnChain(
    merchantKey: SecretKey,
    vaultAddress: string,
    paymentId: string,
    amount: bigint | string,
  ): Promise<{ txHash: string; blockNumber: number }> {
    const { aneTestToken } = await this.resolveContracts();
    await this.sendContractTx(merchantKey, aneTestToken, "approve(address,uint256)", [
      vaultAddress,
      amount.toString(),
    ]);
    const res = await this.sendContractTx(
      merchantKey,
      vaultAddress,
      "refundPayment(bytes32,uint256)",
      [paymentId, amount.toString()],
    );
    return { txHash: res.txHash, blockNumber: res.blockNumber };
  }

  async executeFaucetClaimOnChain(
    relayerKey: SecretKey,
    recipient: string,
  ): Promise<{ txHash: string; blockNumber: number }> {
    const { aneFaucet } = await this.resolveContracts();
    const res = await this.sendContractTx(
      relayerKey,
      aneFaucet,
      "claim(address)",
      [toChecksumAddress(recipient)],
    );
    return { txHash: res.txHash, blockNumber: res.blockNumber };
  }

  /**
   * Verifies a settlement transaction hash directly against JSON-RPC without relying
   * on any hosted facilitator (REQ-005, ADR-0005).
   */
  async verifySettlementOnChain(params: {
    txHash: string;
    expectedAsset?: string;
    expectedPayee: string;
    expectedAmount: bigint | string;
    expectedVault?: string;
    expectedPaymentId?: string;
  }): Promise<{
    verified: boolean;
    blockNumber: number;
    txHash: string;
    reason?: string;
  }> {
    const receipt = await this.rpcCall<{
      status: string;
      blockNumber: string;
      logs: Array<{ address: string; topics: string[]; data: string }>;
    } | null>("eth_getTransactionReceipt", [params.txHash]);

    if (!receipt) {
      return {
        verified: false,
        blockNumber: 0,
        txHash: params.txHash,
        reason: "Transaction receipt not found",
      };
    }
    if (BigInt(receipt.status) !== 1n) {
      return {
        verified: false,
        blockNumber: 0,
        txHash: params.txHash,
        reason: "Transaction reverted on-chain",
      };
    }

    const { aneTestToken } = await this.resolveContracts();
    const assetAddr = (params.expectedAsset ?? aneTestToken).toLowerCase();
    const transferTopic = keccak256Utf8("Transfer(address,address,uint256)").toLowerCase();
    const expectedPayeeTopic = "0x" + abiWordAddress(params.expectedPayee).toLowerCase();
    const expectedAmt = BigInt(params.expectedAmount);

    let matchedTransfer = false;
    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() === assetAddr &&
        log.topics[0]?.toLowerCase() === transferTopic &&
        log.topics[2]?.toLowerCase() === expectedPayeeTopic
      ) {
        if (params.expectedVault) {
          const expectedFromTopic = "0x" + abiWordAddress(params.expectedVault).toLowerCase();
          if (log.topics[1]?.toLowerCase() !== expectedFromTopic) {
            continue;
          }
        }
        const value = BigInt(log.data);
        if (value >= expectedAmt) {
          matchedTransfer = true;
          break;
        }
      }
    }

    if (!matchedTransfer) {
      return {
        verified: false,
        blockNumber: Number(BigInt(receipt.blockNumber)),
        txHash: params.txHash,
        reason: "Matching ERC-20 Transfer log to expectedPayee not found in receipt",
      };
    }

    if (params.expectedVault && params.expectedPaymentId) {
      const rec = await this.getPaymentRecord(params.expectedVault, params.expectedPaymentId);
      if (rec.amountPaid < expectedAmt) {
        return {
          verified: false,
          blockNumber: Number(BigInt(receipt.blockNumber)),
          txHash: params.txHash,
          reason: "Payment ID not recorded in AneAgentVault",
        };
      }
    }

    return {
      verified: true,
      blockNumber: Number(BigInt(receipt.blockNumber)),
      txHash: params.txHash,
    };
  }

  signServiceManifest(
    manifest: Omit<ServiceManifestPayload, "signer" | "signature">,
    signerKey: SecretKey,
    directoryAddress?: string,
  ): ServiceManifestPayload {
    const dir =
      directoryAddress ??
      this.cachedContracts?.aneServiceDirectory ??
      "0x0000000000000000000000000000000000000000";
    const full: ServiceManifestPayload = {
      ...manifest,
      payTo: toChecksumAddress(manifest.payTo),
      tokenAddress: toChecksumAddress(manifest.tokenAddress),
    };
    const { digest } = hashServiceManifest(full, dir);
    const sig = signDigest(digest, signerKey);
    const signer = recoverAddress(digest, sig.serialized);
    return {
      ...full,
      signer,
      signature: sig.serialized,
    };
  }

  verifyServiceManifest(
    manifest: ServiceManifestPayload,
    directoryAddress?: string,
  ): { valid: boolean; signer?: string; digest: string; reason?: string } {
    if (!manifest.signature || !manifest.signer) {
      return { valid: false, digest: "0x", reason: "Missing manifest signature or signer" };
    }
    const dir =
      directoryAddress ??
      this.cachedContracts?.aneServiceDirectory ??
      "0x0000000000000000000000000000000000000000";
    const { digest } = hashServiceManifest(manifest, dir);
    try {
      const recovered = recoverAddress(digest, manifest.signature);
      if (recovered.toLowerCase() !== manifest.signer.toLowerCase()) {
        return {
          valid: false,
          signer: recovered,
          digest,
          reason: `Manifest signature mismatch: recovered ${recovered}, expected ${manifest.signer}`,
        };
      }
      return { valid: true, signer: recovered, digest };
    } catch (err) {
      return {
        valid: false,
        digest,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
