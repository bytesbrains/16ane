import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { redactUrls } from "../src/http.ts";
import { createSandboxServer } from "../src/server.ts";

// Stands in for an RPC provider whose error pages echo the keyed URL (#52).
const LEAKY_URL = "https://rpc.example.invalid/v3/sk_live_DO_NOT_LEAK";
const word = (n: number) => n.toString(16).padStart(64, "0");

async function fakeRpc(): Promise<{ url: string; fail: () => void; close: () => Promise<void> }> {
  let healthy = true;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (!healthy) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`upstream error at ${LEAKY_URL}`);
        return;
      }
      const { id } = JSON.parse(body) as { id: number };
      // getDeployment(): token, vault factory, faucet, service directory.
      const result = "0x" + word(0x11) + word(0x22) + word(0x33) + word(0x44);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    fail: () => (healthy = false),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function withServer(
  t: test.TestContext,
  run: (url: string, logs: string[]) => Promise<void>,
): Promise<void> {
  const rpc = await fakeRpc();
  const sandbox = await createSandboxServer({
    rpcUrl: rpc.url,
    registryAddress: "0x" + "ab".repeat(20),
    relayerPrivateKey: "0x" + "1".repeat(64),
  });
  const logs: string[] = [];
  t.mock.method(console, "error", (line: string) => logs.push(line));
  rpc.fail();
  try {
    await run(sandbox.url, logs);
  } finally {
    await sandbox.close();
    await rpc.close();
  }
}

test("redactUrls removes URLs, including keyed RPC URLs", () => {
  assert.equal(redactUrls(`RPC HTTP error 500: see ${LEAKY_URL} now`), "RPC HTTP error 500: see <url> now");
  assert.equal(redactUrls("no url here"), "no url here");
});

test("a failed faucet claim returns a fixed 502 and logs the detail without the URL", async (t) => {
  await withServer(t, async (url, logs) => {
    const res = await fetch(`${url}/v1/faucet/claims`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipient: "0x" + "cd".repeat(20) }),
    });
    const text = await res.text();
    assert.equal(res.status, 502);
    assert.doesNotMatch(text, /DO_NOT_LEAK|rpc\.example|HTTP error|cast send|--rpc-url/);
    const { error } = JSON.parse(text) as { error: { code: string; message: string; errorId: string } };
    assert.equal(error.code, "ANE-E-1004");
    assert.equal(error.message, "Faucet claim could not be completed on-chain; try again later");
    assert.equal(logs.length, 1);
    assert.ok(logs[0].includes(error.errorId), "log line carries the same errorId");
    // The chain client shells out to `cast send`, so its error carries the command line and RPC URL.
    assert.match(logs[0], /HTTP error 500/);
    assert.doesNotMatch(logs[0], /DO_NOT_LEAK|rpc\.example|127\.0\.0\.1/);
  });
});

test("an unexpected error returns a generic 500 without the underlying message", async (t) => {
  await withServer(t, async (url, logs) => {
    const res = await fetch(`${url}/v1/wallets/0x${"cd".repeat(20)}/balances`);
    const text = await res.text();
    assert.equal(res.status, 500);
    assert.doesNotMatch(text, /DO_NOT_LEAK|rpc\.example|RPC HTTP error/);
    const { error } = JSON.parse(text) as { error: { code: string; message: string } };
    assert.equal(error.code, "ANE-E-5000");
    assert.equal(error.message, "Internal server error");
    assert.equal(logs.length, 1);
    assert.doesNotMatch(logs[0], /DO_NOT_LEAK/);
  });
});

test("a malformed JSON body is a 400, not a 500", async (t) => {
  await withServer(t, async (url) => {
    const res = await fetch(`${url}/v1/faucet/claims`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    const { error } = (await res.json()) as { error: { code: string } };
    assert.equal(error.code, "ANE-E-4000");
  });
});
