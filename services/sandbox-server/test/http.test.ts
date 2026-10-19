import test from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import { Readable } from "node:stream";
import { clientIp, PayloadTooLargeError, readRequestBody } from "../src/http.ts";

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
