import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokensFromText,
  keccak256Utf8,
  MemoryKeyValueStore,
  privateKeyToAddress,
  SecretKey,
  signCampaignControl,
  SponsoredQuotaEngine,
  verifyCampaignControl,
  type SponsoredCampaignInput,
} from "../src/index.ts";

const PROVIDER_KEY = keccak256Utf8("16ane.test.campaigns.provider.v1");
const OTHER_KEY = keccak256Utf8("16ane.test.campaigns.other.v1");
const PROVIDER = privateKeyToAddress(new SecretKey(PROVIDER_KEY));
const OTHER = privateKeyToAddress(new SecretKey(OTHER_KEY));

const base = (over: Partial<SponsoredCampaignInput> = {}): SponsoredCampaignInput => ({
  campaignId: "test-campaign",
  providerId: PROVIDER,
  serviceId: "test-service",
  endpoints: ["/v1/demo/summarize"],
  testTokenPrices: { "/v1/demo/summarize": (16n * 10n ** 18n).toString() },
  maxCallsPerWallet: 5,
  maxCallsGlobalPerDay: 100,
  sponsorDisclosure: "Test sponsorship (0 tANE charged)",
  ...over,
});

const at = (iso: string) => {
  let now = Date.parse(iso);
  const engine = new SponsoredQuotaEngine(new MemoryKeyValueStore(), () => now);
  return { engine, advance: (ms: number) => (now += ms) };
};

const reserve = (
  engine: SponsoredQuotaEngine,
  callerId = "127.0.0.1",
  over: Partial<{ endpoint: string; estimatedTokens: number; estimatedCostMicros: bigint }> = {},
) =>
  engine.checkAndReserve({
    campaignId: "test-campaign",
    callerId,
    endpoint: "/v1/demo/summarize",
    estimatedTokens: 10,
    ...over,
  });

test("invalid campaigns are refused with a reason, not stored", () => {
  const { engine } = at("2026-10-20T10:00:00Z");
  for (const [name, input] of Object.entries({
    "empty id": base({ campaignId: "" }),
    "bad provider": base({ providerId: "0x123" }),
    "no endpoints": base({ endpoints: [] }),
    "bad price": base({ testTokenPrices: { "/v1/demo/summarize": "sixteen" } }),
    "negative calls": base({ maxCallsPerWallet: -1 }),
    "negative budget": base({ providerCostBudgetMicros: -1n }),
    "inverted window": base({ startsAtSec: 200, expiresAtSec: 100 }),
    "trial-only non-endpoint": base({ trialOnlyEndpoints: ["/v1/demo/other"] }),
  })) {
    assert.throws(() => engine.upsertCampaign(input), /Sponsored campaign refused/, name);
  }
  assert.deepEqual(engine.listCampaigns(), []);
});

test("per-caller quota: 5 sponsored calls, then paid fallback (never a rejection)", () => {
  const { engine } = at("2026-10-20T10:00:00Z");
  engine.upsertCampaign(base());
  for (let n = 4; n >= 0; n--) {
    const d = reserve(engine);
    assert.equal(d.sponsored, true);
    assert.equal(d.sponsored && d.remainingCallerQuota, n);
  }
  const denied = reserve(engine);
  assert.equal(denied.sponsored, false);
  assert.equal(denied.sponsored === false && denied.reason, "caller-quota-exhausted");
  assert.equal(denied.sponsored === false && denied.fallback, "paid");
  // Another caller is unaffected by the first caller's quota.
  assert.equal(reserve(engine, "10.0.0.2").sponsored, true);
});

test("the global daily cap binds even when caller quota is open", () => {
  const { engine } = at("2026-10-20T10:00:00Z");
  engine.upsertCampaign(base({ maxCallsPerWallet: 10, maxCallsGlobalPerDay: 2 }));
  assert.equal(reserve(engine, "10.0.0.1").sponsored, true);
  assert.equal(reserve(engine, "10.0.0.2").sponsored, true);
  const denied = reserve(engine, "10.0.0.3");
  assert.equal(denied.sponsored, false);
  assert.equal(denied.sponsored === false && denied.reason, "global-quota-exhausted");
  assert.equal(denied.sponsored === false && denied.fallback, "paid");
});

test("racing reservations cannot overspend the sponsor budget", () => {
  const { engine } = at("2026-10-20T10:00:00Z");
  engine.upsertCampaign(base({ providerCostBudgetMicros: 200n, estimatedCostMicrosPerCall: 100n }));
  // Five concurrent requests, budget for two: each reserves synchronously, so exactly two pass.
  const decisions = [1, 2, 3, 4, 5].map((n) => reserve(engine, `10.0.0.${n}`));
  assert.equal(decisions.filter((d) => d.sponsored).length, 2);
  const denied = decisions.find((d) => !d.sponsored)!;
  assert.equal(denied.sponsored === false && denied.reason, "sponsor-budget-exhausted");
  assert.equal(engine.getCampaign("test-campaign")!.status, "PAUSED_BUDGET_EXHAUSTED");
  assert.equal(engine.getUsage("test-campaign").inFlightCostMicros, 200n);
});

test("settle swaps the hold for actual cost; release refunds counts and frees the hold", () => {
  const { engine } = at("2026-10-20T10:00:00Z");
  engine.upsertCampaign(base({ providerCostBudgetMicros: 1000n, estimatedCostMicrosPerCall: 100n }));
  const first = reserve(engine);
  assert.equal(first.sponsored, true);
  if (first.sponsored) engine.settle(first.reservation, 60n); // upstream came back cheaper
  assert.equal(engine.getUsage("test-campaign").spentCostMicros, 60n);
  assert.equal(engine.getUsage("test-campaign").inFlightCostMicros, 0n);
  assert.equal(engine.remainingForCaller("test-campaign", "127.0.0.1"), 4);

  const second = reserve(engine);
  assert.equal(second.sponsored, true);
  if (second.sponsored) engine.release(second.reservation); // delivery never happened
  assert.equal(engine.getUsage("test-campaign").spentCostMicros, 60n);
  assert.equal(engine.remainingForCaller("test-campaign", "127.0.0.1"), 4, "the call count is handed back");
});

test("settle and release each apply once: repeats are ignored, never double-counted", () => {
  const { engine } = at("2026-10-20T10:00:00Z");
  engine.upsertCampaign(base({ providerCostBudgetMicros: 1000n, estimatedCostMicrosPerCall: 100n }));
  const d = reserve(engine);
  assert.equal(d.sponsored, true);
  if (!d.sponsored) return;
  engine.settle(d.reservation, 100n);
  engine.settle(d.reservation, 100n);
  engine.release(d.reservation);
  assert.equal(engine.getUsage("test-campaign").spentCostMicros, 100n);
  assert.equal(engine.remainingForCaller("test-campaign", "127.0.0.1"), 4);

  const e = reserve(engine, "10.0.0.9");
  assert.equal(e.sponsored, true);
  if (!e.sponsored) return;
  engine.release(e.reservation);
  engine.release(e.reservation);
  engine.settle(e.reservation, 100n);
  assert.equal(engine.getUsage("test-campaign").spentCostMicros, 100n, "release then settle spends nothing");
  assert.equal(engine.remainingForCaller("test-campaign", "10.0.0.9"), 5);
});

test("the per-service hourly velocity cap binds on cost, then reopens next hour", () => {
  const { engine, advance } = at("2026-10-20T10:30:00Z");
  engine.upsertCampaign(
    base({ serviceHourlyCostMicros: 150n, estimatedCostMicrosPerCall: 100n, maxCallsGlobalPerDay: 1000 }),
  );
  assert.equal(reserve(engine).sponsored, true);
  const denied = reserve(engine, "10.0.0.2");
  assert.equal(denied.sponsored, false);
  assert.equal(denied.sponsored === false && denied.reason, "service-velocity-exceeded");
  assert.equal(denied.sponsored === false && denied.rejectStatus, 503);
  advance(31 * 60 * 1000); // into the next UTC hour
  assert.equal(reserve(engine, "10.0.0.2").sponsored, true);
});

test("requests over maxTokensPerRequest are not sponsored", () => {
  const { engine } = at("2026-10-20T10:00:00Z");
  engine.upsertCampaign(base({ maxTokensPerRequest: 100 }));
  assert.equal(reserve(engine, "127.0.0.1", { estimatedTokens: 100 }).sponsored, true);
  const denied = reserve(engine, "127.0.0.1", { estimatedTokens: 101 });
  assert.equal(denied.sponsored, false);
  assert.equal(denied.sponsored === false && denied.reason, "tokens-per-request-exceeded");
  assert.equal(denied.sponsored === false && denied.fallback, "paid");
});

test("estimates count ~4 characters per token", () => {
  assert.equal(estimateTokensFromText(""), 0);
  assert.equal(estimateTokensFromText("hi"), 1);
  assert.equal(estimateTokensFromText("abcd"), 1);
  assert.equal(estimateTokensFromText("abcde"), 2);
});

test("the campaign window gates sponsorship, and expiry latches the status", () => {
  const { engine, advance } = at("2026-10-20T10:00:00Z");
  const nowSec = Math.floor(Date.parse("2026-10-20T10:00:00Z") / 1000);
  engine.upsertCampaign(base({ startsAtSec: nowSec + 60, expiresAtSec: nowSec + 3600 }));
  const early = reserve(engine);
  assert.equal(early.sponsored, false);
  assert.equal(early.sponsored === false && early.reason, "campaign-not-started");
  advance(61 * 1000);
  assert.equal(reserve(engine).sponsored, true);
  advance(3600 * 1000);
  const late = reserve(engine);
  assert.equal(late.sponsored, false);
  assert.equal(late.sponsored === false && late.reason, "campaign-expired");
  assert.equal(engine.getCampaign("test-campaign")!.status, "EXPIRED");
});

test("an allowlisted campaign sponsors only its eligible callers", () => {
  const { engine } = at("2026-10-20T10:00:00Z");
  engine.upsertCampaign(base({ eligibility: "allowlisted wallets", allowedCallers: ["10.0.0.7"] }));
  assert.equal(reserve(engine, "10.0.0.7").sponsored, true);
  const denied = reserve(engine, "10.0.0.8");
  assert.equal(denied.sponsored, false);
  assert.equal(denied.sponsored === false && denied.reason, "caller-ineligible");
});

test("trial-only endpoints reject with 429/503 instead of falling back to paid", () => {
  const { engine } = at("2026-10-20T10:00:00Z");
  engine.upsertCampaign(base({ campaignId: "quota-only", maxCallsPerWallet: 1, trialOnlyEndpoints: ["/v1/demo/summarize"] }));
  engine.upsertCampaign(
    base({
      campaignId: "budget-only",
      maxCallsPerWallet: 100,
      maxCallsGlobalPerDay: 1000,
      trialOnlyEndpoints: ["/v1/demo/summarize"],
      providerCostBudgetMicros: 100n,
      estimatedCostMicrosPerCall: 100n,
    }),
  );
  const ask = (campaignId: string, callerId: string) =>
    engine.checkAndReserve({ campaignId, callerId, endpoint: "/v1/demo/summarize", estimatedTokens: 1 });

  assert.equal(ask("quota-only", "127.0.0.1").sponsored, true);
  const quota = ask("quota-only", "127.0.0.1");
  assert.equal(quota.sponsored, false);
  assert.equal(quota.sponsored === false && quota.reason, "caller-quota-exhausted");
  assert.equal(quota.sponsored === false && quota.fallback, "reject");
  assert.equal(quota.sponsored === false && quota.rejectStatus, 429);
  const retryAfter = quota.sponsored === false ? quota.retryAfterSeconds : undefined;
  assert.ok((retryAfter ?? 0) > 0);

  const first = ask("budget-only", "127.0.0.1");
  assert.equal(first.sponsored, true);
  if (first.sponsored) engine.settle(first.reservation, 100n);
  const budget = ask("budget-only", "10.0.0.5"); // fresh caller, but the $0.0001 budget is gone
  assert.equal(budget.sponsored, false);
  assert.equal(budget.sponsored === false && budget.reason, "sponsor-budget-exhausted");
  assert.equal(budget.sponsored === false && budget.fallback, "reject");
  assert.equal(budget.sponsored === false && budget.rejectStatus, 503);
});

test("peek reports the decision without consuming quota", () => {
  const { engine } = at("2026-10-20T10:00:00Z");
  engine.upsertCampaign(base({ maxCallsPerWallet: 1 }));
  const seen = engine.peek({ campaignId: "test-campaign", callerId: "127.0.0.1", endpoint: "/v1/demo/summarize", estimatedTokens: 1 });
  assert.equal(seen.sponsored, true);
  assert.equal(seen.sponsored && seen.remainingCallerQuota, 1, "peek consumes nothing");
  assert.equal(reserve(engine).sponsored, true);
  assert.equal(
    engine.peek({ campaignId: "test-campaign", callerId: "127.0.0.1", endpoint: "/v1/demo/summarize", estimatedTokens: 1 }).sponsored,
    false,
  );
});

test("pause stops sponsorship now; resume restarts it; a restart never unpauses", () => {
  const store = new MemoryKeyValueStore();
  let now = Date.parse("2026-10-20T10:00:00Z");
  const engine = new SponsoredQuotaEngine(store, () => now);
  engine.seedCampaign(base());
  assert.equal(reserve(engine).sponsored, true);
  engine.pauseCampaign("test-campaign");
  const paused = reserve(engine, "10.0.0.2");
  assert.equal(paused.sponsored, false);
  assert.equal(paused.sponsored === false && paused.reason, "campaign-paused");
  assert.equal(paused.sponsored === false && paused.fallback, "paid");

  // A restart (same store, new engine) keeps the latch.
  const restarted = new SponsoredQuotaEngine(store, () => now);
  restarted.seedCampaign(base());
  assert.equal(restarted.getCampaign("test-campaign")!.status, "PAUSED");
  assert.equal(
    restarted.checkAndReserve({
      campaignId: "test-campaign",
      callerId: "10.0.0.3",
      endpoint: "/v1/demo/summarize",
      estimatedTokens: 1,
    }).sponsored,
    false,
  );
  const { resumed } = restarted.resumeCampaign("test-campaign");
  assert.equal(resumed, true);
  assert.equal(
    restarted.checkAndReserve({
      campaignId: "test-campaign",
      callerId: "10.0.0.3",
      endpoint: "/v1/demo/summarize",
      estimatedTokens: 1,
    }).sponsored,
    true,
  );
});

test("resume refuses while the budget is still spent or the window has passed", () => {
  const { engine, advance } = at("2026-10-20T10:00:00Z");
  const nowSec = Math.floor(Date.parse("2026-10-20T10:00:00Z") / 1000);
  engine.upsertCampaign(
    base({ providerCostBudgetMicros: 100n, estimatedCostMicrosPerCall: 100n, expiresAtSec: nowSec + 3600 }),
  );
  const d = reserve(engine);
  assert.equal(d.sponsored, true);
  if (d.sponsored) engine.settle(d.reservation, 100n);
  assert.equal(engine.getCampaign("test-campaign")!.status, "PAUSED_BUDGET_EXHAUSTED");
  const stuck = engine.resumeCampaign("test-campaign");
  assert.equal(stuck.resumed, false);
  assert.equal(stuck.reason, "sponsor-budget-exhausted");
  advance(3600 * 1000 + 1000);
  const expired = engine.resumeCampaign("test-campaign");
  assert.equal(expired.resumed, false);
  assert.equal(expired.reason, "campaign-expired");
});

test("a new UTC day restarts the call quotas; spent budget persists", () => {
  const { engine, advance } = at("2026-10-20T23:59:00Z");
  engine.upsertCampaign(base({ maxCallsPerWallet: 1, maxCallsGlobalPerDay: 1, providerCostBudgetMicros: 1000n, estimatedCostMicrosPerCall: 100n }));
  const d = reserve(engine);
  assert.equal(d.sponsored, true);
  if (d.sponsored) engine.settle(d.reservation, 100n);
  assert.equal(reserve(engine).sponsored, false);
  advance(2 * 60 * 1000);
  assert.equal(reserve(engine).sponsored, true, "call quotas reopen at 00:00 UTC");
  assert.equal(engine.getUsage("test-campaign").spentCostMicros, 100n, "budget spend is lifetime");
});

test("unknown campaigns fail closed", () => {
  const { engine } = at("2026-10-20T10:00:00Z");
  assert.throws(() => reserve(engine), /Unknown sponsored campaign/);
  assert.throws(() => engine.pauseCampaign("nope"), /Unknown sponsored campaign/);
  assert.equal(engine.campaignForEndpoint("/v1/demo/summarize"), undefined);
});

test("campaign control signatures: the provider pauses, no one else can", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const control = signCampaignControl(PROVIDER_KEY, {
    campaignId: "test-campaign",
    action: "pause",
    deadline: nowSec + 300,
  });
  assert.equal(control.providerId.toLowerCase(), PROVIDER.toLowerCase());
  assert.deepEqual(verifyCampaignControl(control, PROVIDER), { valid: true });

  // Another key's signature over the same campaign is refused.
  const forged = signCampaignControl(OTHER_KEY, { campaignId: "test-campaign", action: "pause", deadline: nowSec + 300 });
  assert.equal(verifyCampaignControl(forged, PROVIDER).valid, false);

  // Retargeting a signature at another campaign or action breaks it.
  assert.equal(verifyCampaignControl({ ...control, campaignId: "other" }, PROVIDER).valid, false);
  assert.equal(verifyCampaignControl({ ...control, action: "resume" }, PROVIDER).valid, false);

  // Stale or far-future deadlines are refused.
  assert.match(
    verifyCampaignControl({ ...control, deadline: nowSec - 1 }, PROVIDER).reason!,
    /deadline/,
  );
  assert.match(
    verifyCampaignControl({ ...control, deadline: nowSec + 7200 }, PROVIDER).reason!,
    /deadline/,
  );

  // A valid signature for another campaign's provider is refused here.
  assert.equal(verifyCampaignControl(control, OTHER).valid, false);
});
