import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ONE_TANE, OWNER_KEY, SESSION_KEY, setupFundedSession, startSandboxStack } from "../harness.ts";

const execFileAsync = promisify(execFile);

// Inspectability without private logs: payment records, receipts and the CLI verifier
// expose tx, chain, parties, asset, amount and status — and never key material (REQ-015).
test("payments are inspectable on-chain, via API and CLI, without secrets (REQ-015)", async (t) => {
  const stack = await startSandboxStack(t);
  await setupFundedSession(stack);
  const { rpcUrl, repoRoot, registryAddress, sandbox, client, vaultAddress, session } = stack;
  const seen: string[] = [];
  // Named consts, not inline literals: gitleaks flags `idempotencyKey: "…"` as a generic API key.
  const histKeys = ["idem-history-001", "idem-history-002", "idem-history-003", "idem-history-004"];

  await t.test("two purchases settle with inspectable payment records", async () => {
    for (const [key, text] of [
      [histKeys[0], "first inspectable call"],
      [histKeys[1], "second inspectable call"],
    ]) {
      const bought = await session.purchase<{ txHash: string }>(`${sandbox.url}/v1/demo/summarize`, {
        method: "POST",
        body: JSON.stringify({ text }),
        idempotencyKey: key,
        maxPayment: 32n * ONE_TANE,
        verifyReceiptOnChain: true,
      });
      assert.equal(bought.status, 200);
      assert.ok(bought.receipt?.paymentId);
      assert.ok(bought.receipt?.txHash.startsWith("0x"));
      seen.push(JSON.stringify(bought.receipt));
    }
    const summary = await client.getAccountingSummary(vaultAddress);
    seen.push(JSON.stringify(summary, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    assert.equal(summary.cumulativeSpent, 32n * ONE_TANE);
    assert.equal(summary.tokenBalance, (1600n - 32n) * ONE_TANE);
  });

  await t.test("the receipt API serves the payment by id", async () => {
    const bought = await session.purchase<{ txHash: string }>(`${sandbox.url}/v1/demo/summarize`, {
      method: "POST",
      body: JSON.stringify({ text: "receipt lookup call" }),
      idempotencyKey: histKeys[2],
      maxPayment: 32n * ONE_TANE,
    });
    const paymentId = bought.receipt!.paymentId!;
    const lookedUp = await fetch(`${sandbox.url}/v1/payments/${paymentId}`);
    assert.equal(lookedUp.status, 200);
    const receipt = (await lookedUp.json()) as {
      txHash: string;
      network: string;
      payer: string;
      payTo: string;
      asset: string;
      amount: string;
      blockNumber: number;
      settledAt: string;
    };
    seen.push(JSON.stringify(receipt));
    assert.equal(receipt.txHash, bought.receipt!.txHash);
    assert.equal(receipt.network, "eip155:84532");
    assert.equal(receipt.payer.toLowerCase(), vaultAddress.toLowerCase());
    assert.equal(receipt.payTo.toLowerCase(), sandbox.providerAddress.toLowerCase());
    assert.equal(receipt.amount, (16n * ONE_TANE).toString());
    assert.ok(receipt.blockNumber > 0);

    const missing = await fetch(`${sandbox.url}/v1/payments/0x${"00".repeat(32)}`);
    assert.equal(missing.status, 404);
  });

  await t.test("the CLI verifies the right amount and rejects a wrong one", async () => {
    const bought = await session.purchase<{ txHash: string }>(`${sandbox.url}/v1/demo/summarize`, {
      method: "POST",
      body: JSON.stringify({ text: "cli verified call" }),
      idempotencyKey: histKeys[3],
      maxPayment: 32n * ONE_TANE,
    });
    const verify = (amount: string) =>
      execFileAsync(
        "node",
        [
          "--experimental-strip-types",
          "packages/cli/bin/ane.mjs",
          "receipt",
          "verify",
          "--rpc-url",
          rpcUrl,
          "--registry",
          registryAddress,
          "--tx",
          bought.receipt!.txHash,
          "--payee",
          sandbox.providerAddress,
          "--amount",
          amount,
          "--vault",
          vaultAddress,
        ],
        { cwd: repoRoot },
      );
    const { stdout: goodOut } = await verify((16n * ONE_TANE).toString());
    seen.push(goodOut);
    assert.equal((JSON.parse(goodOut) as { verified: boolean }).verified, true);

    const bad = await verify((17n * ONE_TANE).toString()).then(
      () => assert.fail("a wrong amount must not verify"),
      (err: unknown) => JSON.parse((err as { stdout: string }).stdout) as { verified: boolean },
    );
    assert.equal(bad.verified, false);
  });

  await t.test("nothing inspected leaks owner or session key material", async () => {
    const traffic = seen.join("\n").toLowerCase();
    for (const secret of [OWNER_KEY, SESSION_KEY]) {
      assert.ok(!traffic.includes(secret.toLowerCase().replace(/^0x/, "")), "no key material leaks");
    }
  });
});
