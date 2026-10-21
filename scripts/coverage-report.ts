// Coverage report for CI (#55): merges LCOV files from the forge, node and coverage.py suites,
// computes per-group and total line/branch coverage plus changed-line coverage from a unified diff,
// writes a GitHub job summary, and fails below the thresholds.
//   node --experimental-strip-types scripts/coverage-report.ts --lcov <file> [--lcov <file>...]
//     [--diff <unified-diff>] [--summary <file>]
//     [--min-lines-total <pct>] [--min-branches-total <pct>] [--min-lines-changed <pct>]
// Exit codes: 0 thresholds met, 1 below a threshold (the report is still written first), 2 bad usage.
import { readFileSync, appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

// Provisional floors: the first CI run on real data sets the baseline, and these move to just
// under it (see #55). They must pass on current code — raising coverage is explicitly non-scope.
export const DEFAULT_MIN_LINES_TOTAL = 50;
export const DEFAULT_MIN_BRANCHES_TOTAL = 15;
export const DEFAULT_MIN_LINES_CHANGED = 50;

export interface FileCoverage {
  lines: Map<number, number>;
  branches: Map<string, boolean>;
}

export function normalizePath(sf: string): string {
  const stripped = sf.startsWith("./") ? sf.slice(2) : sf;
  if (path.isAbsolute(stripped)) return path.relative(process.cwd(), stripped).replaceAll(path.sep, "/");
  return stripped;
}

const CODE_EXTENSIONS = [".sol", ".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".py"];

// First-party code under coverage. Test files are excluded (they always execute); node_modules,
// build output and anything outside the known source trees never counts.
export function isCoverable(file: string): boolean {
  if (!/^(src|packages|services|e2e|scripts)\//.test(file)) return false;
  if (!CODE_EXTENSIONS.some((ext) => file.endsWith(ext))) return false;
  if (file.split("/").some((seg) => seg === "test" || seg === "tests" || seg === "__tests__")) return false;
  const base = file.split("/").at(-1) ?? "";
  if (
    base.startsWith("test_") ||
    base.startsWith("test-") ||
    base.includes(".test.") ||
    base.includes("_test.") ||
    base === "conftest.py"
  ) {
    return false;
  }
  return true;
}

export function groupOf(file: string): string {
  if (file.startsWith("src/")) return "contracts";
  if (file.startsWith("packages/sdk-ts/src/")) return "sdk-ts";
  if (file.startsWith("packages/cli/")) return "cli";
  if (file.startsWith("services/sandbox-server/src/")) return "server";
  if (file.startsWith("packages/sdk-py/ane_sdk/")) return "sdk-py";
  if (file.startsWith("e2e/")) return "e2e";
  if (file.startsWith("scripts/")) return "scripts";
  return "other";
}

// A line counts as covered when any suite hit it; a branch when any suite took it.
export function parseLcov(text: string): Map<string, FileCoverage> {
  const files = new Map<string, FileCoverage>();
  let current: FileCoverage | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("SF:")) {
      const file = normalizePath(line.slice(3));
      current = files.get(file);
      if (!current) {
        current = { lines: new Map(), branches: new Map() };
        files.set(file, current);
      }
    } else if (current && line.startsWith("DA:")) {
      const [num, hits] = line.slice(3).split(",");
      const n = Number(num);
      if (Number.isInteger(n)) current.lines.set(n, Math.max(current.lines.get(n) ?? 0, Number(hits) || 0));
    } else if (current && line.startsWith("BRDA:")) {
      const parts = line.slice(5).split(",");
      const taken = parts[3] ?? "-";
      current.branches.set(`${parts[0]}:${parts[1]}:${parts[2]}`, taken !== "-" && taken !== "0");
    } else if (line === "end_of_record") {
      current = undefined;
    }
  }
  return files;
}

export function mergeLcov(maps: Map<string, FileCoverage>[]): Map<string, FileCoverage> {
  const merged = new Map<string, FileCoverage>();
  for (const map of maps) {
    for (const [file, cov] of map) {
      let into = merged.get(file);
      if (!into) {
        into = { lines: new Map(), branches: new Map() };
        merged.set(file, into);
      }
      for (const [n, hits] of cov.lines) into.lines.set(n, Math.max(into.lines.get(n) ?? 0, hits));
      for (const [key, taken] of cov.branches) into.branches.set(key, (into.branches.get(key) ?? false) || taken);
    }
  }
  return merged;
}

// Added line numbers per new path from a unified diff (`git diff -U0`). Deletions, renames to
// /dev/null and non-coverable files contribute nothing.
export function parseDiff(text: string): Map<string, Set<number>> {
  const changed = new Map<string, Set<number>>();
  let file: string | undefined;
  let newLine = 0;
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      file = target === "/dev/null" ? undefined : target.replace(/^b\//, "");
      if (file && !changed.has(file)) changed.set(file, new Set());
    } else if (line.startsWith("@@ ")) {
      const match = /\+(\d+)(?:,(\d+))?/.exec(line);
      newLine = match ? Number(match[1]) : 0;
    } else if (file && line.startsWith("+") && !line.startsWith("+++")) {
      changed.get(file)?.add(newLine);
      newLine += 1;
    } else if (file && (line === "" || line.startsWith(" "))) {
      // Context advances the new-file counter; deletions and "\ No newline" markers do not.
      newLine += 1;
    }
  }
  return changed;
}

export interface CoverageTotals {
  linesFound: number;
  linesHit: number;
  branchesFound: number;
  branchesHit: number;
}

export function coverableFileCount(files: Map<string, FileCoverage>): number {
  return [...files.keys()].filter(isCoverable).length;
}

export function totalOf(files: Map<string, FileCoverage>, predicate: (file: string) => boolean): CoverageTotals {
  const totals = { linesFound: 0, linesHit: 0, branchesFound: 0, branchesHit: 0 };
  for (const [file, cov] of files) {
    if (!predicate(file)) continue;
    totals.linesFound += cov.lines.size;
    totals.linesHit += [...cov.lines.values()].filter((h) => h > 0).length;
    totals.branchesFound += cov.branches.size;
    totals.branchesHit += [...cov.branches.values()].filter(Boolean).length;
  }
  return totals;
}

export interface ChangedCoverage {
  coverable: number;
  covered: number;
  files: number;
}

export function changedCoverage(
  files: Map<string, FileCoverage>,
  changed: Map<string, Set<number>>,
): ChangedCoverage | undefined {
  let coverable = 0;
  let covered = 0;
  let withLines = 0;
  for (const [file, lines] of changed) {
    const cov = files.get(file);
    if (!cov || !isCoverable(file)) continue;
    let fileLines = 0;
    for (const n of lines) {
      const hits = cov.lines.get(n);
      if (hits === undefined) continue; // not executable (comment, blank, declaration)
      fileLines += 1;
      coverable += 1;
      if (hits > 0) covered += 1;
    }
    if (fileLines > 0) withLines += 1;
  }
  return coverable === 0 ? undefined : { coverable, covered, files: withLines };
}

const pct = (hit: number, found: number): string => `${((100 * hit) / found).toFixed(1)}%`;
const cell = (hit: number, found: number): string => (found === 0 ? "n/a" : `${hit}/${found} (${pct(hit, found)})`);

export interface ReportInput {
  files: Map<string, FileCoverage>;
  changed?: ChangedCoverage;
  thresholds: { linesTotal: number; branchesTotal: number; linesChanged: number };
}

export function renderReport({ files, changed, thresholds }: ReportInput): { markdown: string; breaches: string[] } {
  const groups = ["contracts", "sdk-ts", "cli", "server", "sdk-py", "e2e", "scripts", "other"].filter((g) =>
    [...files.keys()].some((f) => isCoverable(f) && groupOf(f) === g),
  );
  const rows = groups.map((g) => {
    const t = totalOf(files, (f) => isCoverable(f) && groupOf(f) === g);
    return `| ${g} | ${cell(t.linesHit, t.linesFound)} | ${cell(t.branchesHit, t.branchesFound)} |`;
  });
  const total = totalOf(files, isCoverable);
  rows.push(`| **total** | ${cell(total.linesHit, total.linesFound)} | ${cell(total.branchesHit, total.branchesFound)} |`);
  const changedLine = changed
    ? `Changed lines: **${changed.covered}/${changed.coverable} (${pct(changed.covered, changed.coverable)})** in ${changed.files} coverable file(s).`
    : "Changed lines: n/a (no coverable lines changed).";
  const breaches: string[] = [];
  if (total.linesFound > 0 && (100 * total.linesHit) / total.linesFound < thresholds.linesTotal) {
    breaches.push(
      `total line coverage ${pct(total.linesHit, total.linesFound)} is below ${thresholds.linesTotal}%`,
    );
  }
  if (total.branchesFound > 0 && (100 * total.branchesHit) / total.branchesFound < thresholds.branchesTotal) {
    breaches.push(
      `total branch coverage ${pct(total.branchesHit, total.branchesFound)} is below ${thresholds.branchesTotal}%`,
    );
  }
  if (changed && (100 * changed.covered) / changed.coverable < thresholds.linesChanged) {
    breaches.push(
      `changed-line coverage ${pct(changed.covered, changed.coverable)} is below ${thresholds.linesChanged}%`,
    );
  }
  const verdict =
    breaches.length === 0
      ? `Thresholds (lines ≥ ${thresholds.linesTotal}%, branches ≥ ${thresholds.branchesTotal}%, changed ≥ ${thresholds.linesChanged}%): **PASS**.`
      : `Thresholds (lines ≥ ${thresholds.linesTotal}%, branches ≥ ${thresholds.branchesTotal}%, changed ≥ ${thresholds.linesChanged}%): **FAIL** — ${breaches.join("; ")}.`;
  const markdown = [
    "## Coverage",
    "",
    "| group | lines | branches |",
    "| --- | --- | --- |",
    ...rows,
    "",
    changedLine,
    "",
    verdict,
    "",
  ].join("\n");
  return { markdown, breaches };
}

function usage(): string {
  return "Usage: coverage-report.ts --lcov <file> [--lcov <file>...] [--diff <unified-diff>] [--summary <file>] [--min-lines-total <pct>] [--min-branches-total <pct>] [--min-lines-changed <pct>]";
}

export function parseArgs(argv: string[]): {
  lcovFiles: string[];
  diffFile?: string;
  summaryFile?: string;
  thresholds: { linesTotal: number; branchesTotal: number; linesChanged: number };
} {
  const out = {
    lcovFiles: [] as string[],
    diffFile: undefined as string | undefined,
    summaryFile: undefined as string | undefined,
    thresholds: {
      linesTotal: DEFAULT_MIN_LINES_TOTAL,
      branchesTotal: DEFAULT_MIN_BRANCHES_TOTAL,
      linesChanged: DEFAULT_MIN_LINES_CHANGED,
    },
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag === "--lcov" || flag === "--diff" || flag === "--summary") && value !== undefined) {
      if (flag === "--lcov") out.lcovFiles.push(value);
      if (flag === "--diff") out.diffFile = value;
      if (flag === "--summary") out.summaryFile = value;
      i += 1;
    } else if (
      (flag === "--min-lines-total" || flag === "--min-branches-total" || flag === "--min-lines-changed") &&
      value !== undefined &&
      Number.isFinite(Number(value))
    ) {
      if (flag === "--min-lines-total") out.thresholds.linesTotal = Number(value);
      if (flag === "--min-branches-total") out.thresholds.branchesTotal = Number(value);
      if (flag === "--min-lines-changed") out.thresholds.linesChanged = Number(value);
      i += 1;
    } else {
      throw new Error(`${usage()}\nUnknown or incomplete flag: ${flag}`);
    }
  }
  if (out.lcovFiles.length === 0) throw new Error(`${usage()}\nAt least one --lcov file is required.`);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  let files: Map<string, FileCoverage>;
  try {
    files = mergeLcov(args.lcovFiles.map((f) => parseLcov(readFileSync(f, "utf8"))));
  } catch (err) {
    console.error(`cannot read an --lcov file: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  if (coverableFileCount(files) === 0) {
    console.error("no coverable files in the LCOV input: check the SF paths and isCoverable");
    process.exit(2);
  }
  const changed = args.diffFile ? changedCoverage(files, parseDiff(readFileSync(args.diffFile, "utf8"))) : undefined;
  const { markdown, breaches } = renderReport({ files, changed, thresholds: args.thresholds });
  const summaryFile = args.summaryFile ?? process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) appendFileSync(summaryFile, markdown);
  console.log(markdown);
  for (const breach of breaches) console.error(`COVERAGE BELOW THRESHOLD: ${breach}`);
  process.exit(breaches.length === 0 ? 0 : 1);
}
