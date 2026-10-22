// Tier-2 global setup: runs once in the Playwright main process (ESM, so the
// harness imports work exactly as in Tier-1). Boots the 31337 Anvil stack,
// settles one lookup-fixture payment through the SDK, and writes
// test-results/tier2-stack.json for the CJS specs under metamask/ — those
// cannot import the ESM harness without tripping the ESM/CJS loader split
// (see metamask/tier2.spec.ts). The servers intentionally stay up: the sandbox
// and dashboard servers die with this process at run end, and the teardown
// kills Anvil by PID.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { OWNER_KEY, setupFundedSession } from "../../../e2e/harness.js";
import { startDashboardStack } from "./fixtures.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

export default async function globalSetup(): Promise<void> {
  const tier = await startDashboardStack({ chainId: 31337, chainName: "Local Anvil 31337" });
  // Settle one payment through the SDK so the lookup step has something real;
  // the wallet never touches this part.
  await setupFundedSession(tier.stack);
  const paid = await tier.stack.session.purchase<{ paidAmount: string }>(
    `${tier.stack.sandbox.url}/v1/demo/summarize`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "tier-2 lookup fixture" }),
      settleDirectOnChain: true,
    },
  );
  const paymentId = paid.receipt?.paymentId;
  if (!/^0x[0-9a-f]{64}$/.test(paymentId ?? "")) {
    throw new Error("tier2 setup: fixture payment did not settle");
  }
  const dir = path.join(ROOT, "test-results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "tier2-stack.json"),
    JSON.stringify(
      {
        rpcUrl: tier.stack.rpcUrl,
        chainId: tier.stack.chainId,
        anvilPid: tier.stack.anvilPid,
        registryAddress: tier.stack.registryAddress,
        contracts: tier.stack.contracts,
        sandboxUrl: tier.stack.sandbox.url,
        dashboardUrl: tier.url,
        owner: tier.owner,
        provider: tier.provider,
        ownerKey: OWNER_KEY,
        paymentId,
      },
      null,
      2,
    ),
  );
}
