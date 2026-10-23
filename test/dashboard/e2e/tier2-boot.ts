// Tier-2 stack boot: shared by the runner (tier2-run.ts, which holds the stack
// in-process for the whole run) and the Playwright global setup (cold starts
// only). Boots the 31337 Anvil stack, settles one lookup-fixture payment
// through the SDK, and writes test-results/tier2-stack.json for the CJS specs
// under metamask/ — those cannot import the ESM harness without tripping the
// ESM/CJS loader split (see metamask/tier2.spec.ts).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { OWNER_MNEMONIC, setupFundedSession } from "../../../e2e/harness.ts";
import { startDashboardStack, type DashboardStack } from "./dashboard-stack.ts";

export function tier2StackFile(): string {
  return path.resolve("test-results", "tier2-stack.json");
}

export interface Tier2Boot {
  tier: DashboardStack;
  close: () => Promise<void>;
}

export async function bootTier2Stack(): Promise<Tier2Boot> {
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
  const file = tier2StackFile();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
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
        ownerMnemonic: OWNER_MNEMONIC,
        paymentId,
      },
      null,
      2,
    ),
  );
  return { tier, close: tier.close };
}

// True when a stack file exists and both its servers answer: the runner is
// holding the stack, so globalSetup must reuse it rather than boot a second
// one. Any response status counts — only reachability matters here.
export async function liveStackPresent(): Promise<boolean> {
  let parsed: { sandboxUrl?: unknown; dashboardUrl?: unknown };
  try {
    parsed = JSON.parse(readFileSync(tier2StackFile(), "utf8")) as {
      sandboxUrl?: unknown;
      dashboardUrl?: unknown;
    };
  } catch {
    return false;
  }
  if (typeof parsed.sandboxUrl !== "string" || typeof parsed.dashboardUrl !== "string") return false;
  try {
    for (const url of [parsed.sandboxUrl, parsed.dashboardUrl]) {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
    }
    return true;
  } catch {
    return false;
  }
}
