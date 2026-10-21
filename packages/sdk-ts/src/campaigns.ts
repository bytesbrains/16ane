// Provider-sponsored trial campaigns and the real-compute quota engine (ISS-016, ADR-0008,
// REQ-014, REQ-103). A campaign lets a provider sponsor trial calls priced in tANE while bounding
// its real compute exposure with independent per-caller, per-service and aggregate cost caps.
//
// Limits principle (#61): quotas bind only the provider's sponsored cost. They never throttle a
// paid call and never count paid usage — the engine is consulted only on the sponsored-trial path,
// before any upstream compute is spent. When a quota binds, the call falls back to the endpoint's
// normal paid 402 quote, unless the provider explicitly marked that endpoint trial-only, in which
// case the engine says "reject" (429 for quota, 503 for sponsor budget).
import { keccak256 } from "./keccak.ts";
import { privateKeyToAddress, recoverAddress, signDigest, toChecksumAddress } from "./secp256k1.ts";
import type { SecretKey } from "./secret.ts";
import { type KeyValueStore, MemoryKeyValueStore } from "./store.ts";

/** Real-compute money is counted in USD micros (1_000_000 = $1.00), as in ADR-0008. */
export type CampaignStatus = "ACTIVE" | "PAUSED" | "PAUSED_BUDGET_EXHAUSTED" | "EXPIRED";

export type QuotaDenialReason =
  | "campaign-paused"
  | "campaign-not-started"
  | "campaign-expired"
  | "caller-ineligible"
  | "tokens-per-request-exceeded"
  | "caller-quota-exhausted"
  | "global-quota-exhausted"
  | "service-velocity-exceeded"
  | "sponsor-budget-exhausted";

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

export interface SponsorReservation {
  readonly campaignId: string;
  readonly day: string;
  readonly hour: string;
  readonly callerKey: string;
  readonly costMicros: bigint;
}

export type SponsoredQuotaDecision =
  | {
      sponsored: true;
      campaignId: string;
      reservation: SponsorReservation;
      remainingCallerQuota: number;
      remainingGlobalQuota: number;
      remainingBudgetMicros: bigint | undefined;
      disclosure: string;
    }
  | {
      sponsored: false;
      campaignId: string;
      reason: QuotaDenialReason;
      /** "paid" serves the endpoint's normal 402 quote; "reject" answers 429/503 (trial-only). */
      fallback: "paid" | "reject";
      /** 429/503 use 429, budget/velocity use 503. */
      rejectStatus: 429 | 503;
      /** Seconds until the quota window reopens, when retrying can help. */
      retryAfterSeconds: number | undefined;
      disclosure: string;
    };

export interface CampaignUsage {
  campaignId: string;
  effectiveStatus: CampaignStatus;
  callsTodayGlobal: number;
  spentCostMicros: bigint;
  inFlightCostMicros: bigint;
  serviceCostThisHourMicros: bigint;
  remainingBudgetMicros: bigint | undefined;
}

const CAMPAIGNS_NS = "sponsored.campaigns";
const QUOTA_NS = "sponsored.quota";

const utcDay = (nowMs: number) => new Date(nowMs).toISOString().slice(0, 10);
const utcHour = (nowMs: number) => new Date(nowMs).toISOString().slice(0, 13);

function secondsToNextUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  const nextMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.ceil((nextMidnight - nowMs) / 1000);
}

function secondsToNextUtcHour(nowMs: number): number {
  const d = new Date(nowMs);
  const nextHour = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1);
  return Math.ceil((nextHour - nowMs) / 1000);
}

/** ~4 characters per token: a documented estimate. Providers with a real tokenizer pass exact counts. */
export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
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
type CampaignDto = Omit<
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

function toDto(c: SponsoredCampaign): CampaignDto {
  return {
    ...c,
    providerCostBudgetMicros: c.providerCostBudgetMicros.toString(),
    serviceHourlyCostMicros: c.serviceHourlyCostMicros.toString(),
    estimatedCostMicrosPerCall: c.estimatedCostMicrosPerCall.toString(),
  };
}

function fromDto(dto: CampaignDto): SponsoredCampaign {
  return {
    ...dto,
    providerCostBudgetMicros: BigInt(dto.providerCostBudgetMicros),
    serviceHourlyCostMicros: BigInt(dto.serviceHourlyCostMicros),
    estimatedCostMicrosPerCall: BigInt(dto.estimatedCostMicrosPerCall),
  };
}

export interface ReserveSponsoredCall {
  campaignId: string;
  /** The caller's network address: unauthenticated headers must not mint fresh trials (#31). */
  callerId: string;
  endpoint: string;
  estimatedTokens: number;
  /** Upstream cost to pre-reserve; defaults to the campaign's per-call estimate. */
  estimatedCostMicros?: bigint;
}

export class SponsoredQuotaEngine {
  readonly #store: KeyValueStore;
  readonly #now: () => number;
  // Cost held by calls still waiting on upstream compute, per campaign. In memory: the server is one
  // process, and a restart has no calls in flight. Counts and settled spend live in the store.
  readonly #inFlight = new Map<string, bigint>();
  // Each reservation settles or releases exactly once: a repeated cleanup is ignored, never
  // double-counted, so at-least-once error paths cannot corrupt the counters.
  readonly #closed = new WeakSet<SponsorReservation>();

  constructor(store: KeyValueStore = new MemoryKeyValueStore(), now: () => number = Date.now) {
    this.#store = store;
    this.#now = now;
  }

  upsertCampaign(input: SponsoredCampaignInput): SponsoredCampaign {
    const campaign = normalizeCampaign(input);
    this.#store.set(CAMPAIGNS_NS, campaign.campaignId, toDto(campaign));
    return campaign;
  }

  /**
   * Inserts the campaign, or refreshes its operator-configured fields while keeping a stored pause
   * latch: a restart must not silently resume a campaign the provider paused (or that ran dry).
   */
  seedCampaign(input: SponsoredCampaignInput): SponsoredCampaign {
    const stored = this.getCampaign(input.campaignId);
    if (!stored) return this.upsertCampaign(input);
    return this.upsertCampaign({ ...input, status: stored.status });
  }

  getCampaign(campaignId: string): SponsoredCampaign | undefined {
    const dto = this.#store.get<CampaignDto>(CAMPAIGNS_NS, campaignId);
    return dto === undefined ? undefined : fromDto(dto);
  }

  listCampaigns(): SponsoredCampaign[] {
    return this.#store.values<CampaignDto>(CAMPAIGNS_NS).map(fromDto);
  }

  campaignForEndpoint(endpoint: string): SponsoredCampaign | undefined {
    return this.listCampaigns().find((c) => c.endpoints.includes(endpoint));
  }

  /** The provider's circuit breaker: stops new sponsorship now; paid calls are unaffected. */
  pauseCampaign(campaignId: string): SponsoredCampaign {
    const campaign = this.#require(campaignId);
    const paused = { ...campaign, status: "PAUSED" as CampaignStatus };
    this.#store.set(CAMPAIGNS_NS, campaignId, toDto(paused));
    return paused;
  }

  /**
   * Lifts a pause. A campaign whose budget is still spent, or whose window has passed, stays
   * latched and reports why instead of resuming into an undeliverable promise.
   */
  resumeCampaign(campaignId: string): { campaign: SponsoredCampaign; resumed: boolean; reason?: string } {
    const campaign = this.#require(campaignId);
    const nowSec = Math.floor(this.#now() / 1000);
    if (campaign.expiresAtSec !== 0 && nowSec > campaign.expiresAtSec) {
      return { campaign: this.#latch(campaign, "EXPIRED"), resumed: false, reason: "campaign-expired" };
    }
    if (campaign.providerCostBudgetMicros > 0n && this.#spent(campaign.campaignId) >= campaign.providerCostBudgetMicros) {
      return {
        campaign: this.#latch(campaign, "PAUSED_BUDGET_EXHAUSTED"),
        resumed: false,
        reason: "sponsor-budget-exhausted",
      };
    }
    const active = { ...campaign, status: "ACTIVE" as CampaignStatus };
    this.#store.set(CAMPAIGNS_NS, campaignId, toDto(active));
    return { campaign: active, resumed: true };
  }

  effectiveStatus(campaign: SponsoredCampaign, nowMs: number = this.#now()): CampaignStatus {
    const nowSec = Math.floor(nowMs / 1000);
    if (campaign.expiresAtSec !== 0 && nowSec > campaign.expiresAtSec) return "EXPIRED";
    if (campaign.status === "ACTIVE" && this.#budgetSpent(campaign)) return "PAUSED_BUDGET_EXHAUSTED";
    return campaign.status;
  }

  getUsage(campaignId: string): CampaignUsage {
    const campaign = this.#require(campaignId);
    const now = this.#now();
    const spent = this.#spent(campaignId);
    return {
      campaignId,
      effectiveStatus: this.effectiveStatus(campaign, now),
      callsTodayGlobal: this.#getCount(this.#globalKey(campaignId, utcDay(now))),
      spentCostMicros: spent,
      inFlightCostMicros: this.#inFlight.get(campaignId) ?? 0n,
      serviceCostThisHourMicros: this.#getMicros(this.#serviceHourKey(campaignId, utcHour(now))),
      remainingBudgetMicros:
        campaign.providerCostBudgetMicros > 0n
          ? campaign.providerCostBudgetMicros - spent - (this.#inFlight.get(campaignId) ?? 0n) > 0n
            ? campaign.providerCostBudgetMicros - spent - (this.#inFlight.get(campaignId) ?? 0n)
            : 0n
          : undefined,
    };
  }

  remainingForCaller(campaignId: string, callerId: string): number {
    const campaign = this.#require(campaignId);
    const used = this.#getCount(this.#callerKey(campaignId, utcDay(this.#now()), callerId));
    return Math.max(0, campaign.maxCallsPerWallet - used);
  }

  /**
   * The sponsored-trial gate: every check and every write happens in this one synchronous call, so
   * concurrent requests racing for the last unit of quota or budget cannot all pass before any of
   * them records. Call it before invoking upstream compute; settle or release the reservation after.
   */
  checkAndReserve(request: ReserveSponsoredCall): SponsoredQuotaDecision {
    return this.#decide(request, true);
  }

  /** The same checks without consuming anything: for the 402 quote's trial-available hint. */
  peek(request: ReserveSponsoredCall): SponsoredQuotaDecision {
    return this.#decide(request, false);
  }

  /** Swaps the cost hold for the upstream cost actually incurred. */
  settle(reservation: SponsorReservation, actualCostMicros: bigint): void {
    if (!this.#closeReservation(reservation)) return;
    const spentKey = this.#spentKey(reservation.campaignId);
    this.#store.set(QUOTA_NS, spentKey, (this.#getMicros(spentKey) + actualCostMicros).toString());
    const hourKey = this.#serviceHourKey(reservation.campaignId, reservation.hour);
    this.#store.set(
      QUOTA_NS,
      hourKey,
      (this.#getMicros(hourKey) - reservation.costMicros + actualCostMicros).toString(),
    );
    const campaign = this.getCampaign(reservation.campaignId);
    if (campaign && campaign.status === "ACTIVE" && this.#budgetSpent(campaign)) {
      this.#latch(campaign, "PAUSED_BUDGET_EXHAUSTED");
    }
  }

  /**
   * Drops a reservation whose sponsored delivery never happened (e.g. the server failed before
   * calling upstream): the cost hold is freed and the consumed call counts are handed back, since
   * no sponsorship was delivered. Paid calls never reach the engine, so they are never counted.
   */
  release(reservation: SponsorReservation): void {
    if (!this.#closeReservation(reservation)) return;
    const hourKey = this.#serviceHourKey(reservation.campaignId, reservation.hour);
    this.#store.set(QUOTA_NS, hourKey, (this.#getMicros(hourKey) - reservation.costMicros).toString());
    const callerKey = this.#callerKey(reservation.campaignId, reservation.day, reservation.callerKey);
    this.#store.set(QUOTA_NS, callerKey, Math.max(0, this.#getCount(callerKey) - 1));
    const globalKey = this.#globalKey(reservation.campaignId, reservation.day);
    this.#store.set(QUOTA_NS, globalKey, Math.max(0, this.#getCount(globalKey) - 1));
  }

  #require(campaignId: string): SponsoredCampaign {
    const campaign = this.getCampaign(campaignId);
    if (!campaign) throw new Error(`Unknown sponsored campaign: ${campaignId}`);
    return campaign;
  }

  #latch(campaign: SponsoredCampaign, status: CampaignStatus): SponsoredCampaign {
    const latched = { ...campaign, status };
    this.#store.set(CAMPAIGNS_NS, campaign.campaignId, toDto(latched));
    return latched;
  }

  #callerKey(campaignId: string, day: string, callerId: string): string {
    return `calls:${campaignId}:${day}:caller:${callerId.toLowerCase()}`;
  }

  #globalKey(campaignId: string, day: string): string {
    return `calls:${campaignId}:${day}:global`;
  }

  #spentKey(campaignId: string): string {
    return `cost:${campaignId}:spent-micros`;
  }

  #serviceHourKey(campaignId: string, hour: string): string {
    return `cost:${campaignId}:${hour}:service`;
  }

  #getCount(key: string): number {
    return this.#store.get<number>(QUOTA_NS, key) ?? 0;
  }

  #getMicros(key: string): bigint {
    return BigInt(this.#store.get<string>(QUOTA_NS, key) ?? "0");
  }

  #spent(campaignId: string): bigint {
    return this.#getMicros(this.#spentKey(campaignId));
  }

  #budgetSpent(campaign: SponsoredCampaign): boolean {
    return campaign.providerCostBudgetMicros > 0n && this.#spent(campaign.campaignId) >= campaign.providerCostBudgetMicros;
  }

  /**
   * Marks a reservation closed and frees its cost hold. Returns false when the reservation was
   * already closed, so settle/release each apply exactly once. Shared: settle and release must
   * free the hold identically, or the survivors drift.
   */
  #closeReservation(reservation: SponsorReservation): boolean {
    if (this.#closed.has(reservation)) return false;
    this.#closed.add(reservation);
    const held = this.#inFlight.get(reservation.campaignId) ?? 0n;
    const freed = held >= reservation.costMicros ? reservation.costMicros : held;
    if (held - freed > 0n) this.#inFlight.set(reservation.campaignId, held - freed);
    else this.#inFlight.delete(reservation.campaignId);
    return true;
  }

  #deny(
    campaign: SponsoredCampaign,
    endpoint: string,
    reason: QuotaDenialReason,
    nowMs: number,
  ): SponsoredQuotaDecision {
    const trialOnly = campaign.trialOnlyEndpoints.includes(endpoint);
    const budgetLike = reason === "sponsor-budget-exhausted" || reason === "service-velocity-exceeded";
    let retryAfterSeconds: number | undefined;
    if (reason === "caller-quota-exhausted" || reason === "global-quota-exhausted") {
      retryAfterSeconds = secondsToNextUtcMidnight(nowMs);
    } else if (reason === "service-velocity-exceeded") {
      retryAfterSeconds = secondsToNextUtcHour(nowMs);
    }
    return {
      sponsored: false,
      campaignId: campaign.campaignId,
      reason,
      fallback: trialOnly ? "reject" : "paid",
      rejectStatus: budgetLike ? 503 : 429,
      retryAfterSeconds,
      disclosure: campaign.sponsorDisclosure,
    };
  }

  #decide(request: ReserveSponsoredCall, consume: boolean): SponsoredQuotaDecision {
    const campaign = this.#require(request.campaignId);
    const nowMs = this.#now();
    const nowSec = Math.floor(nowMs / 1000);
    const day = utcDay(nowMs);
    const hour = utcHour(nowMs);
    const callerKey = request.callerId.toLowerCase();

    if (campaign.status === "PAUSED" || campaign.status === "PAUSED_BUDGET_EXHAUSTED") {
      const reason: QuotaDenialReason =
        campaign.status === "PAUSED_BUDGET_EXHAUSTED" ? "sponsor-budget-exhausted" : "campaign-paused";
      return this.#deny(campaign, request.endpoint, reason, nowMs);
    }
    if (campaign.startsAtSec !== 0 && nowSec < campaign.startsAtSec) {
      return this.#deny(campaign, request.endpoint, "campaign-not-started", nowMs);
    }
    if (campaign.expiresAtSec !== 0 && nowSec > campaign.expiresAtSec) {
      if (consume) this.#latch(campaign, "EXPIRED");
      return this.#deny(campaign, request.endpoint, "campaign-expired", nowMs);
    }
    if (campaign.allowedCallers !== undefined && !campaign.allowedCallers.includes(callerKey)) {
      return this.#deny(campaign, request.endpoint, "caller-ineligible", nowMs);
    }
    if (campaign.maxTokensPerRequest > 0 && request.estimatedTokens > campaign.maxTokensPerRequest) {
      return this.#deny(campaign, request.endpoint, "tokens-per-request-exceeded", nowMs);
    }
    const callerCountKey = this.#callerKey(campaign.campaignId, day, callerKey);
    const globalCountKey = this.#globalKey(campaign.campaignId, day);
    const usedByCaller = this.#getCount(callerCountKey);
    const usedGlobal = this.#getCount(globalCountKey);
    if (usedByCaller >= campaign.maxCallsPerWallet) {
      return this.#deny(campaign, request.endpoint, "caller-quota-exhausted", nowMs);
    }
    if (usedGlobal >= campaign.maxCallsGlobalPerDay) {
      return this.#deny(campaign, request.endpoint, "global-quota-exhausted", nowMs);
    }
    const costMicros = request.estimatedCostMicros ?? campaign.estimatedCostMicrosPerCall;
    if (costMicros < 0n) throw new Error("Sponsored reservation refused: estimatedCostMicros must not be negative");
    const hourKey = this.#serviceHourKey(campaign.campaignId, hour);
    if (
      campaign.serviceHourlyCostMicros > 0n &&
      this.#getMicros(hourKey) + costMicros > campaign.serviceHourlyCostMicros
    ) {
      return this.#deny(campaign, request.endpoint, "service-velocity-exceeded", nowMs);
    }
    if (
      campaign.providerCostBudgetMicros > 0n &&
      this.#spent(campaign.campaignId) + (this.#inFlight.get(campaign.campaignId) ?? 0n) + costMicros >
        campaign.providerCostBudgetMicros
    ) {
      if (consume) this.#latch(campaign, "PAUSED_BUDGET_EXHAUSTED");
      return this.#deny(campaign, request.endpoint, "sponsor-budget-exhausted", nowMs);
    }

    const remainingBudget =
      campaign.providerCostBudgetMicros > 0n
        ? campaign.providerCostBudgetMicros -
          this.#spent(campaign.campaignId) -
          (this.#inFlight.get(campaign.campaignId) ?? 0n) -
          costMicros
        : undefined;
    if (consume) {
      this.#store.set(QUOTA_NS, callerCountKey, usedByCaller + 1);
      this.#store.set(QUOTA_NS, globalCountKey, usedGlobal + 1);
      this.#store.set(QUOTA_NS, hourKey, (this.#getMicros(hourKey) + costMicros).toString());
      if (costMicros > 0n) {
        this.#inFlight.set(
          campaign.campaignId,
          (this.#inFlight.get(campaign.campaignId) ?? 0n) + costMicros,
        );
      }
    }
    return {
      sponsored: true,
      campaignId: campaign.campaignId,
      reservation: { campaignId: campaign.campaignId, day, hour, callerKey, costMicros },
      remainingCallerQuota: Math.max(0, campaign.maxCallsPerWallet - usedByCaller - (consume ? 1 : 0)),
      remainingGlobalQuota: Math.max(0, campaign.maxCallsGlobalPerDay - usedGlobal - (consume ? 1 : 0)),
      remainingBudgetMicros: remainingBudget,
      disclosure: campaign.sponsorDisclosure,
    };
  }
}

// ---- provider circuit-breaker signatures --------------------------------------------------------
// Pause/resume requests are authorized by the campaign provider's key, not by a server login, so
// any self-hosted quota engine enforces the same control. The message is EIP-191 personal-signed
// ("Signed by the provider" is checkable with secp256k1 recovery alone) and carries a short
// deadline so a captured control cannot be replayed later.

export type CampaignControlAction = "pause" | "resume";

export interface SignedCampaignControl {
  providerId: string;
  campaignId: string;
  action: CampaignControlAction;
  deadline: number;
  signature: string;
}

const CONTROL_PREFIX = "16ane campaign control";

export function campaignControlMessage(control: {
  providerId: string;
  campaignId: string;
  action: CampaignControlAction;
  deadline: number;
}): string {
  return (
    `${CONTROL_PREFIX}\nprovider: ${control.providerId.toLowerCase()}\n` +
    `campaign: ${control.campaignId}\naction: ${control.action}\ndeadline: ${control.deadline}`
  );
}

export function hashCampaignControlMessage(message: string): string {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix);
  joined.set(body, prefix.length);
  return keccak256(joined);
}

export function signCampaignControl(
  providerKey: string | SecretKey,
  control: { campaignId: string; action: CampaignControlAction; deadline: number },
): SignedCampaignControl {
  // The address is derived from the key, never taken from caller input.
  const providerId = toChecksumAddress(privateKeyToAddress(providerKey));
  const message = campaignControlMessage({ providerId, ...control });
  return {
    providerId,
    campaignId: control.campaignId,
    action: control.action,
    deadline: control.deadline,
    signature: signDigest(hashCampaignControlMessage(message), providerKey).serialized,
  };
}

export function verifyCampaignControl(
  control: SignedCampaignControl,
  expectedProviderId: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): { valid: boolean; reason?: string } {
  if (control.action !== "pause" && control.action !== "resume") {
    return { valid: false, reason: "action must be pause or resume" };
  }
  if (!Number.isSafeInteger(control.deadline) || control.deadline <= nowSec || control.deadline > nowSec + 3600) {
    return { valid: false, reason: "deadline must be within the next hour" };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(control.providerId)) {
    return { valid: false, reason: "providerId must be an address" };
  }
  let signer: string;
  try {
    signer = recoverAddress(hashCampaignControlMessage(campaignControlMessage(control)), control.signature);
  } catch {
    return { valid: false, reason: "the signature is invalid" };
  }
  if (signer.toLowerCase() !== control.providerId.toLowerCase()) {
    return { valid: false, reason: "not signed by the providerId" };
  }
  if (signer.toLowerCase() !== expectedProviderId.toLowerCase()) {
    return { valid: false, reason: "not signed by this campaign's provider" };
  }
  return { valid: true };
}
