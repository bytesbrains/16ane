import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { SANDBOX_DISCLAIMER } from "../../sdk-ts/src/index.ts";

const execFileAsync = promisify(execFile);
const CLI = path.resolve(import.meta.dirname, "../bin/ane.mjs");

async function ane(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", CLI, ...args],
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

test("help lists commands and carries the no-cash-value disclaimer", async () => {
  const { code, stdout } = await ane("help");
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.cli, "ane");
  assert.ok(out.commands.includes("ane receipt verify --tx <hash> --payee <address> --amount <wei>"));
  assert.equal(out.disclaimer, SANDBOX_DISCLAIMER);
});

test("network list returns every bundled network with its disclaimer", async () => {
  const { code, stdout } = await ane("network", "list");
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  const names = out.networks.map((n: { name: string }) => n.name).sort();
  assert.deepEqual(names, ["dev-sepolia", "local", "sandbox-sepolia"]);
  assert.equal(out.disclaimer, SANDBOX_DISCLAIMER);
});

test("wallet create prints addresses but never a private key (REQ-003)", async () => {
  const { code, stdout } = await ane("wallet", "create");
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.match(out.ownerAddress, /^0x[0-9a-fA-F]{40}$/);
  assert.match(out.sessionAddress, /^0x[0-9a-fA-F]{40}$/);
  assert.doesNotMatch(stdout, /[0-9a-fA-F]{64}/);
});

test("unknown commands exit non-zero with a JSON error", async () => {
  const { code, stderr } = await ane("nonsense", "command");
  assert.equal(code, 1);
  const err = JSON.parse(stderr.trim().split("\n").pop()!);
  assert.match(err.error, /Unknown command: nonsense command/);
  assert.equal(err.disclaimer, SANDBOX_DISCLAIMER);
});
