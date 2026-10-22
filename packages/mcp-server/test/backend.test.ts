// LiveBackend paths that run without a chain: quote-probe size cap and timeout
// (stub fetch), plus the offline manifest sign/verify round-trip.

import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentSession,
  AneClient,
  SecretKey,
} from "../../sdk-ts/src/index.ts";
import { DEFAULT_PROBE_MAX_BYTES, LiveBackend } from "../src/backend.ts";
import {
  TEST_AGENT_KEY_HEX,
  TEST_MERCHANT,
  TEST_TOKEN,
  TEST_VAULT,
  mockConfig,
  testAgentSessionAddress,
} from "./mock-backend.ts";

function liveBackend(fetchImpl: typeof fetch, probeMaxBytes?: number, probeTimeoutMs?: number): LiveBackend {
  const config = mockConfig({ fetchImpl, probeMaxBytes, probeTimeoutMs });
  const client = new AneClient({
    rpcUrl: "http://127.0.0.1:1",
    chainId: config.chainId,
    contracts: {
      aneTestToken: config.tokenAddress,
      aneVaultFactory: TEST_VAULT,
      aneFaucet: TEST_VAULT,
      aneServiceDirectory: config.directoryAddress,
    },
  });
  const agentKey = new SecretKey(TEST_AGENT_KEY_HEX);
  const session = new AgentSession({ client, vaultAddress: TEST_VAULT, sessionKey: agentKey });
  return new LiveBackend(client, session, agentKey, config);
}

test("probeUrl returns small bodies with lowercased headers", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "X-Custom": "yes" },
    })) as typeof fetch;
  const probe = await liveBackend(fetchImpl).probeUrl("https://merchant.test/sum", {
    method: "GET",
    headers: {},
  });
  assert.equal(probe.status, 200);
  assert.equal(probe.text, JSON.stringify({ ok: true }));
  assert.equal(probe.headers["x-custom"], "yes");
});

test("probeUrl refuses bodies past the byte cap without buffering them fully", async () => {
  const fetchImpl = (async () => new Response("x".repeat(300))) as typeof fetch;
  await assert.rejects(
    () =>
      liveBackend(fetchImpl, 100).probeUrl("https://merchant.test/huge", {
        method: "GET",
        headers: {},
      }),
    /exceeded the 100-byte response cap/,
  );
  assert.equal(DEFAULT_PROBE_MAX_BYTES, 256 * 1024);
});

test("probeUrl passes an abort signal so a hanging merchant cannot hang the tool", async () => {
  let seenSignal: AbortSignal | undefined;
  const hanging = ((url: string, init: { signal?: AbortSignal }) => {
    seenSignal = init?.signal;
    // Honor the signal the way a real fetch implementation does.
    return new Promise((_resolve, reject) => {
      seenSignal?.addEventListener("abort", () => reject(new Error("aborted by timeout signal")), {
        once: true,
      });
    })}) as typeof fetch;
  const started = Date.now();
  await assert.rejects(
    () =>
      liveBackend(hanging, undefined, 50).probeUrl("https://merchant.test/hang", {
        method: "GET",
        headers: {},
      }),
    /aborted by timeout signal/,
  );
  assert.ok(Date.now() - started < 10_000, "the probe must fail fast, not hang");
  assert.ok(seenSignal instanceof AbortSignal, "fetch must receive an abort signal");
});

test("LiveBackend signs manifests with the agent key and verifies them", () => {
  const fetchImpl = (async () => new Response("{}")) as typeof fetch;
  const backend = liveBackend(fetchImpl);
  const signed = backend.signManifest({
    schemaVersion: "16ane-manifest-v0",
    serviceId: "live-sum",
    name: "Live Summarizer",
    version: "0.1.0",
    network: "eip155:31337",
    chainId: 31337,
    payTo: TEST_MERCHANT,
    tokenAddress: TEST_TOKEN,
    tokenSymbol: "tANE",
    updatedAt: 1761091200,
    endpoints: [{ id: "sum", method: "POST", path: "/sum", priceAmount: "16", scheme: "ane-vault-v1" }],
  });
  assert.equal(signed.signer, testAgentSessionAddress());
  assert.equal(backend.verifyManifest(signed).valid, true);
});
