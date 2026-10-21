import test from "node:test";
import assert from "node:assert/strict";
import { ONE_TANE, setupFundedSession, startSandboxStack } from "../harness.ts";

// Sponsored trial quota: the first call is free, the second falls back to paid, and a
// rotated caller header mints no fresh trial (REQ-103, REQ-014, T8).
test("trial quota is spent once, then calls fall back to paid (REQ-103, REQ-014, T8)", async (t) => {
  const stack = await startSandboxStack(t);
  await setupFundedSession(stack);
  const { sandbox, client, vaultAddress, session } = stack;
  const spentBeforeTrial = (await client.getAccountingSummary(vaultAddress)).cumulativeSpent;

  await t.test("the first trial call is sponsored and charges nothing", async () => {
    const trialRes = await session.purchase<{
      sponsored: boolean;
      trialQuotaRemaining: number;
    }>(`${sandbox.url}/v1/demo/summarize`, {
      method: "POST",
      headers: { "x-trial-request": "true" },
      body: JSON.stringify({ text: "First free sponsored trial call" }),
    });
    assert.equal(trialRes.status, 200);
    assert.equal(trialRes.trialSponsored, true);
    assert.equal(trialRes.data.sponsored, true);
    assert.equal(trialRes.data.trialQuotaRemaining, 0);

    const spentAfterTrial = (await client.getAccountingSummary(vaultAddress)).cumulativeSpent;
    assert.equal(spentAfterTrial, spentBeforeTrial);
  });

  await t.test("the exhausted quota falls back to a paid 16 tANE call", async () => {
    const paidFallbackRes = await session.purchase<{
      sponsored: boolean;
      paidAmount: string;
    }>(`${sandbox.url}/v1/demo/summarize`, {
      method: "POST",
      headers: { "x-trial-request": "true" },
      body: JSON.stringify({ text: "Second call after trial quota exhausted" }),
    });
    assert.equal(paidFallbackRes.status, 200);
    assert.equal(paidFallbackRes.trialSponsored, false);
    assert.equal(paidFallbackRes.data.sponsored, false);
    assert.equal(paidFallbackRes.data.paidAmount, (16n * ONE_TANE).toString());

    const spentAfterFallback = (await client.getAccountingSummary(vaultAddress)).cumulativeSpent;
    assert.equal(spentAfterFallback, spentBeforeTrial + 16n * ONE_TANE);
  });

  await t.test("rotating the unauthenticated caller header mints no fresh trial (#31)", async () => {
    const spoofed = await fetch(`${sandbox.url}/v1/demo/summarize`, {
      method: "POST",
      headers: { "x-trial-request": "true", "x-agent-vault": `0x${"ab".repeat(20)}` },
      body: JSON.stringify({ text: "spoofed caller" }),
    });
    assert.equal(spoofed.status, 402);
  });
});
