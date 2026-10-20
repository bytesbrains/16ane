import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteKeyValueStore } from "../src/sqlite-store.ts";

function withDbFile(run: (file: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "kv-test-"));
  try {
    run(path.join(dir, "state.sqlite"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("get / set / has / values round-trip JSON per namespace", () => {
  withDbFile((file) => {
    const kv = new SqliteKeyValueStore(file);
    assert.equal(kv.get("a", "k"), undefined);
    assert.equal(kv.has("a", "k"), false);
    kv.set("a", "k", { n: 1, s: "x", list: [1, 2] });
    kv.set("a", "k2", 2);
    kv.set("b", "k", "other namespace");
    assert.deepEqual(kv.get("a", "k"), { n: 1, s: "x", list: [1, 2] });
    assert.equal(kv.has("a", "k"), true);
    assert.deepEqual(kv.values("a").sort(), [2, { n: 1, s: "x", list: [1, 2] }].sort());
    kv.set("a", "k", "overwritten");
    assert.equal(kv.get("a", "k"), "overwritten");
    kv.close();
  });
});

test("data survives closing and reopening the same file (a restart)", () => {
  withDbFile((file) => {
    const first = new SqliteKeyValueStore(file);
    first.set("x402.proofs", "0xabc", true);
    first.set("faucet.cooldowns", "0xrecipient", 1_700_000_000);
    first.close();
    const second = new SqliteKeyValueStore(file);
    assert.equal(second.has("x402.proofs", "0xabc"), true);
    assert.equal(second.get("faucet.cooldowns", "0xrecipient"), 1_700_000_000);
    second.close();
  });
});
