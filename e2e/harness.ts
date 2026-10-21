import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
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
  privateKeyToAddress,
  type SpendIntent,
} from "../packages/sdk-ts/src/index.ts";
import { createSandboxServer } from "../services/sandbox-server/src/server.ts";

const execFileAsync = promisify(execFile);

export const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const OWNER_KEY = keccak256Utf8("16ane.e2e.owner.key.v1");
export const SESSION_KEY = keccak256Utf8("16ane.e2e.session.key.v1");
export const PROVIDER_KEY = keccak256Utf8("16ane.e2e.provider.key.v1");
export const PEER_OWNER_KEY = keccak256Utf8("16ane.e2e.peer.owner.key.v1");
export const PEER_SESSION_KEY = keccak256Utf8("16ane.e2e.peer.session.key.v1");

/** One whole tANE in base units (18 decimals). Shared by the S1–S6 scenario modules (#65). */
export const ONE_TANE = 10n ** 18n;

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

// Minimal JSON-RPC POST for setup steps that run before the AneClient exists.
async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} failed: HTTP ${res.status}`);
  const payload = (await res.json()) as {
    result?: unknown;
    error?: { code: number; message: string };
  };
  if (payload.error) {
    throw new Error(`RPC ${method} failed (${payload.error.code}): ${payload.error.message}`);
  }
  return payload.result;
}

// Base64 Payment-Signature header for raw fetches against the sandbox: threat flows
// craft (and tamper with) payment payloads the SDK would never sign.
export function encodeX402PaymentSignature(params: {
  asset: string;
  amount: bigint;
  payTo: string;
  intent: SpendIntent;
  signature: string;
  resourceHash: string;
  requestHash: string;
  txHash?: string;
}): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      scheme: "ane-vault-v1",
      network: "eip155:84532",
      accepted: {
        asset: params.asset,
        amount: params.amount.toString(),
        payTo: params.payTo,
      },
      payload: {
        ...params.intent,
        resourceHash: params.resourceHash,
        requestHash: params.requestHash,
        signature: params.signature,
        ...(params.txHash === undefined ? {} : { txHash: params.txHash }),
      },
    }),
    "utf8",
  ).toString("base64");
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
// vault-backed agent session. Teardown is registered on `t`. Two env knobs drive CI:
// ANVIL_FORK_URL (fork Base Sepolia instead of an empty chain) and E2E_ARTIFACT_DIR
// (per-stack anvil.log, deploy.log and stack.json for failure artifacts).
export async function startSandboxStack(t: TestContext) {
  const anvilPort = await findFreePort();
  const rpcUrl = `http://127.0.0.1:${anvilPort}`;
  const forkUrl = process.env.ANVIL_FORK_URL;
  const artifactDir = process.env.E2E_ARTIFACT_DIR;
  if (artifactDir) mkdirSync(artifactDir, { recursive: true });

  const anvilArgs = ["--port", String(anvilPort), "--chain-id", "84532"];
  if (forkUrl) {
    anvilArgs.push("--fork-url", forkUrl);
  } else {
    anvilArgs.push("--silent");
  }
  let anvilLogFd: number | undefined;
  if (artifactDir) {
    // Drop --silent's quiet only when logs are captured; local runs stay readable.
    const silentAt = anvilArgs.indexOf("--silent");
    if (silentAt >= 0) anvilArgs.splice(silentAt, 1);
    anvilLogFd = openSync(path.join(artifactDir, `anvil-${anvilPort}.log`), "a");
  }
  // The harness runs the foundryup/toolchain `anvil` from PATH by design; anyone able to
  // plant a hostile earlier entry already executes code as this user. Reviewed, not a finding.
  const anvilProc: ChildProcess = spawn("anvil", anvilArgs, { // NOSONAR
    stdio: anvilLogFd === undefined ? "ignore" : ["ignore", anvilLogFd, anvilLogFd],
  });

  let sandboxClose: (() => Promise<void>) | undefined;

  t.after(async () => {
    if (sandboxClose) {
      // A flow may stop the server mid-test (hosted-outage coverage); only that
      // deliberate close is forgiven here, every other teardown error still fails.
      await sandboxClose().catch((err: unknown) => {
        if ((err as { code?: string }).code === "ERR_SERVER_NOT_RUNNING") return;
        throw err;
      });
    }
    anvilProc.kill("SIGTERM");
    if (anvilLogFd !== undefined) closeSync(anvilLogFd);
  });

  await waitForRpc(rpcUrl);

  // The deployer pays for the forge-script deployment below. Empty Anvil prefunds it;
  // a fork usually does not, so top it up on the same uniform path.
  await rpcCall(rpcUrl, "anvil_setBalance", [
    privateKeyToAddress(new SecretKey(DEPLOYER_KEY)),
    "0x" + (100n * 10n ** 18n).toString(16),
  ]);

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
  if (artifactDir) {
    writeFileSync(
      path.join(artifactDir, `deploy-${anvilPort}.log`),
      `rpc: ${rpcUrl}\nfork: ${forkUrl ?? "(empty chain)"}\n\n${deployOut}`,
    );
  }

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

  if (artifactDir) {
    writeFileSync(
      path.join(artifactDir, `stack-${anvilPort}.json`),
      JSON.stringify(
        {
          rpcUrl,
          registryAddress,
          vaultAddress,
          owner: owner.address,
          session: session.sessionAddress,
          fork: forkUrl ?? null,
          contracts,
        },
        null,
        2,
      ),
    );
  }

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

/** What `startSandboxStack` returns; every flow file boots its own stack so flows run alone. */
export type SandboxStack = Awaited<ReturnType<typeof startSandboxStack>>;

// Claims faucet tANE for the stack owner, funds the vault and delegates the stack session:
// the funded-agent starting point every purchase flow needs. Mirrors S1's setup
// (1,600 tANE funded, FIXED 320 cap / 64 per-tx) unless overridden.
export async function setupFundedSession(
  stack: SandboxStack,
  opts: {
    fund?: bigint;
    cap?: bigint;
    perTx?: bigint;
    mode?: "FIXED" | "REVOLVING";
    ceiling?: bigint;
    daily?: bigint;
  } = {},
): Promise<void> {
  const { sandbox, client, owner, vaultAddress, session } = stack;
  const claimRes = await fetch(`${sandbox.url}/v1/faucet/claims`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await signedClaimBody(client, OWNER_KEY),
  });
  assert.ok(
    claimRes.status === 201 || claimRes.status === 429,
    `faucet claim for setup must succeed or already exist, got ${claimRes.status}`,
  );
  await owner.fundVault(vaultAddress, opts.fund ?? 1600n * ONE_TANE);
  await owner.delegateSession(vaultAddress, session.sessionAddress, {
    mode: opts.mode ?? "FIXED",
    allowanceCap: opts.cap ?? 320n * ONE_TANE,
    perTxLimit: opts.perTx ?? 64n * ONE_TANE,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    ...(opts.ceiling === undefined ? {} : { revolvingTreasuryCeiling: opts.ceiling }),
    ...(opts.daily === undefined ? {} : { dailyLimit: opts.daily }),
  });
}
