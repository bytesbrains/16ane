import test from "node:test";
import assert from "node:assert/strict";
import { SANDBOX_DISCLAIMER } from "../../packages/sdk-ts/src/index.ts";
import {
  ONE_TANE,
  PEER_OWNER_KEY,
  setupFundedSession,
  signedClaimBody,
  startSandboxStack,
} from "../harness.ts";

// Every public response states no cash value: the x-16ane-disclaimer header on all server
// answers, body disclaimers on faucet/purchase/trial/relay payloads and errors (REQ-012).
test("every public response carries the no-cash-value disclaimer (REQ-012)", async (t) => {
  const stack = await startSandboxStack(t);
  await setupFundedSession(stack);
  const { sandbox, client, owner, session } = stack;
  const headerOf = (res: Response) => res.headers.get("x-16ane-disclaimer");
  // Named const, not an inline literal: gitleaks flags `idempotencyKey: "…"` as a generic API key.
  const idemKey = "idem-disclaimer-001";

  await t.test("health, quote and purchase answers all carry the header", async () => {
    assert.equal(headerOf(await fetch(`${sandbox.url}/healthz`)), SANDBOX_DISCLAIMER);

    const quote = await fetch(`${sandbox.url}/v1/demo/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "no payment attached" }),
    });
    assert.equal(quote.status, 402);
    assert.equal(headerOf(quote), SANDBOX_DISCLAIMER);

    const bought = await session.purchase<{ disclaimer: string }>(`${sandbox.url}/v1/demo/summarize`, {
      method: "POST",
      body: JSON.stringify({ text: "paid call" }),
      idempotencyKey: idemKey,
      maxPayment: 32n * ONE_TANE,
    });
    assert.equal(bought.status, 200);
    assert.equal(bought.data.disclaimer, SANDBOX_DISCLAIMER);
    assert.equal(bought.receipt?.disclaimer, SANDBOX_DISCLAIMER);
    assert.equal(bought.headers["x-16ane-disclaimer"], SANDBOX_DISCLAIMER);
  });

  await t.test("faucet answers and errors state the disclaimer in the body", async () => {
    const claim = await fetch(`${sandbox.url}/v1/faucet/claims`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await signedClaimBody(client, PEER_OWNER_KEY),
    });
    assert.equal(claim.status, 201);
    assert.equal(headerOf(claim), SANDBOX_DISCLAIMER);
    assert.equal(((await claim.json()) as { disclaimer: string }).disclaimer, SANDBOX_DISCLAIMER);

    const conflict = await session.purchase(`${sandbox.url}/v1/demo/summarize`, {
      method: "POST",
      body: JSON.stringify({ text: "different body, same key" }),
      idempotencyKey: idemKey,
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.headers["x-16ane-disclaimer"], SANDBOX_DISCLAIMER);
    assert.equal(
      ((conflict.data as unknown as { error: { disclaimer: string } }).error.disclaimer),
      SANDBOX_DISCLAIMER,
    );
  });

  await t.test("trial and relay answers disclose sponsorship with the disclaimer", async () => {
    const trial = await session.purchase<{ sponsored: boolean }>(`${sandbox.url}/v1/demo/summarize`, {
      method: "POST",
      headers: { "x-trial-request": "true" },
      body: JSON.stringify({ text: "sponsored call" }),
    });
    assert.equal(trial.status, 200);
    assert.equal(trial.trialSponsored, true);
    assert.ok(
      (trial.receipt?.disclaimer ?? "").startsWith(`${SANDBOX_DISCLAIMER} — `),
      "the trial receipt pairs the disclaimer with its sponsorship disclosure",
    );

    const relayed = await fetch(`${sandbox.url}/v1/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "createVault", ...(await owner.signVaultCreation(7n)) }, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ),
    });
    assert.equal(relayed.status, 201);
    assert.equal(headerOf(relayed), SANDBOX_DISCLAIMER);
    assert.equal(((await relayed.json()) as { disclaimer: string }).disclaimer, SANDBOX_DISCLAIMER);
  });
});
