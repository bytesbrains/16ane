// Tier-2 entry point (`npm run test:e2e:dashboard-tier2`): prepares the pinned
// MetaMask build (tier2-extension.ts), boots the 31337 stack IN THIS PROCESS —
// the sandbox and dashboard servers must stay up for the specs, and a
// Playwright globalSetup process exits and takes its servers down — then builds
// the Synpress wallet cache against the stack file and runs the MetaMask specs.
// Needs a headed browser (CI runs under xvfb).
//   node --experimental-strip-types test/dashboard/e2e/tier2-run.ts
import { execFileSync } from "node:child_process";
import path from "node:path";
import { bootTier2Stack } from "./tier2-boot.ts";
import { ensureExtension } from "./tier2-extension.ts";

// CLIs run on this Node binary by repo path, never resolved through PATH.
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const SYNPRESS_CLI = path.join(REPO_ROOT, "node_modules", "@synthetixio", "synpress", "dist", "cli.js");
const PLAYWRIGHT_CLI = path.join(REPO_ROOT, "node_modules", "@playwright", "test", "cli.js");

// Extension first (fails fast on network/version drift), then the stack.
await ensureExtension();
const tier = await bootTier2Stack();
let status = 0;
try {
  execFileSync(process.execPath, [SYNPRESS_CLI, "test/dashboard/e2e/metamask"], { stdio: "inherit", cwd: REPO_ROOT });
  // globalSetup finds the live stack and reuses it (see tier2-global-setup.ts).
  execFileSync(process.execPath, [PLAYWRIGHT_CLI, "test", "-c", "playwright.tier2.config.ts"], {
    stdio: "inherit",
    cwd: REPO_ROOT,
  });
} catch (err) {
  status = (err as { status?: unknown }).status === undefined ? 1 : Number((err as { status: unknown }).status);
} finally {
  await tier.close();
}
process.exit(status);
