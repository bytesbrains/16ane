import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  AneClient,
  functionSelector,
  keccak256Utf8,
  privateKeyToAddress,
  SecretKey,
  type SignedFaucetClaim,
} from "../../../packages/sdk-ts/src/index.ts";
import { checkSignedClaim } from "../src/faucet.ts";
import { createSandboxServer, type SandboxServerConfig } from "../src/server.ts";

const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const FAUCET = "0x0000000000000000000000000000000000000033";
const RECIPIENT_KEY = new SecretKey(keccak256Utf8("16ane.test.faucet.recipient"));
const OTHER_KEY = new SecretKey(keccak256Utf8("16ane.test.faucet.other"));
const RECIPIENT = privateKeyToAddress(RECIPIENT_KEY);
const signer = new AneClient({
  rpcUrl: "http://127.0.0.1:1",
  chainId: 84532,
  contracts: {
    aneTestToken: "0x0000000000000000000000000000000000000011",
    aneVaultFactory: "0x0000000000000000000000000000000000000022",
    aneFaucet: FAUCET,
    aneServiceDirectory: "0x0000000000000000000000000000000000000044",
  },
});
const now = () => Math.floor(Date.now() / 1000);

// An RPC that knows the registry and the faucet's views, records every method it is asked for, and refuses
// everything else. A refused claim must never get past eth_call: no nonce lookup, no gas estimate, no send.
async function fakeRpc(usedNonces: Set<string>) {
  const methods: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: [{ data: string }] };
      methods.push(method);
      let result: string | undefined;
      if (method === "eth_call") {
        const data = params[0].data;
        if (data.startsWith(functionSelector("claimAmount()"))) result = "0x" + word(16_000n * 10n ** 18n);
        else if (data.startsWith(functionSelector("cooldownSeconds()"))) result = "0x" + word(3600);
        else if (data.startsWith(functionSelector("relayedNonceUsed(bytes32)"))) {
          result = "0x" + word(usedNonces.has("0x" + data.slice(10)) ? 1 : 0);
        } else result = "0x" + word(0x11) + word(0x22) + word(0x33) + word(0x44);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          result === undefined
            ? { jsonrpc: "2.0", id, error: { code: -32601, message: "not in this fake" } }
            : { jsonrpc: "2.0", id, result },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    methods,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Stands in for Cloudflare's siteverify: "pass" passes on app.16ane.com, "elsewhere" passes on another site.
async function fakeSiteverify() {
  const requests: Array<{ secret: string; response: string; remoteip: string }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = JSON.parse(body) as { secret: string; response: string; remoteip: string };
      requests.push(r);
      const ok = r.secret === "turnstile-secret" && (r.response === "pass" || r.response === "elsewhere");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          ok
            ? { success: true, hostname: r.response === "pass" ? "app.16ane.com" : "evil.example" }
            : { success: false, "error-codes": ["invalid-input-response"] },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function withServer(
  t: test.TestContext,
  options: Partial<SandboxServerConfig> & { usedNonces?: Set<string> },
  run: (claim: (body: object) => Promise<{ status: number; code?: string; message?: string }>, rpcMethods: string[]) => Promise<void>,
) {
  const rpc = await fakeRpc(options.usedNonces ?? new Set());
  const sandbox = await createSandboxServer({
    rpcUrl: rpc.url,
    registryAddress: "0x" + "ab".repeat(20),
    relayerPrivateKey: "0x" + "1".repeat(64),
    ...options,
  });
  t.mock.method(console, "error", () => {});
  rpc.methods.length = 0; // startup reads (registry, faucet config) aren't part of the claim
  try {
    await run(async (body) => {
      const res = await fetch(`${sandbox.url}/v1/faucet/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { error?: { code: string; message: string } };
      return { status: res.status, code: json.error?.code, message: json.error?.message };
    }, rpc.methods);
  } finally {
    await sandbox.close();
    await rpc.close();
  }
}

const onlyReads = (methods: string[]) => methods.every((m) => m === "eth_call");
const asBody = (c: SignedFaucetClaim) => ({
  recipient: c.recipient,
  authorization: { deadline: c.deadline, nonce: c.nonce, signature: c.signature },
});

test("checkSignedClaim accepts the SDK's signature and refuses a wrong signer, bad deadlines and malformed input", async () => {
  const good = await signer.signFaucetClaim(RECIPIENT_KEY);
  assert.equal(checkSignedClaim(84532, FAUCET, good, now()), undefined);
  assert.match(checkSignedClaim(84532, FAUCET, { ...good, recipient: privateKeyToAddress(OTHER_KEY) }, now())!, /not signed by the recipient/);
  assert.match(checkSignedClaim(84531, FAUCET, good, now())!, /not signed by the recipient/, "another chain's domain");
  assert.match(checkSignedClaim(84532, FAUCET, good, good.deadline - 10)!, /deadline/, "about to expire");
  const far = await signer.signFaucetClaim(RECIPIENT_KEY, { deadline: now() + 7200 });
  assert.match(checkSignedClaim(84532, FAUCET, far, now())!, /deadline/, "too far ahead");
  assert.match(checkSignedClaim(84532, FAUCET, { ...good, signature: "0x1234" }, now())!, /65-byte signature/);
  assert.match(checkSignedClaim(84532, FAUCET, { ...good, deadline: "soon" as unknown as number }, now())!, /integer deadline/);
  const flipped = good.signature.slice(0, 10) + (good.signature[10] === "0" ? "1" : "0") + good.signature.slice(11);
  assert.ok(checkSignedClaim(84532, FAUCET, { ...good, signature: flipped }, now()), "a tampered signature");
});

test("a claim with no proof is refused with 401 before anything is sent", async (t) => {
  await withServer(t, {}, async (claim, methods) => {
    const r = await claim({ recipient: RECIPIENT });
    assert.equal(r.status, 401);
    assert.equal(r.code, "ANE-E-1007");
    assert.match(r.message!, /signFaucetClaim/);
    assert.deepEqual(methods, []);
  });
});

test("a claim signed by someone other than the recipient is refused without spending gas", async (t) => {
  await withServer(t, {}, async (claim, methods) => {
    const theirs = await signer.signFaucetClaim(OTHER_KEY);
    const r = await claim(asBody({ ...theirs, recipient: RECIPIENT }));
    assert.equal(r.status, 403);
    assert.equal(r.code, "ANE-E-1008");
    assert.match(r.message!, /not signed by the recipient/);
    assert.deepEqual(methods, []);
  });
});

test("an expired claim is refused without spending gas", async (t) => {
  await withServer(t, {}, async (claim, methods) => {
    const r = await claim(asBody(await signer.signFaucetClaim(RECIPIENT_KEY, { deadline: now() - 1 })));
    assert.equal(r.status, 403);
    assert.match(r.message!, /deadline/);
    assert.deepEqual(methods, []);
  });
});

test("a replayed claim (nonce already used on-chain) is refused without spending gas", async (t) => {
  const replayed = await signer.signFaucetClaim(RECIPIENT_KEY);
  await withServer(t, { usedNonces: new Set([replayed.nonce]) }, async (claim, methods) => {
    const r = await claim(asBody(replayed));
    assert.equal(r.status, 403);
    assert.match(r.message!, /nonce was already used/);
    assert.ok(methods.length > 0 && onlyReads(methods), `only the nonce lookup: ${methods.join(",")}`);
  });
});

test("a valid signed claim passes every check and goes to the chain", async (t) => {
  await withServer(t, {}, async (claim, methods) => {
    const r = await claim(asBody(await signer.signFaucetClaim(RECIPIENT_KEY)));
    // This fake can't mine, so the send fails; what matters is that it was attempted.
    assert.equal(r.status, 502);
    assert.equal(r.code, "ANE-E-1004");
    assert.ok(!onlyReads(methods), "the relayer tried to send");
  });
});

test("Turnstile: a failed check, another site's token, and a missing secret are refused without spending gas", async (t) => {
  const siteverify = await fakeSiteverify();
  t.after(() => siteverify.close());
  const turnstile = {
    turnstileSecretKey: "turnstile-secret",
    turnstileExpectedHostname: "app.16ane.com",
    turnstileSiteverifyUrl: siteverify.url,
  };
  await withServer(t, turnstile, async (claim, methods) => {
    const failed = await claim({ recipient: RECIPIENT, turnstileToken: "forged" });
    assert.equal(failed.status, 403);
    assert.match(failed.message!, /Turnstile check failed \(invalid-input-response\)/);
    const elsewhere = await claim({ recipient: RECIPIENT, turnstileToken: "elsewhere" });
    assert.equal(elsewhere.status, 403);
    assert.match(elsewhere.message!, /another site/);
    assert.deepEqual(methods, []);
    assert.equal(siteverify.requests[0].secret, "turnstile-secret");
    assert.equal(siteverify.requests[0].response, "forged");
    assert.equal(siteverify.requests[0].remoteip, "127.0.0.1");

    const passed = await claim({ recipient: RECIPIENT, turnstileToken: "pass" });
    assert.equal(passed.status, 502, "a passing token goes on to the chain");
  });
  // Without a secret the Turnstile path is off, and a token is not a proof.
  await withServer(t, {}, async (claim, methods) => {
    const r = await claim({ recipient: RECIPIENT, turnstileToken: "pass" });
    assert.equal(r.status, 401);
    assert.deepEqual(methods, []);
  });
});

test("faucetOpenClaims accepts a claim with no proof (local and private servers only)", async (t) => {
  await withServer(t, { faucetOpenClaims: true }, async (claim, methods) => {
    const r = await claim({ recipient: RECIPIENT });
    assert.equal(r.status, 502);
    assert.ok(!onlyReads(methods), "the relayer tried to send");
  });
});
