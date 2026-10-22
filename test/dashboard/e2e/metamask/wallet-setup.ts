// Synpress wallet setup for the dashboard Tier-2 spec: imports the stack owner
// key (a local-test secret from e2e/harness.ts, handed over through the stack
// file — never a real account) into a real MetaMask. Synpress caches this
// setup by function hash; the key is constant and the per-run Anvil RPC is
// added inside the tests, so the cache stays valid across runs.
import { defineWalletSetup } from "@synthetixio/synpress";
import { MetaMask } from "@synthetixio/synpress/playwright";
import type { BrowserContext, Page } from "@playwright/test";
import { readTier2Stack } from "./stack.js";

const PASSWORD = "16ane-tier2-local-test";

export const tier2WalletSetup = defineWalletSetup(PASSWORD, async (context, walletPage) => {
  const { ownerKey } = readTier2Stack();
  // Synpress nests playwright-core 1.48.2 while the repo runs 1.64.1: the same
  // runtime objects under a dual type identity. Cast once at this boundary.
  const metamask = new MetaMask(
    context as unknown as BrowserContext,
    walletPage as unknown as Page,
    PASSWORD,
  );
  await metamask.importWalletFromPrivateKey(ownerKey.replace(/^0x/, ""));
});
