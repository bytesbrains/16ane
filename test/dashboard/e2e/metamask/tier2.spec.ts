// Tier-2 dashboard E2E: a REAL MetaMask (Synpress) drives the owner journey
// against Anvil on chain 31337 — connect, faucet fund, vault create, delegate,
// revoke, and a payment lookup. Chain 31337 (not 84532) so the wallet adds the
// test chain without colliding with built-in Base Sepolia, and the chain's RPC
// is added through settings before connecting, so the dashboard's chain switch
// is a no-op and no network prompt can race the test. Needs a headed browser
// plus socket binding: CI-only under xvfb. Provider personal_sign campaign
// controls stay in Tier-1: Synpress onboarding imports a single key, and the
// campaign provider is a different account.
// This directory ships {"type": "commonjs"}: Synpress pulls jszip's cyclic CJS
// through ESM import, which crashes Playwright's ESM loader on Node 24
// ("Unexpected module status 3"); loaded through require() the same graph is
// fine. The tradeoff is that these files cannot import the ESM harness, so a
// global setup boots the stack and hands it over via test-results/tier2-stack.json
// (read lazily so --list works without a booted stack). No import.meta here.
import { testWithSynpress } from "@synthetixio/synpress";
import { metaMaskFixtures } from "@synthetixio/synpress/playwright";
import { expect } from "@playwright/test";
import { readTier2Stack } from "./stack.js";
import { tier2WalletSetup } from "./wallet.setup.js";

const test = testWithSynpress(metaMaskFixtures(tier2WalletSetup));

test.describe("tier2", () => {
  test("owner journey through a real MetaMask", async ({ context, metamask }) => {
    const stack = readTier2Stack();
    // New page straight from the wallet context: Synpress's `page` fixture
    // navigates to '/' and this suite has no static baseURL (the dashboard
    // port is per-run), so that fixture cannot be used here.
    const page = await context.newPage();
    // The wallet account is the harness owner: prove it before spending.
    await metamask.addNetwork({
      name: "Anvil 31337",
      rpcUrl: stack.rpcUrl,
      chainId: 31337,
      symbol: "ETH",
    });
    expect((await metamask.getAccountAddress()).toLowerCase()).toBe(stack.owner.toLowerCase());

    await page.goto(stack.dashboardUrl);
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await metamask.connectToDapp();
    await expect(page.getByText("0x", { exact: false }).first()).toBeVisible({ timeout: 30_000 });

    await page.getByRole("link", { name: "Fund", exact: true }).click();
    await page.getByRole("button", { name: "Use connected wallet" }).click();
    await page.getByRole("button", { name: "Claim test tokens" }).click();
    await metamask.confirmTransaction();
    await expect(page.getByText("Claim confirmed.")).toBeVisible({ timeout: 60_000 });

    await page.getByRole("link", { name: "Vaults", exact: true }).click();
    await page.getByRole("button", { name: "Create vault", exact: true }).click();
    await metamask.confirmTransaction();
    await expect(page.getByText(/Vault .* created/)).toBeVisible({ timeout: 60_000 });

    await page.getByRole("link", { name: "Delegate" }).click();
    await page.getByLabel("Agent signer address").fill(stack.provider);
    await page.getByLabel("Maximum total spend in tANE (whole units)").fill("320");
    await page.getByRole("button", { name: "Sign delegation" }).click();
    await metamask.confirmTransaction();
    await expect(page.getByText(/Delegated 320 tANE/)).toBeVisible({ timeout: 60_000 });

    await page.getByRole("link", { name: "Vaults", exact: true }).click();
    await page.getByRole("button", { name: "Revoke agent" }).click();
    await metamask.confirmTransaction();
    await expect(page.getByText(/Agent revoked/)).toBeVisible({ timeout: 60_000 });

    await page.getByRole("link", { name: "Activity" }).click();
    await page.getByLabel("Payment id").fill(stack.paymentId);
    await page.getByRole("button", { name: "Look up payment" }).click();
    await expect(page.getByText("16 tANE").first()).toBeVisible({ timeout: 30_000 });
  });
});
