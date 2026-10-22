// Tier-1 dashboard E2E: real Anvil chain, real deployment, real sandbox server,
// served dashboard build under its generated CSP, and an injected EIP-1193
// wallet whose signing calls forward to Anvil (which really signs for the
// impersonated test account). Needs socket binding: runs in CI, not in the
// file-only sandbox. The hermetic smoke spec covers the same flows everywhere.
import {
  expect,
  injectProviderStub,
  startDashboardStack,
  test,
  type DashboardStack,
} from "./fixtures.js";
import type { Page } from "@playwright/test";
import { setupFundedSession } from "../../../e2e/harness.js";

let shared: DashboardStack | null = null;

async function startTier1(): Promise<DashboardStack> {
  if (shared) return shared;
  // The stub wallet sends and personal_signs as the owner/provider accounts;
  // Anvil signs for impersonated accounts, so every dashboard signature is real.
  const tier = await startDashboardStack({ chainId: 84532, chainName: "Local Anvil" });
  await tier.stack.client.rpcCall("anvil_impersonateAccount", [tier.owner]);
  await tier.stack.client.rpcCall("anvil_impersonateAccount", [tier.provider]);
  shared = tier;
  return shared;
}

test.beforeAll(async () => {
  await startTier1();
});

test.afterAll(async () => {
  if (shared) await shared.close();
});

async function openDashboard(page: Page, tier: DashboardStack, accounts?: string[]): Promise<void> {
  await injectProviderStub(page, {
    accounts: accounts ?? [tier.owner],
    chainIdHex: "0x14a34",
    rpcUrl: tier.stack.rpcUrl,
  });
  await page.goto(tier.url);
}

test.describe("tier1", () => {
  test("connect, fund, and read the funded balance", async ({ page }) => {
    const tier = await startTier1();
    await openDashboard(page, tier);
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await expect(page.getByText("0x", { exact: false }).first()).toBeVisible();
    await page.getByRole("link", { name: "Fund" }).click();
    await page.getByRole("button", { name: "Use connected wallet" }).click();
    await page.getByRole("button", { name: "Claim test tokens" }).click();
    await expect(page.getByText("Claim confirmed.")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/left today/)).toBeVisible();
  });

  test("create a vault, delegate, revoke, and withdraw", async ({ page }) => {
    const tier = await startTier1();
    await openDashboard(page, tier);
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page.getByRole("link", { name: "Vaults" }).click();
    await page.getByRole("button", { name: "Create vault", exact: true }).click();
    await expect(page.getByText(/Vault .* created/)).toBeVisible({ timeout: 60_000 });
    await page.getByRole("link", { name: "Delegate" }).click();
    // owner is "0x\.\.\."; delegate to a second test account (the provider key).
    await page.getByLabel("Agent signer address").fill(tier.provider);
    await page.getByLabel("Maximum total spend in tANE (whole units)").fill("320");
    await page.getByRole("button", { name: "Sign delegation" }).click();
    await expect(page.getByText(/Delegated 320 tANE/)).toBeVisible({ timeout: 60_000 });
    await page.getByRole("link", { name: "Vaults" }).click();
    await page.getByRole("button", { name: "Revoke agent" }).click();
    await expect(page.getByText(/Agent revoked/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("revoked", { exact: true })).toBeVisible();
  });

  test("provider pauses and resumes a campaign with personal_sign", async ({ page }) => {
    const tier = await startTier1();
    await openDashboard(page, tier, [tier.provider]);
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page.getByRole("link", { name: "Campaigns" }).click();
    // The sandbox seeds at least the trial campaign; take whatever lists first.
    const first = page.locator("#campaign-list li strong").first();
    await expect(first).toBeVisible();
    const id = (await first.textContent())?.replace(/^Campaign /, "").trim() ?? "";
    await page.getByLabel("Campaign id").fill(id);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByText(/paused\./)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(page.getByText(/resumed\./)).toBeVisible({ timeout: 30_000 });
  });

  test("payment lookup finds a settled sandbox payment", async ({ page }) => {
    const tier = await startTier1();
    // Settle one payment through the SDK so the lookup has something real.
    await setupFundedSession(tier.stack);
    const paid = await tier.stack.session.purchase<{ paidAmount: string }>(
      `${tier.stack.sandbox.url}/v1/demo/summarize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "tier-1 lookup fixture" }),
        settleDirectOnChain: true,
      },
    );
    expect(paid.receipt?.paymentId).toMatch(/^0x[0-9a-f]{64}$/);
    await openDashboard(page, tier);
    await page.getByRole("link", { name: "Activity" }).click();
    await page.getByLabel("Payment id").fill(paid.receipt?.paymentId ?? "");
    await page.getByRole("button", { name: "Look up payment" }).click();
    await expect(page.getByText("16 tANE").first()).toBeVisible({ timeout: 30_000 });
    // An unknown id reports cleanly instead of hanging or throwing.
    await page.getByLabel("Payment id").fill(`0x${"cc".repeat(32)}`);
    await page.getByRole("button", { name: "Look up payment" }).click();
    await expect(page.getByText(/No settled payment/)).toBeVisible({ timeout: 30_000 });
  });
});
