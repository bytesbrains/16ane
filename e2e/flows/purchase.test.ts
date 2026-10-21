import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SANDBOX_DISCLAIMER } from "../../packages/sdk-ts/src/index.ts";
import { ONE_TANE, SESSION_KEY, setupFundedSession, startSandboxStack } from "../harness.ts";

const execFileAsync = promisify(execFile);
const ITEM_TEXT = "An anna was a currency unit formerly used in British India equal to 1/16 of a rupee.";

// Pay for an API call: 402 quote, signed intent, settlement, receipt; idempotent retry;
// the same purchase through the Python SDK (REQ-006, REQ-009, REQ-012, T3).
test("pay for an API call, retry idempotently, repeat from Python (REQ-006, REQ-009, REQ-012, T3)", async (t) => {
  const stack = await startSandboxStack(t);
  await setupFundedSession(stack);
  const { rpcUrl, repoRoot, registryAddress, sandbox, client, vaultAddress, session } = stack;
  // Test idempotency label (not a secret); the marker below silences the generic-api-key rule.
  const idemKey = "idem-purchase-summarize-001"; //gitleaks:allow
  let firstTxHash = "";

  await t.test("402 quote leads to a settled purchase with an on-chain-verified receipt", async () => {
    const purchaseRes = await session.purchase<{
      summary: string;
      paidAmount: string;
      txHash: string;
      disclaimer: string;
    }>(`${sandbox.url}/v1/demo/summarize`, {
      method: "POST",
      body: JSON.stringify({ text: ITEM_TEXT }),
      idempotencyKey: idemKey,
      maxPayment: 32n * ONE_TANE,
      verifyManifest: true,
      verifyReceiptOnChain: true,
    });

    assert.equal(purchaseRes.status, 200);
    assert.equal(purchaseRes.trialSponsored, false);
    assert.ok(purchaseRes.receipt);
    assert.equal(purchaseRes.receipt.amount, (16n * ONE_TANE).toString());
    assert.equal(purchaseRes.data.disclaimer, SANDBOX_DISCLAIMER);
    firstTxHash = purchaseRes.data.txHash;
    assert.equal((await client.getAccountingSummary(vaultAddress)).cumulativeSpent, 16n * ONE_TANE);
  });

  await t.test("retrying with the same key and body replays without a second charge", async () => {
    const retryRes = await session.purchase<{ txHash: string }>(`${sandbox.url}/v1/demo/summarize`, {
      method: "POST",
      body: JSON.stringify({ text: ITEM_TEXT }),
      idempotencyKey: idemKey,
    });
    assert.equal(retryRes.status, 200);
    assert.equal(retryRes.headers["x-idempotent-replay"], "true");
    assert.equal(retryRes.data.txHash, firstTxHash);
    assert.equal((await client.getAccountingSummary(vaultAddress)).cumulativeSpent, 16n * ONE_TANE);
  });

  await t.test("reusing the key with a different body is a 409 conflict", async () => {
    const conflictRes = await session.purchase(`${sandbox.url}/v1/demo/summarize`, {
      method: "POST",
      body: JSON.stringify({ text: "Different payload body with same idempotency key" }),
      idempotencyKey: idemKey,
    });
    assert.equal(conflictRes.status, 409);
  });

  await t.test("the Python SDK makes the same purchase (REQ-009 parity)", async () => {
    const { stdout: pyOut } = await execFileAsync(
      "python3",
      [
        "-c",
        `
import sys, json
sys.path.insert(0, "packages/sdk-py")
from ane_sdk import AneClient, AgentSession
client = AneClient(rpc_url="${rpcUrl}", chain_id=84532, registry_address="${registryAddress}")
session = AgentSession(client=client, vault_address="${vaultAddress}", session_key="${SESSION_KEY}")
res = session.purchase(
    "${sandbox.url}/v1/demo/clean-data",
    method="POST",
    body=json.dumps({"items": ["Anna", "Paisa", "anna", "Pie "]}),
    max_payment=64 * 10**18,
    verify_manifest=True,
)
print(json.dumps(res))
`,
      ],
      { cwd: repoRoot },
    );
    const pyResult = JSON.parse(pyOut.trim()) as {
      status: number;
      data: { items: string[]; paidAmount: string };
      receipt: { txHash: string };
    };
    assert.equal(pyResult.status, 200);
    assert.deepEqual(pyResult.data.items, ["anna", "paisa", "pie"]);
    assert.equal(pyResult.data.paidAmount, (32n * ONE_TANE).toString());

    assert.equal((await client.getAccountingSummary(vaultAddress)).cumulativeSpent, 48n * ONE_TANE);
  });
});
