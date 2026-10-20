import test from "node:test";
import assert from "node:assert/strict";
import { keccak256Utf8, privateKeyToAddress, SecretKey } from "../packages/sdk-ts/src/index.ts";
import { runSmoke } from "../scripts/smoke-sandbox.ts";
import { startSandboxStack } from "./harness.ts";

// Keeps scripts/smoke-sandbox.ts working: the deploy runbook (docs/operations/DEPLOY_SANDBOX.md)
// runs it against Base Sepolia, where it can't be tested in CI.
test("the deployment smoke test passes against a fresh local deployment", async (t) => {
  const { rpcUrl, registryAddress, client } = await startSandboxStack(t);
  const ownerKey = new SecretKey(keccak256Utf8("16ane.e2e.smoke.owner.key.v1"));
  await client.rpcCall("anvil_setBalance", [privateKeyToAddress(ownerKey), "0x" + (10n ** 19n).toString(16)]);

  const lines: string[] = [];
  const result = await runSmoke({ rpcUrl, registryAddress, ownerKey, log: (l) => lines.push(l) });

  assert.match(result.paymentTxHash, /^0x[0-9a-f]{64}$/);
  assert.ok(lines.some((l) => l.includes("verified on-chain")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("16000 tANE per claim")), "reads the deployed faucet config");
});
