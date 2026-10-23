// Checks for the onboarding guides and the hackathon kit docs (#20): every link resolves, every command
// they tell a participant to type exists, the English and Hindi guides give the same commands, and each
// document carries the no-value callout without promotional wording (REQ-012). The commands themselves
// run end to end in CI as `npm run kit:demo`.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DOCS = [
  "docs/guides/ONBOARDING.md",
  "docs/guides/ONBOARDING.hi.md",
  "examples/hackathon-kit/README.md",
  "examples/hackathon-kit/WORKSHOP.md",
];
const CALLOUT = "TEST TOKENS — NO MONETARY VALUE";
const EXTERNAL_ALLOWED = ["https://book.getfoundry.sh/", "https://github.com/bytesbrains/16ane", "https://api.16ane.com"];
// Promotional or value-implying wording (AGENTS.md), checked outside the callout, which is where the
// negations ("cannot be redeemed") belong.
const DENYLIST = [/\binvest/i, /\breturns\b/i, /\bairdrops?\b/i, /\bpre-?sale\b/i, /\bprofits?\b/i, /\bapy\b/i, /\bguarantee/i, /\b(₹|inr|rupee)[- ]backed\b/i, /मुनाफ़ा|निवेश|गारंटी/];
const OWNER_SUBCOMMANDS = ["setup", "status", "revoke", "withdraw"];

const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;

function withoutCallout(md: string): string {
  return md.replace(/> \[!IMPORTANT\][\s\S]*?\n\n/, "\n");
}

function codeBlocks(md: string): string[] {
  return [...md.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
}

/** Command lines from bash blocks, comments stripped. */
function commands(md: string): string[] {
  return codeBlocks(md)
    .flatMap((block) => block.split("\n"))
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter(Boolean);
}

/** Commands quoted inline in prose, such as `npm run kit:owner -- revoke`. */
function inlineCommands(md: string): string[] {
  return [...md.matchAll(/`((?:npm run|python3) [^`]+)`/g)].map((m) => m[1]);
}

function slug(heading: string): string {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");
}

for (const doc of DOCS) {
  test(`${doc}: carries the no-monetary-value callout first`, () => {
    const md = read(doc);
    const callout = md.indexOf(CALLOUT);
    assert.ok(callout >= 0, "missing the TEST TOKENS — NO MONETARY VALUE callout");
    assert.ok(callout < md.indexOf("\n## "), "the callout comes before the first section");
  });

  test(`${doc}: no promotional or value-implying wording`, () => {
    const body = withoutCallout(read(doc));
    for (const word of DENYLIST) assert.doesNotMatch(body, word);
  });

  test(`${doc}: every link resolves`, () => {
    const md = read(doc);
    for (const [, target] of md.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^https?:/.test(target)) {
        assert.ok(EXTERNAL_ALLOWED.some((p) => target.startsWith(p)), `external link not allowlisted: ${target}`);
        continue;
      }
      const [file, anchor] = target.split("#");
      const resolved = file ? path.resolve(path.dirname(path.join(ROOT, doc)), file) : path.join(ROOT, doc);
      assert.ok(existsSync(resolved), `broken link: ${target}`);
      if (anchor) {
        const headings = [...readFileSync(resolved, "utf8").matchAll(/^#+ (.+)$/gm)].map((m) => slug(m[1]));
        assert.ok(headings.includes(anchor), `broken anchor: ${target}`);
      }
    }
  });

  test(`${doc}: every command it gives exists`, () => {
    const md = read(doc);
    for (const cmd of [...commands(md), ...inlineCommands(md)]) {
      const npm = cmd.match(/^npm run ([\w:-]+)(?: -- (\S+))?/);
      if (npm) {
        assert.ok(scripts[npm[1]], `no npm script "${npm[1]}" (in: ${cmd})`);
        if (npm[1] === "kit:owner" && npm[2]) {
          assert.ok(OWNER_SUBCOMMANDS.includes(npm[2]), `no kit:owner subcommand "${npm[2]}"`);
        }
        continue;
      }
      const py = cmd.match(/^python3 (\S+)/);
      if (py) {
        assert.ok(existsSync(path.join(ROOT, py[1])), `no file ${py[1]} (in: ${cmd})`);
        continue;
      }
      assert.match(cmd, /^(git clone|cd 16ane|npm ci)\b/, `unchecked command: ${cmd}`);
    }
  });
}

test("the owner script implements every subcommand the guides use", () => {
  const owner = read("examples/hackathon-kit/owner.ts");
  for (const sub of OWNER_SUBCOMMANDS) assert.match(owner, new RegExp(`command === "${sub}"`));
});

test("the English and Hindi guides give exactly the same commands", () => {
  assert.deepEqual(commands(read("docs/guides/ONBOARDING.hi.md")), commands(read("docs/guides/ONBOARDING.md")));
});

test("the Hindi guide states the disclaimer in Hindi too", () => {
  const md = read("docs/guides/ONBOARDING.hi.md");
  assert.ok(md.includes("टेस्ट टोकन — कोई मौद्रिक मूल्य नहीं"));
  assert.ok(md.includes("यह ₹1,000 या कोई भी रक़म **नहीं** है"), "the 16,000 tANE ≠ ₹1,000 warning is translated");
});

test("both guides link to each other", () => {
  assert.ok(read("docs/guides/ONBOARDING.md").includes("(ONBOARDING.hi.md)"));
  assert.ok(read("docs/guides/ONBOARDING.hi.md").includes("(ONBOARDING.md)"));
});

test("kit state is gitignored, so generated keys are never committed", () => {
  assert.match(read(".gitignore"), /^examples\/hackathon-kit\/\.kit\/$/m);
});
