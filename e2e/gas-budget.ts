import test from "node:test";
import assert from "node:assert/strict";
import { createSandboxServer } from "../services/sandbox-server/src/server.ts";
import { DEPLOYER_KEY, PROVIDER_KEY, startSandboxStack } from "./harness.ts";

// #76 on a real chain: with a 1-wei daily budget the first sponsored claim goes through (nothing spent yet),
// it records its real fee, and the next one is refused with 503 + Retry-After and a self-serve hint.
test("the relayer stops sponsoring gas once today's budget is spent", async (t) => {
  const { rpcUrl, registryAddress } = await startSandboxStack(t);
  const server = await createSandboxServer({
    rpcUrl,
    chainId: 84532,
    registryAddress,
    relayerPrivateKey: DEPLOYER_KEY,
    providerPrivateKey: PROVIDER_KEY,
    relayerGasBudgetWei: 1n,
    faucetOpenClaims: true, // keyless recipients; claim proofs are covered in faucet-proof.ts
  });
  t.after(() => server.close());
  const claim = (recipient: string) =>
    fetch(`${server.url}/v1/faucet/claims`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipient }),
    });

  assert.equal((await claim("0x00000000000000000000000000000000000BdE01")).status, 201);
  const refused = await claim("0x00000000000000000000000000000000000BdE02");
  assert.equal(refused.status, 503);
  assert.ok(Number(refused.headers.get("retry-after")) > 0);
  const { error } = (await refused.json()) as { error: { code: string; message: string } };
  assert.equal(error.code, "ANE-E-1006");
  assert.match(error.message, /claim directly from the AneFaucet contract/);

  const health = (await (await fetch(`${server.url}/healthz`)).json()) as {
    relayer: { spentTodayWei: string; remainingTodayWei: string; dailyGasBudgetWei: string };
  };
  assert.ok(BigInt(health.relayer.spentTodayWei) > 0n, "the first claim's real fee was recorded");
  assert.equal(health.relayer.remainingTodayWei, "0");
  assert.equal(health.relayer.dailyGasBudgetWei, "1");
});

// The race both #83 reviews found: concurrent claims must not all pass the check before any fee is recorded.
test("concurrent sponsored claims can't overspend the budget", async (t) => {
  const { rpcUrl, registryAddress } = await startSandboxStack(t);
  const server = await createSandboxServer({
    rpcUrl,
    chainId: 84532,
    registryAddress,
    relayerPrivateKey: DEPLOYER_KEY,
    providerPrivateKey: PROVIDER_KEY,
    relayerGasBudgetWei: 1n,
    faucetOpenClaims: true, // keyless recipients; claim proofs are covered in faucet-proof.ts
  });
  t.after(() => server.close());
  const statuses = await Promise.all(
    ["0x00000000000000000000000000000000000BdE11", "0x00000000000000000000000000000000000BdE12", "0x00000000000000000000000000000000000BdE13"].map(
      async (recipient) =>
        (
          await fetch(`${server.url}/v1/faucet/claims`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ recipient }),
          })
        ).status,
    ),
  );
  assert.deepEqual(statuses.sort(), [201, 503, 503]);
});
