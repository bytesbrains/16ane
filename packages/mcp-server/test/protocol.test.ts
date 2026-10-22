// MCP 2026-07-28 protocol handling: metadata validation, discovery, dispatch.

import test from "node:test";
import assert from "node:assert/strict";
import {
  McpProtocolHandler,
  SERVER_NAME,
  SERVER_VERSION,
  type ToolAdapter,
  type ToolResult,
} from "../src/protocol.ts";
import { SixteenAneAdapter, listToolDefinitions } from "../src/tools.ts";
import { MockBackend } from "./mock-backend.ts";

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

function request(id: number | string, method: string, params: Record<string, unknown> = {}): unknown {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: { ...params, _meta: { ...META, ...(params["_meta"] as object | undefined) } },
  };
}

function handler(): McpProtocolHandler {
  return new McpProtocolHandler(new SixteenAneAdapter(new MockBackend()));
}

test("server/discover advertises versions, tools capability and server identity", async () => {
  const res = await handler().handleMessage(request(1, "server/discover"));
  assert.equal(res?.id, 1);
  const result = res?.result!;
  assert.equal(result["resultType"], "complete");
  assert.deepEqual(result["supportedVersions"], ["2026-07-28"]);
  assert.deepEqual(result["capabilities"], { tools: { listChanged: false } });
  assert.match(String(result["instructions"]), /sandbox/i);
  assert.deepEqual((result["_meta"] as Record<string, unknown>)["io.modelcontextprotocol/serverInfo"], {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
});

test("tools/list returns the seven tools in a deterministic order", async () => {
  const h = handler();
  const first = await h.handleMessage(request(1, "tools/list"));
  const second = await h.handleMessage(request(2, "tools/list"));
  const names = (first?.result?.["tools"] as { name: string }[]).map((t) => t.name);
  assert.deepEqual(names, [
    "list_services",
    "get_quote",
    "wallet_balance",
    "payment_status",
    "purchase_service",
    "publish_service",
    "request_refund",
  ]);
  assert.deepEqual(second?.result?.["tools"], first?.result?.["tools"]);
  for (const tool of first?.result?.["tools"] as Record<string, unknown>[]) {
    assert.ok(typeof tool["description"] === "string" && tool["description"].length > 0);
    assert.equal((tool["inputSchema"] as Record<string, unknown>)["type"], "object");
  }
  assert.deepEqual(
    (first?.result?.["tools"] as { name: string }[]).map((t) => t.name),
    listToolDefinitions().map((t) => t.name),
  );
});

test("tools/list with a cursor returns an empty page (single page of seven)", async () => {
  const res = await handler().handleMessage(request(1, "tools/list", { cursor: "abc" }));
  assert.deepEqual(res?.result?.["tools"], []);
});

test("tools/call returns the tool result with resultType and server identity", async () => {
  const res = await handler().handleMessage(
    request(7, "tools/call", { name: "wallet_balance", arguments: {} }),
  );
  assert.equal(res?.id, 7);
  assert.equal(res?.result?.["resultType"], "complete");
  assert.equal(res?.result?.["isError"], false);
  assert.ok(Array.isArray(res?.result?.["content"]));
  assert.ok(res?.result?.["_meta"] !== undefined);
});

test("tool-level failures arrive as isError results, not JSON-RPC errors", async () => {
  const res = await handler().handleMessage(
    request(8, "tools/call", { name: "purchase_service", arguments: { url: "https://x.test/" } }),
  );
  assert.equal(res?.error, undefined);
  assert.equal(res?.result?.["isError"], true);
  assert.match(String((res?.result?.["structuredContent"] as Record<string, unknown>)["error"]), /max_payment/);
});

test("missing _meta protocol fields are rejected with -32602", async () => {
  const h = handler();
  const noMeta = await h.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.equal(noMeta?.error?.code, -32602);
  const noCaps = await h.handleMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
  });
  assert.equal(noCaps?.error?.code, -32602);
});

test("unsupported protocol version returns -32022 with supported and requested", async () => {
  const res = await handler().handleMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "1900-01-01",
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  assert.equal(res?.error?.code, -32022);
  assert.deepEqual(res?.error?.data, { supported: ["2026-07-28"], requested: "1900-01-01" });
});

test("unknown methods and tools are rejected", async () => {
  const h = handler();
  const legacyInit = await h.handleMessage(request(1, "initialize", {}));
  assert.equal(legacyInit?.error?.code, -32601);
  const noTool = await h.handleMessage(request(2, "tools/call", { name: "drain_wallet", arguments: {} }));
  assert.equal(noTool?.error?.code, -32602);
  const noName = await h.handleMessage(request(3, "tools/call", { arguments: {} }));
  assert.equal(noName?.error?.code, -32602);
});

test("notifications get no response", async () => {
  const res = await handler().handleMessage({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 1, _meta: META },
  });
  assert.equal(res, null);
});

test("malformed messages are rejected with -32600", async () => {
  const h = handler();
  assert.equal((await h.handleMessage("nope"))?.error?.code, -32600);
  assert.equal((await h.handleMessage({ jsonrpc: "1.0", id: 1, method: "tools/list" }))?.error?.code, -32600);
  assert.equal((await h.handleMessage({ jsonrpc: "2.0", id: 1 }))?.error?.code, -32600);
  assert.equal(
    (await h.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: [] }))?.error?.code,
    -32600,
  );
  assert.equal(
    (await h.handleMessage({ jsonrpc: "2.0", id: null, method: "tools/list", params: { _meta: META } }))
      ?.error?.code,
    -32600,
  );
});

test("adapter crashes surface as -32603 without hanging the session", async () => {
  const exploding: ToolAdapter = {
    listTools: () => listToolDefinitions(),
    callTool: async (): Promise<ToolResult> => {
      throw new Error("boom");
    },
  };
  const res = await new McpProtocolHandler(exploding).handleMessage(
    request(1, "tools/call", { name: "wallet_balance", arguments: {} }),
  );
  assert.equal(res?.error?.code, -32603);
});
