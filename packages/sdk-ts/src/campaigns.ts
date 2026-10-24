// Provider-sponsored trial campaigns and the real-compute quota engine (ISS-016, ADR-0008,
// REQ-014, REQ-103). A campaign lets a provider sponsor trial calls priced in tANE while bounding
// its real compute exposure with independent per-caller, per-service and aggregate cost caps.
//
// Limits principle (#61): quotas bind only the provider's sponsored cost. They never throttle a
// paid call and never count paid usage — the engine is consulted only on the sponsored-trial path,
// before any upstream compute is spent. When a quota binds, the call falls back to the endpoint's
// normal paid 402 quote, unless the provider explicitly marked that endpoint trial-only, in which
// case the engine says "reject" (429 for quota, 503 for sponsor budget).
import {
  type CampaignDto,
  type CampaignStatus,
  fromDto,
  normalizeCampaign,
  type SponsoredCampaign,
  type SponsoredCampaignInput,
  toDto,
} from "./campaign-definition.ts";
import { type KeyValueStore, MemoryKeyValueStore } from "./store.ts";

export * from "./campaign-control.ts";
export {
  type CampaignStatus,
  normalizeCampaign,
  type SponsoredCampaign,
  type SponsoredCampaignInput,
} from "./campaign-definition.ts";

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
