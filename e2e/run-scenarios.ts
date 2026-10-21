import test from "node:test";
import { startSandboxStack } from "./harness.ts";
import { runS1 } from "./scenarios/s1-purchase.ts";
import { runS2 } from "./scenarios/s2-overspend.ts";
import { runS3 } from "./scenarios/s3-revenue.ts";
import { runS4 } from "./scenarios/s4-trial.ts";
import { runS5 } from "./scenarios/s5-direct-settlement.ts";
import { runS6 } from "./scenarios/s6-refund-revoke.ts";

// One shared Anvil + sandbox stack: S1–S6 build on each other's chain state (spent totals, policy, trial quota).
// Split under the 500-line guideline (#65); behaviour is unchanged.
test("16ane E2E Scenarios S1-S6, Threat Model T1-T10, Python SDK & CLI Verification", async (t) => {
  const stack = await startSandboxStack(t);

  await t.test("S1: Bounded Agent Sandbox Purchase, Faucet Cooldown & Idempotency (REQ-001..006, T5, T7)", async () => {
    await runS1(stack);
  });

  await t.test("S2: Malicious / Prompt-Injected Overspend, Replay & Spoofed Manifest Rejection (T1, T2, T6, T8)", async () => {
    await runS2(stack);
  });

  await t.test("S3: Agent Earns Revenue under FIXED vs REVOLVING Budget Mode (REQ-004, T4)", async () => {
    await runS3(stack);
  });

  await t.test("S4: Sponsored Trial Quota Exhaustion & Paid Fallback (REQ-013, ADR-0008, T9)", async () => {
    await runS4(stack);
  });

  await t.test("S5: Facilitator Outage / Direct On-Chain Settlement & CLI Receipt Verification (REQ-005)", async () => {
    await runS5(stack);
  });

  await t.test("S6: Automatic On-Chain Refund on Downstream Failure & Emergency Revoke + Sweep (REQ-006, ADR-0009)", async () => {
    await runS6(stack);
  });
});
