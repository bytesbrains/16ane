// Sponsored-trial campaign wiring for the reference sandbox server (ISS-016, ADR-0008): the default
// deterministic-stub campaign, its public views, and the provider's pause/resume circuit breaker.
// The quota math lives in the SDK's SponsoredQuotaEngine so any self-hosted provider reuses it.
import type http from "node:http";
import {
  estimateTokensFromText,
  SANDBOX_DISCLAIMER,
  SponsoredQuotaEngine,
  verifyCampaignControl,
  type CampaignControlAction,
  type SponsoredCampaign,
  type SponsoredCampaignInput,
} from "../../../packages/sdk-ts/src/index.ts";
import { readRequestBody, sendError, sendJson } from "./http.ts";

/** The reference demo's sponsored campaign; kept stable so quota state survives upgrades. */
export const DEFAULT_CAMPAIGN_ID = "sandbox-trial-summarize-v1";

/** $20 of real compute, the ADR-0008 example ceiling. The stub spends none of it. */
export const DEFAULT_TRIAL_COST_BUDGET_MICROS = 20_000_000n;

export function buildDefaultCampaignInput(params: {
  providerAddress: string;
  freeCallsPerCaller: number;
  globalDailyCap: number;
  costBudgetMicros: bigint;
  estimatedCostMicrosPerCall: bigint;
  maxTokensPerRequest: number;
  trialOnlyEndpoints: string[];
}): SponsoredCampaignInput {
  return {
    campaignId: DEFAULT_CAMPAIGN_ID,
    providerId: params.providerAddress,
    serviceId: "16ane-sandbox-reference-demo",
    endpoints: ["/v1/demo/summarize"],
    testTokenPrices: { "/v1/demo/summarize": (16n * 10n ** 18n).toString() },
    maxCallsPerWallet: params.freeCallsPerCaller,
    maxCallsGlobalPerDay: params.globalDailyCap,
    maxTokensPerRequest: params.maxTokensPerRequest,
    providerCostBudgetMicros: params.costBudgetMicros,
    estimatedCostMicrosPerCall: params.estimatedCostMicrosPerCall,
    eligibility: "open",
    trialOnlyEndpoints: params.trialOnlyEndpoints.filter((p) => p === "/v1/demo/summarize"),
    // The disclosure states the configured quotas and who sponsors them (AGENTS.md).
    sponsorDisclosure:
      `Provider-sponsored sandbox trial (0 tANE charged; capped at ${params.freeCallsPerCaller} ` +
      `call(s)/caller and ${params.globalDailyCap} calls/day; sponsored by ${params.providerAddress})`,
  };
}

export function campaignPublicView(engine: SponsoredQuotaEngine, campaign: SponsoredCampaign): Record<string, unknown> {
  const usage = engine.getUsage(campaign.campaignId);
  return {
    campaignId: campaign.campaignId,
    providerId: campaign.providerId,
    serviceId: campaign.serviceId,
    endpoints: campaign.endpoints,
    testTokenPrices: campaign.testTokenPrices,
    maxCallsPerWallet: campaign.maxCallsPerWallet,
    maxCallsGlobalPerDay: campaign.maxCallsGlobalPerDay,
    maxTokensPerRequest: campaign.maxTokensPerRequest,
    providerCostBudgetMicros: campaign.providerCostBudgetMicros > 0n ? campaign.providerCostBudgetMicros.toString() : null,
    spentCostMicros: usage.spentCostMicros.toString(),
    remainingCostMicros: usage.remainingBudgetMicros === undefined ? null : usage.remainingBudgetMicros.toString(),
    callsTodayGlobal: usage.callsTodayGlobal,
    startsAt: campaign.startsAtSec,
    expiresAt: campaign.expiresAtSec,
    eligibility: campaign.eligibility,
    status: campaign.status,
    effectiveStatus: usage.effectiveStatus,
    trialOnlyEndpoints: campaign.trialOnlyEndpoints,
    sponsorDisclosure: campaign.sponsorDisclosure,
    ...(campaign.termsUrl === undefined ? {} : { termsUrl: campaign.termsUrl }),
    ...(campaign.refundPolicy === undefined ? {} : { refundPolicy: campaign.refundPolicy }),
  };
}

export function campaignHealthView(engine: SponsoredQuotaEngine, campaign: SponsoredCampaign): Record<string, unknown> {
  const usage = engine.getUsage(campaign.campaignId);
  return {
    campaignId: campaign.campaignId,
    status: usage.effectiveStatus,
    spentCostMicros: usage.spentCostMicros.toString(),
    remainingCostMicros: usage.remainingBudgetMicros === undefined ? null : usage.remainingBudgetMicros.toString(),
    callsTodayGlobal: usage.callsTodayGlobal,
  };
}

/** Token estimate for a demo request body: the summarize text when it parses, else the raw body. */
export function estimateDemoTokens(rawBody: string): number {
  if (!rawBody) return 0;
  try {
    const parsed = JSON.parse(rawBody) as { text?: unknown };
    if (typeof parsed.text === "string") return estimateTokensFromText(parsed.text);
  } catch {
    // Malformed JSON: the endpoint answers 400 without spending sponsorship; estimate the raw body.
  }
  return estimateTokensFromText(rawBody);
}

export async function handleCampaignControl(
  engine: SponsoredQuotaEngine,
  maxBodyBytes: number,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  campaignId: string,
  action: CampaignControlAction,
): Promise<void> {
  const campaign = engine.getCampaign(campaignId);
  if (!campaign) {
    sendError(res, 404, "ANE-E-1301", `Sponsored campaign ${campaignId} not found`, false);
    return;
  }
  const rawBody = await readRequestBody(req, maxBodyBytes);
  const body = JSON.parse(rawBody) as { deadline?: unknown; signature?: unknown };
  if (!Number.isInteger(body.deadline) || typeof body.signature !== "string") {
    sendError(res, 403, "ANE-E-1302", "Campaign control refused: body must carry deadline and signature", false);
    return;
  }
  const check = verifyCampaignControl(
    {
      providerId: campaign.providerId,
      campaignId: campaign.campaignId,
      action,
      deadline: body.deadline as number,
      signature: body.signature,
    },
    campaign.providerId,
  );
  if (!check.valid) {
    sendError(res, 403, "ANE-E-1302", `Campaign control refused: ${check.reason}`, false);
    return;
  }
  if (action === "pause") {
    const paused = engine.pauseCampaign(campaignId);
    sendJson(res, 200, {
      campaignId,
      action,
      status: paused.status,
      effectiveStatus: engine.effectiveStatus(paused),
      disclaimer: SANDBOX_DISCLAIMER,
    });
    return;
  }
  const { campaign: resumed, resumed: ok, reason } = engine.resumeCampaign(campaignId);
  if (!ok) {
    sendError(res, 409, "ANE-E-1303", `Campaign cannot resume while ${reason}`, false);
    return;
  }
  sendJson(res, 200, {
    campaignId,
    action,
    status: resumed.status,
    effectiveStatus: engine.effectiveStatus(resumed),
    disclaimer: SANDBOX_DISCLAIMER,
  });
}
