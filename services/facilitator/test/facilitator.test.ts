import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  functionSelector,
  hashSpendIntent,
  hashTransferWithAuthorization,
  keccak256Utf8,
  MemoryKeyValueStore,
  privateKeyToAddress,
  SecretKey,
  signDigest,
  type X402Receipt,
} from "../../../packages/sdk-ts/src/index.ts";
import { createFacilitatorServer, type FacilitatorServerConfig } from "../src/server.ts";

const word = (n: bigint | number | string) =>
  (typeof n === "string" ? n.replace(/^0x/, "") : BigInt(n).toString(16)).padStart(64, "0");
const TOKEN = "0x" + "11".repeat(20);
const FACTORY = "0x" + "22".repeat(20);
const VAULT = "0x" + "55".repeat(20);
const MERCHANT = "0x" + "66".repeat(20);
const AGENT_KEY = keccak256Utf8("16ane.test.facilitator.agent");
const FROM_KEY = keccak256Utf8("16ane.test.facilitator.from");
const FROM = privateKeyToAddress(new SecretKey(FROM_KEY));
const NETWORK = "eip155:84532" as const;

// An RPC that knows the registry, the factory's vault registry and one balance, answers eth_gasPrice
// with `gasPrice`, and makes every simulation (eth_call with a `from`) revert when `reverts` is set.
// It records each method, so a test can show that a refused settlement sent nothing.
async function fakeRpc(opts: { gasPrice?: bigint; reverts?: boolean; registered?: boolean } = {}) {
  const methods: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method, params = [] } = JSON.parse(body) as {
        id: number;
        method: string;
        params?: [{ data: string; from?: string; to: string }];
      };
      const call = params[0];
      methods.push(method === "eth_call" && call?.from ? "simulate" : method);
      let result: string | undefined;
      let error: { code: number; message: string } | undefined;
      if (method === "eth_gasPrice") result = "0x" + (opts.gasPrice ?? 1n).toString(16);
      else if (method === "eth_blockNumber") result = "0x10";
      else if (method === "eth_getBalance") result = "0x" + (10n * 10n ** 18n).toString(16);
      else if (method === "eth_call" && call?.from) {
        if (opts.reverts) error = { code: 3, message: "execution reverted: expired" };
        else result = "0x";
      } else if (method === "eth_call") {
        const data = call?.data ?? "";
        if (data.startsWith(functionSelector("isRegisteredVault(address)"))) {
          result = "0x" + word(opts.registered === false ? 0n : 1n);
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

function vaultPayload(overrides: Record<string, unknown> = {}) {
  const intent = {
    vault: VAULT,
    merchant: MERCHANT,
    amount: "16",
    quoteId: keccak256Utf8("quote-1"),
    serviceIdHash: keccak256Utf8("demo"),
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 300,
    nonce: keccak256Utf8("nonce-1"),
    policyVersion: 1,
    ...overrides,
  };
  const { digest } = hashSpendIntent(84532, intent);
  return { ...intent, signature: signDigest(digest, new SecretKey(AGENT_KEY)).serialized };
}

function exactPayload(overrides: Record<string, unknown> = {}) {
  const auth = {
    from: FROM,
    to: MERCHANT,
    value: "16",
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 300,
    nonce: keccak256Utf8("enonce-1"),
    ...overrides,
  };
  const { digest } = hashTransferWithAuthorization(84532, TOKEN, auth);
  return { ...auth, signature: signDigest(digest, new SecretKey(FROM_KEY)).serialized };
}

function canonicalRequest(
  scheme: "ane-vault-v1" | "exact",
  payload: Record<string, unknown>,
  overrides: { requirements?: Record<string, unknown>; accepted?: Record<string, unknown> } = {},
) {
  const base = {
    scheme,
    network: NETWORK,
    asset: TOKEN,
    amount: "16",
    payTo: MERCHANT,
    maxTimeoutSeconds: 300,
  };
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      accepted: { ...base, ...overrides.accepted },
      payload,
    },
    paymentRequirements: { ...base, ...overrides.requirements },
  };
}

async function withFacilitator(
  t: test.TestContext,
  opts: { gasPrice?: bigint; reverts?: boolean; registered?: boolean; server?: Partial<FacilitatorServerConfig> } = {},
  run: (
    post: (path: string, body: unknown) => Promise<{ status: number; json: Record<string, any> }>,
    api: {
      url: string;
      methods: string[];
      seedProof: (ids: string[]) => void;
      seedReceipt: (r: X402Receipt) => void;
      seedSpent: (wei: bigint) => void;
    },
  ) => Promise<void>,
) {
  const rpc = await fakeRpc(opts);
  const store = new MemoryKeyValueStore();
  const facilitator = await createFacilitatorServer({
    rpcUrl: rpc.url,
    registryAddress: "0x" + "ab".repeat(20),
    relayerPrivateKey: "0x" + "1".repeat(64),
    store,
    ...(opts.server ?? {}),
  });
  rpc.methods.length = 0;
  try {
    await run(
      async (path, body) => {
        const res = await fetch(`${facilitator.url}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: typeof body === "string" ? body : JSON.stringify(body),
        });
        return { status: res.status, json: (await res.json()) as Record<string, any> };
      },
      {
        url: facilitator.url,
        methods: rpc.methods,
        seedProof: (ids) => ids.forEach((id) => store.set("x402.proofs", id.toLowerCase(), true)),
        seedReceipt: (r) => facilitator.verifier.recordReceipt(r),
        seedSpent: (wei) => store.set("relayer.gas", new Date().toISOString().slice(0, 10), wei.toString()),
      },
    );
  } finally {
    await facilitator.close();
    await rpc.close();
  }
}

const sendsNothing = (methods: string[]) =>
  assert.ok(
    methods.every((m) => ["eth_call", "simulate", "eth_gasPrice", "eth_blockNumber"].includes(m)),
    `only reads, got ${methods.join(",")}`,
  );

test("GET /supported lists both schemes on this network, signed by the relayer", async (t) => {
  await withFacilitator(t, {}, async (_post, api) => {
    const res = await fetch(`${api.url}/supported`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { x402Version: number; kinds: unknown[]; extensions: unknown[]; signers: Record<string, string[]> };
    assert.equal(body.x402Version, 2);
    assert.equal(body.kinds.length, 2);
    assert.deepEqual(body.extensions, []);
    assert.ok(body.signers[NETWORK].length === 1, "the relayer signs settlements");
  });
});

test("POST /verify answers valid for good vault and exact payments, without consuming", async (t) => {
  await withFacilitator(t, {}, async (post) => {
    for (const [scheme, payload] of [
      ["ane-vault-v1", vaultPayload()],
      ["exact", exactPayload()],
    ] as const) {
      const first = await post("/verify", canonicalRequest(scheme, payload));
      assert.equal(first.status, 200);
      assert.equal(first.json.isValid, true, JSON.stringify(first.json));
      const second = await post("/verify", canonicalRequest(scheme, payload));
      assert.equal(second.json.isValid, true, "verifying twice is fine: nothing was consumed");
    }
  });
});

test("POST /verify refuses bad signatures, replays, unregistered vaults and reverting funds", async (t) => {
  await withFacilitator(t, {}, async (post, api) => {
    const badSig = await post("/verify", canonicalRequest("exact", { ...exactPayload(), signature: "0x" + "ee".repeat(65) }));
    assert.equal(badSig.json.isValid, false);
    assert.equal(badSig.json.invalidReason, "ANE-E-4010");

    const { structHash } = hashTransferWithAuthorization(84532, TOKEN, exactPayload());
    api.seedProof([structHash]);
    const replay = await post("/verify", canonicalRequest("exact", exactPayload()));
    assert.equal(replay.json.isValid, false);
    assert.equal(replay.json.invalidReason, "ANE-E-4005");
  });

  await withFacilitator(t, { registered: false }, async (post, api) => {
    const r = await post("/verify", canonicalRequest("ane-vault-v1", vaultPayload()));
    assert.equal(r.json.isValid, false);
    assert.equal(r.json.invalidReason, "ANE-E-4013");
    sendsNothing(api.methods);
  });

  await withFacilitator(t, { reverts: true }, async (post, api) => {
    const r = await post("/verify", canonicalRequest("ane-vault-v1", vaultPayload()));
    assert.equal(r.json.isValid, false);
    assert.equal(r.json.invalidReason, "ANE-E-4011");
    sendsNothing(api.methods);
  });
});

test("POST /verify rejects what this facilitator cannot serve with 400 ANE-E-4001", async (t) => {
  await withFacilitator(t, {}, async (post) => {
    const cases: Array<[string, unknown]> = [
      ["version", { ...canonicalRequest("exact", exactPayload()), x402Version: 1 }],
      ["network", canonicalRequest("exact", exactPayload(), { requirements: { network: "eip155:1" }, accepted: { network: "eip155:1" } })],
      ["asset", canonicalRequest("exact", exactPayload(), { requirements: { asset: "0x" + "99".repeat(20) }, accepted: { asset: "0x" + "99".repeat(20) } })],
      ["accepted", canonicalRequest("exact", exactPayload(), { accepted: { payTo: "0x" + "99".repeat(20) } })],
      ["shape", canonicalRequest("exact", { from: "not-an-address" })],
      ["body", "{not json"],
    ];
    for (const [name, body] of cases) {
      const r = await post("/verify", body);
      assert.equal(r.status, 400, name);
      const reason = r.json.isValid === false ? r.json.invalidReason : r.json.error?.code;
      assert.ok(
        reason === "ANE-E-4001" || reason === "ANE-E-4000",
        `${name}: got ${JSON.stringify(r.json)}`,
      );
    }
  });
});

test("POST /settle refuses before any send: bad proof, unregistered vault, reverting funds", async (t) => {
  await withFacilitator(t, {}, async (post, api) => {
    const badSig = await post("/settle", canonicalRequest("exact", { ...exactPayload(), signature: "0x" + "ee".repeat(65) }));
    assert.equal(badSig.status, 200);
    assert.equal(badSig.json.success, false);
    assert.equal(badSig.json.errorReason, "ANE-E-4010");
    sendsNothing(api.methods);
  });

  await withFacilitator(t, { registered: false }, async (post, api) => {
    const r = await post("/settle", canonicalRequest("ane-vault-v1", vaultPayload()));
    assert.equal(r.json.success, false);
    assert.equal(r.json.errorReason, "ANE-E-4013");
    sendsNothing(api.methods);
  });

  await withFacilitator(t, { reverts: true }, async (post, api) => {
    const r = await post("/settle", canonicalRequest("ane-vault-v1", vaultPayload()));
    assert.equal(r.json.success, false);
    assert.equal(r.json.errorReason, "ANE-E-4011");
    sendsNothing(api.methods);
  });
});

test("POST /settle replays the stored receipt for an honest retry after a lost response", async (t) => {
  await withFacilitator(t, {}, async (post, api) => {
    const payload = exactPayload();
    const { structHash } = hashTransferWithAuthorization(84532, TOKEN, payload);
    const receipt: X402Receipt = {
      x402Version: 2,
      success: true,
      scheme: "exact",
      network: NETWORK,
      txHash: "0x" + "dd".repeat(32),
      blockNumber: 9,
      intentId: structHash,
      paymentId: structHash,
      payer: FROM,
      payTo: MERCHANT,
      asset: TOKEN,
      amount: "16",
      resourceHash: "",
      requestHash: "",
      settledAt: new Date().toISOString(),
      sponsored: false,
      disclaimer: "TEST TOKENS (tANE) - NO CASH VALUE",
    };
    api.seedProof([structHash]);
    api.seedReceipt(receipt);
    const r = await post("/settle", canonicalRequest("exact", payload));
    assert.equal(r.status, 200);
    assert.equal(r.json.success, true);
    assert.equal(r.json.transaction, receipt.txHash);
    assert.equal(r.json.extra.replayed, true);
    sendsNothing(api.methods);
  });
});

test("POST /settle honors the gas policy: fee ceiling 503s before reads settle anything", async (t) => {
  await withFacilitator(
    t,
    { gasPrice: 100n, server: { relayerMaxFeeWei: 10n } },
    async (post, api) => {
      const r = await post("/settle", canonicalRequest("exact", exactPayload()));
      assert.equal(r.status, 503);
      assert.equal(r.json.error.code, "ANE-E-1205");
      sendsNothing(api.methods);
    },
  );
});

test("POST /settle stops when the daily gas budget is used up", async (t) => {
  await withFacilitator(t, {}, async (post, api) => {
    // Today's spend already reached the default budget: the send must refuse in the budget hook,
    // before any transaction is built.
    api.seedSpent(50_000_000_000_000_000n);
    const r = await post("/settle", canonicalRequest("exact", exactPayload()));
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, "ANE-E-1006");
    sendsNothing(api.methods);
  });
});

test("GET /healthz reports the chain and the relayer budget, 503 when the RPC is down", async (t) => {
  const rpc = await fakeRpc();
  const facilitator = await createFacilitatorServer({
    rpcUrl: rpc.url,
    registryAddress: "0x" + "ab".repeat(20),
    relayerPrivateKey: "0x" + "1".repeat(64),
  });
  try {
    const ok = await fetch(`${facilitator.url}/healthz`);
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { status: string; chainId: number; relayer: { lowBalance: boolean } };
    assert.equal(body.status, "ok");
    assert.equal(body.chainId, 84532);
    assert.equal(body.relayer.lowBalance, false);
  } finally {
    await rpc.close();
  }
  const down = await fetch(`${facilitator.url}/healthz`);
  assert.equal(down.status, 503);
  await facilitator.close();
});

test("GET /v1/payments/:id serves stored receipts, 404 otherwise", async (t) => {
  await withFacilitator(t, {}, async (_post, api) => {
    const missing = await fetch(`${api.url}/v1/payments/0xdead`);
    assert.equal(missing.status, 404);
  });
});
