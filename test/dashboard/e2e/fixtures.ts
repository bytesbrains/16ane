// Shared Playwright fixtures: a faithful injected EIP-1193 stub (wallet calls
// answered locally, transactions forwarded to Anvil, personal_sign answered by
// the test process) plus the shared stack re-exported from dashboard-stack.ts.
import { test as base, type Page } from "@playwright/test";
import { keccak256 } from "../../../packages/sdk-ts/src/keccak.js";
import { signDigest } from "../../../packages/sdk-ts/src/secp256k1.js";

export { REPO_ROOT, startDashboardStack, type DashboardStack } from "./dashboard-stack.ts";

export interface StubWallet {
  accounts: string[];
  chainIdHex: string;
  /** Private keys by address for personal_sign (the test process signs: Anvil cannot sign for impersonated accounts). */
  keys?: Record<string, string>;
}

// EIP-191 personal_sign over raw message bytes — what a wallet returns for the
// dashboard's UTF-8 control messages, verified by packages/sdk-ts recoverAddress.
function personalSignBytes(messageHex: string, key: string): string {
  const body = Buffer.from(messageHex.replace(/^0x/i, ""), "hex");
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix);
  joined.set(body, prefix.length);
  return signDigest(keccak256(joined), key).serialized;
}

// Injects window.ethereum before any page script runs. Wallet methods are
// answered locally; transaction and receipt calls are forwarded to rpcUrl, so
// against Anvil the stub really sends. personal_sign is answered by the test
// process over a binding (Anvil cannot sign for impersonated accounts).
// Calls are recorded on window.__pw.calls and watchAsset offers on
// window.__pw.watchAssets.
export async function injectProviderStub(page: Page, wallet: StubWallet & { rpcUrl: string }): Promise<void> {
  const keys = new Map<string, string>();
  for (const [address, key] of Object.entries(wallet.keys ?? {})) keys.set(address.toLowerCase(), key);
  await page.exposeBinding("__pwPersonalSign", (_source, messageHex: string, address: string) => {
    const key = keys.get(String(address).toLowerCase());
    if (!key) throw new Error(`stub: no key for ${address}`);
    return personalSignBytes(messageHex, key);
  });
  await page.addInitScript(
    ({ accounts, chainIdHex, rpcUrl }) => {
      const calls: { method: string; params?: unknown }[] = [];
      const watchAssets: unknown[] = [];
      let chain = chainIdHex;
      (window as unknown as { __pw: object }).__pw = {
        calls,
        watchAssets,
        setAccounts(next: string[]) {
          accounts.length = 0;
          accounts.push(...next);
        },
      };
      let id = 1;
      async function forward(method: string, params: unknown): Promise<unknown> {
        const res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
        });
        const body = (await res.json()) as { result?: unknown; error?: { message?: string; code?: number } };
        if (body.error) {
          const err = new Error(`RPC ${method} failed: ${body.error.message || body.error.code}`) as Error & {
            code?: number;
          };
          err.code = body.error.code;
          throw err;
        }
        return body.result;
      }
      const listeners: Record<string, (() => void)[]> = {};
      (window as unknown as { ethereum: object }).ethereum = {
        isMetaMask: true,
        request: async ({ method, params }: { method: string; params?: unknown }) => {
          calls.push({ method, params });
          switch (method) {
            case "eth_requestAccounts":
            case "eth_accounts":
              return [...accounts];
            case "eth_chainId":
              return chain;
            case "wallet_switchEthereumChain": {
              const want = (params as [{ chainId: string }])[0].chainId;
              if (want.toLowerCase() !== chain.toLowerCase()) {
                const err = new Error("stub: refusing to leave the test chain") as Error & { code?: number };
                err.code = 4902;
                throw err;
              }
              return null;
            }
            case "wallet_addEthereumChain":
              return null;
            case "wallet_watchAsset":
              watchAssets.push(params);
              return true;
            case "personal_sign": {
              // Real wallets accept a UTF-8 message; the binding signs raw
              // bytes, so translate once here and let the test process sign.
              const [message, address] = (params ?? []) as [unknown, unknown];
              const hexMessage =
                typeof message === "string" && !message.startsWith("0x")
                  ? "0x" +
                    [...new TextEncoder().encode(message)].map((b) => b.toString(16).padStart(2, "0")).join("")
                  : message;
              return (
                window as unknown as {
                  __pwPersonalSign: (messageHex: unknown, address: unknown) => Promise<unknown>;
                }
              ).__pwPersonalSign(hexMessage, address);
            }
            default:
              return forward(method, params);
          }
        },
        on: (event: string, fn: () => void) => {
          listeners[event] = [...(listeners[event] ?? []), fn];
        },
      };
    },
    { accounts: [...wallet.accounts], chainIdHex: wallet.chainIdHex, rpcUrl: wallet.rpcUrl },
  );
}

export const test = base;
export { expect } from "@playwright/test";

export async function rpcCall(rpcUrl: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`anvil ${method}: ${body.error.message}`);
  return body.result;
}
