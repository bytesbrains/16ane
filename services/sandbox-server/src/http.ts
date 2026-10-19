import http from "node:http";
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

export function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
