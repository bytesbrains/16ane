import test from "node:test";
import assert from "node:assert/strict";
import { checkApiHealth } from "../scripts/api-health.ts";
import { runApiSmoke } from "../scripts/smoke-api.ts";
import { createSandboxServer } from "../services/sandbox-server/src/server.ts";
import { DEPLOYER_KEY, PROVIDER_KEY, startSandboxStack } from "./harness.ts";

// Keeps the hosted-API smoke test and the monitor's health check working (#78, docs/operations/DEPLOY_API.md):
// both run here against a local server exactly as they would against api.16ane.com.
test("the hosted-API smoke test passes against a local server", async (t) => {
  const { rpcUrl, registryAddress, sandbox } = await startSandboxStack(t);
  const lines: string[] = [];
  const { recipient } = await runApiSmoke({ apiUrl: sandbox.url, rpcUrl, expectedRegistry: registryAddress, log: (l) => lines.push(l) });
  assert.match(lines.join("\n"), /no proof: 401[\s\S]*0 ETH[\s\S]*cooldown: 429[\s\S]*402 quote/);
  assert.match(recipient, /^0x[0-9a-fA-F]{40}$/);
});

test("the monitor sees a used-up gas budget on a real server", async (t) => {
  const { rpcUrl, registryAddress } = await startSandboxStack(t);
  const server = await createSandboxServer({
    rpcUrl,
    chainId: 84532,
    registryAddress,
    relayerPrivateKey: DEPLOYER_KEY,
    providerPrivateKey: PROVIDER_KEY,
    relayerGasBudgetWei: 1n,
    faucetOpenClaims: true,
  });
  t.after(() => server.close());
  assert.deepEqual(await checkApiHealth(server.url, registryAddress), []);
  const claim = await fetch(`${server.url}/v1/faucet/claims`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipient: "0x00000000000000000000000000000000000BdE21" }),
  });
  assert.equal(claim.status, 201);
  const problems = await checkApiHealth(server.url, registryAddress);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /gas budget \(1 wei\) is used up/);
});
