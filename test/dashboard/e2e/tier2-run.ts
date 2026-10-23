// Tier-2 entry point (`npm run test:e2e:dashboard-tier2`): prepares the pinned
// MetaMask build (tier2-extension.ts), boots the 31337 stack IN THIS PROCESS —
// the sandbox and dashboard servers must stay up for the specs, and a
// Playwright globalSetup process exits and takes its servers down — then builds
// the Synpress wallet cache against the stack file and runs the MetaMask specs.
// Needs a headed browser (CI runs under xvfb).
//   node --experimental-strip-types test/dashboard/e2e/tier2-run.ts
import { execFileSync } from "node:child_process";
import { bootTier2Stack } from "./tier2-boot.ts";
import { ensurePatchedExtension } from "./tier2-extension.ts";

// Extension first (fails fast on network/version drift), then the stack.
await ensurePatchedExtension();
const tier = await bootTier2Stack();
let status = 0;
try {
  execFileSync("npx", ["synpress", "test/dashboard/e2e/metamask"], { stdio: "inherit" });
  // globalSetup finds the live stack and reuses it (see tier2-global-setup.ts).
  execFileSync("npx", ["playwright", "test", "-c", "playwright.tier2.config.ts"], { stdio: "inherit" });
} catch (err) {
  status = (err as { status?: unknown }).status === undefined ? 1 : Number((err as { status: unknown }).status);
} finally {
  await tier.close();
}
process.exit(status);
