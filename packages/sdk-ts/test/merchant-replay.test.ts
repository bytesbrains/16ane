import test from "node:test";
import assert from "node:assert/strict";
import { type AneClient, AnePaymentVerifier, keccak256Utf8, SecretKey } from "../src/index.ts";

const MERCHANT = "0x" + "22".repeat(20);
const TOKEN = "0x" + "33".repeat(20);
const endpoint = { serviceId: "demo", priceAmount: "16", payTo: MERCHANT, assetAddress: TOKEN };

// An x402 ane-vault-v1 proof where the agent already paid on-chain and presents the transaction hash.
// Verifying it is read-only, so only the verifier's replay guard stops the same proof buying twice.
function directProof(txHash: string): string {
  const payload = {
    vault: "0x" + "11".repeat(20),
    merchant: MERCHANT,
    amount: "16",
    quoteId: keccak256Utf8("quote-1"),
    serviceIdHash: keccak256Utf8("demo"),
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 300,
    nonce: keccak256Utf8("nonce-1"),
    policyVersion: 1,
    signature: "0x",
    txHash,
  };
  const header = { x402Version: 2, scheme: "ane-vault-v1", network: "eip155:84532", accepted: {}, payload };
  return Buffer.from(JSON.stringify(header), "utf8").toString("base64");
}

function verifierWith(verify: () => Promise<{ verified: boolean; reason?: string }>) {
  const client = {
    chainId: 84532,
    verifySettlementOnChain: async (params: { txHash: string }) => ({ blockNumber: 5, txHash: params.txHash, ...(await verify()) }),
  } as unknown as AneClient;
  return new AnePaymentVerifier({ client, relayerKey: new SecretKey(keccak256Utf8("relayer")) });
}

const call = (v: AnePaymentVerifier, header: string) =>
  v.verifyAndSettle({ paymentSignatureHeader: header, endpoint, method: "POST", canonicalUrl: "http://x/demo" });

test("two concurrent requests with the same paid proof: exactly one is served (#82)", async () => {
  const v = verifierWith(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50)); // settlement takes time
    return { verified: true };
  });
  const header = directProof("0x" + "ab".repeat(32));
  const [a, b] = await Promise.all([call(v, header), call(v, header)]);
  const outcomes = [a, b].map((r) => (r.ok ? "ok" : `${r.status}`)).sort();
  assert.deepEqual(outcomes, ["409", "ok"]);
  const later = await call(v, header);
  assert.equal(later.ok ? "ok" : later.status, 409, "and it stays used afterwards");
});

test("a failed verification releases the reservation, so an honest retry still works", async () => {
  let attempt = 0;
  const v = verifierWith(async () => (++attempt === 1 ? { verified: false, reason: "not mined yet" } : { verified: true }));
  const header = directProof("0x" + "cd".repeat(32));
  const first = await call(v, header);
  assert.equal(first.ok ? "ok" : first.status, 402);
  const retry = await call(v, header);
  assert.equal(retry.ok, true);
});
