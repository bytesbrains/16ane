import test from "node:test";
import assert from "node:assert/strict";
import { ConfigError, parseIndexerConfig } from "../src/config.ts";

const BASE = {
  ANE_RPC_URL: "http://127.0.0.1:8545",
  ANE_REGISTRY_ADDRESS: "0x" + "ab".repeat(20),
};

test("required settings parse, with read-only defaults", () => {
  const c = parseIndexerConfig({ ...BASE });
  assert.equal(c.rpcUrl, BASE.ANE_RPC_URL);
  assert.equal(c.registryAddress, BASE.ANE_REGISTRY_ADDRESS);
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.port, 8789);
  assert.equal(c.chainId, 84532);
  assert.equal(c.fromBlock, "latest");
  assert.equal(c.pollMs, 5000);
  assert.equal(c.maxRange, 2000);
  assert.equal(c.statePath, undefined);
});

test("optional settings parse", () => {
  const c = parseIndexerConfig({
    ...BASE,
    ANE_HOST: "0.0.0.0",
    ANE_PORT: "9001",
    ANE_CHAIN_ID: "31337",
    ANE_INDEX_FROM_BLOCK: "12345",
    ANE_INDEX_POLL_MS: "1000",
    ANE_INDEX_MAX_RANGE: "500",
    ANE_STATE_PATH: "/data/indexer.sqlite",
  });
  assert.equal(c.host, "0.0.0.0");
  assert.equal(c.port, 9001);
  assert.equal(c.chainId, 31337);
  assert.equal(c.fromBlock, 12345);
  assert.equal(c.pollMs, 1000);
  assert.equal(c.maxRange, 500);
  assert.equal(c.statePath, "/data/indexer.sqlite");
  assert.equal(parseIndexerConfig({ ...BASE, ANE_INDEX_FROM_BLOCK: "earliest" }).fromBlock, "earliest");
});

test("an unsafe-integer from block is rejected, the largest safe one parses", () => {
  assert.throws(
    () => parseIndexerConfig({ ...BASE, ANE_INDEX_FROM_BLOCK: "9007199254740993" }),
    /ANE_INDEX_FROM_BLOCK must be a block number/,
  );
  assert.equal(
    parseIndexerConfig({ ...BASE, ANE_INDEX_FROM_BLOCK: "9007199254740991" }).fromBlock,
    9007199254740991,
  );
});

test("every problem is reported together", () => {
  try {
    parseIndexerConfig({
      ANE_RPC_URL: "not-a-url",
      ANE_INDEX_FROM_BLOCK: "yesterday",
      ANE_INDEX_POLL_MS: "soon",
    });
    assert.fail("expected a ConfigError");
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    assert.ok(err.problems.length >= 4, err.problems.join("; "));
  }
});
