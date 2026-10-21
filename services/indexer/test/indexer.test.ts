import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  AneClient,
  keccak256Utf8,
  MemoryKeyValueStore,
  toChecksumAddress,
} from "../../../packages/sdk-ts/src/index.ts";
import { decodeServiceAnchored, SERVICE_ANCHORED_TOPIC, ServiceDirectoryIndexer } from "../src/indexer.ts";
import { createIndexerServer } from "../src/server.ts";

const word = (n: bigint | number | string) =>
  (typeof n === "string" ? n.replace(/^0x/, "") : BigInt(n).toString(16)).padStart(64, "0");
const DIRECTORY = "0x" + "dd".repeat(20);
const PROVIDER = "0x" + "22".repeat(20);
const ID_A = keccak256Utf8("service-a");
const ID_B = keccak256Utf8("service-b");

// One ServiceAnchored log, ABI-encoded exactly as AneServiceDirectory emits it.
function anchoredLog(opts: {
  serviceIdHash?: string;
  provider?: string;
  manifestUri?: string;
  manifestHash?: string;
  expiresAt?: number;
  status?: number;
  blockNumber?: number;
  txHash?: string;
  logIndex?: number;
}) {
  const uri = opts.manifestUri ?? "https://a.example/.well-known/16ane-service.json";
  const uriHex = Buffer.from(uri, "utf8").toString("hex");
  const data =
    "0x" +
    word(0x80) +
    word(opts.manifestHash ?? keccak256Utf8(uri)) +
    word(opts.expiresAt ?? 1_900_000_000) +
    word(opts.status ?? 1) +
    word(uriHex.length / 2) +
    uriHex.padEnd(Math.ceil(uriHex.length / 64) * 64, "0");
  return {
    address: DIRECTORY,
    topics: [SERVICE_ANCHORED_TOPIC, opts.serviceIdHash ?? ID_A, "0x" + word(opts.provider ?? PROVIDER)],
    data,
    blockNumber: "0x" + (opts.blockNumber ?? 7).toString(16),
    transactionHash: opts.txHash ?? "0x" + "ab".repeat(32),
    logIndex: "0x" + (opts.logIndex ?? 0).toString(16),
  };
}

test("decodeServiceAnchored reads the event the contract emits", () => {
  const anchor = decodeServiceAnchored(anchoredLog({}));
  assert.deepEqual(anchor, {
    serviceIdHash: ID_A,
    provider: toChecksumAddress(PROVIDER),
    manifestUri: "https://a.example/.well-known/16ane-service.json",
    manifestHash: keccak256Utf8("https://a.example/.well-known/16ane-service.json"),
    expiresAt: 1_900_000_000,
    status: "ACTIVE",
    blockNumber: 7,
    txHash: "0x" + "ab".repeat(32),
  });
});

test("decodeServiceAnchored skips anything that is not exactly that event", () => {
  const good = anchoredLog({});
  const bad = [
    { ...good, topics: [keccak256Utf8("Other()"), ID_A, "0x" + word(PROVIDER)] },
    { ...good, topics: [SERVICE_ANCHORED_TOPIC] },
    { ...good, data: "0x1234" },
    { ...good, blockNumber: "seven" },
    { ...good, transactionHash: "0x1234" },
    anchoredLog({ manifestHash: "0x" + "00".repeat(32) }),
    anchoredLog({ manifestUri: "https://evil.example/\x00.png" }),
    anchoredLog({ manifestUri: "https://x.example/" + "a".repeat(3000) }),
    anchoredLog({ status: 9 }),
    anchoredLog({ expiresAt: Number.MAX_SAFE_INTEGER + 100 }),
    {},
  ];
  for (const [i, log] of bad.entries()) {
    assert.equal(decodeServiceAnchored(log), undefined, `case ${i}`);
  }
});

// An RPC with a scripted chain head and log set; records eth_getLogs ranges so chunking is observable.
function fakeRpc(opts: { head?: number; logs?: Array<Record<string, unknown>> } = {}) {
  let head = opts.head ?? 10;
  const logs = opts.logs ?? [];
  const ranges: Array<[number, number]> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method, params = [] } = JSON.parse(body) as { id: number; method: string; params?: any[] };
      let result: unknown;
      if (method === "eth_blockNumber") result = "0x" + head.toString(16);
      else if (method === "eth_getLogs") {
        const from = Number(BigInt(params[0].fromBlock));
        const to = Number(BigInt(params[0].toBlock));
        ranges.push([from, to]);
        result = logs.filter((l) => {
          const n = Number(BigInt(l.blockNumber as string));
          return n >= from && n <= to;
        });
      } else if (method === "eth_call") {
        result = "0x" + word(0x11) + word(0x22) + word(0x33) + word(DIRECTORY);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "not in this fake" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  return {
    start: async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    setHead: (n: number) => (head = n),
    ranges,
  };
}

// Scan tests drive a bare indexer (no server, no poll loop) so counts are deterministic.
async function withScanner(
  t: test.TestContext,
  opts: {
    head?: number;
    logs?: Array<Record<string, unknown>>;
    fromBlock?: number | "latest" | "earliest";
    maxRange?: number;
  },
  run: (indexer: ServiceDirectoryIndexer) => Promise<void>,
) {
  const rpc = fakeRpc(opts);
  const url = await rpc.start();
  t.after(() => rpc.close());
  const client = new AneClient({ rpcUrl: url, chainId: 84532, registryAddress: "0x" + "ab".repeat(20) });
  const indexer = new ServiceDirectoryIndexer(client, DIRECTORY, new MemoryKeyValueStore(), {
    fromBlock: opts.fromBlock ?? 0,
    maxRange: opts.maxRange,
  });
  await run(indexer);
}

test("scanOnce indexes new anchors, latest event wins, cursor resumes", async (t) => {
  await withScanner(
    t,
    {
      head: 10,
      logs: [
        anchoredLog({ blockNumber: 5, status: 1 }),
        anchoredLog({ blockNumber: 8, status: 2, txHash: "0x" + "cd".repeat(32) }),
        anchoredLog({ serviceIdHash: ID_B, blockNumber: 9 }),
        { topics: [], data: "0x", blockNumber: "0x9", transactionHash: "0x" + "ee".repeat(32) },
      ],
    },
    async (indexer) => {
      const first = await indexer.scanOnce();
      assert.equal(first.scannedTo, 10);
      assert.equal(first.upserted, 3);
      assert.equal(indexer.lastScannedBlock, 10);
      const a = indexer.getAnchor(ID_A)!;
      assert.equal(a.status, "PAUSED", "the later event wins");
      assert.equal(a.txHash, "0x" + "cd".repeat(32));
      assert.ok(indexer.getAnchor(ID_B), "the second service is indexed");
      assert.equal(indexer.listAnchors().length, 2, "the foreign log was skipped");

      const second = await indexer.scanOnce();
      assert.equal(second.upserted, 0, "nothing new under the cursor");
      assert.deepEqual(indexer.listAnchors({ status: "PAUSED" }).map((x) => x.serviceIdHash), [ID_A]);
      assert.equal(indexer.listAnchors({ provider: "0x" + "99".repeat(20) }).length, 0);
    },
  );
});

test("scanOnce chunks long ranges inside the cap and advances per chunk", async (t) => {
  const rpc = fakeRpc({ head: 10, logs: [anchoredLog({ blockNumber: 9 })] });
  const url = await rpc.start();
  t.after(() => rpc.close());
  const client = new AneClient({ rpcUrl: url, chainId: 84532, registryAddress: "0x" + "ab".repeat(20) });
  const indexer = new ServiceDirectoryIndexer(client, DIRECTORY, new MemoryKeyValueStore(), { fromBlock: 0, maxRange: 4 });
  await indexer.scanOnce();
  assert.deepEqual(rpc.ranges, [
    [0, 3],
    [4, 7],
    [8, 10],
  ]);
  assert.equal(indexer.lastScannedBlock, 10);
  assert.equal(indexer.listAnchors().length, 1);
});

test("a fresh store starts at fromBlock; 'latest' skips the backfill", async (t) => {
  await withScanner(t, { head: 10, logs: [anchoredLog({ blockNumber: 3 })], fromBlock: 0 }, async (indexer) => {
    await indexer.scanOnce();
    assert.equal(indexer.listAnchors().length, 1, "block 0 catches the old anchor");
  });
  await withScanner(t, { head: 10, logs: [anchoredLog({ blockNumber: 3 })], fromBlock: "latest" }, async (indexer) => {
    await indexer.scanOnce();
    assert.equal(indexer.listAnchors().length, 0, "starting at the head skips history");
    assert.equal(indexer.lastScannedBlock, 10);
  });
});

test("HTTP: list, filters, one anchor, and health", async (t) => {
  const rpc = fakeRpc({
    head: 10,
    logs: [anchoredLog({ blockNumber: 5 }), anchoredLog({ serviceIdHash: ID_B, blockNumber: 6, status: 3 })],
  });
  const rpcUrl = await rpc.start();
  const server = await createIndexerServer({ rpcUrl, registryAddress: "0x" + "ab".repeat(20), fromBlock: 0, pollMs: 1000 });
  t.after(async () => {
    await server.close();
    await rpc.close();
  });
  // The server's poll loop scans on its own schedule; wait for it instead of racing it.
  const deadline = Date.now() + 10000;
  while (server.indexer.listAnchors().length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(server.indexer.listAnchors().length, 2, "the poll loop indexed both anchors");
  {
      const api = { url: server.url };
      const list = (await (await fetch(`${api.url}/v1/services`)).json()) as { services: unknown[] };
      assert.equal(list.services.length, 2);
      const paused = (await (await fetch(`${api.url}/v1/services?status=DEPRECATED`)).json()) as { services: unknown[] };
      assert.equal(paused.services.length, 1);
      assert.equal((await fetch(`${api.url}/v1/services?status=BOGUS`)).status, 400);
      assert.equal((await fetch(`${api.url}/v1/services?provider=not-an-address`)).status, 400);

      const one = await fetch(`${api.url}/v1/services/${ID_A}`);
      assert.equal(one.status, 200);
      assert.equal((await fetch(`${api.url}/v1/services/0x${"00".repeat(32)}`)).status, 404);
      assert.equal((await fetch(`${api.url}/v1/services/nope`)).status, 400);

      const health = (await (await fetch(`${api.url}/healthz`)).json()) as {
        status: string;
        lastScannedBlock: number;
        services: number;
      };
      assert.equal(health.status, "ok");
      assert.equal(health.lastScannedBlock, 10);
      assert.equal(health.services, 2);
  }
});

test("healthz is 503 when the RPC is down", async (t) => {
  const rpc = fakeRpc({ head: 10 });
  const url = await rpc.start();
  const server = await createIndexerServer({ rpcUrl: url, registryAddress: "0x" + "ab".repeat(20), pollMs: 3600_000 });
  t.after(() => server.close());
  assert.equal((await fetch(`${server.url}/healthz`)).status, 200);
  await rpc.close();
  assert.equal((await fetch(`${server.url}/healthz`)).status, 503);
});
