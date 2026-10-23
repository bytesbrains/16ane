// Synpress wallet setup for the dashboard Tier-2 spec: onboards a real MetaMask
// with the stack owner mnemonic (a local-test vector from e2e/harness.ts,
// handed over through the stack file — never a real account). The stack owner
// is account 0 of that mnemonic, so onboarding IS the import and no
// account-menu interaction is needed afterwards. The `.setup.ts` suffix is
// load-bearing: `synpress <dir>` only picks up `**/*.setup.{ts,js,mjs}`.
// Synpress caches this setup by function hash; the mnemonic is constant and
// the per-run Anvil RPC is added inside the tests, so the cache stays valid
// across runs.
//
// Hash-convergence note: Synpress hashes the setup function's SOURCE, and it
// loads this file twice through different transforms — tsup ESM for the cache
// build, babel CJS for the specs. Any imported binding referenced inside the
// function renders differently per transform (`readTier2Stack()` vs
// `(0, _stack.readTier2Stack)()`), which splits the hash and the specs never
// find the cache. So everything inside the function below resolves through
// `require` (identical text under both transforms; Synpress's bundle banner
// defines `require` for the ESM side) and reads the stack file inline instead
// of importing ./stack.js (which tsup bundles away from require's reach).
import { defineWalletSetup } from "@synthetixio/synpress";

const PASSWORD = "16ane-tier2-local-test";

declare const require: (id: string) => any;

export const tier2WalletSetup = defineWalletSetup(PASSWORD, async (context, walletPage) => {
  const { readFileSync } = require("node:fs");
  const path = require("node:path");
  const { MetaMask } = require("@synthetixio/synpress/playwright");
  let mnemonic: unknown;
  try {
    const parsed = JSON.parse(readFileSync(path.resolve("test-results", "tier2-stack.json"), "utf8"));
    mnemonic = parsed.ownerMnemonic;
  } catch {
    throw new Error("tier2 stack not booted: run via `npm run test:e2e:dashboard-tier2`");
  }
  if (typeof mnemonic !== "string" || !/^[a-z]+( [a-z]+){11}$/.test(mnemonic)) {
    throw new Error("tier2 stack file is corrupt: delete test-results/tier2-stack.json and re-run");
  }
  const metamask = new MetaMask(context, walletPage, PASSWORD);
  await metamask.importWallet(mnemonic);
  // 13.13.1 parks on a completion page after import; Synpress's importWallet
  // stops there, so continue to the wallet explicitly. Waiting for the home
  // page proves onboarding completed before the profile is snapshotted.
  await walletPage.getByTestId("onboarding-complete-done").click();
  await walletPage.locator('[data-testid="account-menu-icon"]').waitFor({ timeout: 30_000 });
});

// The spec imports the named setup; the cache builder requires a default export.
export default tier2WalletSetup;
