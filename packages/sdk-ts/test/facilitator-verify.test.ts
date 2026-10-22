import test from "node:test";
import assert from "node:assert/strict";
import {
  type AneClient,
  AnePaymentVerifier,
  functionSelector,
  hashSpendIntent,
  hashTransferWithAuthorization,
  keccak256Utf8,
  privateKeyToAddress,
  SecretKey,
  signDigest,
  type X402DecodedPayment,
} from "../src/index.ts";

const MERCHANT = "0x" + "22".repeat(20);
const TOKEN = "0x" + "33".repeat(20);
const FACTORY = "0x" + "44".repeat(20);
const VAULT = "0x" + "55".repeat(20);
const AGENT_KEY = keccak256Utf8("16ane.test.facilitator.agent");
const FROM_KEY = keccak256Utf8("16ane.test.facilitator.from");
const endpoint = { serviceId: "demo", priceAmount: "16", payTo: MERCHANT, assetAddress: TOKEN };
const word = (n: bigint) => n.toString(16).padStart(64, "0");

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
    from: privateKeyToAddress(new SecretKey(FROM_KEY)),
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

const decoded = (scheme: "ane-vault-v1" | "exact", payload: Record<string, unknown>): X402DecodedPayment => ({
  x402Version: 2,
  scheme,
  network: "eip155:84532",
  accepted: { asset: TOKEN, amount: "16", payTo: MERCHANT },
  payload,
});

// A chain that answers registration reads and simulations from flags and records every send; nothing
// reaches a chain, so a test can show that a refused payment sent nothing.
function mockChain(opts: { registered?: boolean; reverts?: boolean; verified?: boolean; unreachable?: boolean } = {}) {
  const sent: string[] = [];
  const client = {
    chainId: 84532,
    resolveContracts: async () => ({ aneTestToken: TOKEN, aneVaultFactory: FACTORY }),
    ethCall: async (_to: string, data: string) => {
      if (data.startsWith(functionSelector("isRegisteredVault(address)"))) {
        return "0x" + word(opts.registered === false ? 0n : 1n);
      }
      throw new Error(`unexpected eth_call ${data.slice(0, 18)}`);
    },
    simulateCall: async () => {
      if (opts.unreachable) throw new TypeError("fetch failed");
      if (opts.reverts) throw new Error("execution reverted: expired");
      return "0x";
    },
    verifySettlementOnChain: async () => ({ verified: opts.verified ?? true, reason: "mock" }),
    settleSpendIntentOnChain: async (_key: SecretKey, intent: { vault: string }) => {
      sent.push(intent.vault);
      return { txHash: "0x" + "ab".repeat(32), blockNumber: 7 };
    },
    settleExactAuthorizationOnChain: async () => {
      sent.push(TOKEN);
      return { txHash: "0x" + "ab".repeat(32), blockNumber: 7 };
    },
    sendContractTx: async (_key: SecretKey, to: string) => {
      sent.push(to);
      return { txHash: "0x" + "ab".repeat(32), blockNumber: 7, status: 1 };
    },
  } as unknown as AneClient;
  const verifier = new AnePaymentVerifier({ client, relayerKey: new SecretKey(keccak256Utf8("relayer")) });
  return { verifier, sent };
}

test("verifyPayment answers valid for a good vault intent, and consumes nothing", async () => {
  const { verifier, sent } = mockChain();
  const first = await verifier.verifyPayment({ decoded: decoded("ane-vault-v1", vaultPayload()), endpoint });
  assert.deepEqual(first, { valid: true, payer: VAULT });
  const second = await verifier.verifyPayment({ decoded: decoded("ane-vault-v1", vaultPayload()), endpoint });
  assert.equal(second.valid, true, "verifying twice is fine: nothing was consumed");
  assert.deepEqual(sent, []);
});

test("verifyPayment refuses wrong merchant, short amount and expiry with the settle codes", async () => {
  const { verifier } = mockChain();
  for (const [name, payload, code] of [
    ["merchant", vaultPayload({ merchant: "0x" + "99".repeat(20) }), "ANE-E-4007"],
    ["amount", vaultPayload({ amount: "15" }), "ANE-E-4008"],
    ["expiry", vaultPayload({ validBefore: Math.floor(Date.now() / 1000) - 1 }), "ANE-E-4003"],
  ] as const) {
    const r = await verifier.verifyPayment({ decoded: decoded("ane-vault-v1", payload), endpoint });
    assert.equal(r.valid, false, name);
    if (!r.valid) assert.equal(r.code, code, name);
  }
});

test("verifyPayment refuses an unregistered vault and a reverting simulation, sending nothing", async () => {
  const unregistered = mockChain({ registered: false });
  const r1 = await unregistered.verifier.verifyPayment({ decoded: decoded("ane-vault-v1", vaultPayload()), endpoint });
  assert.equal(r1.valid, false);
  if (!r1.valid) {
    assert.equal(r1.code, "ANE-E-4013");
    assert.match(r1.message, /not a vault created by the 16ane factory/);
  }
  assert.deepEqual(unregistered.sent, []);

  const reverting = mockChain({ reverts: true });
  const r2 = await reverting.verifier.verifyPayment({ decoded: decoded("ane-vault-v1", vaultPayload()), endpoint });
  assert.equal(r2.valid, false);
  if (!r2.valid) {
    assert.equal(r2.code, "ANE-E-4011");
    assert.match(r2.message, /would revert, so nothing was sent/);
  }
  assert.deepEqual(reverting.sent, []);
});

test("verifyPayment checks client-settled proofs against the chain, read-only", async () => {
  const txHash = "0x" + "cc".repeat(32);
  const good = mockChain({ verified: true });
  const r1 = await good.verifier.verifyPayment({
    decoded: decoded("ane-vault-v1", vaultPayload({ txHash })),
    endpoint,
  });
  assert.deepEqual(r1, { valid: true, payer: VAULT });

  const bad = mockChain({ verified: false });
  const r2 = await bad.verifier.verifyPayment({
    decoded: decoded("ane-vault-v1", vaultPayload({ txHash })),
    endpoint,
  });
  assert.equal(r2.valid, false);
  if (!r2.valid) assert.equal(r2.code, "ANE-E-4009");
  assert.deepEqual(good.sent, bad.sent);
});

test("verifyPayment covers exact authorizations: signer, replay and simulation", async () => {
  const { verifier } = mockChain();
  const good = await verifier.verifyPayment({ decoded: decoded("exact", exactPayload()), endpoint });
  assert.equal(good.valid, true);

  const wrongSigner = await verifier.verifyPayment({
    decoded: decoded("exact", { ...exactPayload(), from: "0x" + "99".repeat(20) }),
    endpoint,
  });
  assert.equal(wrongSigner.valid, false);
  if (!wrongSigner.valid) assert.equal(wrongSigner.code, "ANE-E-4010");

  const reverting = mockChain({ reverts: true });
  const r = await reverting.verifier.verifyPayment({ decoded: decoded("exact", exactPayload()), endpoint });
  assert.equal(r.valid, false);
  if (!r.valid) assert.equal(r.code, "ANE-E-4011");
  assert.deepEqual(reverting.sent, []);
});

test("settleDecoded preflight refuses before any send; without it merchants are untouched", async () => {
  const unregistered = mockChain({ registered: false });
  const r1 = await unregistered.verifier.settleDecoded({
    decoded: decoded("ane-vault-v1", vaultPayload()),
    endpoint,
    preflight: { simulate: true, requireRegisteredVault: true },
  });
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.equal(r1.code, "ANE-E-4013");
  assert.deepEqual(unregistered.sent, []);

  const reverting = mockChain({ reverts: true });
  const r2 = await reverting.verifier.settleDecoded({
    decoded: decoded("exact", exactPayload()),
    endpoint,
    preflight: { simulate: true, requireRegisteredVault: true },
  });
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.code, "ANE-E-4011");
  assert.deepEqual(reverting.sent, []);

  // Preflight off: the mock chain settles and the proof is consumed, as merchants expect.
  // One payload object for both calls: exactPayload() stamps Date.now(), so two calls straddling
  // a second boundary would differ in validBefore and the "replay" would legitimately settle.
  const plain = mockChain();
  const payload = exactPayload();
  const r3 = await plain.verifier.settleDecoded({ decoded: decoded("exact", payload), endpoint });
  assert.equal(r3.ok, true);
  assert.deepEqual(plain.sent, [TOKEN]);
  const replay = await plain.verifier.settleDecoded({ decoded: decoded("exact", payload), endpoint });
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.equal(replay.code, "ANE-E-4005");
});

test("settleDecoded without a request carries empty binding hashes on the receipt", async () => {
  const { verifier } = mockChain();
  const unbound = await verifier.settleDecoded({ decoded: decoded("exact", exactPayload()), endpoint });
  assert.equal(unbound.ok, true);
  if (unbound.ok) {
    assert.equal(unbound.receipt.resourceHash, "");
    assert.equal(unbound.receipt.requestHash, "");
  }

  const bound = await verifier.settleDecoded({
    decoded: decoded("exact", exactPayload({ nonce: keccak256Utf8("enonce-2") })),
    endpoint,
    method: "POST",
    canonicalUrl: "http://127.0.0.1:8788/paid",
    rawBody: "{}",
  });
  assert.equal(bound.ok, true);
  if (bound.ok) {
    assert.notEqual(bound.receipt.resourceHash, "");
    assert.notEqual(bound.receipt.requestHash, "");
  }
});

test("an unreachable chain during simulation throws instead of rejecting the payment", async () => {
  const { verifier } = mockChain({ unreachable: true });
  await assert.rejects(
    verifier.verifyPayment({ decoded: decoded("exact", exactPayload()), endpoint }),
    /fetch failed/,
  );
  await assert.rejects(
    verifier.settleDecoded({
      decoded: decoded("exact", exactPayload()),
      endpoint,
      preflight: { simulate: true, requireRegisteredVault: true },
    }),
    /fetch failed/,
  );
});
