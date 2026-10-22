// Streamable HTTP transport (MCP 2026-07-28): every JSON-RPC message is its own
// HTTP POST to a single endpoint. This server always answers with a single
// JSON object (SSE streams are a per-request server choice; notifications and
// subscriptions are not needed for a static tool list).

import http from "node:http";
import { McpProtocolHandler, errorResponse } from "./protocol.ts";

// Application-defined codes (outside the JSON-RPC reserved range, per the MCP
// error-code policy): the HTTP status carries the meaning, the code avoids
// collision with protocol errors.
export const MCP_HTTP_FORBIDDEN = -31001;
export const MCP_HTTP_UNAUTHORIZED = -31002;

export interface StreamableHttpOptions {
  /** MCP endpoint path. Defaults to "/mcp". */
  endpoint?: string;
  /** Origins allowed to call the endpoint; Origin-less callers (curl, CLIs) always pass. */
  allowedOrigins?: string[];
  /** When set, every request must carry `Authorization: Bearer <token>`. */
  authToken?: string;
  /** Max JSON body size in bytes. Defaults to 1 MiB. */
  maxBodyBytes?: number;
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Maps a JSON-RPC error code to the HTTP status the spec pins for it. */
export function httpStatusFor(code: number): number {
  switch (code) {
    case -32700: // Parse error
    case -32600: // Invalid Request
    case -32602: // Invalid params (incl. missing _meta)
    case -32020: // HeaderMismatch
    case -32021: // MissingRequiredClientCapability
    case -32022: // UnsupportedProtocolVersion
      return 400;
    case -32601: // Method not found
      return 404;
    default:
      return 500;
  }
}

/** Mcp-Name may use the Base64 sentinel form `=base64:<b64>` for non-ASCII values. */
function decodeMirroredName(headerValue: string): string | null {
  const match = /^=base64:([A-Za-z0-9+/=]+)$/.exec(headerValue.trim());
  if (!match) {
    // Plain ASCII header value.
    // eslint-disable-next-line no-control-regex
    return /^[\x20-\x7E]*$/.test(headerValue) ? headerValue : null;
  }
  try {
    return Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return null;
  }
}

export function createRequestListener(
  handler: McpProtocolHandler,
  options: StreamableHttpOptions = {},
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const endpoint = options.endpoint ?? "/mcp";
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;

  return (req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== endpoint) {
          sendJson(res, 404, { error: `Not found: ${url.pathname}` });
          return;
        }
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "Method not allowed: use POST" });
          return;
        }
        // DNS-rebinding guard: a present Origin must be allowlisted.
        const origin = req.headers["origin"];
        if (typeof origin === "string" && !(options.allowedOrigins ?? []).includes(origin)) {
          sendJson(res, 403, errorResponse(null, MCP_HTTP_FORBIDDEN, "Forbidden: invalid Origin"));
          return;
        }
        if (options.authToken !== undefined) {
          const auth = req.headers["authorization"];
          if (auth !== `Bearer ${options.authToken}`) {
            sendJson(res, 401, errorResponse(null, MCP_HTTP_UNAUTHORIZED, "Unauthorized: bad or missing bearer token"));
            return;
          }
        }
        const contentType = req.headers["content-type"] ?? "";
        if (!contentType.includes("application/json")) {
          sendJson(res, 400, errorResponse(null, -32600, "Invalid Request: content-type must be application/json"));
          return;
        }
        let raw: string;
        try {
          raw = await readBody(req, maxBodyBytes);
        } catch {
          sendJson(res, 413, errorResponse(null, -32600, "Invalid Request: body too large"));
          return;
        }
        let message: unknown;
        try {
          message = JSON.parse(raw);
        } catch {
          sendJson(res, 400, errorResponse(null, -32700, "Parse error: body is not valid JSON"));
          return;
        }
        // Header/body mirror validation (body is the source of truth).
        const record = message as { method?: unknown; params?: { name?: unknown; uri?: unknown } };
        const protocolHeader = req.headers["mcp-protocol-version"];
        const methodHeader = req.headers["mcp-method"];
        if (typeof protocolHeader !== "string" || typeof methodHeader !== "string") {
          sendJson(
            res,
            400,
            errorResponse(null, -32020, "Header mismatch: MCP-Protocol-Version and Mcp-Method are required"),
          );
          return;
        }
        if (typeof record.method !== "string" || methodHeader !== record.method) {
          sendJson(
            res,
            400,
            errorResponse(null, -32020, "Header mismatch: Mcp-Method does not match the body method"),
          );
          return;
        }
        if (record.method === "tools/call") {
          const nameHeader = req.headers["mcp-name"];
          const bodyName = record.params?.name;
          if (typeof nameHeader !== "string" || typeof bodyName !== "string") {
            sendJson(
              res,
              400,
              errorResponse(null, -32020, "Header mismatch: Mcp-Name is required for tools/call"),
            );
            return;
          }
          const decoded = decodeMirroredName(nameHeader);
          if (decoded === null || decoded !== bodyName) {
            sendJson(
              res,
              400,
              errorResponse(null, -32020, "Header mismatch: Mcp-Name does not match params.name"),
            );
            return;
          }
        }
        // The version header must match the body's _meta protocolVersion.
        const meta = (
          record.params && typeof record.params === "object"
            ? (record.params as { _meta?: unknown })._meta
            : undefined
        ) as Record<string, unknown> | undefined;
        const bodyVersion = meta?.["io.modelcontextprotocol/protocolVersion"];
        // A missing body version is a malformed request (-32602 from the protocol
        // handler), not a header mismatch; a present-but-different version is a
        // header failure, and an unknown-but-consistent one is the protocol
        // handler's UnsupportedProtocolVersion.
        if (bodyVersion !== undefined && bodyVersion !== protocolHeader) {
          sendJson(
            res,
            400,
            errorResponse(
              null,
              -32020,
              "Header mismatch: MCP-Protocol-Version does not match the body's protocolVersion",
            ),
          );
          return;
        }
        const response = await handler.handleMessage(message);
        if (response === null) {
          // JSON-RPC notification accepted.
          res.writeHead(202);
          res.end();
          return;
        }
        if (response.error) {
          sendJson(res, httpStatusFor(response.error.code), response);
          return;
        }
        sendJson(res, 200, response);
      } catch (err) {
        sendJson(
          res,
          500,
          errorResponse(null, -32603, `Internal error: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    })();
  };
}

export function createStreamableHttpServer(
  handler: McpProtocolHandler,
  options: StreamableHttpOptions = {},
): http.Server {
  return http.createServer(createRequestListener(handler, options));
}
