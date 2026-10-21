import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SecretKey, privateKeyToAddress } from "../../packages/sdk-ts/src/index.ts";
import {
  ONE_TANE,
  OWNER_KEY,
  PEER_OWNER_KEY,
  setupFundedSession,
  startSandboxStack,
} from "../harness.ts";

const execFileAsync = promisify(execFile);

// Direct on-chain paths: settle without the facilitator and verify the receipt with the
// CLI; then stop the server and still move tANE over plain RPC (REQ-001, REQ-015, T9, REL).
test("direct settlement, CLI receipt check, and transfers with the server down (REQ-001, REQ-015, T9, REL)", async (t) => {
  const stack = await startSandboxStack(t);
  await setupFundedSession(stack);
  const { rpcUrl, repoRoot, registryAddress, sandbox, client, contracts, vaultAddress, session } = stack;

  await t.test("settleDirectOnChain pays and the CLI verifies the receipt", async () => {
    const directRes = await session.purchase<{ txHash: string }>(`${sandbox.url}/v1/demo/summarize`, {
      method: "POST",
      body: JSON.stringify({ text: "Direct on-chain settlement without facilitator" }),
      settleDirectOnChain: true,
      verifyReceiptOnChain: true,
    });
    assert.equal(directRes.status, 200);
    assert.ok(directRes.receipt?.txHash);

    // Verify receipt using the `ane receipt verify` CLI command directly against local RPC.
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

  await t.test("with the server stopped, tANE still moves over plain RPC", async () => {
    await sandbox.close();
    await assert.rejects(
      fetch(`${sandbox.url}/healthz`),
      "the stopped server refuses connections",
    );

    const peer = privateKeyToAddress(new SecretKey(PEER_OWNER_KEY));
    const peerBefore = await client.getTokenBalance(peer);
    const sent = await client.sendContractTx(
      new SecretKey(OWNER_KEY),
      contracts.aneTestToken,
      "transfer(address,uint256)",
      [peer, (100n * ONE_TANE).toString()],
    );
    assert.ok(sent.txHash.startsWith("0x"));
    assert.equal(await client.getTokenBalance(peer), peerBefore + 100n * ONE_TANE);
  });
});
