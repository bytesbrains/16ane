import test from "node:test";
import assert from "node:assert/strict";
import { keccak256Utf8, privateKeyToAddress, SecretKey } from "../packages/sdk-ts/src/index.ts";
import { runSmoke, waitFor } from "../scripts/smoke-sandbox.ts";
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

test("waitFor retries reads that throw (a lagging or rate-limited RPC), not only stale values", async () => {
  let calls = 0;
  const value = await waitFor(
    async () => {
      calls++;
      if (calls === 1) throw new Error("RPC HTTP error 429: rate limited");
      return calls;
    },
    (n) => n >= 3,
    "the third read",
    { delayMs: 1 },
  );
  assert.equal(value, 3);
  assert.equal(calls, 3);
});

test("waitFor reports the last error when every attempt fails", async () => {
  await assert.rejects(
    waitFor(async () => { throw new Error("RPC HTTP error 503"); }, () => true, "a read", { attempts: 3, delayMs: 1 }),
    /gave up waiting for a read: RPC HTTP error 503/,
  );
  await assert.rejects(
    waitFor(async () => 0, (n) => n > 0, "a value", { attempts: 2, delayMs: 1 }),
    /timed out waiting for a value/,
  );
});
