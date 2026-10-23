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
// Hash-convergence note: Synpress hashes the setup CALLBACK's source, and it
// loads this file twice through different transforms — tsup ESM for the cache
// build, babel CJS for the specs. Any imported binding referenced inside the
// callback renders differently per transform (`readTier2Stack()` vs
// `(0, _stack.readTier2Stack)()`), which splits the hash and the specs never
// find the cache. So the callback below references only bare identifiers —
// module-level helpers plus the banner-provided `require` — and reads the
// stack file inline instead of importing ./stack.js (which tsup bundles away
// from require's reach). Keep the callback itself small on top of that:
// Synpress extracts it with a brace-counting regex that backtracks
// catastrophically on deeply nested callbacks and hangs the cache build
// before the browser even launches. All real logic lives in helpers, which
// are neither hashed nor regex-scanned.
import { defineWalletSetup } from "@synthetixio/synpress";

const PASSWORD = "16ane-tier2-local-test";

declare const require: (id: string) => any;

// Stack handover from tier2-boot.ts (see tier2.spec.ts for why this reads a
// file instead of importing the ESM harness).
function readTier2StackFile(): { mnemonic: string; owner: string } {
  const { readFileSync } = require("node:fs");
  const path = require("node:path");
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(path.resolve("test-results", "tier2-stack.json"), "utf8"));
  } catch {
    throw new Error("tier2 stack not booted: run via `npm run test:e2e:dashboard-tier2`");
  }
  const mnemonic = parsed.ownerMnemonic;
  const owner = parsed.owner;
  if (typeof mnemonic !== "string" || !/^[a-z]+( [a-z]+){11}$/.test(mnemonic)) {
    throw new Error("tier2 stack file is corrupt: delete test-results/tier2-stack.json and re-run");
  }
  if (typeof owner !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(owner)) {
    throw new Error("tier2 stack file is corrupt: delete test-results/tier2-stack.json and re-run");
  }
  return { mnemonic, owner };
}

// Full onboarding against the pristine pinned build (see tier2-extension.ts
// for why the build must stay pristine). Ends with the snapshot gate: home
// must render and list the owner address, so a vault-less or wrong-account
// profile fails here, loudly, instead of poisoning the cache
// the specs restore.
async function runTier2Onboarding(walletPage: any, mnemonic: string, owner: string): Promise<void> {
  // Own steps (same testids Synpress drives).
  await walletPage.getByTestId("onboarding-import-wallet").click();
  await walletPage.getByTestId("onboarding-import-with-srp-button").click();
  // The SRP textarea parses incrementally off key events (a lone fill never
  // enables confirm) and, once parsed, explodes into 12 per-word boxes that
  // become the confirm's source of truth. Blind typing demonstrably corrupts
  // the phrase into a DIFFERENT VALID mnemonic — one build snapshotted a
  // vault for 0x0f74… instead of the owner — so verify every parsed word and
  // heal mismatches by direct per-box fill before confirming.
  const srpWords = mnemonic.split(" ");
  const srpBox = walletPage.getByTestId("srp-input-import__srp-note");
  await srpBox.fill("");
  await srpBox.pressSequentially(mnemonic, { delay: 15 });
  await walletPage.getByTestId("import-srp__srp-word-11").waitFor({ state: "visible", timeout: 10_000 });
  for (let i = 0; i < 12; i++) {
    const box = walletPage.getByTestId("import-srp__srp-word-" + i);
    if ((await box.inputValue()).trim() !== srpWords[i]) {
      await box.fill(srpWords[i]);
    }
  }
  for (let i = 0; i < 12; i++) {
    const word = await walletPage.getByTestId("import-srp__srp-word-" + i).inputValue();
    if (word.trim() !== srpWords[i]) {
      throw new Error("tier2: SRP word " + i + " is " + JSON.stringify(word) + "; aborting before a bad snapshot");
    }
  }
  await walletPage.getByTestId("import-srp-confirm").click();
  await walletPage.getByTestId("create-password-new-input").fill(PASSWORD);
  await walletPage.getByTestId("create-password-confirm-input").fill(PASSWORD);
  await walletPage.getByTestId("create-password-terms").click();
  await walletPage.getByTestId("create-password-submit").click();
  await walletPage.locator("#metametrics-opt-in").click();
  await walletPage.getByTestId("metametrics-i-agree").click();
  // 13.13.1 parks on a completion page after import. Its done handler awaits
  // `sidePanel.open()` BEFORE `setCompletedOnboarding()`; under automation that
  // open never settles, the flag never flips, and the hung call takes the
  // service worker down with it. When the API is absent the same handler skips
  // straight to `setCompletedOnboarding()` + navigate home (its non-side-panel
  // path), so hide `sidePanel.open` in this page only — webextension-polyfill
  // binds it lazily on first access, which is the click. Skipping the click
  // instead leaves a vault with completedOnboarding:false, which unlocks
  // straight back onto this page. Do NOT patch the bundle's baked side-panel
  // flag either: a patched bundle walks the UI home while the backend never
  // creates the vault, and the cache restores as a fresh wallet.
  const done = walletPage.getByTestId("onboarding-complete-done");
  await done.waitFor({ state: "visible", timeout: 30_000 });
  // The hide must run at document start: once LavaMoat boots it scuttles
  // globalThis (chrome, eval, ...), so neither page.evaluate nor a raw CDP
  // Runtime.evaluate can reach the API afterwards. Register an init script and
  // reload — the background stays unlocked and routes back to this page.
  // The same pre-scuttle script keeps a handle on chrome.storage.local and
  // mirrors what is PERSISTED onto an <html> attribute (Playwright reads
  // attributes from its own unscuttled world): see the persistence wait below.
  await walletPage.addInitScript(() => {
    const g = globalThis as any;
    for (const ns of [g.chrome, g.browser]) {
      if (ns && ns.sidePanel) Object.defineProperty(ns.sidePanel, "open", { value: undefined, configurable: true });
    }
    const local = g.chrome && g.chrome.storage && g.chrome.storage.local;
    if (!local) return;
    const publish = () =>
      local.get("data").then((got: any) => {
        const data = got && got.data;
        const flags = {
          completedOnboarding: Boolean(data && data.OnboardingController && data.OnboardingController.completedOnboarding),
          vault: Boolean(data && data.KeyringController && data.KeyringController.vault),
        };
        if (document.documentElement) document.documentElement.setAttribute("data-tier2-persisted", JSON.stringify(flags));
      });
    setInterval(publish, 250);
  });
  await walletPage.reload();
  await done.waitFor({ state: "visible", timeout: 30_000 });
  await done.click();
  await walletPage.getByTestId("account-menu-icon").waitFor({ state: "visible", timeout: 30_000 });
  // Prove the RIGHT wallet is home. 13.13.1's multichain home renders no
  // address; the Receive page lists it per network, truncated as
  // "0x9858E...Eda94", so match both ends of the owner address.
  await walletPage.getByTestId("eth-overview-receive").click();
  const shown = walletPage.getByTestId("multichain-address-row-address").first();
  await shown.waitFor({ state: "visible", timeout: 15_000 });
  const text = (await shown.innerText()).trim().toLowerCase();
  const want = owner.toLowerCase();
  const [head, tail] = text.split("...");
  if (!head || !tail || head.length < 6 || !want.startsWith(head) || !want.endsWith(tail)) {
    throw new Error("tier2: wallet shows " + JSON.stringify(text) + ", expected owner " + owner + "; aborting before a bad snapshot");
  }
  // Synpress snapshots the profile the moment this setup returns, but
  // MetaMask persists state through a 1 s throttle, so the UI being home does
  // not mean the disk agrees: an early snapshot restores with
  // completedOnboarding:false and every dapp request is rejected. Wait until
  // chrome.storage.local itself holds the finished onboarding and the vault.
  const persisted = '{"completedOnboarding":true,"vault":true}';
  await walletPage.locator(`html[data-tier2-persisted='${persisted}']`).waitFor({ state: "attached", timeout: 30_000 });
}

export const tier2WalletSetup = defineWalletSetup(PASSWORD, async (context, walletPage) => {
  const stack = readTier2StackFile();
  await runTier2Onboarding(walletPage, stack.mnemonic, stack.owner);
});

// The spec imports the named setup; the cache builder requires a default export.
export default tier2WalletSetup;
