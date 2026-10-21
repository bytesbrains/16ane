// Guards the coverage scripts (#55): every coverage:* script must run exactly the test files its
// test:* twin runs (plus coverage flags), so coverage can never silently miss a suite.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const packageJson = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../../package.json"), "utf8"),
) as { scripts: Record<string, string> };

const fileArgs = (script: string): string[] =>
  script.split(/\s+/).filter((token) => token.includes("/") && token.endsWith(".ts"));

for (const suite of ["sdk-ts", "cli", "server", "scripts", "e2e"]) {
  test(`coverage:${suite} runs the same files as test:${suite}, under coverage`, () => {
    const run = packageJson.scripts[`test:${suite}`];
    const cover = packageJson.scripts[`coverage:${suite}`];
    assert.ok(run, `test:${suite} exists`);
    assert.ok(cover, `coverage:${suite} exists`);
    assert.deepEqual(fileArgs(cover).sort(), fileArgs(run).sort(), "same test files");
    assert.ok(cover.includes("--experimental-test-coverage"), "collects coverage");
    assert.ok(cover.includes("--test-reporter=lcov"), "reports lcov");
    const concurrency = run.match(/--test-concurrency=\S+/);
    if (concurrency) assert.ok(cover.includes(concurrency[0]), "keeps the concurrency limit");
  });
}

test("coverage:sdk-py runs the same unittest discovery as test:sdk-py, under coverage", () => {
  const run = packageJson.scripts["test:sdk-py"];
  const cover = packageJson.scripts["coverage:sdk-py"];
  assert.ok(run && cover);
  for (const token of ["-m unittest", "discover", "-s packages/sdk-py/tests", "-p"]) {
    assert.ok(cover.includes(token), `coverage keeps ${token}`);
  }
  assert.ok(cover.includes("coverage run"), "collects with coverage.py");
});

test("every coverage collector writes into coverage/", () => {
  for (const [name, script] of Object.entries(packageJson.scripts)) {
    if (name === "coverage" || name === "coverage:report" || !name.startsWith("coverage:")) continue;
    assert.ok(script.includes("coverage/"), `${name} writes under coverage/`);
  }
});
