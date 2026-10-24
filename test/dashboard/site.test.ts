// Static checks for the dashboard (app.16ane.com): headers/CSP, disclosures,
// wording denylist, markup hygiene, link integrity. Mirrors test/web/site.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..", "..");
const DASHBOARD = path.join(ROOT, "dashboard");
const PAGES = ["index.html", "404.html"];
const REPO = "https://github.com/bytesbrains/16ane";
const DENYLIST = [
  /\bpresale\b/i,
  /\btoken sale\b/i,
  /\bairdrop\b/i,
  /\bapy\b/i,
  /\bstaking rewards?\b/i,
  /\bguaranteed returns?\b/i,
  /₹\s*\d/,
  /\$\s*\d/,
];

function read(rel: string): string {
  return readFileSync(path.join(DASHBOARD, rel), "utf8");
}

function text(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function headerRule(pattern: string): string {
  const lines = read("_headers").split("\n");
  const start = lines.findIndex((line) => line.trim() === pattern);
  assert.ok(start >= 0, `missing _headers rule ${pattern}`);
  const rule: string[] = [];
  for (let i = start + 1; i < lines.length && /^\s+\S/.test(lines[i]); i++) {
    rule.push(lines[i].trim());
  }
  return rule.join("\n");
}

test("dashboard _headers carry the hardening set and a script-allowing CSP", () => {
  const root = headerRule("/*");
  assert.match(root, /X-Frame-Options: DENY/);
  assert.match(root, /X-Content-Type-Options: nosniff/);
  assert.match(root, /frame-ancestors 'none'/);
  assert.match(root, /object-src 'none'/);
  assert.match(root, /base-uri 'none'/);
  assert.match(root, /form-action 'none'/);
  const csp = root.match(/Content-Security-Policy: ([^\n]+)/)?.[1] ?? "";
  assert.match(csp, /default-src 'none'/);
  // Unlike 16ane.com, the dashboard runs its own scripts — but only its own.
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.match(csp, /style-src 'self'/);
  assert.match(root, /Strict-Transport-Security: max-age=31536000/);
  assert.match(headerRule("https://:version.:subdomain.workers.dev/*"), /X-Robots-Tag: noindex/);
});

test("dashboard CSP connect-src matches the committed network's RPC and API", () => {
  const net = JSON.parse(readFileSync(path.join(ROOT, "networks", "sandbox-sepolia.json"), "utf8")) as {
    rpcUrl: string;
  };
  const csp = headerRule("/*").match(/Content-Security-Policy: ([^\n]+)/)?.[1] ?? "";
  // The exact source list: same-origin, the network RPC and the sandbox API,
  // nothing more and no look-alike hosts.
  const connect = (csp.match(/connect-src ([^;]+)/)?.[1] ?? "").trim().split(/\s+/);
  assert.deepEqual(connect, ["'self'", net.rpcUrl, "https://api.16ane.com"]);
});

test("every dashboard screen carries the no-cash-value disclosure", () => {
  const html = read("index.html");
  assert.match(html, /<p class="sandbox" role="note">[\s\S]*?NO CASH VALUE/);
  const screens = [...html.matchAll(/<section data-screen="([a-z]+)"[\s\S]*?<\/section>/g)];
  assert.ok(screens.length >= 7, "expected the dashboard screens");
  for (const m of screens) {
    assert.match(m[0], /NO CASH VALUE/, `screen ${m[1]} shows the disclaimer`);
  }
});

test("dashboard states the exact REQ-012 disclosure and no sale wording", () => {
  const body = text(read("index.html"));
  assert.ok(body.includes("NO CASH VALUE"));
  assert.ok(!/token sale|presale/i.test(body) || /no token sale/i.test(body));
});

for (const page of PAGES) {
  test(`${page}: no promotional or value-implying wording`, () => {
    const body = text(read(page));
    for (const word of DENYLIST) assert.doesNotMatch(body, word);
  });

  test(`${page}: no inline scripts, styles or event handlers`, () => {
    const html = read(page);
    for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
      assert.match(tag, /src="/, "script tags load files, never inline code");
    }
    assert.doesNotMatch(html, /\sstyle=|<style/i);
    assert.doesNotMatch(html, /\son[a-z]+=/i);
  });

  test(`${page}: local references exist and external links stay allowlisted`, () => {
    const html = read(page);
    const refs = [...html.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length > 0);
    for (const ref of refs) {
      if (ref.startsWith("#")) continue;
      if (/^https?:/.test(ref)) {
        const ok =
          ref === REPO ||
          ref.startsWith(`${REPO}/`) ||
          ref.startsWith(`${REPO}#`) ||
          ref.startsWith("https://16ane.com/") ||
          ref.startsWith("https://app.16ane.com/");
        assert.ok(ok, `external link ${ref}`);
        continue;
      }
      const file = ref === "/" ? "index.html" : ref.replace(/^\//, "");
      assert.ok(existsSync(path.join(DASHBOARD, file)), `missing ${ref}`);
    }
  });

  test(`${page}: images have alt text and the document declares its language`, () => {
    const html = read(page);
    assert.match(html, /<html lang="en">/);
    for (const img of html.match(/<img[^>]*>/g) ?? []) assert.match(img, /\salt="/);
  });

  test(`${page}: forms label every control`, () => {
    const html = read(page);
    const ids = new Set([...html.matchAll(/<(?:input|select|textarea)[^>]*\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const id of ids) {
      assert.ok(html.includes(`for="${id}"`), `control #${id} has a label`);
    }
  });
}

test("dashboard scripts use no innerHTML, eval, or dynamic code loading", () => {
  // Rendered chain/API data must never become markup: textContent only.
  const sources = [
    "assets/app.js",
    "assets/api.js",
    "assets/contracts.js",
    "assets/provider.js",
    "assets/provider-screens.js",
    "assets/session.js",
    "assets/ui.js",
  ];
  for (const rel of sources) {
    const js = read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|\s)\/\/.*$/gm, " ");
    assert.doesNotMatch(js, /innerHTML|outerHTML|document\.write|eval\(|new Function|import\(/, `${rel} builds DOM safely`);
  }
});

test("the dashboard offers the square wallet mark over absolute https (EIP-747)", () => {
  const app = read("assets/app.js");
  assert.ok(app.includes("https://16ane.com/mark-square.png"), "watchAsset image is the square mark");
  assert.ok(
    existsSync(path.join(ROOT, "web", "mark-square.png")),
    "the wallet mark is served from the apex site",
  );
});

test("the committed dashboard is exactly the sandbox-sepolia generator build", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dashboard-env-"));
  try {
    execFileSync(process.execPath, [path.join(ROOT, "scripts", "dashboard-env.cjs"), "sandbox-sepolia", tmp], {
      stdio: "pipe",
    });
    for (const rel of ["assets/network.js", "_headers"]) {
      assert.equal(
        readFileSync(path.join(tmp, rel), "utf8"),
        read(rel),
        `${rel} must be regenerated, never edited`,
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
