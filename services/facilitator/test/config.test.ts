import test from "node:test";
import assert from "node:assert/strict";
import { ConfigError, parseFacilitatorConfig } from "../src/config.ts";

const BASE = {
  ANE_RPC_URL: "http://127.0.0.1:8545",
  ANE_REGISTRY_ADDRESS: "0x" + "ab".repeat(20),
  ANE_RELAYER_PRIVATE_KEY: "0x" + "1".repeat(64),
};

test("required settings parse, with sandbox-adjacent defaults", () => {
  const c = parseFacilitatorConfig({ ...BASE });
  assert.equal(c.rpcUrl, BASE.ANE_RPC_URL);
  assert.equal(c.registryAddress, BASE.ANE_REGISTRY_ADDRESS);
  assert.equal(c.relayerPrivateKey, BASE.ANE_RELAYER_PRIVATE_KEY);
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.port, 8788);
  assert.equal(c.chainId, 84532);
  assert.equal(c.statePath, undefined);
  assert.equal(c.relayerGasBudgetWei, undefined);
  assert.equal(c.relayerMaxFeeWei, undefined);
});

test("optional settings parse", () => {
  const c = parseFacilitatorConfig({
    ...BASE,
    ANE_HOST: "0.0.0.0",
    ANE_PORT: "9000",
    ANE_CHAIN_ID: "31337",
    ANE_STATE_PATH: "/data/facilitator.sqlite",
    ANE_RELAYER_GAS_BUDGET_WEI: "100000000000000000",
    ANE_RELAYER_MAX_FEE_WEI: "2000000000",
  });
  assert.equal(c.host, "0.0.0.0");
  assert.equal(c.port, 9000);
  assert.equal(c.chainId, 31337);
  assert.equal(c.statePath, "/data/facilitator.sqlite");
  assert.equal(c.relayerGasBudgetWei, 100000000000000000n);
  assert.equal(c.relayerMaxFeeWei, 2000000000n);
});

test("every problem is reported together, and no error carries a key", () => {
  try {
    parseFacilitatorConfig({
      ANE_RPC_URL: "not-a-url",
      ANE_REGISTRY_ADDRESS: "0x123",
      ANE_RELAYER_PRIVATE_KEY: "0xbeef",
      ANE_PORT: "99999",
      ANE_RELAYER_GAS_BUDGET_WEI: "a lot",
    });
    assert.fail("expected a ConfigError");
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    assert.ok(err.problems.length >= 5, err.problems.join("; "));
    assert.ok(!err.message.includes("beef"), "the key value must never appear");
  }
});
