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

test("faucet proofs (#79): required by default; open claims and Turnstile are opt-in", () => {
  const d = parseServerConfig(BASE);
  assert.equal(d.faucetOpenClaims, false);
  assert.equal(d.turnstileSecretKey, undefined);
  const c = parseServerConfig({
    ...BASE,
    ANE_FAUCET_OPEN_CLAIMS: "true",
    ANE_TURNSTILE_SECRET_KEY: "0x4AAA-secret",
    ANE_TURNSTILE_HOSTNAME: "app.16ane.com",
  });
  assert.equal(c.faucetOpenClaims, true);
  assert.equal(c.turnstileSecretKey, "0x4AAA-secret");
  assert.equal(c.turnstileExpectedHostname, "app.16ane.com");
  assert.throws(
    () => parseServerConfig({ ...BASE, ANE_FAUCET_OPEN_CLAIMS: "yes", ANE_TURNSTILE_HOSTNAME: "app.16ane.com" }),
    (err: unknown) =>
      err instanceof ConfigError &&
      err.problems.includes("ANE_FAUCET_OPEN_CLAIMS must be true or false") &&
      err.problems.includes("ANE_TURNSTILE_HOSTNAME needs ANE_TURNSTILE_SECRET_KEY"),
  );
});

test("ANE_RELAYER_MAX_FEE_WEI is a whole number of wei, unset by default", () => {
  assert.equal(parseServerConfig(BASE).relayerMaxFeeWei, undefined);
  assert.equal(parseServerConfig({ ...BASE, ANE_RELAYER_MAX_FEE_WEI: "1000000000" }).relayerMaxFeeWei, 1_000_000_000n);
  assert.throws(
    () => parseServerConfig({ ...BASE, ANE_RELAYER_MAX_FEE_WEI: "1 gwei" }),
    (err: unknown) => err instanceof ConfigError && err.problems.includes("ANE_RELAYER_MAX_FEE_WEI must be a whole number of wei"),
  );
});

