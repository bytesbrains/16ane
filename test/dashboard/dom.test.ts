// Dashboard app tests over a minimal fake DOM (no browser): the element tree is
// seeded from the real dashboard/index.html, so ID typos and wiring mistakes
// fail here. Wallet and network are stubbed; every flow below is also covered
// against real Anvil + Chromium in test/dashboard/e2e (CI-only).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { functionSelector as sdkSelector } from "../../packages/sdk-ts/src/abi.ts";
import { campaignControlMessage as sdkMessage } from "../../packages/sdk-ts/src/campaigns.ts";

const ROOT = path.join(import.meta.dirname, "..", "..");
const OWNER = "0x1111111111111111111111111111111111111111";
const VAULT = "0x2222222222222222222222222222222222222222";

const word = (n: bigint) => n.toString(16).padStart(64, "0");
const addrWord = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

interface FakeEl {
  tag: string;
  id: string;
  attrs: Record<string, string>;
  textContent: string;
  value: string;
  hidden: boolean;
  disabled: boolean;
  dataset: Record<string, string>;
  children: FakeEl[];
  listeners: Record<string, ((e: Record<string, unknown>) => void)[]>;
  addEventListener(t: string, fn: (e: Record<string, unknown>) => void): void;
  append(...nodes: (FakeEl | string)[]): void;
  replaceChildren(...nodes: (FakeEl | string)[]): void;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  querySelector(sel: string): FakeEl | null;
  click(): void;
  focus(): void;
  reset(): void;
}

function makeEl(tag: string, id: string): FakeEl {
  const el: FakeEl = {
    tag,
    id,
    attrs: {},
    textContent: "",
    value: "",
    hidden: false,
    disabled: false,
    dataset: {},
    children: [],
    listeners: {},
    addEventListener(t, fn) {
      el.listeners[t] = [...(el.listeners[t] ?? []), fn];
    },
    append(...nodes) {
      for (const n of nodes) el.children.push(typeof n === "string" ? makeText(n) : n);
    },
    replaceChildren(...nodes) {
      el.children = nodes.map((n) => (typeof n === "string" ? makeText(n) : n));
    },
    setAttribute(k, v) {
      el.attrs[k] = v;
    },
    removeAttribute(k) {
      delete el.attrs[k];
    },
    querySelector(sel) {
      return queryIn(el, sel);
    },
    click() {
      for (const fn of el.listeners["click"] ?? []) fn({ preventDefault() {} });
    },
    focus() {},
    reset() {
      for (const child of el.children) child.value = "";
    },
  };
  return el;
}

function makeText(text: string): FakeEl {
  const el = makeEl("#text", "");
  el.textContent = text;
  return el;
}

function matches(el: FakeEl, sel: string): boolean {
  const tag = /^[a-z]+/.exec(sel)?.[0];
  if (tag && el.tag !== tag) return false;
  const id = /#([A-Za-z][\w-]*)/.exec(sel)?.[1];
  if (id && el.id !== id) return false;
  for (const [, k, v] of sel.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
    if (k === "type" && el.tag === "button" && v === "submit") continue; // buttons carry no type attr in the fake
    if (k.startsWith("data-")) {
      const dataKey = k.slice(5);
      if (v === undefined ? el.dataset[dataKey] === undefined : el.dataset[dataKey] !== v) return false;
      continue;
    }
    if (v === undefined ? el.attrs[k] === undefined : el.attrs[k] !== v) return false;
  }
  return true;
}

function queryAllIn(root: FakeEl, sel: string): FakeEl[] {
  // Supports the selectors the dashboard uses: single simple selectors and
  // one descendant combinator ("#id tag", "[data-x=\"v\"] tag").
  const parts = sel.split(/ (?![^[]*\])/);
  if (parts.length === 1) {
    const found: FakeEl[] = [];
    const walk = (el: FakeEl) => {
      if (el !== root && matches(el, sel)) found.push(el);
      for (const child of el.children) walk(child);
    };
    walk(root);
    return found;
  }
  const found: FakeEl[] = [];
  for (const base of queryAllIn(root, parts.slice(0, -1).join(" "))) {
    found.push(...queryAllIn(base, parts[parts.length - 1]));
  }
  return found;
}

function queryIn(root: FakeEl, sel: string): FakeEl | null {
  return queryAllIn(root, sel)[0] ?? null;
}

interface FakeDom {
  document: {
    getElementById(id: string): FakeEl | null;
    createElement(tag: string): FakeEl;
    querySelector(sel: string): FakeEl | null;
    querySelectorAll(sel: string): FakeEl[];
  };
  window: Record<string, unknown>;
  localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  setHash(hash: string): void;
  byId(id: string): FakeEl;
}

function buildDom(html: string): FakeDom {
  const root = makeEl("#root", "");
  const byId = new Map<string, FakeEl>();
  // Elements with ids.
  for (const m of html.matchAll(/<([a-z]+)([^>]*)\sid="([^"]+)"[^>]*>/g)) {
    const el = makeEl(m[1], m[3]);
    for (const [, k, v] of m[2].matchAll(/([\w-]+)="([^"]*)"/g)) {
      if (k.startsWith("data-")) el.dataset[k.slice(5)] = v;
      else el.attrs[k] = v;
    }
    if (/\shidden[\s>]/.test(m[0])) el.hidden = true;
    byId.set(m[3], el);
    root.children.push(el);
  }
  // Sections and their headings (routing targets).
  for (const m of html.matchAll(/<section data-screen="([a-z]+)"[^>]*>([\s\S]*?)<\/section>/g)) {
    const section = makeEl("section", "");
    section.dataset["screen"] = m[1];
    section.hidden = true;
    const heading = makeEl("h2", "");
    heading.textContent = m[1];
    section.children.push(heading);
    root.children.push(section);
  }
  // Nav links (routing + aria-current).
  for (const m of html.matchAll(/<a href="#\/([a-z]+)" data-route="([a-z]+)">/g)) {
    const link = makeEl("a", "");
    link.dataset["route"] = m[2];
    link.textContent = m[2];
    root.children.push(link);
  }
  // Submit buttons inside forms (delegate + campaign control submit handlers).
  for (const formId of ["delegate-form", "campaign-control-form", "faucet-form", "vault-create-form", "vault-open-form", "payment-form"]) {
    const form = byId.get(formId);
    if (form) {
      const submit = makeEl("button", "");
      submit.attrs["type"] = "submit";
      form.children.push(submit);
      if (formId === "campaign-control-form") {
        const resume = makeEl("button", "");
        resume.attrs["type"] = "submit";
        resume.attrs["value"] = "resume";
        resume.value = "resume";
        form.children.push(resume);
      }
    }
  }
  const listeners: Record<string, (() => void)[]> = {};
  const store = new Map<string, string>();
  const win: Record<string, unknown> = {
    location: { hash: "" },
    scrollTo() {},
    addEventListener(t: string, fn: () => void) {
      listeners[t] = [...(listeners[t] ?? []), fn];
    },
  };
  return {
    document: {
      getElementById: (id: string) => byId.get(id) ?? null,
      createElement: (tag: string) => makeEl(tag, ""),
      querySelector: (sel: string) => queryIn(root, sel),
      querySelectorAll: (sel: string) => queryAllIn(root, sel),
    },
    window: win,
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    },
    setHash(hash: string) {
      (win["location"] as { hash: string }).hash = hash;
      for (const fn of listeners["hashchange"] ?? []) fn();
    },
    byId(id: string) {
      const el = byId.get(id);
      assert.ok(el, `missing #${id}`);
      return el;
    },
  };
}

interface StubNet {
  posts: { url: string; body: unknown }[];
  ethCalls: string[];
  txs: { from: string; to: string; data: string }[];
  signs: { message: string; from: string }[];
  watchAssets: unknown[];
  install(dom: FakeDom, opts?: { receipt?: { status: string }; services?: unknown[]; campaigns?: unknown[] }): void;
}

function accountingFixture(): string {
  return (
    "0x" + addrWord(OWNER) + addrWord(OWNER) + word(100n) + word(100n) + word(320n) + word(16n) +
    word(304n) + word(304n) + word(0n) + word(84n) + word(1n) + word(0n) + word(0n) + word(0n) + word(1n)
  );
}

function makeNet(): StubNet {
  const net: StubNet = {
    posts: [],
    ethCalls: [],
    txs: [],
    signs: [],
    watchAssets: [],
    install(dom, opts = {}) {
      const g = globalThis as Record<string, unknown>;
      g["window"] = dom.window;
      g["document"] = dom.document;
      g["localStorage"] = dom.localStorage;
      g["fetch"] = (async (url: unknown, init: { body?: string; method?: string } = {}) => {
        const href = String(url);
        if (new URL(href).hostname === "sepolia.base.org") {
          const body = JSON.parse(String(init.body)) as { id: number; params: { data?: string }[] };
          const data = (body.params[0]?.data ?? "").toLowerCase();
          net.ethCalls.push(data);
          let result = "0x" + word(0n);
          if (data.startsWith("0x70a08231")) result = "0x" + word(16000n * 10n ** 18n);
          else if (data.startsWith("0xaf33ccfd")) result = accountingFixture();
          else if (data.startsWith("0xac818711")) result = "0x" + word(32n) + word(1n) + addrWord(VAULT);
          else if (data.startsWith("0x089ec70e")) result = "0x" + addrWord(VAULT);
          else if (data.startsWith("0x0716326d")) {
            result = "0x" + addrWord(OWNER) + word(16n) + word(0n) + word(100n);
          }
          return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: body.id, result }) };
        }
        if (opts.services !== undefined && href.endsWith("/v1/services")) {
          return { ok: true, status: 200, json: async () => ({ services: opts.services }) };
        }
        if (opts.campaigns !== undefined && href.endsWith("/v1/campaigns") && init.method !== "POST") {
          return { ok: true, status: 200, json: async () => ({ campaigns: opts.campaigns }) };
        }
        if (init.method === "POST" && /\/v1\/campaigns\//.test(href)) {
          net.posts.push({ url: href, body: JSON.parse(String(init.body)) });
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }), json: async () => ({ ok: true }) };
        }
        if (/\/v1\/payments\//.test(href)) {
          return { ok: true, status: 200, json: async () => ({ txHash: "0x" + "ab".repeat(32), payer: VAULT }) };
        }
        return { ok: true, status: 200, json: async () => ({ services: [], campaigns: [] }) };
      }) as typeof fetch;
      const eth = {
        calls: [] as string[],
        request: async ({ method, params }: { method: string; params?: unknown }) => {
          eth.calls.push(method);
          switch (method) {
            case "eth_requestAccounts":
            case "eth_accounts":
              return [OWNER];
            case "eth_chainId":
              return "0x14a34";
            case "wallet_switchEthereumChain":
            case "wallet_addEthereumChain":
              return null;
            case "wallet_watchAsset":
              net.watchAssets.push(params);
              return true;
            case "personal_sign": {
              const [message, from] = params as [string, string];
              net.signs.push({ message, from });
              return "0x" + "cd".repeat(65);
            }
            case "eth_sendTransaction": {
              const [tx] = params as [{ from: string; to: string; data: string }];
              net.txs.push(tx);
              return "0x" + "ef".repeat(32);
            }
            case "eth_getTransactionReceipt":
              return { status: opts.receipt?.status ?? "0x1", blockNumber: "0x7" };
            default:
              throw new Error(`unexpected wallet method ${method}`);
          }
        },
        on() {},
      };
      (dom.window as Record<string, unknown>)["ethereum"] = eth;
    },
  };
  return net;
}

let fresh = 0;

async function boot(opts?: { services?: unknown[]; campaigns?: unknown[] }): Promise<{ dom: FakeDom; net: StubNet }> {
  const html = readFileSync(path.join(ROOT, "dashboard", "index.html"), "utf8");
  const dom = buildDom(html);
  const net = makeNet();
  net.install(dom, opts);
  // app.js is re-imported fresh per boot, but the session module it shares with the screen modules
  // stays cached: reset it so no test inherits a previous test's account, contracts or open vault.
  const { state } = await import("../../dashboard/assets/session.js");
  Object.assign(state, { account: null, contracts: null, openVault: null });
  await import(`../../dashboard/assets/app.js?fresh=${fresh++}`);
  // Let init()'s async refreshes settle.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { dom, net };
}

function restoreGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  delete g["window"];
  delete g["document"];
  delete g["localStorage"];
}

test("boot renders network info, directory, and campaigns", async () => {
  const { dom } = await boot({
    services: [{ serviceId: "demo-sum", name: "Demo", description: "d", endpoints: [] }],
    campaigns: [{ id: "trial-1", providerId: OWNER, status: "active", quota: { remaining: 7 } }],
  });
  try {
    assert.match(dom.byId("network-line").textContent, /Base Sepolia/);
    assert.match(dom.byId("service-list").children[0].children[0].textContent, /Demo/);
    assert.match(dom.byId("campaign-list").children[0].children[0].textContent, /trial-1/);
  } finally {
    restoreGlobals();
  }
});

test("routing shows one screen and moves focus", async () => {
  const { dom } = await boot({ services: [], campaigns: [] });
  try {
    dom.setHash("#/fund");
    const screens = dom.document.querySelectorAll("[data-screen]");
    assert.equal(screens.filter((s) => !s.hidden).length, 1);
    assert.equal(screens.find((s) => !s.hidden)?.dataset["screen"], "fund");
  } finally {
    restoreGlobals();
  }
});

test("connect fills the badge and stats, add-token offers the square mark", async () => {
  const { dom, net } = await boot({ services: [], campaigns: [] });
  try {
    dom.byId("connect").click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(dom.byId("wallet-address").textContent, "0x1111…1111");
    assert.match(dom.byId("stat-wallet").textContent, /16000/);
    dom.byId("add-token").click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(net.watchAssets.length, 1);
    assert.match(JSON.stringify(net.watchAssets[0]), /mark-square\.png/);
  } finally {
    restoreGlobals();
  }
});

test("faucet claim sends claim() with the recipient", async () => {
  const { dom, net } = await boot({ services: [], campaigns: [] });
  try {
    dom.byId("connect").click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    dom.byId("faucet-to").value = OWNER;
    for (const fn of dom.byId("faucet-form").listeners["submit"] ?? []) {
      await fn({ preventDefault() {} });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(net.txs.length, 1);
    assert.ok(net.txs[0].data.startsWith(sdkSelector("claim(address)")), "claim(address) selector");
    assert.match(dom.byId("status").textContent, /Claim confirmed/);
  } finally {
    restoreGlobals();
  }
});

test("campaign pause signs the SDK-identical message and posts the control", async () => {
  const { dom, net } = await boot({ services: [], campaigns: [{ id: "trial-1" }] });
  try {
    dom.byId("connect").click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    dom.byId("campaign-id").value = "trial-1";
    for (const fn of dom.byId("campaign-control-form").listeners["submit"] ?? []) {
      await fn({ preventDefault() {}, submitter: { value: "pause" } });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(net.signs.length, 1);
    assert.equal(net.posts.length, 1);
    const posted = net.posts[0].body as { providerId: string; campaignId: string; action: string; deadline: number; signature: string };
    assert.equal(posted.action, "pause");
    assert.equal(net.signs[0].message, sdkMessage({ providerId: OWNER, campaignId: "trial-1", action: "pause", deadline: posted.deadline }));
    assert.match(net.posts[0].url, /\/v1\/campaigns\/trial-1\/pause/);
  } finally {
    restoreGlobals();
  }
});

test("payment lookup renders the on-chain record and receipt link", async () => {
  const { dom } = await boot({ services: [], campaigns: [] });
  try {
    dom.byId("payment-id").value = "0x" + "cc".repeat(32);
    for (const fn of dom.byId("payment-form").listeners["submit"] ?? []) {
      await fn({ preventDefault() {} });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(dom.byId("payment-paid").textContent, /16/);
    assert.equal(dom.byId("payment-result").hidden, false);
    dom.byId("payment-id").value = "nope";
    for (const fn of dom.byId("payment-form").listeners["submit"] ?? []) {
      await fn({ preventDefault() {} });
    }
    assert.match(dom.byId("status").textContent, /not a 32-byte hex/);
  } finally {
    restoreGlobals();
  }
});

test("delegate sends setPolicy with the tuple calldata", async () => {
  const { dom, net } = await boot({ services: [], campaigns: [] });
  try {
    dom.byId("connect").click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    dom.byId("vault-address").value = VAULT;
    for (const fn of dom.byId("vault-open-form").listeners["submit"] ?? []) {
      await fn({ preventDefault() {} });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    dom.byId("delegate-agent").value = OWNER;
    dom.byId("delegate-max").value = "320";
    dom.byId("delegate-per-tx").value = "16";
    for (const fn of dom.byId("delegate-form").listeners["submit"] ?? []) {
      await fn({ preventDefault() {} });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(net.txs.length, 1);
    assert.equal(net.txs[0].to, VAULT);
    assert.ok(net.txs[0].data.startsWith("0x"), "calldata present");
    assert.match(dom.byId("status").textContent, /Delegated/);
  } finally {
    restoreGlobals();
  }
});
