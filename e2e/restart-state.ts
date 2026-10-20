import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSandboxServer } from "../services/sandbox-server/src/server.ts";
import { SqliteKeyValueStore } from "../services/sandbox-server/src/sqlite-store.ts";
import { DEPLOYER_KEY, OWNER_KEY, PROVIDER_KEY, signedClaimBody, startSandboxStack } from "./harness.ts";

const ONE_TANE = 10n ** 18n;

// #75: a hosted server restarts (deploys, crashes, Fly.io machine moves). With ANE_STATE_PATH set, nothing a
// client relies on may be forgotten: faucet cooldowns, x402 idempotency (no double charge, 409 on a changed
// body) and receipts.
test("server state survives a restart on the same SQLite file", async (t) => {
  const { rpcUrl, registryAddress, client, owner, vaultAddress, session } = await startSandboxStack(t);
  const dir = mkdtempSync(path.join(tmpdir(), "state-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.sqlite");
  const start = (store: SqliteKeyValueStore) =>
    createSandboxServer({
      rpcUrl,
      chainId: 84532,
      registryAddress,
      relayerPrivateKey: DEPLOYER_KEY,
      providerPrivateKey: PROVIDER_KEY,
      store,
    });

  // Server A: a faucet claim and a paid purchase.
  const storeA = new SqliteKeyValueStore(file);
  const a = await start(storeA);
  const claim = await fetch(`${a.url}/v1/faucet/claims`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await signedClaimBody(client, OWNER_KEY),
  });
  assert.equal(claim.status, 201);
  await owner.fundVault(vaultAddress, 100n * ONE_TANE);
  await owner.delegateSession(vaultAddress, session.sessionAddress, {
    mode: "FIXED",
    allowanceCap: 100n * ONE_TANE,
    perTxLimit: 32n * ONE_TANE,
    expiry: Math.floor(Date.now() / 1000) + 3600,
  });
  const body = JSON.stringify({ text: "Sixteen annas made a rupee." });
  const idempotencyKey = "idem-restart-001";
  const paid = await session.purchase(`${a.url}/v1/demo/summarize`, {
    method: "POST",
    body,
    idempotencyKey,
    maxPayment: 32n * ONE_TANE,
  });
  assert.equal(paid.status, 200);
  assert.ok(paid.receipt?.paymentId);
  const spentAfterPurchase = (await client.getAccountingSummary(vaultAddress)).cumulativeSpent;
  assert.equal(spentAfterPurchase, 16n * ONE_TANE);
  await a.close();
  storeA.close();

  // Server B: a fresh process on the same file.
  const storeB = new SqliteKeyValueStore(file);
  const b = await start(storeB);
  t.after(async () => {
    await b.close();
    storeB.close();
  });

  const again = await fetch(`${b.url}/v1/faucet/claims`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await signedClaimBody(client, OWNER_KEY),
  });
  assert.equal(again.status, 429, "the faucet cooldown survived the restart");

  const replay = await session.purchase(`${b.url}/v1/demo/summarize`, {
    method: "POST",
    body,
    idempotencyKey,
    maxPayment: 32n * ONE_TANE,
  });
  assert.equal(replay.status, 200, "the cached response is replayed");
  assert.equal(
    (await client.getAccountingSummary(vaultAddress)).cumulativeSpent,
    spentAfterPurchase,
    "no second charge after the restart",
  );

  const changed = await session.purchase(`${b.url}/v1/demo/summarize`, {
    method: "POST",
    body: JSON.stringify({ text: "a different request" }),
    idempotencyKey,
    maxPayment: 32n * ONE_TANE,
  });
  assert.equal(changed.status, 409, "a reused key with a different body is still rejected");

  const receipt = await fetch(`${b.url}/v1/payments/${paid.receipt.paymentId}`);
  assert.equal(receipt.status, 200, "the receipt survived the restart");
});
