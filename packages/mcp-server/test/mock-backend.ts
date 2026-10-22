// Shared mock backend for the MCP server tests: scriptable responses, real
// manifest cryptography (sign/verify delegate to the SDK), no chain needed.
// Test keys are keccak-derived fixtures, never real secrets.

import {
  AneClient,
  keccak256Utf8,
  privateKeyToAddress,
  SecretKey,
  type PaymentRecordView,
  type PurchaseOptions,
  type PurchaseResult,
  type ServiceManifestPayload,
  type VaultAccountingSummary,
  type X402Receipt,
} from "../../sdk-ts/src/index.ts";
import type { McpBackend, McpBackendConfig, PublishReceipt, VaultBalances } from "../src/backend.ts";

export const TEST_AGENT_KEY_HEX = keccak256Utf8("16ane.test.mcp.agent.v1");
export const TEST_ATTACKER_KEY_HEX = keccak256Utf8("16ane.test.mcp.attacker.v1");
export const TEST_VAULT = "0x1111111111111111111111111111111111111111";
export const TEST_TOKEN = "0x2222222222222222222222222222222222222222";
export const TEST_DIRECTORY = "0x3333333333333333333333333333333333333333";
export const TEST_MERCHANT = "0x4444444444444444444444444444444444444444";
export const TEST_OWNER = "0x5555555555555555555555555555555555555555";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function testAgentSessionAddress(): string {
  return privateKeyToAddress(new SecretKey(TEST_AGENT_KEY_HEX));
}

export function mockConfig(overrides: Partial<McpBackendConfig> = {}): McpBackendConfig {
  return {
    chainId: 31337,
    network: "eip155:31337",
    vaultAddress: TEST_VAULT,
    sessionAddress: testAgentSessionAddress(),
    tokenAddress: TEST_TOKEN,
    directoryAddress: TEST_DIRECTORY,
    apiBaseUrl: "https://api.test",
    ...overrides,
  };
}

export function mockAccounting(overrides: Partial<VaultAccountingSummary> = {}): VaultAccountingSummary {
  return {
    owner: TEST_OWNER,
    agentSigner: testAgentSessionAddress(),
    tokenBalance: 16000n,
    ownerPrincipalDeposited: 16000n,
    maxTotalSpend: 320n,
    cumulativeSpent: 16n,
    authorizedRemaining: 304n,
    spendableNow: 304n,
    verifiedRevenue: 0n,
    unallocatedBalance: 15696n,
    policyVersion: 1,
    expiry: 0,
    budgetMode: "FIXED",
    revolvingTreasuryCeiling: 0n,
    active: true,
    ...overrides,
  };
}

export function zeroPaymentRecord(): PaymentRecordView {
  return { merchant: ZERO_ADDRESS, amountPaid: 0n, amountRefunded: 0n, settledAt: 0 };
}

export function mockReceipt(overrides: Partial<X402Receipt> = {}): X402Receipt {
  return {
    x402Version: 2,
    success: true,
    scheme: "ane-vault-v1",
    network: "eip155:31337",
    txHash: "0xabc123",
    blockNumber: 42,
    intentId: "0xintent",
    paymentId: "0xpay1",
    payer: TEST_VAULT,
    payTo: TEST_MERCHANT,
    asset: TEST_TOKEN,
    amount: "16",
    resourceHash: "0xresource",
    requestHash: "0xrequest",
    settledAt: "2026-10-22T00:00:00.000Z",
    disclaimer: "TEST TOKENS (tANE) - NO CASH VALUE",
    ...overrides,
  };
}

export interface MockProbe {
  status: number;
  headers: Record<string, string>;
  text: string;
}

export function quote402Envelope(payTo: string, amount = "16"): Record<string, unknown> {
  return {
    x402Version: 2,
    accepts: [
      {
        scheme: "ane-vault-v1",
        network: "eip155:31337",
        asset: TEST_TOKEN,
        assetSymbol: "tANE",
        amount,
        payTo,
        maxTimeoutSeconds: 300,
        resource: "POST https://merchant.test/summarize",
        description: "Demo summarization",
        extra: { quoteId: "0xquote", expiresAt: 1893456000, serviceId: "demo-sum" },
      },
    ],
  };
}

export class MockBackend implements McpBackend {
  readonly config: McpBackendConfig;
  readonly agentKey = new SecretKey(TEST_AGENT_KEY_HEX);
  readonly #client: AneClient;

  services: ServiceManifestPayload[] = [];
  probes = new Map<string, MockProbe>();
  records = new Map<string, PaymentRecordView>();
  receipts = new Map<string, X402Receipt>();
  balances: VaultBalances = { tokenBalance: 16000n, accounting: mockAccounting() };
  purchaseResult: PurchaseResult = { status: 200, data: { ok: true }, trialSponsored: false, headers: {} };
  purchaseError?: Error;
  purchaseCalls: { url: string; options: PurchaseOptions }[] = [];
  probeCalls: string[] = [];
  published: ServiceManifestPayload[] = [];
  forcedVerify?: { valid: boolean; signer?: string; digest: string; reason?: string };

  constructor(config: McpBackendConfig = mockConfig()) {
    this.config = config;
    this.#client = new AneClient({
      rpcUrl: "http://127.0.0.1:1",
      chainId: config.chainId,
      contracts: {
        aneTestToken: config.tokenAddress,
        aneVaultFactory: TEST_VAULT,
        aneFaucet: TEST_VAULT,
        aneServiceDirectory: config.directoryAddress,
      },
    });
  }

  async getBalances(): Promise<VaultBalances> {
    return this.balances;
  }

  async getPaymentRecord(paymentId: string): Promise<PaymentRecordView> {
    return this.records.get(paymentId) ?? zeroPaymentRecord();
  }

  async listServices(): Promise<{ services: ServiceManifestPayload[]; source: string }> {
    if (!this.config.apiBaseUrl) {
      throw new Error("Service listing needs ANE_API_BASE_URL (the sandbox REST API)");
    }
    return { services: this.services, source: `${this.config.apiBaseUrl}/v1/services` };
  }

  async publishManifest(manifest: ServiceManifestPayload): Promise<PublishReceipt> {
    if (!this.config.apiBaseUrl) {
      throw new Error("Service publishing needs ANE_API_BASE_URL (the sandbox REST API)");
    }
    this.published.push(manifest);
    const check = this.verifyManifest(manifest);
    return {
      registered: true,
      serviceId: manifest.serviceId,
      signer: check.signer ?? manifest.signer ?? ZERO_ADDRESS,
      manifestDigest: check.digest,
    };
  }

  async getReceipt(id: string): Promise<X402Receipt | null> {
    return this.receipts.get(id) ?? null;
  }

  async purchase(url: string, options: PurchaseOptions): Promise<PurchaseResult> {
    this.purchaseCalls.push({ url, options });
    if (this.purchaseError) {
      throw this.purchaseError;
    }
    return this.purchaseResult;
  }

  signManifest(input: Omit<ServiceManifestPayload, "signer" | "signature">): ServiceManifestPayload {
    return this.#client.signServiceManifest(input, this.agentKey);
  }

  signManifestAs(
    input: Omit<ServiceManifestPayload, "signer" | "signature">,
    keyHex: string,
  ): ServiceManifestPayload {
    return this.#client.signServiceManifest(input, new SecretKey(keyHex));
  }

  verifyManifest(manifest: ServiceManifestPayload): {
    valid: boolean;
    signer?: string;
    digest: string;
    reason?: string;
  } {
    if (this.forcedVerify) {
      return this.forcedVerify;
    }
    return this.#client.verifyServiceManifest(manifest, this.config.directoryAddress);
  }

  async probeUrl(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<MockProbe> {
    void init;
    this.probeCalls.push(url);
    return this.probes.get(url) ?? { status: 404, headers: {}, text: "not found" };
  }
}

/** A manifest whose merchant-controlled text carries a prompt-injection payload. */
export function maliciousManifest(backend: MockBackend, injection: string): ServiceManifestPayload {
  return backend.signManifestAs(
    {
      schemaVersion: "16ane-manifest-v0",
      serviceId: "evil-service",
      name: `Helpful Summarizer. ${injection}`,
      description: injection,
      version: "0.1.0",
      network: "eip155:31337",
      chainId: 31337,
      payTo: TEST_MERCHANT,
      tokenAddress: TEST_TOKEN,
      tokenSymbol: "tANE",
      updatedAt: 1761091200,
      endpoints: [
        {
          id: "run",
          method: "POST",
          path: "/run",
          priceAmount: "16",
          scheme: "ane-vault-v1",
          description: injection,
        },
      ],
    },
    TEST_ATTACKER_KEY_HEX,
  );
}
