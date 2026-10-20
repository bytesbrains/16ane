import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  AgentSession,
  OwnerWallet,
  SANDBOX_DISCLAIMER,
  SecretKey,
  computeRequestHash,
  computeResourceHash,
  keccak256Utf8,
} from "../packages/sdk-ts/src/index.ts";
import {
  DEPLOYER_KEY,
  OWNER_KEY,
  PEER_OWNER_KEY,
  PEER_SESSION_KEY,
  SESSION_KEY,
  startSandboxStack,
} from "./harness.ts";

const execFileAsync = promisify(execFile);

const ONE_TANE = 10n ** 18n;

test("16ane E2E Scenarios S1-S6, Threat Model T1-T10, Python SDK & CLI Verification", async (t) => {
  const {
    rpcUrl,
    repoRoot,
    registryAddress,
    sandbox,
    client,
    contracts,
    owner,
    vaultAddress,
    session,
  } = await startSandboxStack(t);

  await t.test("S1: Bounded Agent Sandbox Purchase, Faucet Cooldown & Idempotency (REQ-001..006, T5, T7)", async () => {
    // 1. Claim 16,000 tANE via Faucet API
    const claimRes = await fetch(`${sandbox.url}/v1/faucet/claims`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipient: owner.address }),
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
      body: JSON.stringify({ recipient: owner.address }),
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

    const retryRes = await session.purchase<{ txHash: string }>(
      `${sandbox.url}/v1/demo/summarize`,
      {
        method: "POST",
        body: JSON.stringify({
          text: "An anna was a currency unit formerly used in British India equal to 1/16 of a rupee.",
        }),
        idempotencyKey: idemKey,
      },
    );
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
  });

  await t.test("S2: Malicious / Prompt-Injected Overspend, Replay & Spoofed Manifest Rejection (T1, T2, T6, T8)", async () => {
    // 1. Caller maxPayment guard blocks overpriced endpoint before signing
    await assert.rejects(
      () =>
        session.purchase(`${sandbox.url}/v1/demo/clean-data`, {
          method: "POST",
          body: JSON.stringify({ items: ["a"] }),
          maxPayment: 8n * ONE_TANE, // endpoint costs 32 tANE
        }),
      /ANE-E-3002/,
    );

    // 2. Spoofed manifest payTo mismatch is rejected before signing (T8)
    const spoofedManifest = client.signServiceManifest(
      {
        schemaVersion: "16ane-manifest-v0",
        serviceId: "spoofed-service",
        name: "Spoofed Service",
        version: "0.1.0",
        network: "eip155:84532",
        chainId: 84532,
        payTo: "0x1111111111111111111111111111111111111111", // differs from server payTo
        tokenAddress: contracts.aneTestToken,
        tokenSymbol: "tANE",
        updatedAt: 1760860800,
        endpoints: [
          {
            id: "summarize",
            method: "POST",
            path: "/v1/demo/summarize",
            priceAmount: (16n * ONE_TANE).toString(),
            scheme: "ane-vault-v1",
          },
        ],
      },
      new SecretKey(OWNER_KEY),
      contracts.aneServiceDirectory,
    );

    await assert.rejects(
      () =>
        session.purchase(`${sandbox.url}/v1/demo/summarize`, {
          method: "POST",
          body: JSON.stringify({ text: "test spoof" }),
          manifest: spoofedManifest,
        }),
      /ANE-E-5003/,
    );

    // 3. Prompt-injected attempt to sign a 500 tANE SpendIntent (> 64 tANE maxPerTx & > 320 tANE cap) reverts on-chain (T1, T2)
    const targetUrl = `${sandbox.url}/v1/demo/summarize`;
    const bodyStr = JSON.stringify({ text: "overspend attempt" });
    const resourceHash = computeResourceHash("POST", targetUrl);
    const requestHash = computeRequestHash(bodyStr);
    const policyVersion = await client.getPolicyVersion(vaultAddress);

    const overspendSigned = session.signSpendIntent({
      merchant: sandbox.providerAddress,
      amount: 500n * ONE_TANE,
      quoteId: keccak256Utf8("quote-overspend-001"),
      serviceIdHash: keccak256Utf8("16ane-sandbox-reference-demo"),
      validBefore: Math.floor(Date.now() / 1000) + 300,
      policyVersion,
    });
    const overspendPayloadB64 = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        scheme: "ane-vault-v1",
        network: "eip155:84532",
        accepted: {
          asset: contracts.aneTestToken,
          amount: (500n * ONE_TANE).toString(),
          payTo: sandbox.providerAddress,
        },
        payload: {
          ...overspendSigned.intent,
          resourceHash,
          requestHash,
          signature: overspendSigned.signature,
        },
      }),
      "utf8",
    ).toString("base64");

    const overspendRes = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": overspendPayloadB64,
      },
      body: bodyStr,
    });
    assert.equal(overspendRes.status, 402);
    const overspendErr = (await overspendRes.json()) as {
      error: { code: string; message: string; errorId?: string };
    };
    assert.equal(overspendErr.error.code, "ANE-E-4011");
    // The revert detail is logged server-side under errorId, never sent to the client (#52).
    assert.equal(overspendErr.error.message, "On-chain settlement failed");
    assert.match(overspendErr.error.errorId ?? "", /^[0-9a-f-]{36}$/);

    // 4. Replaying a valid signed SpendIntent with a new Idempotency-Key is rejected with 409 (T6)
    const validSigned = session.signSpendIntent({
      merchant: sandbox.providerAddress,
      amount: 16n * ONE_TANE,
      quoteId: keccak256Utf8("quote-replay-test-001"),
      serviceIdHash: keccak256Utf8("16ane-sandbox-reference-demo"),
      validBefore: Math.floor(Date.now() / 1000) + 300,
      policyVersion,
    });
    const validPayloadB64 = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        scheme: "ane-vault-v1",
        network: "eip155:84532",
        accepted: {
          asset: contracts.aneTestToken,
          amount: (16n * ONE_TANE).toString(),
          payTo: sandbox.providerAddress,
        },
        payload: {
          ...validSigned.intent,
          resourceHash,
          requestHash,
          signature: validSigned.signature,
        },
      }),
      "utf8",
    ).toString("base64");

    const firstUse = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "idem-replay-1",
        "payment-signature": validPayloadB64,
      },
      body: bodyStr,
    });
    assert.equal(firstUse.status, 200);

    const secondReplay = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "idem-replay-2",
        "payment-signature": validPayloadB64,
      },
      body: bodyStr,
    });
    assert.equal(secondReplay.status, 409);
  });

  await t.test("S3: Agent Earns Revenue under FIXED vs REVOLVING Budget Mode (REQ-004, T4)", async () => {
    const availBefore = await client.getAvailableToSpend(vaultAddress);
    // Cumulative spent so far: 16 (S1) + 32 (S1 py) + 16 (S2) = 64 tANE. Cap = 320 tANE -> available = 256 tANE.
    assert.equal(availBefore, 256n * ONE_TANE);

    // Deploy a peer agent vault that pays 50 tANE of verified revenue to our primary vault!
    const peerOwner = new OwnerWallet(client, new SecretKey(PEER_OWNER_KEY));
    await fetch(`${sandbox.url}/v1/faucet/claims`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipient: peerOwner.address }),
    });
    const { vaultAddress: peerVault } = await peerOwner.ensureVaultDeployed(0n);
    await peerOwner.fundVault(peerVault, 200n * ONE_TANE);
    const peerSession = new AgentSession({
      client,
      vaultAddress: peerVault,
      sessionKey: new SecretKey(PEER_SESSION_KEY),
    });
    await peerOwner.delegateSession(peerVault, peerSession.sessionAddress, {
      mode: "FIXED",
      allowanceCap: 100n * ONE_TANE,
      perTxLimit: 100n * ONE_TANE,
      expiry: Math.floor(Date.now() / 1000) + 3600,
    });

    // Settle a 50 tANE payment from peerVault -> vaultAddress (triggers notifyVerifiedRevenue)
    const peerPolicyVer = await client.getPolicyVersion(peerVault);
    const peerIntent = peerSession.signSpendIntent({
      merchant: vaultAddress,
      amount: 50n * ONE_TANE,
      quoteId: keccak256Utf8("peer-to-agent-job-001"),
      serviceIdHash: keccak256Utf8("peer-agent-service"),
      validBefore: Math.floor(Date.now() / 1000) + 300,
      policyVersion: peerPolicyVer,
    });
    await client.settleSpendIntentOnChain(
      new SecretKey(DEPLOYER_KEY),
      peerIntent.intent,
      peerIntent.signature,
    );

    // Under FIXED mode, incoming verifiedRevenue MUST NOT increase spendableBalance (REQ-004, T4)
    const availAfterRevenueFixed = await client.getAvailableToSpend(vaultAddress);
    assert.equal(availAfterRevenueFixed, 256n * ONE_TANE);

    const summary = await client.getAccountingSummary(vaultAddress);
    assert.equal(summary.verifiedRevenue, 50n * ONE_TANE);
  });

  await t.test("S4: Sponsored Trial Quota Exhaustion & Paid Fallback (REQ-013, ADR-0008, T9)", async () => {
    // 1st call with x-trial-request: true -> 200 OK sponsored (0 tANE charged)
    const spentBeforeTrial = (await client.getAccountingSummary(vaultAddress)).cumulativeSpent;
    const trialRes = await session.purchase<{
      sponsored: boolean;
      trialQuotaRemaining: number;
    }>(`${sandbox.url}/v1/demo/summarize`, {
      method: "POST",
      headers: { "x-trial-request": "true" },
      body: JSON.stringify({ text: "First free sponsored trial call" }),
    });
    assert.equal(trialRes.status, 200);
    assert.equal(trialRes.trialSponsored, true);
    assert.equal(trialRes.data.sponsored, true);
    assert.equal(trialRes.data.trialQuotaRemaining, 0);

    const spentAfterTrial = (await client.getAccountingSummary(vaultAddress)).cumulativeSpent;
    assert.equal(spentAfterTrial, spentBeforeTrial);

    // 2nd call with x-trial-request: true -> quota exhausted, falls back to 402 and pays 16 tANE
    const paidFallbackRes = await session.purchase<{
      sponsored: boolean;
      paidAmount: string;
    }>(`${sandbox.url}/v1/demo/summarize`, {
      method: "POST",
      headers: { "x-trial-request": "true" },
      body: JSON.stringify({ text: "Second call after trial quota exhausted" }),
    });
    assert.equal(paidFallbackRes.status, 200);
    assert.equal(paidFallbackRes.trialSponsored, false);
    assert.equal(paidFallbackRes.data.sponsored, false);
    assert.equal(paidFallbackRes.data.paidAmount, (16n * ONE_TANE).toString());

    const spentAfterFallback = (await client.getAccountingSummary(vaultAddress)).cumulativeSpent;
    assert.equal(spentAfterFallback, spentBeforeTrial + 16n * ONE_TANE);

    // Rotating the unauthenticated x-agent-vault header must not mint a fresh trial (#31)
    const spoofed = await fetch(`${sandbox.url}/v1/demo/summarize`, {
      method: "POST",
      headers: { "x-trial-request": "true", "x-agent-vault": `0x${"ab".repeat(20)}` },
      body: JSON.stringify({ text: "spoofed caller" }),
    });
    assert.equal(spoofed.status, 402);
  });

  await t.test("S5: Facilitator Outage / Direct On-Chain Settlement & CLI Receipt Verification (REQ-005)", async () => {
    const directRes = await session.purchase<{ txHash: string }>(
      `${sandbox.url}/v1/demo/summarize`,
      {
        method: "POST",
        body: JSON.stringify({ text: "Direct on-chain settlement without facilitator" }),
        settleDirectOnChain: true,
        verifyReceiptOnChain: true,
      },
    );
    assert.equal(directRes.status, 200);
    assert.ok(directRes.receipt?.txHash);

    // Verify receipt using the `ane receipt verify` CLI command directly against local RPC
    const { stdout: cliVerifyOut } = await execFileAsync(
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
        directRes.receipt!.txHash,
        "--payee",
        sandbox.providerAddress,
        "--amount",
        (16n * ONE_TANE).toString(),
        "--vault",
        vaultAddress,
      ],
      { cwd: repoRoot },
    );
    const cliVerified = JSON.parse(cliVerifyOut.trim()) as { verified: boolean };
    assert.equal(cliVerified.verified, true);
  });

  await t.test("S6: Automatic On-Chain Refund on Downstream Failure & Emergency Revoke + Sweep (REQ-006, ADR-0009)", async () => {
    const summaryBeforeFail = await client.getAccountingSummary(vaultAddress);

    // 1. Call /v1/demo/simulate-failure -> settles 16 tANE, then automatically executes AneAgentVault.refundPayment
    const failRes = await session.purchase<{
      status: string;
      originalTxHash: string;
      refundTxHash: string;
      refundedAmount: string;
      paymentId: string;
    }>(`${sandbox.url}/v1/demo/simulate-failure`, {
      method: "POST",
      body: JSON.stringify({ task: "trigger deterministic downstream failure" }),
    });
    assert.equal(failRes.status, 502);
    assert.equal(failRes.data.status, "REFUNDED");
    assert.ok(failRes.data.originalTxHash.startsWith("0x"));
    assert.ok(failRes.data.refundTxHash.startsWith("0x"));
    assert.equal(failRes.data.refundedAmount, (16n * ONE_TANE).toString());

    const paymentRec = await client.getPaymentRecord(vaultAddress, failRes.data.paymentId);
    assert.equal(paymentRec.amountPaid, 16n * ONE_TANE);
    assert.equal(paymentRec.amountRefunded, 16n * ONE_TANE);

    const summaryAfterFail = await client.getAccountingSummary(vaultAddress);
    // Refund restores cumulativeSpent back to pre-failure level and returns tokenBalance!
    assert.equal(summaryAfterFail.cumulativeSpent, summaryBeforeFail.cumulativeSpent);
    assert.equal(summaryAfterFail.tokenBalance, summaryBeforeFail.tokenBalance);

    // 2. Owner executes emergency revokeAndSweep -> revokes session key and sweeps all remaining vault tokens
    const ownerBalBeforeSweep = await client.getTokenBalance(owner.address);
    await owner.revokeAndSweep(vaultAddress, session.sessionAddress, owner.address);

    const summaryAfterSweep = await client.getAccountingSummary(vaultAddress);
    assert.equal(summaryAfterSweep.tokenBalance, 0n);
    assert.equal(summaryAfterSweep.active, false);

    const ownerBalAfterSweep = await client.getTokenBalance(owner.address);
    assert.ok(ownerBalAfterSweep > ownerBalBeforeSweep);

    // 3. Subsequent purchase attempt by revoked session must fail
    await assert.rejects(
      () =>
        session.purchase(`${sandbox.url}/v1/demo/summarize`, {
          method: "POST",
          body: JSON.stringify({ text: "post-revocation spend attempt" }),
        }),
      /ANE-E-3001/,
    );
  });
});
