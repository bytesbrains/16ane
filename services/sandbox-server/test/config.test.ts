import test from "node:test";
import assert from "node:assert/strict";
import { keccak256Utf8 } from "../../../packages/sdk-ts/src/index.ts";
import { ConfigError, parseServerConfig } from "../src/config.ts";

const KEY = keccak256Utf8("16ane.test.config.relayer.v1");
const BASE = {
  ANE_RPC_URL: "https://sepolia.base.org",
  ANE_REGISTRY_ADDRESS: "0x01d5daB670DE5868305eB862721ebE62772C3Df3",
  ANE_RELAYER_PRIVATE_KEY: KEY,
};

test("defaults: localhost, port 8787, Base Sepolia, no proxy trust", () => {
  const c = parseServerConfig(BASE);
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.port, 8787);
  assert.equal(c.chainId, 84532);
  assert.equal(c.trustProxy, false);
  assert.equal(c.providerPrivateKey, undefined);
});

test("container settings are read from the environment", () => {
  const c = parseServerConfig({ ...BASE, ANE_HOST: "0.0.0.0", ANE_PORT: "8080", ANE_TRUST_PROXY: "true" });
  assert.equal(c.host, "0.0.0.0");
  assert.equal(c.port, 8080);
  assert.equal(c.trustProxy, true);
});

test("every problem is reported at once, and key values never appear in the error", () => {
  const badKey = "0x" + "ab".repeat(31); // one byte short
  assert.throws(
    () =>
      parseServerConfig({
        ANE_RPC_URL: "ftp://x",
        ANE_REGISTRY_ADDRESS: "0x123",
        ANE_RELAYER_PRIVATE_KEY: badKey,
        ANE_PROVIDER_PRIVATE_KEY: KEY + "00",
        ANE_PORT: "70000",
        ANE_TRUST_PROXY: "yes",
      }),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.problems.length, 6, err.message);
      assert.ok(!err.message.includes(badKey.slice(2)), "relayer key value not echoed");
      assert.ok(!err.message.includes(KEY.slice(2)), "provider key value not echoed");
      return true;
    },
  );
});

test("missing required settings are named", () => {
  assert.throws(() => parseServerConfig({}), (err: unknown) => {
    assert.ok(err instanceof ConfigError);
    assert.deepEqual(err.problems, [
      "ANE_RPC_URL is required",
      "ANE_REGISTRY_ADDRESS is required",
      "ANE_RELAYER_PRIVATE_KEY is required",
    ]);
    return true;
  });
});
