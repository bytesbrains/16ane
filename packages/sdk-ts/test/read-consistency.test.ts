import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { AneClient } from "../src/index.ts";

// A load-balanced public RPC in miniature (#67): `head` is the block the answering node has reached, `lagging`
// makes the next N state reads fail as a node behind the requested block does, and every request is recorded.
async function fakeRpc() {
  const state = { head: 10, lagging: 0, receiptAfter: 0 };
  const calls: Array<{ method: string; tag?: string }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      const tag = typeof params.at(-1) === "string" ? (params.at(-1) as string) : undefined;
      calls.push({ method, tag });
      let reply: object;
      if (method === "eth_blockNumber") {
        reply = { result: "0x" + state.head.toString(16) };
        state.head += 1; // the node catches up a block each time it's asked
      } else if (method === "eth_getTransactionReceipt") {
        reply = { result: state.receiptAfter-- > 0 ? null : { status: "0x1", blockNumber: "0xc", logs: [] } };
      } else if (state.lagging > 0) {
        state.lagging -= 1;
        reply = { error: { code: -32000, message: "header not found" } };
      } else {
        reply = { result: "0x" + "00".repeat(31) + "07" };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, ...reply }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, state, calls, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const contracts = {
  aneTestToken: "0x" + "11".repeat(20),
  aneVaultFactory: "0x" + "22".repeat(20),
  aneFaucet: "0x" + "33".repeat(20),
  aneServiceDirectory: "0x" + "44".repeat(20),
};
const VAULT = "0x" + "55".repeat(20);

test("without a recent write, reads use latest and cost one call", async (t) => {
  const rpc = await fakeRpc();
  t.after(() => rpc.close());
  const client = new AneClient({ rpcUrl: rpc.url, contracts });
  assert.equal(await client.getPolicyVersion(VAULT), 7);
  assert.deepEqual(rpc.calls, [{ method: "eth_call", tag: "latest" }]);
});

test("after a write, reads wait until the node has reached that block, then read at the node's head", async (t) => {
  const rpc = await fakeRpc();
  t.after(() => rpc.close());
  const client = new AneClient({ rpcUrl: rpc.url, contracts });
  client.observeBlock(12); // the node is at 10, 11, then 12
  assert.equal(await client.getPolicyVersion(VAULT), 7);
  assert.deepEqual(
    rpc.calls.map((c) => c.method),
    ["eth_blockNumber", "eth_blockNumber", "eth_blockNumber", "eth_call"],
  );
  assert.equal(rpc.calls.at(-1)!.tag, "0xc", "read at block 12, not 'latest'");
});

test("a read routed to a node without that block ('header not found') is retried", async (t) => {
  const rpc = await fakeRpc();
  t.after(() => rpc.close());
  const client = new AneClient({ rpcUrl: rpc.url, contracts });
  client.observeBlock(10);
  rpc.state.lagging = 2;
  assert.equal(await client.getTokenBalance(VAULT), 7n);
  assert.equal(rpc.calls.filter((c) => c.method === "eth_call").length, 3);
});

test("a node that never catches up fails clearly instead of returning old state", async (t) => {
  const rpc = await fakeRpc();
  t.after(() => rpc.close());
  const client = new AneClient({ rpcUrl: rpc.url, contracts });
  client.observeBlock(1_000);
  await assert.rejects(client.getPolicyVersion(VAULT), /RPC node is behind this client's last write \(block 1000/);
  assert.equal(rpc.calls.filter((c) => c.method === "eth_call").length, 0, "no stale read was returned");
});

test("the read floor expires, and a later write never lowers it", async (t) => {
  const rpc = await fakeRpc();
  t.after(() => rpc.close());
  const client = new AneClient({ rpcUrl: rpc.url, contracts, readFloorWindowMs: 50 });
  client.observeBlock(10);
  client.observeBlock(5);
  await client.getPolicyVersion(VAULT);
  assert.equal(rpc.calls.at(-1)!.tag, "0xa", "the higher floor (10) held");
  await new Promise((resolve) => setTimeout(resolve, 80));
  rpc.calls.length = 0;
  await client.getPolicyVersion(VAULT);
  assert.deepEqual(rpc.calls, [{ method: "eth_call", tag: "latest" }]);

  const off = new AneClient({ rpcUrl: rpc.url, contracts, readFloorWindowMs: 0 });
  off.observeBlock(1_000);
  rpc.calls.length = 0;
  await off.getPolicyVersion(VAULT);
  assert.deepEqual(rpc.calls, [{ method: "eth_call", tag: "latest" }], "0 turns the floor off");
});

test("a receipt a lagging node doesn't have yet is asked for again before it's reported missing", async (t) => {
  const rpc = await fakeRpc();
  t.after(() => rpc.close());
  const client = new AneClient({ rpcUrl: rpc.url, contracts });
  rpc.state.receiptAfter = 2;
  const result = await client.verifySettlementOnChain({
    txHash: "0x" + "ab".repeat(32),
    expectedPayee: "0x" + "66".repeat(20),
    expectedAmount: 1n,
  });
  assert.notEqual(result.reason, "Transaction receipt not found", "found on the third try");
  assert.equal(rpc.calls.filter((c) => c.method === "eth_getTransactionReceipt").length, 3);
});
