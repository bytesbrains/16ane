import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SANDBOX_DISCLAIMER } from "../../packages/sdk-ts/src/index.ts";
import { ONE_TANE, OWNER_KEY, SESSION_KEY, signedClaimBody, type SandboxStack } from "../harness.ts";

const execFileAsync = promisify(execFile);

/** S1: faucet claim, fund, delegate, paid purchase, idempotency, Python SDK (REQ-001..006, T5, T7). */
export async function runS1(stack: SandboxStack): Promise<void> {
  const { rpcUrl, repoRoot, registryAddress, sandbox, client, owner, vaultAddress, session } = stack;

  // 1. Claim 16,000 tANE via Faucet API, signed by the recipient (#79)
  const claimRes = await fetch(`${sandbox.url}/v1/faucet/claims`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await signedClaimBody(client, OWNER_KEY),
  });
  assert.equal(claimRes.status, 201);
  const claimBody = (await claimRes.json()) as {
    claimId: string;
    amount: string;
    disclaimer: string;
  };
  assert.equal(claimBody.amount, (16_000n * ONE_TANE).toString());
  assert.equal(claimBody.disclaimer, SANDBOX_DISCLAIMER);

  // 2. Second immediate faucet claim for same recipient must be rejected with 429 (T5)
  const repeatClaim = await fetch(`${sandbox.url}/v1/faucet/claims`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await signedClaimBody(client, OWNER_KEY),
  });
  assert.equal(repeatClaim.status, 429);

  // 3. Fund Vault with 1,600 tANE and delegate FIXED session (cap = 320 tANE, perTx = 64 tANE)
  await owner.fundVault(vaultAddress, 1600n * ONE_TANE);
  const nowSec = Math.floor(Date.now() / 1000);
  await owner.delegateSession(vaultAddress, session.sessionAddress, {
    mode: "FIXED",
    allowanceCap: 320n * ONE_TANE,
    perTxLimit: 64n * ONE_TANE,
    expiry: nowSec + 3600,
  });

  const summaryBefore = await client.getAccountingSummary(vaultAddress);
  assert.equal(summaryBefore.tokenBalance, 1600n * ONE_TANE);
  assert.equal(summaryBefore.ownerPrincipalDeposited, 1600n * ONE_TANE);
  assert.equal(summaryBefore.spendableNow, 320n * ONE_TANE);

  // 4. Execute paid x402 purchase (16 tANE) with manifest verification and on-chain receipt check
  const idemKey = "idem-s1-summarize-001";
  const purchaseRes = await session.purchase<{
    summary: string;
    paidAmount: string;
    txHash: string;
    disclaimer: string;
  }>(`${sandbox.url}/v1/demo/summarize`, {
    method: "POST",
    body: JSON.stringify({
      text: "An anna was a currency unit formerly used in British India equal to 1/16 of a rupee.",
    }),
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

  // 5. Retry with same Idempotency-Key + same body -> cached 200 OK without double-charging (T7)
  const spentAfterFirst = (await client.getAccountingSummary(vaultAddress)).cumulativeSpent;
  assert.equal(spentAfterFirst, 16n * ONE_TANE);

  const retryRes = await session.purchase<{ txHash: string }>(`${sandbox.url}/v1/demo/summarize`, {
    method: "POST",
    body: JSON.stringify({
      text: "An anna was a currency unit formerly used in British India equal to 1/16 of a rupee.",
    }),
    idempotencyKey: idemKey,
  });
  assert.equal(retryRes.status, 200);
  assert.equal(retryRes.headers["x-idempotent-replay"], "true");
  assert.equal(retryRes.data.txHash, purchaseRes.data.txHash);
  const spentAfterRetry = (await client.getAccountingSummary(vaultAddress)).cumulativeSpent;
  assert.equal(spentAfterRetry, 16n * ONE_TANE);

  // 6. Reusing same Idempotency-Key with DIFFERENT request payload -> 409 Conflict (ANE-E-4004)
  const conflictRes = await session.purchase(`${sandbox.url}/v1/demo/summarize`, {
    method: "POST",
    body: JSON.stringify({ text: "Different payload body with same idempotency key" }),
    idempotencyKey: idemKey,
  });
  assert.equal(conflictRes.status, 409);

  // 7. Execute cross-SDK purchase from Python SDK (ane_sdk) against /v1/demo/clean-data (32 tANE)
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

  const spentAfterPy = (await client.getAccountingSummary(vaultAddress)).cumulativeSpent;
  assert.equal(spentAfterPy, 48n * ONE_TANE); // 16 + 32 = 48 tANE
}
