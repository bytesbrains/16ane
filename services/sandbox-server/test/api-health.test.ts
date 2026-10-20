import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { assessHealth, checkApiHealth, type HealthReport } from "../../../scripts/api-health.ts";
import { runApiSmoke } from "../../../scripts/smoke-api.ts";

const REGISTRY = "0x01d5daB670DE5868305eB862721ebE62772C3Df3";
const healthy: HealthReport = {
  status: "ok",
  chainId: 84532,
  registry: REGISTRY,
  relayer: {
    address: "0x00000000000000000000000000000000000000Aa",
    balanceWei: "40000000000000000",
    dailyGasBudgetWei: "50000000000000000",
    remainingTodayWei: "30000000000000000",
    lowBalance: false,
  },
};

test("a healthy server raises nothing", () => {
  assert.deepEqual(assessHealth(200, healthy, REGISTRY.toLowerCase()), []);
});

test("RPC down, low relayer balance, a used-up budget and the wrong registry are each named", () => {
  assert.match(assessHealth(503, { status: "unavailable" })[0], /503 \(unavailable\): the server can't reach its RPC/);
  // A platform proxy's error page (no machine running) is not an RPC problem.
  assert.match(assessHealth(502, {})[0], /502 \(no status\): the API isn't serving/);
  assert.match(assessHealth(404, {})[0], /isn't serving/);
  const low = assessHealth(200, { ...healthy, relayer: { ...healthy.relayer, lowBalance: true } });
  assert.equal(low.length, 1);
  assert.match(low[0], /top it up/);
  const spent = assessHealth(200, { ...healthy, relayer: { ...healthy.relayer, remainingTodayWei: "0" } });
  assert.match(spent[0], /used up: sponsorship is paused until 00:00 UTC/);
  const other = assessHealth(200, healthy, "0x" + "11".repeat(20));
  assert.match(other[0], /another deployment/);
  assert.match(assessHealth(200, { status: "ok" })[0], /no relayer section/);
});

test("an unreachable API is a problem, not a crash", async () => {
  const problems = await checkApiHealth("http://127.0.0.1:1");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unreachable/);
});

// One fake host serving a healthy /healthz, a configurable /v1/networks, and JSON-RPC (eth_chainId = 84532) on POST /.
async function fakeApi(networks: { status: number; body: string }) {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        // eth_chainId is 84532; the registry's getDeployment() lists 0x55… for every contract.
        const { method } = JSON.parse(body) as { method: string };
        const result = method === "eth_chainId" ? "0x14a34" : "0x" + ("55".repeat(20)).padStart(64, "0").repeat(4);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
      });
    } else if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(healthy));
    } else if (req.url === "/v1/networks") {
      res.writeHead(networks.status);
      res.end(networks.body);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("the API smoke test reports the status of an error page, an empty network list and a chain mismatch", async (t) => {
  const contracts = { aneTestToken: "0x" + "11".repeat(20), aneVaultFactory: "0x" + "22".repeat(20), aneFaucet: "0x" + "33".repeat(20), aneServiceDirectory: "0x" + "44".repeat(20) };
  const cases: Array<[{ status: number; body: string }, RegExp]> = [
    [{ status: 502, body: "<html>Bad Gateway</html>" }, /\/v1\/networks: expected 200, got 502 <html>Bad Gateway/],
    [{ status: 200, body: "<html>maintenance</html>" }, /\/v1\/networks: answered 200 without JSON/],
    [{ status: 200, body: JSON.stringify({ networks: [] }) }, /lists no network/],
    [{ status: 200, body: JSON.stringify({ networks: [{ chainId: 1, contracts }] }) }, /server says chain 1, the RPC is chain 84532/],
  ];
  for (const [networks, expected] of cases) {
    const api = await fakeApi(networks);
    t.after(() => api.close());
    await assert.rejects(runApiSmoke({ apiUrl: api.url, rpcUrl: api.url }), expected);
  }
  // The server's contracts must be the expected registry's, read from the chain, not taken on trust.
  const api = await fakeApi({ status: 200, body: JSON.stringify({ networks: [{ chainId: 84532, contracts }] }) });
  t.after(() => api.close());
  await assert.rejects(
    runApiSmoke({ apiUrl: api.url, rpcUrl: api.url, expectedRegistry: REGISTRY }),
    /the server's aneTestToken is 0x1111111111111111111111111111111111111111, the registry's is 0x5555/,
  );
});
