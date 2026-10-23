// Hermetic dashboard smoke: file:// build, stubbed RPC/API routes, injected
// wallet. Runs anywhere a browser launches (no Anvil, no sockets) and covers
// routing, wallet flows, forms, disclosures, and keyboard order.
import { expect, test } from "./fixtures.js";
import { openDashboard, stubNetwork, TOKEN } from "./harness-smoke.js";

test.describe("smoke", () => {
  test("loads with network info, directory, and campaigns", async ({ page }) => {
    await stubNetwork(page);
    await openDashboard(page);
    await expect(page.getByText(/Base Sepolia/)).toBeVisible();
    await page.getByRole("link", { name: "Earn", exact: true }).click();
    await expect(page.getByText("Demo Summarizer")).toBeVisible();
    await page.getByRole("link", { name: "Campaigns" }).click();
    await expect(page.getByText(/trial-1/)).toBeVisible();
  });

  test("routes move focus and mark the current page", async ({ page }) => {
    await stubNetwork(page);
    await openDashboard(page);
    await page.getByRole("link", { name: "Fund", exact: true }).click();
    await expect(page).toHaveURL(/#\/fund/);
    await expect(page.getByRole("link", { name: "Fund", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "Fund" })).toBeFocused();
    await expect(page.getByRole("heading", { name: "Overview" })).toBeHidden();
  });

  test("connect populates the badge and stats", async ({ page }) => {
    await stubNetwork(page);
    // The stub answers eth_requestAccounts + eth_chainId locally; reads hit fixtures.
    await openDashboard(page);
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await expect(page.locator("#wallet-address")).toHaveText("0x1111…1111");
    await expect(page.getByText("16000 tANE").first()).toBeVisible();
  });

  test("add-token offers tANE with the square mark", async ({ page }) => {
    await stubNetwork(page);
    await openDashboard(page);
    await page.getByRole("button", { name: "Add tANE to wallet" }).click();
    const assets = await page.evaluate(() => (window as unknown as { __pw: { watchAssets: unknown[] } }).__pw.watchAssets);
    expect(assets).toHaveLength(1);
    expect(JSON.stringify(assets[0]).toLowerCase()).toContain(TOKEN.toLowerCase());
    expect(JSON.stringify(assets[0])).toContain("https://16ane.com/mark-square.png");
  });

  test("faucet form rejects a bad address without touching the wallet", async ({ page }) => {
    await stubNetwork(page);
    await openDashboard(page);
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page.getByRole("link", { name: "Fund", exact: true }).click();
    await page.getByLabel("Recipient address").fill("not-an-address");
    await page.getByRole("button", { name: "Claim test tokens" }).click();
    await expect(page.getByText("Recipient is not an address.")).toBeVisible();
    const calls = await page.evaluate(() => (window as unknown as { __pw: { calls: { method: string }[] } }).__pw.calls);
    expect(calls.filter((c) => c.method === "eth_sendTransaction")).toHaveLength(0);
  });

  test("every screen shows the no-cash-value disclosure", async ({ page }) => {
    await stubNetwork(page);
    await openDashboard(page);
    for (const name of ["Overview", "Fund", "Vaults", "Delegate", "Earn", "Campaigns", "Activity"]) {
      await page.getByRole("link", { name, exact: true }).click();
      const section = page.locator(`[data-screen="${name.toLowerCase()}"]`);
      await expect(section.getByText("NO CASH VALUE").first()).toBeVisible();
    }
  });

  test("keyboard order starts at the skip link and reaches wallet controls", async ({ page }) => {
    await stubNetwork(page);
    await openDashboard(page);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    const focused: string[] = [];
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press("Tab");
      const label = await page.evaluate(() => {
        const el = document.activeElement;
        return el ? `${el.tagName}:${(el.textContent ?? "").trim().slice(0, 24)}` : "none";
      });
      focused.push(label);
      if (label.startsWith("BUTTON:Connect wallet")) break;
    }
    expect(focused.some((f) => f.startsWith("A:Overview"))).toBe(true);
    expect(focused.some((f) => f.startsWith("BUTTON:Connect wallet"))).toBe(true);
  });
});
