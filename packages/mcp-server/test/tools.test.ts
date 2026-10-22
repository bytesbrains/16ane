// Tool behavior against the mock backend: happy paths, policy enforcement and
// refusal cases. Key-isolation and prompt-injection assertions live in
// security.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { SixteenAneAdapter } from "../src/tools.ts";
import {
  MockBackend,
  TEST_MERCHANT,
  TEST_TOKEN,
  TEST_VAULT,
  mockConfig,
  mockReceipt,
  quote402Envelope,
} from "./mock-backend.ts";
import type { ServiceManifestPayload } from "../../sdk-ts/src/index.ts";

function setup(backend?: MockBackend): { adapter: SixteenAneAdapter; backend: MockBackend } {
  const b = backend ?? new MockBackend();
  return { adapter: new SixteenAneAdapter(b), backend: b };
}

function goodManifest(backend: MockBackend): ServiceManifestPayload {
  return backend.signManifest({
    schemaVersion: "16ane-manifest-v0",
    serviceId: "demo-sum",
    name: "Demo Summarizer",
    description: "Deterministic summaries",
    version: "0.1.0",
    network: "eip155:31337",
    chainId: 31337,
    payTo: TEST_MERCHANT,
    tokenAddress: TEST_TOKEN,
    tokenSymbol: "tANE",
    updatedAt: 1761091200,
    endpoints: [{ id: "sum", method: "POST", path: "/sum", priceAmount: "16", scheme: "ane-vault-v1" }],
  });
}

test("list_services verifies signatures and filters by provider", async () => {
  const { adapter, backend } = setup();
  backend.services = [goodManifest(backend)];
  const res = await adapter.callTool("list_services", {});
  assert.equal(res.isError, false);
  const structured = res.structuredContent as { services: { signature_valid: boolean; signer: string }[] };
  assert.equal(structured.services.length, 1);
  assert.equal(structured.services[0].signature_valid, true);

  const filtered = await adapter.callTool("list_services", { provider: "no-such-provider" });
  assert.equal((filtered.structuredContent as { services: unknown[] }).services.length, 0);

  const unchecked = await adapter.callTool("list_services", { verify_signatures: false });
  assert.equal(
    (unchecked.structuredContent as { services: { signature_valid: null }[] }).services[0]
      .signature_valid,
    null,
  );
});

test("list_services flags a tampered manifest instead of trusting it", async () => {
  const { adapter, backend } = setup();
  const manifest = goodManifest(backend);
  manifest.payTo = "0x9999999999999999999999999999999999999999";
  backend.services = [manifest];
  const res = await adapter.callTool("list_services", {});
  const row = (res.structuredContent as { services: { signature_valid: boolean }[] }).services[0];
  assert.equal(row.signature_valid, false);
});

test("get_quote parses a 402 envelope and cross-checks the origin manifest", async () => {
  const { adapter, backend } = setup();
  const url = "https://merchant.test/sum";
  backend.probes.set(url, {
    status: 402,
    headers: {
      "payment-required": Buffer.from(JSON.stringify(quote402Envelope(TEST_MERCHANT))).toString("base64"),
    },
    text: "payment required",
  });
  backend.probes.set("https://merchant.test/.well-known/16ane-service.json", {
    status: 200,
    headers: {},
    text: JSON.stringify(goodManifest(backend)),
  });
  const res = await adapter.callTool("get_quote", { url, method: "POST" });
  assert.equal(res.isError, false);
  const quote = (res.structuredContent as { quote: Record<string, unknown> }).quote;
  assert.equal(quote["amount_base_units"], "16");
  assert.equal(quote["pay_to"], TEST_MERCHANT);
  assert.deepEqual(quote["manifest"], {
    valid: true,
    signer: (quote["manifest"] as Record<string, unknown>)["signer"],
    pay_to_matches: true,
  });
});

test("get_quote reports a spoofed payee that mismatches the signed manifest", async () => {
  const { adapter, backend } = setup();
  const url = "https://merchant.test/sum";
  const attacker = "0x9999999999999999999999999999999999999999";
  backend.probes.set(url, {
    status: 402,
    headers: {
      "payment-required": Buffer.from(JSON.stringify(quote402Envelope(attacker))).toString("base64"),
    },
    text: "payment required",
  });
  backend.probes.set("https://merchant.test/.well-known/16ane-service.json", {
    status: 200,
    headers: {},
    text: JSON.stringify(goodManifest(backend)),
  });
  const res = await adapter.callTool("get_quote", { url });
  const quote = (res.structuredContent as { quote: Record<string, unknown> }).quote;
  assert.equal((quote["manifest"] as Record<string, unknown>)["pay_to_matches"], false);
});

test("get_quote handles free endpoints and broken quotes", async () => {
  const { adapter, backend } = setup();
  backend.probes.set("https://free.test/", { status: 200, headers: {}, text: "{}" });
  const free = await adapter.callTool("get_quote", { url: "https://free.test/" });
  assert.equal(free.isError, false);
  assert.equal((free.structuredContent as Record<string, unknown>)["payment_required"], false);

  backend.probes.set("https://down.test/", { status: 500, headers: {}, text: "boom" });
  const down = await adapter.callTool("get_quote", { url: "https://down.test/" });
  assert.equal(down.isError, true);

  backend.probes.set("https://bad.test/", {
    status: 402,
    headers: { "payment-required": "!!!not-base64!!!" },
    text: "",
  });
  const bad = await adapter.callTool("get_quote", { url: "https://bad.test/" });
  assert.equal(bad.isError, true);

  const badUrl = await adapter.callTool("get_quote", { url: "gopher://x/" });
  assert.equal(badUrl.isError, true);
});

test("wallet_balance reports token balance with and without vault accounting", async () => {
  const { adapter, backend } = setup();
  const full = await adapter.callTool("wallet_balance", {});
  assert.equal(full.isError, false);
  const structured = full.structuredContent as Record<string, unknown>;
  assert.equal(structured["token_balance_base_units"], "16000");
  assert.equal(
    ((structured["accounting"] as Record<string, unknown>)["spendable_now_base_units"]),
    "304",
  );

  backend.balances = { tokenBalance: 5n, accounting: null };
  const bare = await adapter.callTool("wallet_balance", {});
  assert.equal((bare.structuredContent as Record<string, unknown>)["accounting"], null);
  assert.match(bare.content[0].text, /not a vault contract/);
});

test("payment_status merges the on-chain record with the REST receipt", async () => {
  const { adapter, backend } = setup();
  backend.records.set("0xpay1", {
    merchant: TEST_MERCHANT,
    amountPaid: 16n,
    amountRefunded: 0n,
    settledAt: 100,
  });
  backend.receipts.set("0xpay1", mockReceipt());
  const res = await adapter.callTool("payment_status", { payment_id: "0xpay1" });
  assert.equal(res.isError, false);
  const structured = res.structuredContent as Record<string, unknown>;
  assert.equal((structured["onchain"] as Record<string, unknown>)["amount_paid_base_units"], "16");
  assert.equal((structured["receipt"] as Record<string, unknown>)["txHash"], "0xabc123");

  const missing = await adapter.callTool("payment_status", {});
  assert.equal(missing.isError, true);

  const unknownPayment = await adapter.callTool("payment_status", { payment_id: "0xnope" });
  assert.equal(
    ((unknownPayment.structuredContent as Record<string, unknown>)["onchain"] as Record<string, unknown>)[
      "exists"
    ],
    false,
  );
});

test("purchase_service spends within max_payment and surfaces the receipt", async () => {
  const { adapter, backend } = setup();
  backend.purchaseResult = {
    status: 200,
    data: { summary: "hello" },
    receipt: mockReceipt(),
    trialSponsored: false,
    headers: {},
  };
  const res = await adapter.callTool("purchase_service", {
    url: "https://merchant.test/sum",
    method: "POST",
    body: "{}",
    max_payment: "16",
    idempotency_key: "idem-1",
  });
  assert.equal(res.isError, false);
  assert.equal(backend.purchaseCalls.length, 1);
  assert.equal(backend.purchaseCalls[0].options.maxPayment, 16n);
  assert.equal((res.structuredContent as Record<string, unknown>)["status"], 200);
  assert.deepEqual((res.structuredContent as Record<string, unknown>)["data"], { summary: "hello" });
});

test("purchase_service refuses a call above the server ceiling without spending", async () => {
  const backend = new MockBackend(mockConfig({ maxPaymentCeiling: 16n }));
  const a = new SixteenAneAdapter(backend);
  const res = await a.callTool("purchase_service", {
    url: "https://merchant.test/sum",
    max_payment: "17",
  });
  assert.equal(res.isError, true);
  assert.match(String((res.structuredContent as Record<string, unknown>)["error"]), /ceiling/);
  assert.equal(backend.purchaseCalls.length, 0);
});

test("purchase_service clamps to the ceiling and requires max_payment", async () => {
  const backend = new MockBackend(mockConfig({ maxPaymentCeiling: 100n }));
  const a = new SixteenAneAdapter(backend);
  await a.callTool("purchase_service", { url: "https://merchant.test/sum", max_payment: "16" });
  assert.equal(backend.purchaseCalls[0].options.maxPayment, 16n);

  const missing = await a.callTool("purchase_service", { url: "https://merchant.test/sum" });
  assert.equal(missing.isError, true);

  const badAmount = await a.callTool("purchase_service", {
    url: "https://merchant.test/sum",
    max_payment: "1.5",
  });
  assert.equal(badAmount.isError, true);
});

test("purchase_service surfaces quote-over-max and backend failures as tool errors", async () => {
  const { adapter, backend } = setup();
  backend.purchaseError = new Error("ANE-E-3002: Quote amount 32 exceeds caller maxPayment 16");
  const res = await adapter.callTool("purchase_service", {
    url: "https://merchant.test/sum",
    max_payment: "16",
  });
  assert.equal(res.isError, true);
  assert.match(String((res.structuredContent as Record<string, unknown>)["error"]), /ANE-E-3002/);
});

test("publish_service pins revenue to the vault in tANE on the configured network", async () => {
  const { adapter, backend } = setup();
  const res = await adapter.callTool("publish_service", {
    service_id: "my-sum",
    name: "My Summarizer",
    version: "0.1.0",
    endpoints: [{ id: "sum", method: "POST", path: "/sum", price_amount: "16", scheme: "ane-vault-v1" }],
  });
  assert.equal(res.isError, false);
  assert.equal(backend.published.length, 1);
  const manifest = backend.published[0];
  assert.equal(manifest.payTo, TEST_VAULT);
  assert.equal(manifest.tokenAddress, TEST_TOKEN);
  assert.equal(manifest.tokenSymbol, "tANE");
  assert.equal(manifest.network, "eip155:31337");
  assert.equal(manifest.chainId, 31337);
  assert.ok(manifest.signature);
  const check = backend.verifyManifest(manifest);
  assert.equal(check.valid, true);

  const bad = await adapter.callTool("publish_service", {
    service_id: "bad",
    name: "Bad",
    version: "0.1.0",
    endpoints: [],
  });
  assert.equal(bad.isError, true);
});

test("publish_service refuses a manifest that fails local verification", async () => {
  const { adapter, backend } = setup();
  backend.forcedVerify = { valid: false, digest: "0x", reason: "tampered" };
  const res = await adapter.callTool("publish_service", {
    service_id: "my-sum",
    name: "My Summarizer",
    version: "0.1.0",
    endpoints: [{ id: "sum", method: "POST", path: "/sum", price_amount: "16", scheme: "ane-vault-v1" }],
  });
  assert.equal(res.isError, true);
  assert.equal(backend.published.length, 0);
});

test("request_refund validates against the on-chain record and moves no funds", async () => {
  const { adapter, backend } = setup();
  backend.records.set("0xpay1", {
    merchant: TEST_MERCHANT,
    amountPaid: 16n,
    amountRefunded: 6n,
    settledAt: 100,
  });
  const full = await adapter.callTool("request_refund", { payment_id: "0xpay1", reason: "no delivery" });
  assert.equal(full.isError, false);
  const structured = full.structuredContent as Record<string, unknown>;
  assert.equal(structured["moves_funds"], false);
  assert.equal(
    ((structured["refund_request"] as Record<string, unknown>)["requested_amount_base_units"]),
    "10",
  );

  const partial = await adapter.callTool("request_refund", { payment_id: "0xpay1", amount: "4" });
  assert.equal(
    (
      (partial.structuredContent as Record<string, unknown>)["refund_request"] as Record<string, unknown>
    )["requested_amount_base_units"],
    "4",
  );

  const over = await adapter.callTool("request_refund", { payment_id: "0xpay1", amount: "11" });
  assert.equal(over.isError, true);

  const unknown = await adapter.callTool("request_refund", { payment_id: "0xnope" });
  assert.equal(unknown.isError, true);
});
