import test from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import { Readable } from "node:stream";
import { clientIp, handleCorsPreflight, PayloadTooLargeError, readRequestBody, sendJson } from "../src/http.ts";

function fakeRequest(
  chunks: Buffer[],
  headers: http.IncomingHttpHeaders = {},
  remoteAddress = "203.0.113.7",
): http.IncomingMessage {
  return Object.assign(Readable.from(chunks), {
    headers,
    socket: { remoteAddress },
  }) as unknown as http.IncomingMessage;
}

test("readRequestBody returns bodies within the cap", async () => {
  const body = await readRequestBody(fakeRequest([Buffer.from("hello "), Buffer.from("world")]), 64);
  assert.equal(body, "hello world");
});

test("readRequestBody rejects an oversized declared Content-Length before reading", async () => {
  const req = fakeRequest([Buffer.alloc(8)], { "content-length": "1000" });
  await assert.rejects(readRequestBody(req, 64), PayloadTooLargeError);
});

test("readRequestBody rejects once streamed bytes pass the cap without a Content-Length", async () => {
  const chunks = Array.from({ length: 10 }, () => Buffer.alloc(16, 0x61));
  await assert.rejects(readRequestBody(fakeRequest(chunks), 64), PayloadTooLargeError);
});

test("clientIp ignores client-supplied headers unless a trusted proxy is configured", () => {
  const req = fakeRequest([], {
    "x-forwarded-for": "198.51.100.1",
    "x-agent-vault": "0x" + "ab".repeat(20),
  });
  assert.equal(clientIp(req, false), "203.0.113.7");
});

test("clientIp uses the right-most X-Forwarded-For entry behind a trusted proxy", () => {
  const req = fakeRequest([], { "x-forwarded-for": "198.51.100.1, 192.0.2.44" });
  assert.equal(clientIp(req, true), "192.0.2.44");
  assert.equal(clientIp(fakeRequest([]), true), "203.0.113.7");
});

test("clientIp reads the platform proxy's header when one is configured (Fly-Client-IP on Fly.io)", () => {
  const req = fakeRequest([], { "fly-client-ip": "198.51.100.9", "x-forwarded-for": "192.0.2.66" }, "172.16.0.2");
  assert.equal(clientIp(req, false, "Fly-Client-IP"), "198.51.100.9");
  assert.equal(clientIp(req, false), "172.16.0.2", "ignored unless configured");
  assert.equal(clientIp(fakeRequest([], {}, "172.16.0.2"), false, "fly-client-ip"), "172.16.0.2", "falls back when absent");
});

test("clientIp ignores a configured header that doesn't hold an IP address", () => {
  for (const forged of ["not-an-ip", "198.51.100.9, 192.0.2.66", "0x" + "ab".repeat(20)]) {
    const req = fakeRequest([], { "fly-client-ip": forged }, "172.16.0.2");
    assert.equal(clientIp(req, false, "fly-client-ip"), "172.16.0.2", forged);
  }
  const v6 = fakeRequest([], { "fly-client-ip": "2001:db8::1" }, "172.16.0.2");
  assert.equal(clientIp(v6, false, "fly-client-ip"), "2001:db8::1");
});

function fakeResponse(): http.ServerResponse & { status: number; headers: Record<string, string>; body: string } {
  const res = {
    status: 0,
    headers: {} as Record<string, string>,
    body: "",
    writeHead(status: number, headers: Record<string, string>) {
      res.status = status;
      res.headers = headers;
    },
    end(payload?: string) {
      res.body = payload ?? "";
    },
  };
  return res as unknown as http.ServerResponse & { status: number; headers: Record<string, string>; body: string };
}

test("sendJson serves browser clients with a wildcard CORS origin", () => {
  const res = fakeResponse();
  sendJson(res, 200, { ok: true });
  assert.equal(res.headers["access-control-allow-origin"], "*");
  assert.ok(!("access-control-allow-credentials" in res.headers), "no ambient credentials");
});

test("handleCorsPreflight answers OPTIONS and ignores other methods", () => {
  const preflight = fakeResponse();
  const handled = handleCorsPreflight({ method: "OPTIONS" } as http.IncomingMessage, preflight);
  assert.equal(handled, true);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "*");
  assert.match(preflight.headers["access-control-allow-methods"], /POST/);
  assert.match(preflight.headers["access-control-allow-headers"], /content-type/);
  const get = fakeResponse();
  assert.equal(handleCorsPreflight({ method: "GET" } as http.IncomingMessage, get), false);
  assert.equal(get.status, 0);
});
