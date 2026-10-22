// Transport behavior: stdio framing/cancellation/shutdown and Streamable HTTP
// validation, status mapping and auth, all against the mock backend.

import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import type http from "node:http";
import { McpProtocolHandler } from "../src/protocol.ts";
import { SixteenAneAdapter } from "../src/tools.ts";
import { runStdio } from "../src/stdio.ts";
import {
  createRequestListener,
  createStreamableHttpServer,
  httpStatusFor,
  type StreamableHttpOptions,
} from "../src/http.ts";
import { MockBackend } from "./mock-backend.ts";

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

function handler(): McpProtocolHandler {
  return new McpProtocolHandler(new SixteenAneAdapter(new MockBackend()));
}

async function runStdioSession(lines: string[]): Promise<{ stdout: string[]; stderr: string }> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  stderr.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });
  const serving = runStdio(handler(), { stdin, stdout, stderr });
  for (const line of lines) {
    stdin.write(`${line}\n`);
  }
  stdin.end();
  await serving;
  await new Promise((resolve) => setImmediate(resolve));
  return { stdout: out.split("\n").filter((l) => l.length > 0), stderr: err };
}

function msg(id: number, method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: META } });
}

test("stdio serves requests in order and skips notifications", async () => {
  const { stdout, stderr } = await runStdioSession([
    msg(1, "server/discover"),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }),
    msg(2, "tools/call", { name: "wallet_balance", arguments: {} }),
  ]);
  assert.equal(stdout.length, 2);
  assert.equal((JSON.parse(stdout[0]) as { id: number }).id, 1);
  assert.equal((JSON.parse(stdout[1]) as { id: number }).id, 2);
  assert.equal(stderr, "");
});

test("stdio reports malformed lines on stderr and keeps serving", async () => {
  const { stdout, stderr } = await runStdioSession(["{not json", "", msg(9, "server/discover")]);
  assert.equal(stdout.length, 1);
  assert.match(stderr, /ignoring non-JSON line/);
  for (const line of stdout) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
});

test("stdio drops the response for a cancelled request", async () => {
  const { stdout } = await runStdioSession([
    JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 5 },
    }),
    msg(5, "server/discover"),
    msg(6, "server/discover"),
  ]);
  // Cancellation is in-order on the shared channel: id 5 was already abandoned.
  assert.equal(stdout.length, 1);
  assert.equal((JSON.parse(stdout[0]) as { id: number }).id, 6);
});

test("httpStatusFor pins the spec's status mapping", () => {
  assert.equal(httpStatusFor(-32700), 400);
  assert.equal(httpStatusFor(-32600), 400);
  assert.equal(httpStatusFor(-32602), 400);
  assert.equal(httpStatusFor(-32020), 400);
  assert.equal(httpStatusFor(-32021), 400);
  assert.equal(httpStatusFor(-32022), 400);
  assert.equal(httpStatusFor(-32601), 404);
  assert.equal(httpStatusFor(-32603), 500);
});

// The listener is driven directly with fake requests: no sockets, so these run
// in any sandbox. createStreamableHttpServer (thin node:http wrapper) is
// covered by a construction check below.
function fakeRequest(
  body: string,
  headers: Record<string, string>,
  method = "POST",
  url = "/mcp",
): http.IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(body, "utf8")]), {
    method,
    url,
    headers,
  }) as unknown as http.IncomingMessage;
}

interface FakeResponse {
  res: http.ServerResponse;
  done: Promise<{ status: number; text: string }>;
}

function fakeResponse(): FakeResponse {
  let status = 0;
  let resolve!: (value: { status: number; text: string }) => void;
  const done = new Promise<{ status: number; text: string }>((r) => {
    resolve = r;
  });
  const res = {
    writeHead: (code: number) => {
      status = code;
    },
    end: (data?: string) => {
      resolve({ status, text: data ?? "" });
    },
  } as unknown as http.ServerResponse;
  return { res, done };
}

async function post(
  body: unknown,
  headers: Record<string, string> = {},
  options: StreamableHttpOptions = {},
): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const listener = createRequestListener(handler(), { endpoint: "/mcp", ...options });
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const req = fakeRequest(raw, { "content-type": "application/json", ...headers });
  const { res, done } = fakeResponse();
  listener(req, res);
  const { status, text } = await done;
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // empty body (202) or plain error
  }
  return { status, json, text };
}

async function rawRequest(
  method: string,
  url: string,
  options: StreamableHttpOptions = {},
): Promise<{ status: number; text: string }> {
  const listener = createRequestListener(handler(), { endpoint: "/mcp", ...options });
  const req = fakeRequest("", {}, method, url);
  const { res, done } = fakeResponse();
  listener(req, res);
  return done;
}

function rpcHeaders(method: string, name?: string): Record<string, string> {
  return {
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
    ...(name === undefined ? {} : { "mcp-name": name }),
    accept: "application/json, text/event-stream",
  };
}

test("Streamable HTTP serves tools/list and tools/call as single JSON objects", async () => {
  const list = await post(
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META } },
    rpcHeaders("tools/list"),
  );
  assert.equal(list.status, 200);
  assert.equal((list.json?.["result"] as Record<string, unknown>)["resultType"], "complete");
  assert.equal(((list.json?.["result"] as Record<string, unknown>)["tools"] as unknown[]).length, 7);

  const call = await post(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "wallet_balance", arguments: {}, _meta: META },
    },
    rpcHeaders("tools/call", "wallet_balance"),
  );
  assert.equal(call.status, 200);
  assert.equal((call.json?.["result"] as Record<string, unknown>)["isError"], false);
});

test("Streamable HTTP accepts the Base64 sentinel form of Mcp-Name", async () => {
  const sentinel = `=base64:${Buffer.from("wallet_balance", "utf8").toString("base64")}`;
  const call = await post(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "wallet_balance", arguments: {}, _meta: META },
    },
    rpcHeaders("tools/call", sentinel),
  );
  assert.equal(call.status, 200);
});

test("Streamable HTTP validates routes, methods, origins and auth", async () => {
  const options = { authToken: "secret-token", allowedOrigins: ["https://app.test"] };
  const listBody = { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META } };

  assert.equal((await rawRequest("POST", "/nope", options)).status, 404);
  assert.equal((await rawRequest("GET", "/mcp", options)).status, 405);

  const badOrigin = await post(
    listBody,
    {
      ...rpcHeaders("tools/list"),
      origin: "https://evil.test",
      authorization: "Bearer secret-token",
    },
    options,
  );
  assert.equal(badOrigin.status, 403);

  const noAuth = await post(listBody, rpcHeaders("tools/list"), options);
  assert.equal(noAuth.status, 401);

  const ok = await post(
    listBody,
    {
      ...rpcHeaders("tools/list"),
      origin: "https://app.test",
      authorization: "Bearer secret-token",
    },
    options,
  );
  assert.equal(ok.status, 200);
});

test("Streamable HTTP rejects header/body mismatches with -32020", async () => {
  const callBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "wallet_balance", arguments: {}, _meta: META },
  };

  const missing = await post(callBody, {});
  assert.equal(missing.status, 400);
  assert.equal((missing.json?.["error"] as Record<string, unknown>)["code"], -32020);

  const methodMismatch = await post(callBody, rpcHeaders("tools/list", "wallet_balance"));
  assert.equal(methodMismatch.status, 400);

  const nameMismatch = await post(callBody, rpcHeaders("tools/call", "list_services"));
  assert.equal(nameMismatch.status, 400);
  assert.equal((nameMismatch.json?.["error"] as Record<string, unknown>)["code"], -32020);

  const versionMismatch = await post(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2025-11-25",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    },
    rpcHeaders("tools/list"),
  );
  assert.equal(versionMismatch.status, 400);
  assert.equal((versionMismatch.json?.["error"] as Record<string, unknown>)["code"], -32020);
});

test("Streamable HTTP maps protocol errors to statuses", async () => {
  const unknownMethod = await post(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { _meta: META } },
    rpcHeaders("initialize"),
  );
  assert.equal(unknownMethod.status, 404);
  assert.equal((unknownMethod.json?.["error"] as Record<string, unknown>)["code"], -32601);

  const badVersion = await post(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "1900-01-01",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    },
    { ...rpcHeaders("tools/list"), "mcp-protocol-version": "1900-01-01" },
  );
  assert.equal(badVersion.status, 400);
  assert.equal((badVersion.json?.["error"] as Record<string, unknown>)["code"], -32022);

  const missingMeta = await post(
    { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
    rpcHeaders("tools/list"),
  );
  assert.equal(missingMeta.status, 400);
  assert.equal((missingMeta.json?.["error"] as Record<string, unknown>)["code"], -32602);

  const badJson = await post("{oops", rpcHeaders("tools/list"));
  assert.equal(badJson.status, 400);
  assert.equal((badJson.json?.["error"] as Record<string, unknown>)["code"], -32700);

  const toolError = await post(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "purchase_service", arguments: { url: "https://x.test" }, _meta: META },
    },
    rpcHeaders("tools/call", "purchase_service"),
  );
  assert.equal(toolError.status, 200);
  assert.equal((toolError.json?.["result"] as Record<string, unknown>)["isError"], true);
});

test("Streamable HTTP answers accepted notifications with 202 and no body", async () => {
  const res = await post(
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
    rpcHeaders("notifications/cancelled"),
  );
  assert.equal(res.status, 202);
  assert.equal(res.text, "");
});

test("createStreamableHttpServer builds a node:http server without binding", () => {
  const server = createStreamableHttpServer(handler(), { endpoint: "/mcp" });
  assert.equal(server.listening, false);
  server.unref();
});
