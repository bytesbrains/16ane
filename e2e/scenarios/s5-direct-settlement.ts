import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ONE_TANE, type SandboxStack } from "../harness.ts";

const execFileAsync = promisify(execFile);

/** S5: direct on-chain settlement and `ane receipt verify` (REQ-005). */
export async function runS5(stack: SandboxStack): Promise<void> {
  const { rpcUrl, repoRoot, registryAddress, sandbox, vaultAddress, session } = stack;

  const directRes = await session.purchase<{ txHash: string }>(`${sandbox.url}/v1/demo/summarize`, {
    method: "POST",
    body: JSON.stringify({ text: "Direct on-chain settlement without facilitator" }),
    settleDirectOnChain: true,
    verifyReceiptOnChain: true,
  });
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
}
