import assert from "node:assert/strict";
import { ONE_TANE, type SandboxStack } from "../harness.ts";

/** S4: sponsored trial quota exhaustion and paid fallback (REQ-013, ADR-0008, T9). */
export async function runS4(stack: SandboxStack): Promise<void> {
  const { sandbox, client, vaultAddress, session } = stack;

  // 1st call with x-trial-request: true -> 200 OK sponsored (0 tANE charged)
  const spentBeforeTrial = (await client.getAccountingSummary(vaultAddress)).cumulativeSpent;
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

  // 2nd call with x-trial-request: true -> quota exhausted, falls back to 402 and pays 16 tANE
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

  // Rotating the unauthenticated x-agent-vault header must not mint a fresh trial (#31)
  const spoofed = await fetch(`${sandbox.url}/v1/demo/summarize`, {
    method: "POST",
    headers: { "x-trial-request": "true", "x-agent-vault": `0x${"ab".repeat(20)}` },
    body: JSON.stringify({ text: "spoofed caller" }),
  });
  assert.equal(spoofed.status, 402);
}
