import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { encryptKeystoreV3, keccak256Utf8, privateKeyToAddress, withTemporaryKeystore } from "../src/index.ts";

const KEY = keccak256Utf8("16ane.test.keystore.key.v1");

test("Foundry's cast decrypts our V3 keystore to the right address", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ks-test-"));
  try {
    writeFileSync(path.join(dir, "keystore.json"), JSON.stringify(await encryptKeystoreV3(KEY, "pw")));
    writeFileSync(path.join(dir, "password"), "pw");
    const address = execFileSync(
      "cast",
      ["wallet", "address", "--keystore", path.join(dir, "keystore.json"), "--password-file", path.join(dir, "password")],
      { encoding: "utf8", env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" } },
    ).trim();
    assert.equal(address, privateKeyToAddress(KEY));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the keystore holds no plaintext key, and the temporary files are removed even on failure", async () => {
  const ks = JSON.stringify(await encryptKeystoreV3(KEY, "pw"));
  assert.ok(!ks.includes(KEY.slice(2)), "no plaintext key in the keystore");

  let seen: { ETH_KEYSTORE: string; ETH_PASSWORD: string } | undefined;
  await assert.rejects(
    withTemporaryKeystore(KEY, async (env) => {
      seen = env;
      throw new Error("cast failed");
    }),
    /cast failed/,
  );
  assert.ok(seen);
  const { existsSync } = await import("node:fs");
  assert.ok(!existsSync(seen.ETH_KEYSTORE) && !existsSync(path.dirname(seen.ETH_KEYSTORE)), "temporary directory removed");
});
