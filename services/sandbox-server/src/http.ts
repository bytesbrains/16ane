import { randomUUID } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { SANDBOX_DISCLAIMER } from "../../../packages/sdk-ts/src/index.ts";

export function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-16ane-disclaimer": SANDBOX_DISCLAIMER,
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendError(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
  retryable: boolean,
): void {
  sendJson(res, status, {
    error: { code, message, retryable, disclaimer: SANDBOX_DISCLAIMER },
  });
}

// Strips URLs (an RPC URL often embeds an API key) from text that is about to be logged.
export function redactUrls(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "<url>");
}

/** Optional per-server sink for sendLoggedError (Sentry when ANE_SENTRY_DSN is set; #90). */
export type LoggedErrorSink = (info: { code: string; errorId: string; detail: string }) => void;

// For failures whose underlying error may carry internal detail (RPC responses, chain-client
// errors): the client gets a fixed message and an id; the detail is logged server-side with URLs
// redacted, under the same id (ADR-0010). When a sink is passed it gets the same fields only —
// never the request, headers or client IP (#90). The sink travels in each handler context, never
// in module state, so two servers in one process (or a failed startup) can't cross-report.
export function sendLoggedError(
  res: http.ServerResponse,
  status: number,
  code: string,
  publicMessage: string,
  retryable: boolean,
  cause: unknown,
  sink?: LoggedErrorSink,
): void {
  const errorId = randomUUID();
  const detail = cause instanceof Error ? cause.message : String(cause);
  console.error(`[16ane-sandbox] ${code} ${errorId}: ${redactUrls(detail)}`);
  sink?.({ code, errorId, detail });
  sendJson(res, status, {
    error: { code, message: publicMessage, retryable, errorId, disclaimer: SANDBOX_DISCLAIMER },
  });
}

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export class PayloadTooLargeError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`Request body exceeds ${limitBytes} bytes`);
    this.limitBytes = limitBytes;
  }
}

// Rejects with PayloadTooLargeError as soon as the declared or streamed size passes the cap,
// so an unauthenticated client cannot make the server buffer an unbounded body.
export function readRequestBody(
  req: http.IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      reject(new PayloadTooLargeError(maxBytes));
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    const onData = (c: Buffer) => {
      received += c.length;
      if (received > maxBytes) {
        req.off("data", onData);
        chunks.length = 0;
        req.resume();
        reject(new PayloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(c);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// The caller's network address. Client-supplied headers are ignored unless the deployment says which header
// its platform proxy sets (`clientIpHeader`, e.g. "fly-client-ip" on Fly.io, which the proxy itself writes)
// or that it sits behind a trusted reverse proxy, in which case that proxy's (right-most) X-Forwarded-For
// entry is used. A configured header that doesn't hold an IP address is ignored, not used as a quota key.
export function clientIp(
  req: http.IncomingMessage,
  trustProxy: boolean,
  clientIpHeader?: string,
): string {
  if (clientIpHeader) {
    const value = req.headers[clientIpHeader.toLowerCase()];
    const ip = (Array.isArray(value) ? value[0] : value)?.trim();
    if (ip && net.isIP(ip)) return ip;
  }
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const raw = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
    const last = raw?.split(",").map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}
