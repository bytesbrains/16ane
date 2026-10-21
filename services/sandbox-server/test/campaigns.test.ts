import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  functionSelector,
  keccak256Utf8,
  privateKeyToAddress,
  SecretKey,
  signCampaignControl,
} from "../../../packages/sdk-ts/src/index.ts";
import { DEFAULT_CAMPAIGN_ID } from "../src/campaigns.ts";
import { createSandboxServer, type SandboxServerConfig } from "../src/server.ts";

const word = (n: bigint | number | string) =>
  (typeof n === "string" ? n.replace(/^0x/, "") : BigInt(n).toString(16)).padStart(64, "0");
const TOKEN = "0x" + "11".repeat(20);
const FACTORY = "0x" + "22".repeat(20);
const FAUCET = "0x" + "33".repeat(20);
const DIRECTORY = "0x" + "44".repeat(20);
const PROVIDER_KEY = keccak256Utf8("16ane.test.server-campaigns.provider.v1");
const OTHER_KEY = keccak256Utf8("16ane.test.server-campaigns.other.v1");

// An RPC that knows the registry deployment and the faucet's views, and answers balance checks.
// The trial and campaign paths never settle on-chain, so this fake needs no send support.
async function fakeRpc() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method, params = [] } = JSON.parse(body) as {
        id: number;
        method: string;
        params?: [{ data: string; from?: string; to: string }];
      };
      let result = "0x";
      if (method === "eth_blockNumber") result = "0x10";
      else if (method === "eth_getBalance") result = "0x" + (10n ** 18n).toString(16);
      else if (method === "eth_call") {
        const data = params[0]?.data ?? "";
        if (data.startsWith(functionSelector("claimAmount()"))) result = "0x" + word(16_000n * 10n ** 18n);
        else if (data.startsWith(functionSelector("cooldownSeconds()"))) result = "0x" + word(3600);
        else result = "0x" + word(TOKEN) + word(FACTORY) + word(FAUCET) + word(DIRECTORY);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function withServer(
  t: test.TestContext,
  opts: Partial<SandboxServerConfig>,
  run: (base: string) => Promise<void>,
) {
  const rpc = await fakeRpc();
  const sandbox = await createSandboxServer({
    rpcUrl: rpc.url,
    registryAddress: "0x" + "ab".repeat(20),
    relayerPrivateKey: "0x" + "1".repeat(64),
    providerPrivateKey: PROVIDER_KEY,
    ...opts,
  });
  t.after(() => sandbox.close());
  t.after(() => rpc.close());
  await run(sandbox.url);
}

const trialCall = (base: string, text = "hello world") =>
  fetch(`${base}/v1/demo/summarize`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-trial-request": "true" },
    body: JSON.stringify({ text }),
  });

const trialAvailableOf = (res: Response): boolean => {
  const envelope = JSON.parse(Buffer.from(res.headers.get("payment-required")!, "base64").toString("utf8")) as {
    accepts: [{ extra: { trialAvailable: boolean } }];
  };
  return envelope.accepts[0].extra.trialAvailable;
};

const control = (base: string, campaignId: string, action: "pause" | "resume", key: string, deadline?: number) => {
  const signed = signCampaignControl(new SecretKey(key), {
    campaignId,
    action,
    deadline: deadline ?? Math.floor(Date.now() / 1000) + 300,
  });
  return fetch(`${base}/v1/campaigns/${campaignId}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deadline: signed.deadline, signature: signed.signature }),
  });
};

test("GET /v1/campaigns lists the demo campaign with its quotas, budget and live status", async (t) => {
  await withServer(t, { trialFreeCallsPerCaller: 3, trialGlobalDailyCap: 40 }, async (base) => {
    const res = await fetch(`${base}/v1/campaigns`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { campaigns: Record<string, unknown>[]; disclaimer: string };
    assert.equal(body.campaigns.length, 1);
    const [campaign] = body.campaigns;
    assert.equal(campaign.campaignId, DEFAULT_CAMPAIGN_ID);
    assert.equal(campaign.providerId, privateKeyToAddress(new SecretKey(PROVIDER_KEY)));
    assert.equal(campaign.serviceId, "16ane-sandbox-reference-demo");
    assert.deepEqual(campaign.endpoints, ["/v1/demo/summarize"]);
    assert.equal(campaign.maxCallsPerWallet, 3);
    assert.equal(campaign.maxCallsGlobalPerDay, 40);
    assert.equal(campaign.providerCostBudgetMicros, (20_000_000n).toString());
    assert.equal(campaign.spentCostMicros, "0");
    assert.equal(campaign.callsTodayGlobal, 0);
    assert.equal(campaign.status, "ACTIVE");
    assert.equal(campaign.effectiveStatus, "ACTIVE");
    assert.match(campaign.sponsorDisclosure as string, /capped at 3 call\(s\)\/caller and 40 calls\/day/);
    assert.match(campaign.sponsorDisclosure as string, new RegExp(privateKeyToAddress(new SecretKey(PROVIDER_KEY))));
    assert.match(body.disclaimer, /NO CASH VALUE/);
  });
});

test("the trial is sponsored once, then falls back to a paid 402 quote", async (t) => {
  await withServer(t, {}, async (base) => {
    const quoteBefore = await fetch(`${base}/v1/demo/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "no trial header" }),
    });
    assert.equal(quoteBefore.status, 402);
    assert.equal(trialAvailableOf(quoteBefore), true);

    const first = await trialCall(base);
    assert.equal(first.status, 200);
    const sponsored = (await first.json()) as {
      sponsored: boolean;
      campaignId: string;
      sponsorDisclosure: string;
      trialQuotaRemaining: number;
    };
    assert.equal(sponsored.sponsored, true);
    assert.equal(sponsored.campaignId, DEFAULT_CAMPAIGN_ID);
    assert.equal(sponsored.trialQuotaRemaining, 0);
    assert.equal(first.headers.get("x-trial-quota-remaining"), "0");
    assert.ok(first.headers.get("payment-response"));

    const second = await trialCall(base, "quota spent");
    assert.equal(second.status, 402, "exhausted quota falls back to the paid quote, never rejects");
    assert.match(second.headers.get("payment-required") ?? "", /.+/);
    assert.equal(trialAvailableOf(second), false);
    const quote = (await second.json()) as { error: { code: string } };
    assert.equal(quote.error.code, "ANE-E-4002");
  });
});

test("pause stops sponsorship now and resume restarts it; only the provider's key controls it", async (t) => {
  await withServer(t, {}, async (base) => {
    const paused = await control(base, DEFAULT_CAMPAIGN_ID, "pause", PROVIDER_KEY);
    assert.equal(paused.status, 200);
    assert.equal(((await paused.json()) as { status: string }).status, "PAUSED");

    const whilePaused = await trialCall(base);
    assert.equal(whilePaused.status, 402, "a paused campaign falls back to paid, like an exhausted one");

    const campaigns = (await (await fetch(`${base}/v1/campaigns`)).json()) as {
      campaigns: [{ status: string; effectiveStatus: string }];
    };
    assert.equal(campaigns.campaigns[0].effectiveStatus, "PAUSED");

    const resumed = await control(base, DEFAULT_CAMPAIGN_ID, "resume", PROVIDER_KEY);
    assert.equal(resumed.status, 200);
    assert.equal(((await resumed.json()) as { status: string }).status, "ACTIVE");
    assert.equal((await trialCall(base)).status, 200);

    const forged = await control(base, DEFAULT_CAMPAIGN_ID, "pause", OTHER_KEY);
    assert.equal(forged.status, 403);
    assert.equal(((await forged.json()) as { error: { code: string } }).error.code, "ANE-E-1302");

    const unknown = await control(base, "no-such-campaign", "pause", PROVIDER_KEY);
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as { error: { code: string } }).error.code, "ANE-E-1301");
  });
});

test("a campaign whose budget is spent cannot resume", async (t) => {
  await withServer(t, { trialCostBudgetMicros: 100n, trialEstimatedCostMicrosPerCall: 100n }, async (base) => {
    assert.equal((await trialCall(base)).status, 200);
    const campaigns = (await (await fetch(`${base}/v1/campaigns`)).json()) as {
      campaigns: [{ effectiveStatus: string; spentCostMicros: string; remainingCostMicros: string }];
    };
    assert.equal(campaigns.campaigns[0].effectiveStatus, "PAUSED_BUDGET_EXHAUSTED");
    assert.equal(campaigns.campaigns[0].spentCostMicros, "100");
    assert.equal(campaigns.campaigns[0].remainingCostMicros, "0");

    const resume = await control(base, DEFAULT_CAMPAIGN_ID, "resume", PROVIDER_KEY);
    assert.equal(resume.status, 409);
    assert.equal(((await resume.json()) as { error: { code: string } }).error.code, "ANE-E-1303");
  });
});

test("the sponsor budget binds: calls past it fall back to paid", async (t) => {
  await withServer(
    t,
    {
      trialFreeCallsPerCaller: 10,
      trialGlobalDailyCap: 100,
      trialCostBudgetMicros: 200n,
      trialEstimatedCostMicrosPerCall: 100n,
    },
    async (base) => {
      assert.equal((await trialCall(base, "first")).status, 200);
      assert.equal((await trialCall(base, "second")).status, 200);
      const third = await trialCall(base, "budget spent");
      assert.equal(third.status, 402, "the budget-exceeding call is not sponsored; it is quoted");

      const health = (await (await fetch(`${base}/healthz`)).json()) as {
        status: string;
        sponsored: { campaigns: [{ campaignId: string; status: string; spentCostMicros: string; remainingCostMicros: string; callsTodayGlobal: number }] };
      };
      assert.equal(health.status, "ok");
      const [campaign] = health.sponsored.campaigns;
      assert.equal(campaign.campaignId, DEFAULT_CAMPAIGN_ID);
      assert.equal(campaign.status, "PAUSED_BUDGET_EXHAUSTED");
      assert.equal(campaign.spentCostMicros, "200");
      assert.equal(campaign.remainingCostMicros, "0");
      assert.equal(campaign.callsTodayGlobal, 2);
    },
  );
});

test("trial-only endpoints reject with 429 once the quota is spent", async (t) => {
  await withServer(t, { trialOnlyPaths: ["/v1/demo/summarize"] }, async (base) => {
    assert.equal((await trialCall(base)).status, 200);
    const rejected = await trialCall(base, "quota spent");
    assert.equal(rejected.status, 429);
    const body = (await rejected.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "ANE-E-1304");
    assert.match(body.error.message, /trial-only/);
    assert.ok(Number(rejected.headers.get("retry-after")) > 0);
  });
});

test("trial-only endpoints reject with 503 once the sponsor budget is spent", async (t) => {
  await withServer(
    t,
    {
      trialFreeCallsPerCaller: 10,
      trialGlobalDailyCap: 100,
      trialCostBudgetMicros: 100n,
      trialEstimatedCostMicrosPerCall: 100n,
      trialOnlyPaths: ["/v1/demo/summarize"],
    },
    async (base) => {
      assert.equal((await trialCall(base)).status, 200);
      const rejected = await trialCall(base, "budget spent");
      assert.equal(rejected.status, 503);
      assert.equal(((await rejected.json()) as { error: { code: string } }).error.code, "ANE-E-1305");
    },
  );
});

test("requests over the per-request token ceiling are not sponsored", async (t) => {
  await withServer(t, { trialMaxTokensPerRequest: 10 }, async (base) => {
    const big = await trialCall(base, "this text is far longer than ten tokens when estimated at four characters each");
    assert.equal(big.status, 402, "oversized requests fall back to paid");
    const small = await trialCall(base, "tiny");
    assert.equal(small.status, 200);
    assert.equal(((await small.json()) as { sponsored: boolean }).sponsored, true);
  });
});
