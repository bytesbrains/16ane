// Unit tests for scripts/coverage-report.ts (#55): LCOV parsing and merging, coverable-path
// filtering, diff intersection, and threshold verdicts.
import test from "node:test";
import assert from "node:assert/strict";
import {
  changedCoverage,
  coverableFileCount,
  groupOf,
  isCoverable,
  mergeLcov,
  normalizePath,
  parseArgs,
  parseDiff,
  parseLcov,
  renderReport,
  totalOf,
} from "../../scripts/coverage-report.ts";

const LCOV_A = `TN:
SF:src/A.sol
FN:3,send
FNF:1
FNH:1
DA:3,2
DA:4,0
DA:5,1
BRDA:4,0,0,1
BRDA:4,0,1,-
BRDA:4,0,2,0
BRF:3
BRH:1
end_of_record
SF:packages/sdk-ts/test/a.test.ts
DA:1,5
end_of_record
`;

const LCOV_B = `TN:
SF:./src/A.sol
DA:4,3
DA:6,1
BRDA:4,0,1,2
end_of_record
SF:src/B.sol
DA:1,0
end_of_record
`;

test("parseLcov reads hits and branch outcomes, ignoring function records", () => {
  const files = parseLcov(LCOV_A);
  const a = files.get("src/A.sol");
  assert.ok(a);
  assert.equal(a.lines.get(3), 2);
  assert.equal(a.lines.get(4), 0);
  assert.equal(a.branches.get("4:0:0"), true);
  assert.equal(a.branches.get("4:0:1"), false);
  assert.equal(a.branches.get("4:0:2"), false);
});

test("mergeLcov unions hits: a line or branch covered by any suite counts", () => {
  const merged = mergeLcov([parseLcov(LCOV_A), parseLcov(LCOV_B)]);
  const a = merged.get("src/A.sol");
  assert.ok(a);
  assert.equal(a.lines.get(3), 2);
  assert.equal(a.lines.get(4), 3); // 0 in A, 3 in B
  assert.equal(a.lines.get(6), 1);
  assert.equal(a.branches.get("4:0:1"), true); // untaken in A, taken in B
  assert.ok(merged.get("src/B.sol"));
});

test("normalizePath strips ./ and relativizes absolute paths", () => {
  assert.equal(normalizePath("./src/A.sol"), "src/A.sol");
  assert.equal(normalizePath("src/A.sol"), "src/A.sol");
  assert.equal(normalizePath(`${process.cwd()}/src/A.sol`), "src/A.sol");
});

test("isCoverable keeps first-party sources and drops tests, vendors and docs", () => {
  for (const file of [
    "src/AneAgentVault.sol",
    "packages/sdk-ts/src/client.ts",
    "packages/cli/bin/ane.mjs",
    "services/sandbox-server/src/server.ts",
    "packages/sdk-py/ane_sdk/client.py",
    "scripts/api-health.ts",
  ]) {
    assert.equal(isCoverable(file), true, file);
  }
  for (const file of [
    "e2e/harness.ts",
    "e2e/signed-actions.ts",
    "packages/sdk-ts/test/sdk.test.ts",
    "packages/sdk-py/tests/test_sdk.py",
    "services/sandbox-server/test/x.test.ts",
    "test/AneAgentVault.t.sol",
    "src/test-helpers.sol",
    "e2e/conftest.py",
    "node_modules/leftpad/index.js",
    "lib/forge-std/src/Vm.sol",
    "out/AneAgentVault.sol/AneAgentVault.json",
    "docs/coverage.md",
    "scripts/check-committed-files.sh",
  ]) {
    assert.equal(isCoverable(file), false, file);
  }
});

test("groupOf buckets every coverable path, with an other fallback", () => {
  assert.equal(groupOf("src/A.sol"), "contracts");
  assert.equal(groupOf("packages/sdk-ts/src/a.ts"), "sdk-ts");
  assert.equal(groupOf("packages/cli/bin/ane.mjs"), "cli");
  assert.equal(groupOf("services/sandbox-server/src/a.ts"), "server");
  assert.equal(groupOf("packages/sdk-py/ane_sdk/a.py"), "sdk-py");
  assert.equal(groupOf("e2e/harness.ts"), "e2e");
  assert.equal(groupOf("scripts/a.ts"), "scripts");
  assert.equal(groupOf("packages/cli/test/a.test.ts"), "cli");
  assert.equal(groupOf("services/other/x.ts"), "other");
});

test("parseDiff collects added lines per new path only", () => {
  const diff = [
    "diff --git a/src/A.sol b/src/A.sol",
    "--- a/src/A.sol",
    "+++ b/src/A.sol",
    "@@ -3,3 +3,4 @@",
    " ctx",
    "-gone",
    "+added-one",
    "+added-two",
    " ctx",
    "diff --git a/gone.ts b/gone.ts",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-all gone",
    "\\ No newline at end of file",
    "diff --git a/docs/x.md b/docs/x.md",
    "--- a/docs/x.md",
    "+++ b/docs/x.md",
    "@@ -1 +1,2 @@",
    " ctx",
    "+doc line",
  ].join("\n");
  const changed = parseDiff(diff);
  assert.deepEqual([...(changed.get("src/A.sol") ?? [])].sort((a, b) => a - b), [4, 5]);
  assert.ok(!changed.has("gone.ts"));
  assert.deepEqual([...(changed.get("docs/x.md") ?? [])], [2]);
});

test("changedCoverage intersects added lines with executable lines, skipping the rest", () => {
  const files = parseLcov(LCOV_A);
  const changed = new Map([
    ["src/A.sol", new Set([3, 4, 99])], // hit, missed, not executable
    ["docs/x.md", new Set([1])], // not coverable
    ["src/missing.sol", new Set([1])], // not in the report
  ]);
  assert.deepEqual(changedCoverage(files, changed), { coverable: 2, covered: 1, files: 1 });
  assert.equal(changedCoverage(files, new Map([["docs/x.md", new Set([1])]])), undefined);
});

test("renderReport tabulates groups, totals, changed lines and a PASS verdict", () => {
  const files = mergeLcov([parseLcov(LCOV_A), parseLcov(LCOV_B)]);
  const { markdown, breaches } = renderReport({
    files,
    changed: { coverable: 2, covered: 2, files: 1 },
    thresholds: { linesTotal: 50, branchesTotal: 15, linesChanged: 50 },
  });
  assert.match(markdown, /\| contracts \| 4\/5 \(80\.0%\) \| 2\/3 \(66\.7%\) \|/);
  assert.match(markdown, /\| \*\*total\*\* \| 4\/5 \(80\.0%\) \| 2\/3 \(66\.7%\) \|/);
  assert.ok(!markdown.includes("sdk-ts"), "groups with no files are omitted");
  assert.match(markdown, /Changed lines: \*\*2\/2 \(100\.0%\)\*\* in 1 coverable file/);
  assert.match(markdown, /THRESHOLDS.*PASS/i);
  assert.deepEqual(breaches, []);
});

test("renderReport lists every breach and fails, with n/a where nothing is measurable", () => {
  const files = parseLcov("SF:packages/cli/bin/ane.mjs\nDA:1,0\nend_of_record\n");
  const { markdown, breaches } = renderReport({
    files,
    changed: undefined,
    thresholds: { linesTotal: 50, branchesTotal: 15, linesChanged: 50 },
  });
  assert.match(markdown, /\| cli \| 0\/1 \(0\.0%\) \| n\/a \|/);
  assert.match(markdown, /Changed lines: n\/a/);
  assert.match(markdown, /\*\*FAIL\*\* — total line coverage 0\.0% is below 50%/);
  assert.deepEqual(breaches, ["total line coverage 0.0% is below 50%"]);
});

test("renderReport flags a changed-line breach on its own", () => {
  const files = parseLcov("SF:src/A.sol\nDA:1,1\nDA:2,0\nend_of_record\n");
  const { breaches } = renderReport({
    files,
    changed: { coverable: 4, covered: 1, files: 1 },
    thresholds: { linesTotal: 50, branchesTotal: 15, linesChanged: 50 },
  });
  assert.deepEqual(breaches, ["changed-line coverage 25.0% is below 50%"]);
});

test("totalOf counts hits over the files a predicate keeps", () => {
  const files = parseLcov(LCOV_A);
  assert.deepEqual(totalOf(files, () => true), {
    linesFound: 4,
    linesHit: 3,
    branchesFound: 3,
    branchesHit: 1,
  });
  assert.deepEqual(totalOf(files, isCoverable), {
    linesFound: 3,
    linesHit: 2,
    branchesFound: 3,
    branchesHit: 1,
  });
});

test("coverableFileCount sees only first-party files, so an empty report fails loud", () => {
  assert.equal(coverableFileCount(parseLcov(LCOV_A)), 1);
  assert.equal(coverableFileCount(new Map()), 0);
});

test("parseArgs takes repeatable --lcov, options and threshold overrides", () => {
  const args = parseArgs([
    "--lcov",
    "a.lcov",
    "--lcov",
    "b.lcov",
    "--diff",
    "d.diff",
    "--summary",
    "s.md",
    "--min-lines-total",
    "70",
    "--min-branches-total",
    "20",
    "--min-lines-changed",
    "80",
  ]);
  assert.deepEqual(args.lcovFiles, ["a.lcov", "b.lcov"]);
  assert.equal(args.diffFile, "d.diff");
  assert.equal(args.summaryFile, "s.md");
  assert.deepEqual(args.thresholds, { linesTotal: 70, branchesTotal: 20, linesChanged: 80 });
});

test("parseArgs rejects missing lcov files, unknown flags and bad values", () => {
  assert.throws(() => parseArgs([]), /At least one --lcov/);
  assert.throws(() => parseArgs(["--lcov", "a.lcov", "--bogus"]), /Unknown or incomplete flag/);
  assert.throws(() => parseArgs(["--lcov"]), /Unknown or incomplete flag/);
  assert.throws(() => parseArgs(["--lcov", "a.lcov", "--min-lines-total", "high"]), /Unknown or incomplete/);
});
