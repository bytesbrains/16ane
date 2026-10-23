// Tier-2 dashboard E2E: a REAL MetaMask (Synpress) drives the owner journey
// against Anvil on chain 31337 — connect, faucet fund, vault create, delegate,
// revoke, and a payment lookup. Chain 31337 (not 84532) so the wallet adds the
// test chain without colliding with built-in Base Sepolia; the dashboard's own
// EIP-3085 add-chain request registers it during connect. The wallet comes
// from ./fixture.ts (offline restore of the Synpress-built cache) and prompts
// go through ./mm13.ts, not Synpress's page objects. Needs a headed browser
// plus socket binding: CI-only under xvfb. Provider personal_sign campaign
// controls stay in Tier-1: Synpress onboarding imports a single key, and the
// campaign provider is a different account.
// This directory ships {"type": "commonjs"}: Synpress pulls jszip's cyclic CJS
// through ESM import, which crashes Playwright's ESM loader on Node 24
// ("Unexpected module status 3"); loaded through require() the same graph is
// fine. The tradeoff is that these files cannot import the ESM harness, so a
// global setup boots the stack and hands it over via test-results/tier2-stack.json
// (read lazily so --list works without a booted stack). No import.meta here.
import { expect } from "@playwright/test";
import { readTier2Stack } from "./stack.js";
import { test } from "./fixture.js";
import { approveUntil, captureWalletLogs } from "./mm13.js";

// Never claimed on the fresh Anvil chain (any unused address works).
const FRESH_RECIPIENT = "0x00000000000000000000000000000000000c1a1e";

test.describe("tier2", () => {
  test("owner journey through a real MetaMask", async ({ context, extensionId }) => {
    const stack = readTier2Stack();
    // The dashboard port is per-run, so open the page from the wallet context
    // directly rather than through a baseURL.
    captureWalletLogs(context);
    const page = await context.newPage();
    const approve = (label: string, done: () => Promise<boolean>) => approveUntil(context, extensionId, label, done);
    // Done when the dapp shows `text`; a dapp-side error ends the wait at once.
    const visible = (text: string | RegExp) => async () => {
      const error = page.locator(".status-line.error");
      if (await error.isVisible()) throw new Error(`tier2 dapp error: ${await error.innerText()}`);
      return page.getByText(text).first().isVisible();
    };

    await page.goto(stack.dashboardUrl);
    await page.getByRole("button", { name: "Connect wallet" }).click();
    // One press: connect adds + switches to 31337 under the same request.
    await approve("connect", visible(/^Connected as /));
    // The wallet account is the harness owner on the Anvil chain: prove it
    // from the dapp side before spending.
    const wallet = await page.evaluate(async () => {
      const eth = (window as any).ethereum;
      return {
        accounts: (await eth.request({ method: "eth_accounts" })) as string[],
        chainId: (await eth.request({ method: "eth_chainId" })) as string,
      };
    });
    expect(wallet.accounts.map((a) => a.toLowerCase())).toEqual([stack.owner.toLowerCase()]);
    expect(Number.parseInt(wallet.chainId, 16)).toBe(31337);

    await page.getByRole("link", { name: "Fund", exact: true }).click();
    // The boot's funded session already claimed for the owner, and the faucet
    // cools down per RECIPIENT, so the owner's wallet claims for a fresh one.
    await page.getByLabel("Recipient address").fill(FRESH_RECIPIENT);
    await page.getByRole("button", { name: "Claim test tokens" }).click();
    await approve("claim", visible("Claim confirmed."));

    await page.getByRole("link", { name: "Vaults", exact: true }).click();
    await page.getByRole("button", { name: "Create vault", exact: true }).click();
    await approve("create-vault", visible(/Vault .* created/));

    await page.getByRole("link", { name: "Delegate" }).click();
    await page.getByLabel("Agent signer address").fill(stack.provider);
    await page.getByLabel("Maximum total spend in tANE (whole units)").fill("320");
    await page.getByRole("button", { name: "Sign delegation" }).click();
    await approve("delegate", visible(/Delegated 320 tANE/));

    await page.getByRole("link", { name: "Vaults", exact: true }).click();
    await page.getByRole("button", { name: "Revoke agent" }).click();
    await approve("revoke", visible(/Agent revoked/));

    await page.getByRole("link", { name: "Activity" }).click();
    await page.getByLabel("Payment id").fill(stack.paymentId);
    await page.getByRole("button", { name: "Look up payment" }).click();
    await expect(page.getByText("16 tANE").first()).toBeVisible({ timeout: 30_000 });
  });
});
