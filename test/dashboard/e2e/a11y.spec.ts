// Accessibility audit: axe-core over every dashboard route (WCAG 2.1 A and AA),
// plus a focus-visibility spot check. Runs on the hermetic smoke harness.
import { expect, test } from "./fixtures.js";
import { openDashboard, stubNetwork } from "./harness-smoke.js";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

interface AxeViolation {
  id: string;
  impact?: string;
  description: string;
  nodes: { target: unknown }[];
}

async function audit(page: Page): Promise<AxeViolation[]> {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (o: unknown) => Promise<{ violations: AxeViolation[] }> } }).axe;
    const results = await axe.run({ runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
    return results.violations;
  });
}

const ROUTES = ["overview", "fund", "vaults", "delegate", "earn", "campaigns", "activity"] as const;

test.describe("a11y", () => {
  for (const route of ROUTES) {
    test(`axe reports zero WCAG A/AA violations on #/${route}`, async ({ page }) => {
      await stubNetwork(page);
      await openDashboard(page);
      await page.getByRole("link", { name: route[0].toUpperCase() + route.slice(1), exact: true }).click();
      const violations = await audit(page);
      expect(
        violations.map((v) => `${v.id} (${v.impact ?? "?"}): ${v.description} @ ${JSON.stringify(v.nodes.map((n) => n.target))}`),
        `axe violations on #/${route}`,
      ).toEqual([]);
    });
  }

  test("focused controls show a visible focus indicator", async ({ page }) => {
    await stubNetwork(page);
    await openDashboard(page);
    await page.getByRole("button", { name: "Connect wallet" }).focus();
    const outline = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const style = getComputedStyle(el);
      return { width: style.outlineWidth, style: style.outlineStyle };
    });
    expect(outline.style).not.toBe("none");
    expect(outline.width).not.toBe("0px");
  });
});
