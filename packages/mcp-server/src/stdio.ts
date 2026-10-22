// stdio transport (MCP 2026-07-28): newline-delimited JSON-RPC over the
// subprocess's standard streams. Responses go to stdout; logs go to stderr and
// must never carry secrets. The server MUST NOT write anything else to stdout.

import type { McpProtocolHandler } from "./protocol.ts";

export interface StdioStreams {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

function logLine(stderr: NodeJS.WritableStream, line: string): void {
  stderr.write(`${line}\n`);
}

/**
 * Serves one MCP-over-stdio session until stdin closes. Resolves on clean
 * shutdown (stdin EOF). Malformed lines get no response (their id is unknown)
 * and are reported on stderr only.
 */
export async function runStdio(
  handler: McpProtocolHandler,
  streams: StdioStreams,
): Promise<void> {
  const { stdin, stdout, stderr } = streams;
  const cancelled = new Set<string | number>();
  let buffer = "";

  const onLine = async (line: string): Promise<void> => {
    if (line.trim() === "") {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      logLine(stderr, "16ane-mcp-server: ignoring non-JSON line on stdin");
      return;
    }
    // Best-effort cancellation: drop the response if the client gave up.
    const record = message as { method?: unknown; params?: { requestId?: unknown }; id?: unknown };
    if (
      record.method === "notifications/cancelled" &&
      typeof record.params === "object" &&
      record.params !== null
    ) {
      const target = (record.params as { requestId?: unknown }).requestId;
      if (typeof target === "string" || typeof target === "number") {
        cancelled.add(target);
      }
      return;
    }
    const id = record.id;
    if (typeof id === "string" || typeof id === "number") {
      // A cancel that arrived before its request must skip execution, not just
      // the response: on this ordered channel we know before spending anything.
      if (cancelled.has(id)) {
        cancelled.delete(id);
        return;
      }
    }
    const response = await handler.handleMessage(message);
    if (typeof id === "string" || typeof id === "number") {
      // A cancel that arrived mid-execution still drops the response; work
      // already done (e.g. a sent transaction) cannot be taken back.
      if (cancelled.has(id)) {
        cancelled.delete(id);
        return;
      }
    }
    if (response !== null) {
      stdout.write(`${JSON.stringify(response)}\n`);
    }
  };

  // Lines are processed strictly in order, and shutdown waits for the queue:
  // every response is on stdout before runStdio resolves.
  await new Promise<void>((resolve) => {
    let tail = Promise.resolve();
    stdin.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString("utf8");
      tail = tail
        .then(async () => {
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, "");
            buffer = buffer.slice(newline + 1);
            await onLine(line);
          }
        })
        .catch((err: unknown) => {
          logLine(stderr, `16ane-mcp-server: dispatch error: ${String(err)}`);
        });
    });
    const finish = (): void => {
      void tail.then(() => resolve());
    };
    stdin.on("end", finish);
    stdin.on("close", finish);
  });
}
