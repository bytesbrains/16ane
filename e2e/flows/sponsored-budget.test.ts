import test from "node:test";
import assert from "node:assert/strict";
import {
  keccak256Utf8,
  privateKeyToAddress,
  SecretKey,
} from "../../packages/sdk-ts/src/index.ts";
import { createSandboxServer } from "../../services/sandbox-server/src/server.ts";
import { DEPLOYER_KEY, ONE_TANE, PROVIDER_KEY, setupFundedSession, startSandboxStack } from "../harness.ts";

// ISS-016 acceptance (REQ-014, REQ-103, S3, T8): quotas bind the provider's sponsored cost even for
// an agent holding 1,000,000 tANE. Past the quota the call is not sponsored — it falls back to the
// endpoint's normal paid quote and a paying agent is served at full speed. Rejection (429/503)
// applies only where the provider marked the endpoint trial-only, and then no tANE is settled.
test("sponsored campaigns cap trials for a rich agent, then fall back to paid (ISS-016)", async (t) => {
  const stack = await startSandboxStack(t);
  const { rpcUrl, registryAddress, client, contracts, owner, vaultAddress, session } = stack;

  // A faucet claim is 16,000 tANE; the deployer (token admin) mints the acceptance balance.
  const deployer = privateKeyToAddress(new SecretKey(DEPLOYER_KEY));
  await client.sendContractTx(new SecretKey(DEPLOYER_KEY), contracts.aneTestToken, "grantRole(bytes32,address)", [
    keccak256Utf8("MINTER_ROLE"),
    deployer,
  ]);
  await client.sendContractTx(new SecretKey(DEPLOYER_KEY), contracts.aneTestToken, "mint(address,uint256)", [
    owner.address,
    (1_000_000n * ONE_TANE).toString(),
  ]);
  await setupFundedSession(stack, { fund: 1_000_000n * ONE_TANE });
  assert.equal(await client.getTokenBalance(vaultAddress), 1_000_000n * ONE_TANE);

  const extraServer = (opts: Partial<Parameters<typeof createSandboxServer>[0]>) =>
    createSandboxServer({
      rpcUrl,
      chainId: 84532,
      registryAddress,
      relayerPrivateKey: DEPLOYER_KEY,
      providerPrivateKey: PROVIDER_KEY,
      ...opts,
    }).then((server) => {
      t.after(() => server.close());
      return server;
    });
  const spent = async () => (await client.getAccountingSummary(vaultAddress)).cumulativeSpent;

  await t.test("5 sponsored calls, then the 6th pays 16 tANE at full speed", async () => {
    const server = await extraServer({ trialFreeCallsPerCaller: 5, trialGlobalDailyCap: 1000 });
    const before = await spent();
    for (let n = 0; n < 5; n++) {
      const trial = await session.purchase<{ sponsored: boolean }>(`${server.url}/v1/demo/summarize`, {
        method: "POST",
        headers: { "x-trial-request": "true" },
        body: JSON.stringify({ text: `sponsored call ${n}` }),
      });
      assert.equal(trial.status, 200);
      assert.equal(trial.trialSponsored, true);
      assert.equal(trial.data.sponsored, true);
    }
    assert.equal(await spent(), before, "sponsored calls charge nothing");

    const paid = await session.purchase<{ sponsored: boolean; paidAmount: string }>(
      `${server.url}/v1/demo/summarize`,
      {
        method: "POST",
        headers: { "x-trial-request": "true" },
        body: JSON.stringify({ text: "quota spent, paying" }),
      },
    );
    assert.equal(paid.status, 200);
    assert.equal(paid.trialSponsored, false);
    assert.equal(paid.data.sponsored, false);
    assert.equal(paid.data.paidAmount, (16n * ONE_TANE).toString());
    assert.equal(await spent(), before + 16n * ONE_TANE);
  });

  await t.test("the $1.00 sponsor budget binds: 2 sponsored at $0.40, the 3rd pays", async () => {
    const server = await extraServer({
      trialFreeCallsPerCaller: 100,
      trialGlobalDailyCap: 1000,
      trialCostBudgetMicros: 1_000_000n,
      trialEstimatedCostMicrosPerCall: 400_000n,
    });
    const before = await spent();
    for (const text of ["first forty cents", "second forty cents"]) {
      const trial = await session.purchase(`${server.url}/v1/demo/summarize`, {
        method: "POST",
        headers: { "x-trial-request": "true" },
        body: JSON.stringify({ text }),
      });
      assert.equal(trial.status, 200);
      assert.equal(trial.trialSponsored, true);
    }
    const paid = await session.purchase<{ paidAmount: string }>(`${server.url}/v1/demo/summarize`, {
      method: "POST",
      headers: { "x-trial-request": "true" },
      body: JSON.stringify({ text: "budget spent, paying" }),
    });
    assert.equal(paid.status, 200);
    assert.equal(paid.trialSponsored, false);
    assert.equal(await spent(), before + 16n * ONE_TANE);

    const campaigns = (await (await fetch(`${server.url}/v1/campaigns`)).json()) as {
      campaigns: [{ effectiveStatus: string; spentCostMicros: string; remainingCostMicros: string }];
    };
    assert.equal(campaigns.campaigns[0].effectiveStatus, "PAUSED_BUDGET_EXHAUSTED");
    assert.equal(campaigns.campaigns[0].spentCostMicros, "800000");
    assert.equal(campaigns.campaigns[0].remainingCostMicros, "200000");
  });

  await t.test("trial-only: the spent quota rejects with 429 and settles no tANE", async () => {
    const server = await extraServer({
      trialFreeCallsPerCaller: 1,
      trialOnlyPaths: ["/v1/demo/summarize"],
    });
    const before = await spent();
    const first = await session.purchase(`${server.url}/v1/demo/summarize`, {
      method: "POST",
      headers: { "x-trial-request": "true" },
      body: JSON.stringify({ text: "the one free call" }),
    });
    assert.equal(first.status, 200);
    assert.equal(first.trialSponsored, true);

    const rejected = await fetch(`${server.url}/v1/demo/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-trial-request": "true" },
      body: JSON.stringify({ text: "quota spent" }),
    });
    assert.equal(rejected.status, 429);
    assert.equal(((await rejected.json()) as { error: { code: string } }).error.code, "ANE-E-1304");
    assert.equal(await spent(), before, "a rejected trial settles nothing");
  });

  await t.test("paid calls never consume the trial quota", async () => {
    const server = await extraServer({ trialFreeCallsPerCaller: 5, trialGlobalDailyCap: 1000 });
    // Two paid calls first, with no trial header: the quota must not notice them.
    for (const text of ["paid one", "paid two"]) {
      const paid = await session.purchase<{ sponsored: boolean }>(`${server.url}/v1/demo/summarize`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      assert.equal(paid.status, 200);
      assert.equal(paid.trialSponsored, false);
    }
    for (let n = 0; n < 5; n++) {
      const trial = await session.purchase(`${server.url}/v1/demo/summarize`, {
        method: "POST",
        headers: { "x-trial-request": "true" },
        body: JSON.stringify({ text: `trial ${n} after paid calls` }),
      });
      assert.equal(trial.status, 200);
      assert.equal(trial.trialSponsored, true, `trial ${n} is still sponsored after paid calls`);
    }
  });
});
