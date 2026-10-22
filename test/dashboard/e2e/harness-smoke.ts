// Hermetic dashboard smoke: file:// build, stubbed RPC/API routes, injected
// wallet. Runs anywhere a browser launches (no Anvil, no sockets) and covers
// routing, wallet flows, forms, disclosures, keyboard order, and axe audits.
import { injectProviderStub, REPO_ROOT } from "./fixtures.js";
import type { Page } from "@playwright/test";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const OWNER = "0x1111111111111111111111111111111111111111";
const VAULT = "0x2222222222222222222222222222222222222222";
export const TOKEN = "0x5848C9935C1cA2D2a93329DFd31f0883277b8335";
const PAGE = pathToFileURL(path.join(REPO_ROOT, "dashboard", "index.html")).toString();

const word = (n: bigint) => n.toString(16).padStart(64, "0");
const addrWord = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

function accountingFixture(): string {
  // Mirrors getAccountingSummary field order: owner, agent, balances(7), version,
  // expiry, mode, ceiling, active.
  return (
    "0x" +
    addrWord(OWNER) +
    addrWord("0x3333333333333333333333333333333333333333") +
    word(16000n * 10n ** 18n) +
    word(16000n * 10n ** 18n) +
    word(320n * 10n ** 18n) +
    word(16n * 10n ** 18n) +
    word(304n * 10n ** 18n) +
    word(304n * 10n ** 18n) +
    word(0n) +
    word(15696n * 10n ** 18n) +
    word(1n) +
    word(0n) +
    word(0n) +
    word(0n) +
    word(1n)
  );
}

export async function stubNetwork(page: Page): Promise<{ posts: { url: string; body: unknown }[] }> {
  const posts: { url: string; body: unknown }[] = [];
  await page.route("https://sepolia.base.org/**", async (route) => {
    const body = (await route.request().postDataJSON()) as { id: number; method: string; params: { data?: string }[] };
    if (body.method !== "eth_call") {
      await route.fulfill({ json: { jsonrpc: "2.0", id: body.id, result: "0x1" } });
      return;
    }
    const data = (body.params[0]?.data ?? "").toLowerCase();
    await route.fulfill({ json: { jsonrpc: "2.0", id: body.id, result: fixtureFor(data) } });
  });
  await page.route("https://api.16ane.com/**", async (route) => {
    const url = route.request().url();
    if (route.request().method() === "POST") {
      posts.push({ url, body: await route.request().postDataJSON().catch(() => null) });
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (url.endsWith("/v1/services")) {
      await route.fulfill({
        json: {
          services: [
            {
              serviceId: "demo-sum",
              name: "Demo Summarizer",
              description: "Deterministic summaries.",
              endpoints: [{ method: "POST", path: "/sum", priceAmount: "16" }],
            },
          ],
        },
      });
      return;
    }
    if (url.endsWith("/v1/campaigns")) {
      await route.fulfill({ json: { campaigns: [{ id: "trial-1", providerId: OWNER, status: "active", quota: { remaining: 7 } }] } });
      return;
    }
    await route.fulfill({ status: 404, json: { code: "ANE-E-4040", message: "not found" } });
  });
  return { posts };
}

// eth_call fixtures keyed by selector; keep in sync with dashboard/assets/contracts.js.
function fixtureFor(data: string): string {
  switch (data.slice(0, 10)) {
    case "0x70a08231": // balanceOf(address)
      return "0x" + word(16000n * 10n ** 18n);
    case "0xaf33ccfd": // getAccountingSummary()
      return accountingFixture();
    case "0xac818711": // getVaultsByOwner(address): offset, length 1, one address
      return "0x" + word(32n) + word(1n) + addrWord(VAULT);
    case "0x089ec70e": // predictVaultAddress(address,bytes32)
      return "0x" + addrWord(VAULT);
    case "0x70f23da7": // nextClaimTime(address): eligible now
      return "0x" + word(0n);
    case "0x39dcbd6f": // remainingDailyAllowance()
      return "0x" + word(5000n * 10n ** 18n);
    case "0x0716326d": // payments(bytes32): empty record
      return "0x" + addrWord("0x0000000000000000000000000000000000000000") + word(0n) + word(0n) + word(0n);
    default:
      return "0x" + word(0n);
  }
}

export async function openDashboard(page: Page): Promise<void> {
  await injectProviderStub(page, { accounts: [OWNER], chainIdHex: "0x14a34", rpcUrl: "https://wallet-stub.invalid/rpc" });
  await page.goto(PAGE);
}

