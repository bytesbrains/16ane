// MetaMask 13.13.1 approval driver for the Tier-2 spec. Synpress 4.1.2 pins
// 13.13.1 but its page objects still target the pre-redesign UI
// (`page-container-footer-next`, `.confirmation-footer__actions`, the
// `network-display` dropdown), so connectToDapp/addNetwork/confirmTransaction
// never find their buttons. Synpress only builds the wallet cache here.
//
// One dapp action can raise several prompts in a row (connect, then
// wallet_addEthereumChain, then the switch), sometimes in the same window and
// sometimes in a fresh one, so approval is condition-driven: keep pressing the
// visible primary button until the dapp shows the expected outcome.
import type { BrowserContext, Page } from "@playwright/test";
import { writeFileSync } from "node:fs";

// Primary ("approve") buttons across 13.13.1's confirmation surfaces:
// connect page, templated confirmations (add/switch network), and the
// redesigned transaction/signature confirmations.
const APPROVE_TESTIDS = ["confirm-btn", "confirmation-submit-button", "confirm-footer-button"];

function notificationPages(context: BrowserContext, extensionId: string): Page[] {
  const prefix = `chrome-extension://${extensionId}/notification.html`;
  return context.pages().filter((p) => !p.isClosed() && p.url().startsWith(prefix));
}

async function clickVisibleApprove(page: Page): Promise<string | undefined> {
  for (const id of APPROVE_TESTIDS) {
    const button = page.getByTestId(id).first();
    if ((await button.isVisible().catch(() => false)) && (await button.isEnabled({ timeout: 1_000 }).catch(() => false))) {
      await button.click({ timeout: 5_000 }).catch(() => undefined);
      return id;
    }
  }
  return undefined;
}

// Failure evidence under test-results/ (uploaded by CI): every open page's
// screenshot, the approval windows' DOM, a fresh home.html (spins forever when
// the wallet background is wedged), and the captured console/network log.
async function dump(context: BrowserContext, extensionId: string, label: string): Promise<string> {
  const pages = notificationPages(context, extensionId);
  const lines: string[] = [];
  for (const [i, p] of pages.entries()) {
    const file = `test-results/tier2-${label}-${i}`;
    await p.screenshot({ path: `${file}.png` }).catch(() => undefined);
    const html = await p.content().catch(() => "");
    writeFileSync(`${file}.html`, html);
    const ids = [...new Set([...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]))];
    lines.push(`${p.url()} testids: ${ids.join(", ")}`);
  }
  if (lines.length === 0) lines.push("no notification page open");
  for (const [i, p] of context.pages().entries()) {
    if (p.isClosed()) continue;
    await p.screenshot({ path: `test-results/tier2-${label}-page${i}.png` }).catch(() => undefined);
    lines.push(`page ${i}: ${p.url()}`);
  }
  const liveness = await context.newPage();
  await liveness.goto(`chrome-extension://${extensionId}/home.html`).catch(() => undefined);
  await liveness.waitForTimeout(8_000);
  await liveness.screenshot({ path: `test-results/tier2-${label}-liveness.png` }).catch(() => undefined);
  writeFileSync(`test-results/tier2-${label}-console.txt`, consoleLines.join("\n"));
  return lines.join("\n");
}

const consoleLines: string[] = [];
const watched = new WeakSet<Page>();
function watch(page: Page): void {
  if (watched.has(page)) return;
  watched.add(page);
  page.on("console", (m) => consoleLines.push(`[${m.type()}] ${page.url()} ${m.text()}`));
  page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${page.url()} ${e.message}`));
}

// Records the wallet service worker's and every page's console, plus failed
// requests (the fixture enables service-worker network events), for dump().
export function captureWalletLogs(context: BrowserContext): void {
  const sw = (w: any) => {
    consoleLines.push(`[sw-start] ${w.url()}`);
    w.on("console", (m: any) => consoleLines.push(`[sw ${m.type()}] ${m.text()}`));
    w.on("close", () => consoleLines.push(`[sw-close] ${w.url()}`));
  };
  context.serviceWorkers().forEach(sw);
  context.on("serviceworker", sw);
  context.pages().forEach(watch);
  context.on("page", watch);
  context.on("requestfailed", (r) => consoleLines.push(`[reqfail] ${r.method()} ${r.url().slice(0, 160)} ${r.failure()?.errorText ?? ""}`));
}

// Approves every MetaMask prompt until `done()` holds. Throws with a dump of
// the open notification windows if it does not within `timeoutMs`.
export async function approveUntil(
  context: BrowserContext,
  extensionId: string,
  label: string,
  done: () => Promise<boolean>,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let finished: boolean;
    try {
      finished = await done();
    } catch (err) {
      throw new Error(`${(err as Error).message}\n${await dump(context, extensionId, label)}`);
    }
    if (finished) return;
    for (const page of notificationPages(context, extensionId)) {
      watch(page);
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await clickVisibleApprove(page);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`tier2 ${label}: wallet prompts never settled\n${await dump(context, extensionId, label)}`);
}
