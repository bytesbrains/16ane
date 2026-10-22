// Backend interface behind the MCP tools: a live implementation over AneClient /
// AgentSession plus the sandbox REST API, kept behind an interface so tests run
// without a chain. The backend owns the agentSigner key; it never accepts,
// stores or logs an owner root key (there is no such option anywhere here).

import {
  AgentSession,
  AneClient,
  SANDBOX_DISCLAIMER,
  type PaymentRecordView,
  type PurchaseOptions,
  type PurchaseResult,
  type SecretKey,
  type ServiceManifestPayload,
  type VaultAccountingSummary,
  type X402Receipt,
} from "../../sdk-ts/src/index.ts";

export type McpNetwork = "eip155:84532" | "eip155:31337";

export interface McpBackendConfig {
  chainId: number;
  network: McpNetwork;
  vaultAddress: string;
  sessionAddress: string;
  tokenAddress: string;
  directoryAddress: string;
  /** Sandbox REST base (e.g. https://api.16ane.com); needed for service listing, publishing and receipt lookup. */
  apiBaseUrl?: string;
  /** Optional server-side per-call purchase ceiling in tANE base units. */
  maxPaymentCeiling?: bigint;
  fetchImpl?: typeof fetch;
  /** Quote-probe response cap in bytes; defaults to DEFAULT_PROBE_MAX_BYTES. */
  probeMaxBytes?: number;
  /** Quote-probe fetch timeout in ms; defaults to DEFAULT_PROBE_TIMEOUT_MS. */
  probeTimeoutMs?: number;
}

/** Quote probes only need headers and small JSON manifests; never buffer more. */
export const DEFAULT_PROBE_MAX_BYTES = 256 * 1024;
/** A hanging merchant must fail the probe, not the MCP request. */
export const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

export interface VaultBalances {
  tokenBalance: bigint;
  accounting: VaultAccountingSummary | null;
}

export interface PublishReceipt {
  registered: boolean;
  serviceId: string;
  signer: string;
  manifestDigest: string;
}

export interface McpBackend {
  readonly config: McpBackendConfig;
  getBalances(): Promise<VaultBalances>;
  getPaymentRecord(paymentId: string): Promise<PaymentRecordView>;
  listServices(): Promise<{ services: ServiceManifestPayload[]; source: string }>;
  publishManifest(manifest: ServiceManifestPayload): Promise<PublishReceipt>;
  getReceipt(id: string): Promise<X402Receipt | null>;
  purchase(url: string, options: PurchaseOptions): Promise<PurchaseResult>;
  signManifest(input: Omit<ServiceManifestPayload, "signer" | "signature">): ServiceManifestPayload;
  verifyManifest(manifest: ServiceManifestPayload): {
    valid: boolean;
    signer?: string;
    digest: string;
    reason?: string;
  };
  /** Raw fetch for quote probing (402 without payment); no signing happens here. */
  probeUrl(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    text: string;
  }>;
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

export class LiveBackend implements McpBackend {
  readonly config: McpBackendConfig;
  readonly #client: AneClient;
  readonly #session: AgentSession;
  readonly #agentKey: SecretKey;
  readonly #fetch: typeof fetch;

  constructor(client: AneClient, session: AgentSession, agentKey: SecretKey, config: McpBackendConfig) {
    this.#client = client;
    this.#session = session;
    this.#agentKey = agentKey;
    this.config = config;
    this.#fetch = config.fetchImpl ?? fetch;
  }

  async getBalances(): Promise<VaultBalances> {
    const tokenBalance = await this.#client.getTokenBalance(this.config.vaultAddress);
    let accounting: VaultAccountingSummary | null = null;
    try {
      accounting = await this.#client.getAccountingSummary(this.config.vaultAddress);
    } catch {
      // EOA or non-vault contract: token balance only.
    }
    return { tokenBalance, accounting };
  }

  async getPaymentRecord(paymentId: string): Promise<PaymentRecordView> {
    return this.#client.getPaymentRecord(this.config.vaultAddress, paymentId);
  }

  async listServices(): Promise<{ services: ServiceManifestPayload[]; source: string }> {
    if (!this.config.apiBaseUrl) {
      throw new Error("Service listing needs ANE_API_BASE_URL (the sandbox REST API)");
    }
    const url = joinUrl(this.config.apiBaseUrl, "/v1/services");
    const res = await this.#fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      throw new Error(`Service listing failed: HTTP ${res.status} from ${url}`);
    }
    const body = (await res.json()) as { services?: ServiceManifestPayload[] };
    return { services: Array.isArray(body.services) ? body.services : [], source: url };
  }

  async publishManifest(manifest: ServiceManifestPayload): Promise<PublishReceipt> {
    if (!this.config.apiBaseUrl) {
      throw new Error("Service publishing needs ANE_API_BASE_URL (the sandbox REST API)");
    }
    const url = joinUrl(this.config.apiBaseUrl, "/v1/services");
    const res = await this.#fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(manifest),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Service publishing failed: HTTP ${res.status} ${text}`.trim());
    }
    return (await res.json()) as PublishReceipt;
  }

  async getReceipt(id: string): Promise<X402Receipt | null> {
    if (!this.config.apiBaseUrl) {
      return null;
    }
    const url = joinUrl(this.config.apiBaseUrl, `/v1/payments/${encodeURIComponent(id)}`);
    const res = await this.#fetch(url, { headers: { accept: "application/json" } });
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`Receipt lookup failed: HTTP ${res.status} from ${url}`);
    }
    return (await res.json()) as X402Receipt;
  }

  async purchase(url: string, options: PurchaseOptions): Promise<PurchaseResult> {
    return this.#session.purchase(url, options);
  }

  signManifest(input: Omit<ServiceManifestPayload, "signer" | "signature">): ServiceManifestPayload {
    return this.#client.signServiceManifest(input, this.#agentKey);
  }

  verifyManifest(manifest: ServiceManifestPayload): {
    valid: boolean;
    signer?: string;
    digest: string;
    reason?: string;
  } {
    return this.#client.verifyServiceManifest(manifest, this.config.directoryAddress);
  }

  async probeUrl(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<{ status: number; headers: Record<string, string>; text: string }> {
    const maxBytes = this.config.probeMaxBytes ?? DEFAULT_PROBE_MAX_BYTES;
    const timeoutMs = this.config.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const res = await this.#fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    if (!res.body) {
      return { status: res.status, headers, text: "" };
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(
          `Quote probe of ${new URL(url).origin} exceeded the ${maxBytes}-byte response cap`,
        );
      }
      chunks.push(value);
    }
    return { status: res.status, headers, text: Buffer.concat(chunks).toString("utf8") };
  }
}

export { SANDBOX_DISCLAIMER };
