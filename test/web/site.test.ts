// Checks for the static 16ane.com site in web/ (ADR-0015, #36). The page is the project's most public
// statement, so what it may say and what it may load are tested, not left to review.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const WEB = path.resolve(import.meta.dirname, "../../web");
const PAGES = ["index.html", "404.html"];
const DISCLAIMER = "TEST TOKENS (tANE) - NO CASH VALUE";
const REPO = "https://github.com/bytesbrains/16ane";

// Promotional or value-implying wording (AGENTS.md: tANE is never advertised as ₹-backed, redeemable,
// investable or convertible). Negations such as "no presale" belong only inside the disclaimer block,
// which is removed before this check.
const DENYLIST = [
  /\binvest/i, /\breturns\b/i, /\bredeem/i, /\b(₹|inr|rupee)[- ]backed\b/i, /\bairdrops?\b/i,
  /\bpre-?sale\b/i, /\blist(ed|ing)\b/i, /\bguarantee/i, /\bprofits?\b/i, /\bapy\b/i, /\bbuy (t?ane|tokens?)\b/i,
];

const read = (file: string): string => readFileSync(path.join(WEB, file), "utf8");

function text(html: string): string {
  return html
    .replace(/<section[^>]*data-disclaimer[\s\S]*?<\/section>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/g, " ");
}

function headerRule(pattern: string): string {
  const block = read("_headers").split(/\n(?=\S)/).find((b) => b.split("\n")[0].trim() === pattern);
  assert.ok(block, `_headers has a rule for ${pattern}`);
  return block;
}

test("every response carries a strict CSP and the baseline security headers", () => {
  const rule = headerRule("/*");
  const csp = rule.match(/Content-Security-Policy: (.+)/)?.[1] ?? "";
  for (const directive of ["default-src 'none'", "style-src 'self'", "img-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) {
    assert.ok(csp.includes(directive), `CSP includes ${directive}`);
  }
  assert.doesNotMatch(csp, /unsafe-|script-src|https?:/, "CSP allows no scripts, inline code or other origins");
  assert.match(rule, /Strict-Transport-Security: max-age=\d{8,}/);
  assert.match(rule, /X-Content-Type-Options: nosniff/);
  assert.match(rule, /X-Frame-Options: DENY/);
  assert.match(rule, /Referrer-Policy: /);
});

test("preview copies on workers.dev are kept out of search", () => {
  assert.match(headerRule("https://:version.:subdomain.workers.dev/*"), /X-Robots-Tag: noindex/);
});

test("the home page carries the exact no-cash-value disclosure (REQ-012)", () => {
  const html = read("index.html");
  const block = html.match(/<section[^>]*data-disclaimer[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.ok(block.includes(DISCLAIMER), "disclosure heading is inside the disclaimer block");
  assert.match(block, /no token sale/i);
});

for (const page of PAGES) {
  test(`${page}: no promotional or value-implying wording`, () => {
    const body = text(read(page));
    for (const word of DENYLIST) assert.doesNotMatch(body, word);
  });

  test(`${page}: no scripts, inline styles or event handlers`, () => {
    const html = read(page);
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /\sstyle=|<style/i);
    assert.doesNotMatch(html, /\son[a-z]+=/i);
  });

  test(`${page}: local references exist and external links stay on the project repository`, () => {
    const html = read(page);
    const refs = [...html.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length > 0);
    for (const ref of refs) {
      if (ref.startsWith("#")) continue;
      if (/^https?:/.test(ref)) {
        if (ref === "https://16ane.com/") continue;
        assert.ok(ref === REPO || ref.startsWith(`${REPO}/`) || ref.startsWith(`${REPO}#`), `external link ${ref}`);
        continue;
      }
      const file = ref === "/" ? "index.html" : ref.replace(/^\//, "");
      assert.ok(existsSync(path.join(WEB, file)), `missing ${ref}`);
    }
  });

  test(`${page}: images have alt text and the document declares its language`, () => {
    const html = read(page);
    assert.match(html, /<html lang="en">/);
    for (const img of html.match(/<img[^>]*>/g) ?? []) assert.match(img, /\salt="/);
  });
}

test("any mention of the ANE peg stays a qualified proposal (AGENTS.md, ADR-0012)", () => {
  for (const page of PAGES) {
    const body = text(read(page)).replace(/\s+/g, " ");
    if (!/16 ANE =/.test(body)) continue;
    assert.match(body, /proposal, not a promise/i, `${page}: the peg is called a proposal`);
    assert.match(body, /Indian law and regulators allow/i, `${page}: the peg is conditional on regulators`);
    assert.match(body, /tANE will never turn into ANE/i, `${page}: tANE never converts`);
  }
});

test("link previews point at a real image with its true size (Open Graph)", () => {
  const html = read("index.html");
  const meta = (key: string) =>
    html.match(new RegExp(`<meta (?:property|name)="${key}" content="([^"]+)">`))?.[1];
  const image = meta("og:image") ?? "";
  assert.match(image, /^https:\/\/16ane\.com\/[\w.-]+\.png$/, "og:image is an absolute 16ane.com PNG URL");
  const png = readFileSync(path.join(WEB, image.slice("https://16ane.com/".length)));
  // PNG IHDR: width and height are big-endian uint32s at bytes 16 and 20.
  assert.equal(meta("og:image:width"), String(png.readUInt32BE(16)));
  assert.equal(meta("og:image:height"), String(png.readUInt32BE(20)));
  assert.ok(png.length <= 1024 * 1024, "og:image stays under 1 MB");
  assert.equal(meta("twitter:card"), "summary_large_image");
  assert.equal(meta("og:url"), "https://16ane.com/");
});

test("security.txt names a contact and has not expired (RFC 9116)", () => {
  const body = read(".well-known/security.txt");
  assert.match(body, new RegExp(`^Contact: ${REPO}/security/advisories/new$`, "m"));
  assert.match(body, /^Contact: mailto:security@16ane\.com$/m);
  const expires = body.match(/^Expires: (.+)$/m)?.[1];
  assert.ok(expires && Date.parse(expires) > Date.now(), "Expires is in the future; renew it");
});

test("the site workflow checks but never deploys, and runs no install scripts (ADR-0015)", () => {
  const wf = readFileSync(path.resolve(import.meta.dirname, "../../.github/workflows/site.yml"), "utf8");
  assert.doesNotMatch(wf, /pull_request_target|secrets\.|CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(wf, /wrangler deploy(?! --dry-run)/);
  for (const line of wf.match(/npm (ci|install)\b.*/g) ?? []) assert.match(line, /--ignore-scripts/);
});
