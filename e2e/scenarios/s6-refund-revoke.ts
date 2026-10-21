import assert from "node:assert/strict";
import { ONE_TANE, type SandboxStack } from "../harness.ts";

/** S6: automatic refund on downstream failure, then emergency revoke + sweep (REQ-006, ADR-0009). */
export async function runS6(stack: SandboxStack): Promise<void> {
  const { sandbox, client, owner, vaultAddress, session } = stack;

  const summaryBeforeFail = await client.getAccountingSummary(vaultAddress);

  // 1. Call /v1/demo/simulate-failure -> settles 16 tANE, then automatically executes AneAgentVault.refundPayment
  const failRes = await session.purchase<{
    status: string;
    originalTxHash: string;
    refundTxHash: string;
    refundedAmount: string;
    paymentId: string;
  }>(`${sandbox.url}/v1/demo/simulate-failure`, {
    method: "POST",
    body: JSON.stringify({ task: "trigger deterministic downstream failure" }),
  });
  assert.equal(failRes.status, 502);
  assert.equal(failRes.data.status, "REFUNDED");
  assert.ok(failRes.data.originalTxHash.startsWith("0x"));
  assert.ok(failRes.data.refundTxHash.startsWith("0x"));
  assert.equal(failRes.data.refundedAmount, (16n * ONE_TANE).toString());

  const paymentRec = await client.getPaymentRecord(vaultAddress, failRes.data.paymentId);
  assert.equal(paymentRec.amountPaid, 16n * ONE_TANE);
  assert.equal(paymentRec.amountRefunded, 16n * ONE_TANE);

  const summaryAfterFail = await client.getAccountingSummary(vaultAddress);
  // Refund restores cumulativeSpent back to pre-failure level and returns tokenBalance!
  assert.equal(summaryAfterFail.cumulativeSpent, summaryBeforeFail.cumulativeSpent);
  assert.equal(summaryAfterFail.tokenBalance, summaryBeforeFail.tokenBalance);

  // 2. Owner executes emergency revokeAndSweep -> revokes session key and sweeps all remaining vault tokens
  const ownerBalBeforeSweep = await client.getTokenBalance(owner.address);
  await owner.revokeAndSweep(vaultAddress, session.sessionAddress, owner.address);

  const summaryAfterSweep = await client.getAccountingSummary(vaultAddress);
  assert.equal(summaryAfterSweep.tokenBalance, 0n);
  assert.equal(summaryAfterSweep.active, false);

  const ownerBalAfterSweep = await client.getTokenBalance(owner.address);
  assert.ok(ownerBalAfterSweep > ownerBalBeforeSweep);

  // 3. Subsequent purchase attempt by revoked session must fail
  await assert.rejects(
    () =>
      session.purchase(`${sandbox.url}/v1/demo/summarize`, {
        method: "POST",
        body: JSON.stringify({ text: "post-revocation spend attempt" }),
      }),
    /ANE-E-3001/,
  );
}
