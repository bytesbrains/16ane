import test from "node:test";
import assert from "node:assert/strict";
import { createSandboxServer } from "../../services/sandbox-server/src/server.ts";
import { DEPLOYER_KEY, ONE_TANE, PROVIDER_KEY, setupFundedSession, startSandboxStack } from "../harness.ts";

// Provider-funded sponsored compute is capped per caller and in aggregate: with a global
// daily cap of 1, the second trial call — caller quota still open — falls back to paid.
// (REQ-014, REQ-103. No per-service cap exists yet; see TRACEABILITY.)
test("the global trial cap binds even when caller quota is open (REQ-014, REQ-103)", async (t) => {
  const stack = await startSandboxStack(t);
  await setupFundedSession(stack);
  const { rpcUrl, registryAddress, client, vaultAddress, session } = stack;
  const server = await createSandboxServer({
    rpcUrl,
    chainId: 84532,
    registryAddress,
    relayerPrivateKey: DEPLOYER_KEY,
    providerPrivateKey: PROVIDER_KEY,
    trialFreeCallsPerCaller: 10,
    trialGlobalDailyCap: 1,
  });
  t.after(() => server.close());

  await t.test("the first trial call is sponsored and discloses the sponsorship", async () => {
    const trialRes = await session.purchase<{
      sponsored: boolean;
      sponsorDisclosure: string;
      trialQuotaRemaining: number;
    }>(`${server.url}/v1/demo/summarize`, {
      method: "POST",
      headers: { "x-trial-request": "true" },
      body: JSON.stringify({ text: "first sponsored call" }),
    });
    assert.equal(trialRes.status, 200);
    assert.equal(trialRes.trialSponsored, true);
    assert.match(trialRes.data.sponsorDisclosure, /capped at 10 call\(s\)\/caller and 1 calls\/day/);
    assert.equal((await client.getAccountingSummary(vaultAddress)).cumulativeSpent, 0n);
  });

  await t.test("the second trial call hits the global cap and pays 16 tANE", async () => {
    const paidRes = await session.purchase<{ sponsored: boolean; paidAmount: string }>(
      `${server.url}/v1/demo/summarize`,
      {
        method: "POST",
        headers: { "x-trial-request": "true" },
        body: JSON.stringify({ text: "second call, global cap spent" }),
      },
    );
    assert.equal(paidRes.status, 200);
    assert.equal(paidRes.trialSponsored, false);
    assert.equal(paidRes.data.paidAmount, (16n * ONE_TANE).toString());
    assert.equal((await client.getAccountingSummary(vaultAddress)).cumulativeSpent, 16n * ONE_TANE);
  });
});
