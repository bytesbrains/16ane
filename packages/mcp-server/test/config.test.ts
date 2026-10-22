// Configuration parsing and the startup delegation self-check.

import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, verifyDelegation } from "../src/config.ts";
import { TEST_AGENT_KEY_HEX, TEST_VAULT, mockAccounting } from "./mock-backend.ts";
import type { AneClient } from "../../sdk-ts/src/index.ts";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    ANE_RPC_URL: "http://127.0.0.1:8545",
    ANE_CHAIN_ID: "31337",
    ANE_VAULT_ADDRESS: TEST_VAULT,
    ANE_AGENT_PRIVATE_KEY: TEST_AGENT_KEY_HEX,
    ANE_REGISTRY_ADDRESS: "0x9999999999999999999999999999999999999999",
  };
}

test("loadConfig parses a minimal environment with stdio defaults", () => {
  const config = loadConfig(baseEnv());
  assert.equal(config.transport, "stdio");
  assert.equal(config.network, "eip155:31337");
  assert.equal(config.httpHost, "127.0.0.1");
  assert.equal(config.httpPort, 8786);
  assert.equal(config.httpEndpoint, "/mcp");
  assert.deepEqual(config.allowedOrigins, []);
  assert.equal(config.maxPaymentCeiling, undefined);
  assert.match(config.sessionAddress, /^0x[0-9a-fA-F]{40}$/);
});

test("loadConfig accepts Base Sepolia, explicit contracts and HTTP options", () => {
  const config = loadConfig({
    ...baseEnv(),
    ANE_CHAIN_ID: "84532",
    ANE_REGISTRY_ADDRESS: undefined,
    ANE_TOKEN_ADDRESS: "0x2222222222222222222222222222222222222222",
    ANE_VAULT_FACTORY_ADDRESS: "0x3333333333333333333333333333333333333333",
    ANE_FAUCET_ADDRESS: "0x4444444444444444444444444444444444444444",
    ANE_SERVICE_DIRECTORY_ADDRESS: "0x5555555555555555555555555555555555555555",
    ANE_API_BASE_URL: "https://api.16ane.com",
    ANE_MCP_MAX_PAYMENT: "160",
    ANE_MCP_TRANSPORT: "http",
    ANE_MCP_HOST: "0.0.0.0",
    ANE_MCP_PORT: "9000",
    ANE_MCP_ENDPOINT: "/mcp/v1",
    ANE_MCP_ALLOWED_ORIGINS: "https://a.test, https://b.test",
    ANE_MCP_AUTH_TOKEN: "token",
  });
  assert.equal(config.network, "eip155:84532");
  assert.ok(config.contracts);
  assert.equal(config.maxPaymentCeiling, 160n);
  assert.equal(config.transport, "http");
  assert.equal(config.httpPort, 9000);
  assert.equal(config.httpEndpoint, "/mcp/v1");
  assert.deepEqual(config.allowedOrigins, ["https://a.test", "https://b.test"]);
});

test("loadConfig rejects missing or malformed values", () => {
  const missing = baseEnv();
  delete missing["ANE_AGENT_PRIVATE_KEY"];
  assert.throws(() => loadConfig(missing), /ANE_AGENT_PRIVATE_KEY/);

  const noContracts = baseEnv();
  delete noContracts["ANE_REGISTRY_ADDRESS"];
  assert.throws(() => loadConfig(noContracts), /ANE_REGISTRY_ADDRESS/);

  assert.throws(() => loadConfig({ ...baseEnv(), ANE_CHAIN_ID: "1" }), /ANE_CHAIN_ID/);
  assert.throws(() => loadConfig({ ...baseEnv(), ANE_CHAIN_ID: "abc" }), /ANE_CHAIN_ID/);
  assert.throws(() => loadConfig({ ...baseEnv(), ANE_VAULT_ADDRESS: "nope" }), /ANE_VAULT_ADDRESS/);
  assert.throws(
    () => loadConfig({ ...baseEnv(), ANE_AGENT_PRIVATE_KEY: "0x1234" }),
    /private key/,
  );
  assert.throws(() => loadConfig({ ...baseEnv(), ANE_API_BASE_URL: "ftp://x/" }), /ANE_API_BASE_URL/);
  assert.throws(() => loadConfig({ ...baseEnv(), ANE_MCP_MAX_PAYMENT: "1.5" }), /ANE_MCP_MAX_PAYMENT/);
  assert.throws(() => loadConfig({ ...baseEnv(), ANE_MCP_TRANSPORT: "sse" }), /ANE_MCP_TRANSPORT/);
  assert.throws(() => loadConfig({ ...baseEnv(), ANE_MCP_PORT: "99999" }), /ANE_MCP_PORT/);
});

test("loadConfig exposes no owner-key option", () => {
  // The owner key must never be load-bearing here, even if the shell has one.
  const config = loadConfig({ ...baseEnv(), ANE_OWNER_PRIVATE_KEY: "0x" + "ab".repeat(32) });
  assert.ok(!("ownerKey" in config));
  assert.ok(!JSON.stringify(config).includes("ababab"));
});

test("verifyDelegation fails closed unless the held key is the active agentSigner", async () => {
  const config = loadConfig(baseEnv());
  const matching = { getAccountingSummary: async () => mockAccounting() } as unknown as AneClient;
  await verifyDelegation(matching, config);

  const stranger = {
    getAccountingSummary: async () =>
      mockAccounting({ agentSigner: "0x9999999999999999999999999999999999999999" }),
  } as unknown as AneClient;
  await assert.rejects(() => verifyDelegation(stranger, config), /does not match/);

  const revoked = {
    getAccountingSummary: async () => mockAccounting({ active: false }),
  } as unknown as AneClient;
  await assert.rejects(() => verifyDelegation(revoked, config), /not active/);

  const notAVault = {
    getAccountingSummary: async () => {
      throw new Error("RPC error (3): execution reverted");
    },
  } as unknown as AneClient;
  await assert.rejects(
    () => verifyDelegation(notAVault, config),
    /Vault delegation check failed.*Is ANE_VAULT_ADDRESS a delegated AneAgentVault/,
  );
});
