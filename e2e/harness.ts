import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import path from "node:path";
import type { TestContext } from "node:test";
import {
  AneClient,
  AgentSession,
  OwnerWallet,
  SecretKey,
  keccak256Utf8,
} from "../packages/sdk-ts/src/index.ts";
import { createSandboxServer } from "../services/sandbox-server/src/server.ts";

const execFileAsync = promisify(execFile);

export const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const OWNER_KEY = keccak256Utf8("16ane.e2e.owner.key.v1");
export const SESSION_KEY = keccak256Utf8("16ane.e2e.session.key.v1");
export const PROVIDER_KEY = keccak256Utf8("16ane.e2e.provider.key.v1");
export const PEER_OWNER_KEY = keccak256Utf8("16ane.e2e.peer.owner.key.v1");
export const PEER_SESSION_KEY = keccak256Utf8("16ane.e2e.peer.session.key.v1");

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForRpc(rpcUrl: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for Anvil at ${rpcUrl}`);
}

// A faucet claim request signed by the recipient (#79): the proof agents and the CLI send.
export async function signedClaimBody(client: AneClient, recipientKey: string): Promise<string> {
  const c = await client.signFaucetClaim(new SecretKey(recipientKey));
  return JSON.stringify({
    recipient: c.recipient,
    authorization: { deadline: c.deadline, nonce: c.nonce, signature: c.signature },
  });
}

// Boots Anvil, deploys the sandbox contracts, starts the reference server and funds a
// vault-backed agent session. Teardown is registered on `t`.
export async function startSandboxStack(t: TestContext) {
  const anvilPort = await findFreePort();
  const rpcUrl = `http://127.0.0.1:${anvilPort}`;

  const anvilProc: ChildProcess = spawn(
    "anvil",
    ["--port", String(anvilPort), "--chain-id", "84532", "--silent"],
    { stdio: "ignore" },
  );

  let sandboxClose: (() => Promise<void>) | undefined;

  t.after(async () => {
    if (sandboxClose) {
      await sandboxClose();
    }
    anvilProc.kill("SIGTERM");
  });

  await waitForRpc(rpcUrl);

  // Deploy Sandbox Contracts via DeploySandbox.s.sol
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const { stdout: deployOut } = await execFileAsync(
    "forge",
    [
      "script",
      "script/DeploySandbox.s.sol:DeploySandbox",
      "--rpc-url",
      rpcUrl,
      "--broadcast",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PRIVATE_KEY: DEPLOYER_KEY,
        ANE_ENV: "sandbox",
        FOUNDRY_DISABLE_NIGHTLY_WARNING: "1",
      },
    },
  );

  const regMatch = deployOut.match(/AneRegistry:\s*(0x[0-9a-fA-F]{40})/);
  assert.ok(regMatch, `Failed to parse AneRegistry from deploy output:\n${deployOut}`);
  const registryAddress = regMatch[1];

  // Start Reference Sandbox Server
  const sandbox = await createSandboxServer({
    rpcUrl,
    chainId: 84532,
    registryAddress,
    relayerPrivateKey: DEPLOYER_KEY,
    providerPrivateKey: PROVIDER_KEY,
    trialFreeCallsPerCaller: 1,
    trialGlobalDailyCap: 50,
  });
  sandboxClose = sandbox.close;

  const client = new AneClient({
    rpcUrl,
    chainId: 84532,
    registryAddress,
  });
  const contracts = await client.resolveContracts();
  const owner = new OwnerWallet(client, new SecretKey(OWNER_KEY));
  const sessionPreview = new AgentSession({
    client,
    vaultAddress: "0x1111111111111111111111111111111111111111",
    sessionKey: new SecretKey(SESSION_KEY),
  });
  const peerOwnerPreview = new OwnerWallet(client, new SecretKey(PEER_OWNER_KEY));

  // Fund derived test accounts with Anvil ETH for gas
  const tenEthHex = "0x" + (10n * 10n ** 18n).toString(16);
  for (const addr of [
    owner.address,
    sessionPreview.sessionAddress,
    sandbox.providerAddress,
    peerOwnerPreview.address,
  ]) {
    await client.rpcCall("anvil_setBalance", [addr, tenEthHex]);
  }

  const { vaultAddress } = await owner.ensureVaultDeployed(0n);
  const session = new AgentSession({
    client,
    vaultAddress,
    sessionKey: new SecretKey(SESSION_KEY),
  });

  return {
    rpcUrl,
    repoRoot,
    registryAddress,
    sandbox,
    client,
    contracts,
    owner,
    vaultAddress,
    session,
  };
}
