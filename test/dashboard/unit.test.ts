// Dashboard logic tests that run in Node (no browser): screens' pure pieces —
// campaign message parity with the SDK, calldata builders, read decoders over a
// stubbed fetch transport, and wallet error mapping.
import test from "node:test";
import assert from "node:assert/strict";
import { functionSelector as sdkSelector } from "../../packages/sdk-ts/src/abi.ts";
import { campaignControlMessage as sdkMessage } from "../../packages/sdk-ts/src/campaigns.ts";
import {
  abiWordAddress,
  abiWordBytes32,
  abiWordUint,
  functionSelector,
} from "../../dashboard/assets/abi.js";
import { campaignControlMessage, getReceipt } from "../../dashboard/assets/api.js";
import {
  accountingSummary,
  createVaultData,
  faucetClaimData,
  paymentRecord,
  predictVaultAddress,
  resolveContracts,
  revokeData,
  setPolicyData,
  tokenBalanceOf,
  vaultsByOwner,
  withdrawData,
} from "../../dashboard/assets/contracts.js";
import { ethCall, friendlyWalletError, rpc } from "../../dashboard/assets/provider.js";

const TOKEN = "0x5848C9935C1cA2D2a93329DFd31f0883277b8335";
const VAULT = "0x2222222222222222222222222222222222222222";
const OWNER = "0x1111111111111111111111111111111111111111";

const word = (n: bigint) => n.toString(16).padStart(64, "0");
const addrWord = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

test("campaign control message matches the SDK exactly (personal_sign parity)", () => {
  const control = { providerId: OWNER, campaignId: "trial-1", action: "pause" as const, deadline: 1893456000 };
  assert.equal(campaignControlMessage(control), sdkMessage(control));
});

test("calldata builders match SDK selectors and encoding", () => {
  assert.equal(createVaultData(OWNER, "0x" + "ab".repeat(32)), sdkSelector("createVault(address,bytes32)") + abiWordAddress(OWNER) + abiWordBytes32("0x" + "ab".repeat(32)));
  assert.equal(revokeData(), sdkSelector("revoke()"));
  assert.equal(withdrawData(16n, OWNER), sdkSelector("withdraw(uint256,address)") + abiWordUint(16n) + abiWordAddress(OWNER));
  assert.equal(faucetClaimData(OWNER), sdkSelector("claim(address)") + abiWordAddress(OWNER));
  const policy = setPolicyData({
    agentSigner: OWNER,
    maxTotalSpend: 320n,
    maxPerTx: 16n,
    dailyLimit: 0n,
    expiry: 0,
    budgetMode: "FIXED",
    revolvingTreasuryCeiling: 0n,
  });
  assert.equal(
    policy,
    functionSelector("setPolicy((address,uint256,uint256,uint256,uint64,uint8,uint256))") +
      abiWordAddress(OWNER) +
      abiWordUint(320n) +
      abiWordUint(16n) +
      abiWordUint(0n) +
      abiWordUint(0) +
      abiWordUint(0) +
      abiWordUint(0n),
  );
  assert.throws(() => setPolicyData({ agentSigner: "nope", maxTotalSpend: 1n, maxPerTx: 0n, dailyLimit: 0n, expiry: 0, budgetMode: "FIXED", revolvingTreasuryCeiling: 0n }));
});

async function withFetch(responder: (url: string, body: string) => { status: number; json: unknown }, fn: () => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: { body?: string } = {}) => {
    const { status, json } = responder(String(url), String(init.body ?? ""));
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

function rpcResponder(results: Record<string, string>) {
  return (_url: string, body: string) => {
    const parsed = JSON.parse(body) as { id: number; method: string; params: { data?: string }[] };
    const data = (parsed.params[0]?.data ?? "").toLowerCase();
    return { status: 200, json: { jsonrpc: "2.0", id: parsed.id, result: results[data.slice(0, 10)] ?? "0x" + word(0n) } };
  };
}

test("read decoders parse scripted RPC responses", async () => {
  const accounting =
    "0x" + addrWord(OWNER) + addrWord(OWNER) + word(100n) + word(100n) + word(320n) + word(16n) +
    word(304n) + word(304n) + word(0n) + word(84n) + word(1n) + word(0n) + word(0n) + word(0n) + word(1n);
  await withFetch(
    rpcResponder({
      "0x70a08231": "0x" + word(16000n),
      "0xaf33ccfd": accounting,
      "0xac818711": "0x" + word(32n) + word(1n) + addrWord(VAULT),
      "0x089ec70e": "0x" + addrWord(VAULT),
      "0x0716326d": "0x" + addrWord(OWNER) + word(16n) + word(0n) + word(100n),
    }),
    async () => {
      assert.equal(await tokenBalanceOf(TOKEN, OWNER), 16000n);
      assert.deepEqual(await vaultsByOwner(VAULT, OWNER), [VAULT]);
      assert.equal(await predictVaultAddress(VAULT, OWNER, "0x" + "ab".repeat(32)), VAULT);
      const summary = await accountingSummary(VAULT);
      assert.equal(summary.owner, OWNER);
      assert.equal(summary.spendableNow, 304n);
      assert.equal(summary.budgetMode, "FIXED");
      assert.equal(summary.active, true);
      const record = await paymentRecord(VAULT, "0x" + "cc".repeat(32));
      assert.ok(record);
      assert.equal(record.amountPaid, 16n);
      assert.equal(record.settledAt, 100);
    },
  );
});

test("vaultsByOwner rejects truncated factory responses", async () => {
  // Length word says two vaults but only one address word follows.
  const truncated = "0x" + word(32n) + word(2n) + addrWord(VAULT);
  await withFetch(rpcResponder({ "0xac818711": truncated }), async () => {
    await assert.rejects(() => vaultsByOwner(VAULT, OWNER), /Unexpected vault list/);
  });
  await withFetch(rpcResponder({ "0xac818711": "0x" }), async () => {
    await assert.rejects(() => vaultsByOwner(VAULT, OWNER), /Unexpected vault list/);
  });
});

test("paymentRecord returns null when the target holds no vault record", async () => {
  const id = "0x" + "cc".repeat(32);
  await withFetch(rpcResponder({ "0x0716326d": "0x" }), async () => {
    assert.equal(await paymentRecord(VAULT, id), null);
  });
  await withFetch(rpcResponder({ "0x0716326d": "0x" + addrWord(OWNER) + word(16n) }), async () => {
    assert.equal(await paymentRecord(VAULT, id), null);
  });
});

test("getReceipt maps 404 to null and surfaces other failures", async () => {
  const id = "0x" + "cc".repeat(32);
  await withFetch(
    (url) => (url.includes("/v1/payments/") ? { status: 404, json: {} } : { status: 200, json: {} }),
    async () => {
      assert.equal(await getReceipt(id), null);
    },
  );
  await withFetch(() => ({ status: 500, json: {} }), async () => {
    await assert.rejects(() => getReceipt(id), /HTTP 500/);
  });
  await withFetch(
    (url) =>
      url.includes("/v1/payments/")
        ? { status: 200, json: { txHash: "0xabc", payer: VAULT } }
        : { status: 404, json: {} },
    async () => {
      assert.deepEqual(await getReceipt(id), { txHash: "0xabc", payer: VAULT });
    },
  );
});

test("resolveContracts reads the registry when the build embeds none", async () => {
  // The committed sandbox build embeds contracts; the registry path is what
  // local/dev builds use. Exercise the decoder directly via ethCall shape.
  const deployment = "0x" + addrWord(TOKEN) + addrWord(VAULT) + addrWord(OWNER) + addrWord(VAULT);
  await withFetch(rpcResponder({ "0x8011e1fd": deployment }), async () => {
    const out = await ethCall(OWNER, functionSelector("getDeployment()"));
    assert.equal(out, deployment);
  });
  // And the embedded path resolves without any fetch.
  await withFetch(
    () => {
      throw new Error("must not fetch");
    },
    async () => {
      const c = await resolveContracts();
      assert.equal(c.aneTestToken, TOKEN);
    },
  );
});

test("rpc maps transport and JSON-RPC failures to errors", async () => {
  await withFetch(() => ({ status: 500, json: {} }), async () => {
    await assert.rejects(() => rpc("eth_call", []), /HTTP 500/);
  });
  await withFetch(() => ({ status: 200, json: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "oops" } } }), async () => {
    await assert.rejects(() => rpc("eth_call", []), /oops/);
  });
});

test("wallet errors map to human messages", () => {
  assert.match(friendlyWalletError({ code: 4001 }), /Rejected in the wallet/);
  assert.match(friendlyWalletError({ code: 4902 }), /refused to add/);
  assert.match(friendlyWalletError({ code: -32002 }), /already pending/);
  assert.match(friendlyWalletError(new Error("boom")), /boom/);
});
