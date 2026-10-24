// A sponsored trial campaign's definition (ADR-0008): its input shape, validation into the
// normalized form the quota engine enforces, and the JSON-safe form a KeyValueStore holds.

import { toChecksumAddress } from "./secp256k1.ts";

/** Real-compute money is counted in USD micros (1_000_000 = $1.00), as in ADR-0008. */
export type CampaignStatus = "ACTIVE" | "PAUSED" | "PAUSED_BUDGET_EXHAUSTED" | "EXPIRED";

export interface SponsoredCampaignInput {
  campaignId: string;
  /** Provider address: only this key can pause/resume the campaign. */
  providerId: string;
  serviceId: string;
  /** Endpoint paths this campaign sponsors, e.g. ["/v1/demo/summarize"]. */
  endpoints: string[];
  /** tANE price per sponsored endpoint in base units (informational: the endpoint enforces it). */
  testTokenPrices: Record<string, string>;
  /** Sponsored calls per caller (network address) per UTC day. */
  maxCallsPerWallet: number;
  /** Aggregate sponsored calls per UTC day across all callers. */
  maxCallsGlobalPerDay: number;
  /** Per-request token ceiling for sponsored calls; 0 disables it. */
  maxTokensPerRequest?: number;
  /** Lifetime aggregate real-compute ceiling in USD micros; 0 disables it. */
  providerCostBudgetMicros?: bigint | number | string;
  /** Per-service real-cost velocity cap in USD micros per UTC hour; 0 disables it. */
  serviceHourlyCostMicros?: bigint | number | string;
  /** Upstream cost pre-reserved per sponsored call; 0 for deterministic stubs (ADR-0016). */
  estimatedCostMicrosPerCall?: bigint | number | string;
  /** Unix seconds; 0 means no bound. */
  startsAtSec?: number;
  /** Unix seconds; 0 means no expiry. */
  expiresAtSec?: number;
  /** Human-readable eligibility note, e.g. "open" or "allowlisted wallets". */
  eligibility?: string;
  /** When set, only these caller ids (lowercased) are eligible for sponsorship. */
  allowedCallers?: string[];
  status?: CampaignStatus;
  /** Endpoints where an exhausted quota rejects instead of falling back to paid. */
  trialOnlyEndpoints?: string[];
  /** Disclosure carried on every sponsored response (AGENTS.md: sponsorship and quotas). */
  sponsorDisclosure: string;
  termsUrl?: string;
  refundPolicy?: string;
}

export interface SponsoredCampaign {
  campaignId: string;
  providerId: string;
  serviceId: string;
  endpoints: string[];
  testTokenPrices: Record<string, string>;
  maxCallsPerWallet: number;
  maxCallsGlobalPerDay: number;
  maxTokensPerRequest: number;
  providerCostBudgetMicros: bigint;
  serviceHourlyCostMicros: bigint;
  estimatedCostMicrosPerCall: bigint;
  startsAtSec: number;
  expiresAtSec: number;
  eligibility: string;
  allowedCallers?: string[];
  status: CampaignStatus;
  trialOnlyEndpoints: string[];
  sponsorDisclosure: string;
  termsUrl?: string;
  refundPolicy?: string;
}

function toMicros(value: bigint | number | string | undefined, field: string): bigint {
  if (value === undefined) return 0n;
  const micros = typeof value === "bigint" ? value : BigInt(value);
  if (micros < 0n) throw new Error(`Sponsored campaign refused: ${field} must not be negative`);
  return micros;
}

function toCount(value: number | undefined, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Sponsored campaign refused: ${field} must be a whole number >= 0`);
  }
  return value;
}

// BigInt cannot cross JSON, so the store holds micros as decimal strings; every read revives them.
export type CampaignDto = Omit<
  SponsoredCampaign,
  "providerCostBudgetMicros" | "serviceHourlyCostMicros" | "estimatedCostMicrosPerCall"
> & {
  providerCostBudgetMicros: string;
  serviceHourlyCostMicros: string;
  estimatedCostMicrosPerCall: string;
};

export function normalizeCampaign(input: SponsoredCampaignInput): SponsoredCampaign {
  if (!input.campaignId || input.campaignId.length > 128) {
    throw new Error("Sponsored campaign refused: campaignId must be 1-128 characters");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.providerId)) {
    throw new Error("Sponsored campaign refused: providerId must be a 0x-prefixed 20-byte address");
  }
  if (input.endpoints.length === 0 || input.endpoints.some((e) => !e.startsWith("/"))) {
    throw new Error("Sponsored campaign refused: endpoints must be non-empty paths");
  }
  for (const [path, price] of Object.entries(input.testTokenPrices)) {
    if (!/^\d+$/.test(price)) {
      throw new Error(`Sponsored campaign refused: testTokenPrices[${path}] must be base units`);
    }
  }
  const startsAtSec = toCount(input.startsAtSec, "startsAtSec", 0);
  const expiresAtSec = toCount(input.expiresAtSec, "expiresAtSec", 0);
  if (expiresAtSec !== 0 && startsAtSec !== 0 && expiresAtSec <= startsAtSec) {
    throw new Error("Sponsored campaign refused: expiresAtSec must be after startsAtSec");
  }
  const trialOnlyEndpoints = input.trialOnlyEndpoints ?? [];
  for (const path of trialOnlyEndpoints) {
    if (!input.endpoints.includes(path)) {
      throw new Error(`Sponsored campaign refused: trial-only ${path} is not a campaign endpoint`);
    }
  }
  return {
    campaignId: input.campaignId,
    providerId: toChecksumAddress(input.providerId),
    serviceId: input.serviceId,
    endpoints: [...input.endpoints],
    testTokenPrices: { ...input.testTokenPrices },
    maxCallsPerWallet: toCount(input.maxCallsPerWallet, "maxCallsPerWallet", 0),
    maxCallsGlobalPerDay: toCount(input.maxCallsGlobalPerDay, "maxCallsGlobalPerDay", 0),
    maxTokensPerRequest: toCount(input.maxTokensPerRequest, "maxTokensPerRequest", 0),
    providerCostBudgetMicros: toMicros(input.providerCostBudgetMicros, "providerCostBudgetMicros"),
    serviceHourlyCostMicros: toMicros(input.serviceHourlyCostMicros, "serviceHourlyCostMicros"),
    estimatedCostMicrosPerCall: toMicros(input.estimatedCostMicrosPerCall, "estimatedCostMicrosPerCall"),
    startsAtSec,
    expiresAtSec,
    eligibility: input.eligibility ?? "open",
    allowedCallers: input.allowedCallers?.map((c) => c.toLowerCase()),
    status: input.status ?? "ACTIVE",
    trialOnlyEndpoints: [...trialOnlyEndpoints],
    sponsorDisclosure: input.sponsorDisclosure,
    ...(input.termsUrl === undefined ? {} : { termsUrl: input.termsUrl }),
    ...(input.refundPolicy === undefined ? {} : { refundPolicy: input.refundPolicy }),
  };
}

export function toDto(c: SponsoredCampaign): CampaignDto {
  return {
    ...c,
    providerCostBudgetMicros: c.providerCostBudgetMicros.toString(),
    serviceHourlyCostMicros: c.serviceHourlyCostMicros.toString(),
    estimatedCostMicrosPerCall: c.estimatedCostMicrosPerCall.toString(),
  };
}

export function fromDto(dto: CampaignDto): SponsoredCampaign {
  return {
    ...dto,
    providerCostBudgetMicros: BigInt(dto.providerCostBudgetMicros),
    serviceHourlyCostMicros: BigInt(dto.serviceHourlyCostMicros),
    estimatedCostMicrosPerCall: BigInt(dto.estimatedCostMicrosPerCall),
  };
}
