// Tier-2 wallet fixture: restores the Synpress-built wallet cache into a
// throwaway profile, launches it OFFLINE except for localhost, and unlocks it.
// Replaces Synpress's metaMaskFixtures, which cannot take browser args:
// online, the restored 13.13.1 background wedges seconds after unlock (it
// starts mainnet balance/price polling for its preinstalled Solana/Bitcoin/
// Tron snaps and auto-updates them from npm; every fresh UI then shows
// "Background connection unresponsive" and dapp requests never surface).
// Offline it stays responsive, and the test talks only to the local Anvil
// stack anyway. Synpress is still used to BUILD the cache (`npx synpress`).
import { test as base, chromium } from "@playwright/test";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tier2WalletSetup } from "./wallet.setup.js";

// Same pin as tier2-extension.ts; the cached profile registered the unpacked
// extension at this path, which also fixes its id.
const EXTENSION_DIR = path.resolve(".cache-synpress", "metamask-chrome-13.13.1");
const OFFLINE = "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 127.0.0.1";

export const test = base.extend<{ extensionId: string }>({
  context: async ({}, use) => {
    const cache = path.resolve(".cache-synpress", tier2WalletSetup.hash);
    if (!existsSync(cache)) {
      throw new Error(`tier2: wallet cache ${tier2WalletSetup.hash} missing; run via \`npm run test:e2e:dashboard-tier2\``);
    }
    // Lets context.route see the wallet's service-worker requests (below).
    process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";
    const profile = mkdtempSync(path.join(os.tmpdir(), "tier2-wallet-"));
    cpSync(cache, profile, { recursive: true });
    const context = await chromium.launchPersistentContext(profile, {
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, OFFLINE, "--disable-dev-shm-usage"],
    });
    // Offline, MetaMask cannot publish a transaction: on approve it asks the
    // tx-sentinel API which networks support its relay and does not fall back
    // when that fetch fails ("Failed to fetch" back to the dapp). Answer "none".
    await context.route("https://tx-sentinel-*.api.cx.metamask.io/networks", (route) => route.fulfill({ json: {} }));
    try {
      await use(context);
    } finally {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    }
  },
  extensionId: async ({ context }, use) => {
    const isWallet = (url: string) => url.startsWith("chrome-extension://");
    const worker =
      context.serviceWorkers().find((w) => isWallet(w.url())) ??
      (await context.waitForEvent("serviceworker", { predicate: (w) => isWallet(w.url()) }));
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/home.html`);
    await page.getByTestId("unlock-password").fill(tier2WalletSetup.walletPassword);
    await page.getByTestId("unlock-submit").click();
    await page.getByTestId("account-menu-icon").waitFor({ state: "visible", timeout: 30_000 });
    // MetaMask only pops its approval window when no wallet UI is the active
    // tab (the background skips showPopup while a fullscreen home.html is
    // focused and expects that tab to render the request), so close every
    // wallet tab — including any the restored session reopened.
    for (const p of context.pages()) {
      if (isWallet(p.url())) await p.close();
    }
    await use(extensionId);
  },
});
