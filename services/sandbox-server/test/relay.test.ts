import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  type AneClient,
  functionSelector,
  keccak256Utf8,
  OwnerWallet,
} from "../../../packages/sdk-ts/src/index.ts";
import { createSandboxServer, type SandboxServerConfig } from "../src/server.ts";

const word = (n: bigint | number | string) =>
  (typeof n === "string" ? n.replace(/^0x/, "") : BigInt(n).toString(16)).padStart(64, "0");
const TOKEN = "0x" + "11".repeat(20);
const FACTORY = "0x" + "22".repeat(20);
const VAULT = "0x" + "55".repeat(20);
const OWNER_KEY = keccak256Utf8("16ane.test.relay.owner");
const OTHER_KEY = keccak256Utf8("16ane.test.relay.other");

// An RPC that knows the registry, the faucet's views, the factory's registry of vaults and one vault's owner,
// answers eth_gasPrice with `gasPrice`, and makes every simulation (eth_call with a `from`) revert when
// `reverts` is set. It records each method, so a test can show that a refused request sent nothing.
async function fakeRpc(opts: {
  gasPrice?: bigint;
  reverts?: boolean;
  vaultOwner: string;
  /** Called when eth_call carries a `from` (simulation); tests can advance a clock here. */
  onSimulate?: () => void;
}) {
  const methods: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method, params = [] } = JSON.parse(body) as { id: number; method: string; params?: [{ data: string; from?: string; to: string }] };
      const call = params[0];
      methods.push(method === "eth_call" && call?.from ? "simulate" : method);
      let result: string | undefined;
      let error: { code: number; message: string } | undefined;
      if (method === "eth_gasPrice") result = "0x" + (opts.gasPrice ?? 1n).toString(16);
      else if (method === "eth_blockNumber") result = "0x10";
      else if (method === "eth_call" && call?.from) {
        opts.onSimulate?.();
        if (opts.reverts) error = { code: 3, message: "execution reverted: custom error 0xdeadbeef" };
        else result = "0x";
      } else if (method === "eth_call") {
        const data = call?.data ?? "";
        if (data.startsWith(functionSelector("claimAmount()"))) result = "0x" + word(16_000n * 10n ** 18n);
        else if (data.startsWith(functionSelector("cooldownSeconds()"))) result = "0x" + word(3600);
        else if (data.startsWith(functionSelector("isRegisteredVault(address)"))) {
          result = "0x" + word(data.slice(10).endsWith(VAULT.slice(2)) ? 1 : 0);
        } else if (data.startsWith(functionSelector("getAccountingSummary()"))) {
          result = "0x" + word(opts.vaultOwner) + word(0).repeat(14);
        } else result = "0x" + word(TOKEN) + word(FACTORY) + word(0x33) + word(0x44);
      } else error = { code: -32601, message: "not in this fake" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    methods,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// An OwnerWallet that signs against the fake's contracts, with the vault at policy version 1.
const signerFor = (key: string) =>
  new OwnerWallet(
    {
      chainId: 84532,
      resolveContracts: async () => ({ aneTestToken: TOKEN, aneVaultFactory: FACTORY }),
      getPolicyVersion: async () => 1,
    } as unknown as AneClient,
    key,
  );
const owner = signerFor(OWNER_KEY);
const other = signerFor(OTHER_KEY);

async function withServer(
  t: test.TestContext,
  opts: Partial<SandboxServerConfig> & {
    gasPrice?: bigint;
    reverts?: boolean;
    vaultOwner?: string;
    onSimulate?: () => void;
  },
  run: (relay: (body: object) => Promise<{ status: number; code?: string; message?: string }>, methods: string[]) => Promise<void>,
) {
  const rpc = await fakeRpc({
    gasPrice: opts.gasPrice,
    reverts: opts.reverts,
    vaultOwner: opts.vaultOwner ?? owner.address,
    onSimulate: opts.onSimulate,
  });
  const { gasPrice: _g, reverts: _r, vaultOwner: _v, onSimulate: _o, ...serverOpts } = opts;
  const sandbox = await createSandboxServer({
    rpcUrl: rpc.url,
    registryAddress: "0x" + "ab".repeat(20),
    relayerPrivateKey: "0x" + "1".repeat(64),
    ...serverOpts,
  });
  t.mock.method(console, "error", () => {});
  rpc.methods.length = 0;
  try {
    await run(async (body) => {
      const res = await fetch(`${sandbox.url}/v1/relay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      });
      const json = (await res.json()) as { error?: { code: string; message: string } };
      return { status: res.status, code: json.error?.code, message: json.error?.message };
    }, rpc.methods);
  } finally {
    await sandbox.close();
    await rpc.close();
  }
}

const sendsNothing = (methods: string[]) =>
  assert.ok(methods.every((m) => m === "eth_call"), `only reads, got ${methods.join(",")}`);

test("an unknown action or a malformed field is a 400 that sends nothing", async (t) => {
  await withServer(t, {}, async (relay, methods) => {
    assert.equal((await relay({ action: "approve" })).code, "ANE-E-1201");
    const r = await relay({ action: "transfer", from: "0x12", to: VAULT, value: "1", validBefore: 1, nonce: "0x", signature: "0x" });
    assert.equal(r.status, 400);
    assert.match(r.message!, /from must be an address/);
    assert.deepEqual(methods, []);
  });
});

test("a transfer, creation, policy or revocation not signed by the right key is refused before anything is sent", async (t) => {
  await withServer(t, {}, async (relay, methods) => {
    const transfer = await other.signTransfer(VAULT, 10n);
    const r1 = await relay({ action: "transfer", ...transfer, from: owner.address });
    assert.equal(r1.status, 403);
    assert.match(r1.message!, /transfer: not signed by/);

    const creation = await other.signVaultCreation(1n);
    assert.match((await relay({ action: "createVault", ...creation, owner: owner.address })).message!, /createVault: not signed by/);

    // The vault's owner is read from the chain; another key's signature is refused.
    const policy = await other.signPolicy(VAULT, "0x" + "66".repeat(20), { allowanceCap: 1n, perTxLimit: 1n, expiry: 1_900_000_000 });
    assert.match((await relay({ action: "setPolicy", ...policy })).message!, /setPolicy: not signed by/);
    assert.match((await relay({ action: "revoke", ...(await other.signRevoke(VAULT)) })).message!, /revoke: not signed by/);
    sendsNothing(methods);
  });
});

test("a vault the factory didn't create, and a deadline out of range, are refused", async (t) => {
  await withServer(t, {}, async (relay, methods) => {
    const elsewhere = await owner.signRevoke("0x" + "99".repeat(20));
    const r = await relay({ action: "revoke", ...elsewhere });
    assert.equal(r.status, 403);
    assert.match(r.message!, /not a vault created by the 16ane factory/);

    const expired = await owner.signRevoke(VAULT, { deadline: Math.floor(Date.now() / 1000) - 1 });
    assert.match((await relay({ action: "revoke", ...expired })).message!, /deadline must be/);
    const tooFar = await owner.signTransfer(VAULT, 1n, { validBefore: Math.floor(Date.now() / 1000) + 7200 });
    assert.match((await relay({ action: "transfer", ...tooFar })).message!, /deadline must be/);
    sendsNothing(methods);
  });
});

test("above the fee ceiling: 503 with Retry-After, nothing simulated or sent", async (t) => {
  await withServer(t, { relayerMaxFeeWei: 1_000n, gasPrice: 5_000n }, async (relay, methods) => {
    const r = await relay({ action: "revoke", ...(await owner.signRevoke(VAULT)) });
    assert.equal(r.status, 503);
    assert.equal(r.code, "ANE-E-1205");
    assert.match(r.message!, /5000 wei\) is above the relayer's ceiling \(1000 wei\)/);
    assert.ok(!methods.includes("simulate"));
  });
});

test("an action that would revert is refused with 422 after simulation, and never sent", async (t) => {
  await withServer(t, { reverts: true }, async (relay, methods) => {
    const r = await relay({ action: "revoke", ...(await owner.signRevoke(VAULT)) });
    assert.equal(r.status, 422);
    assert.equal(r.code, "ANE-E-1204");
    assert.match(r.message!, /would revert, so it was not sent: .*0xdeadbeef/);
    assert.deepEqual(methods.filter((m) => m !== "eth_call"), ["simulate"]);
  });
});

test("a signed action that passes every check goes to the chain", async (t) => {
  await withServer(t, {}, async (relay, methods) => {
    const r = await relay({ action: "revoke", ...(await owner.signRevoke(VAULT)) });
    // This fake can't mine, so the send fails; what matters is that it was attempted after the simulation.
    assert.equal(r.status, 502);
    assert.equal(r.code, "ANE-E-1206");
    assert.ok(methods.includes("simulate"));
    assert.ok(methods.some((m) => !["eth_call", "simulate"].includes(m)), "the relayer tried to send");
  });
});

test("a registered vault with a zero owner is refused before send", async (t) => {
  await withServer(t, { vaultOwner: "0x" + "00".repeat(20) }, async (relay, methods) => {
    const r = await relay({ action: "revoke", ...(await owner.signRevoke(VAULT)) });
    assert.equal(r.status, 403);
    assert.equal(r.code, "ANE-E-1202");
    assert.match(r.message!, /has no owner/);
    sendsNothing(methods);
  });
});

test("a deadline that expires during prepare/simulate is refused without sending", async (t) => {
  const realNow = Date.now;
  let skewMs = 0;
  Date.now = () => realNow() + skewMs;
  t.after(() => {
    Date.now = realNow;
  });
  await withServer(
    t,
    {
      onSimulate: () => {
        // Jump past the signature's deadline after prepare accepted it, before the pre-send re-check.
        skewMs = 120_000;
      },
    },
    async (relay, methods) => {
      const deadline = Math.floor(realNow() / 1000) + 45;
      const r = await relay({ action: "revoke", ...(await owner.signRevoke(VAULT, { deadline })) });
      assert.equal(r.status, 403);
      assert.equal(r.code, "ANE-E-1202");
      assert.match(r.message!, /deadline has passed/);
      assert.ok(methods.includes("simulate"));
      assert.ok(methods.every((m) => m === "eth_call" || m === "simulate" || m === "eth_gasPrice"));
    },
  );
});

test("malformed JSON on /v1/relay is a 400 ANE-E-4000 (server SyntaxError handler), not a crash", async (t) => {
  const rpc = await fakeRpc({ vaultOwner: owner.address });
  const sandbox = await createSandboxServer({
    rpcUrl: rpc.url,
    registryAddress: "0x" + "ab".repeat(20),
    relayerPrivateKey: "0x" + "1".repeat(64),
  });
  t.mock.method(console, "error", () => {});
  try {
    const res = await fetch(`${sandbox.url}/v1/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    const { error } = (await res.json()) as { error: { code: string } };
    assert.equal(error.code, "ANE-E-4000");
  } finally {
    await sandbox.close();
    await rpc.close();
  }
});
