// Dashboard E2E stack: boots Anvil, deploys the sandbox contracts, starts the
// sandbox server, builds the dashboard against them, and serves it under the
// generated headers. Shared by the Playwright specs (via fixtures.ts) and the
// Tier-2 runner (tier2-run.ts, plain Node) — so every import here uses an
// explicit .ts extension, which both loaders resolve.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OWNER_KEY,
  PROVIDER_KEY,
  startSandboxStack,
  type SandboxStack,
} from "../../../e2e/harness.ts";
import { privateKeyToAddress, SecretKey } from "../../../packages/sdk-ts/src/index.ts";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
};

// Parses the `/*` rule of a generated _headers file into response headers.
export function headersFor(rootDir: string): Record<string, string> {
  const lines = readFileSync(path.join(rootDir, "_headers"), "utf8").split("\n");
  const headers: Record<string, string> = {};
  let inRoot = false;
  for (const line of lines) {
    if (line.trim() === "/*") {
      inRoot = true;
      continue;
    }
    if (inRoot) {
      if (!/^\s+\S/.test(line)) break;
      const at = line.indexOf(":");
      headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
  }
  return headers;
}

export async function serveDirectory(rootDir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const headers = headersFor(rootDir);
  const server: Server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
      if (rel.includes("..")) {
        res.writeHead(400);
        res.end("bad path");
        return;
      }
      let file = path.join(rootDir, rel);
      if (!file.startsWith(rootDir)) {
        res.writeHead(400);
        res.end("bad path");
        return;
      }
      let body: Buffer;
      try {
        body = readFileSync(file);
      } catch {
        res.writeHead(404, { ...headers, "content-type": "text/html; charset=utf-8" });
        try {
          res.end(readFileSync(path.join(rootDir, "404.html")));
        } catch {
          res.end("not found");
        }
        return;
      }
      res.writeHead(200, {
        ...headers,
        "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
      });
      res.end(body);
    } catch {
      res.writeHead(500);
      res.end("error");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

export interface DashboardStack {
  stack: SandboxStack;
  /** Served dashboard build URL (generated network file + API URL baked in). */
  url: string;
  owner: string;
  provider: string;
  close: () => Promise<void>;
}

// Boots Anvil on `chainId`, deploys the sandbox contracts, starts the sandbox
// server, builds the dashboard against them, and serves it under the generated
// headers. Tier-1 passes 84532 and impersonates the stub accounts afterwards
// (Anvil signs for them); Tier-2 passes 31337 with no impersonation so a real
// MetaMask can add the test chain without colliding with built-in Base Sepolia.
export async function startDashboardStack(opts: {
  chainId: number;
  chainName: string;
}): Promise<DashboardStack> {
  const teardowns: (() => Promise<void>)[] = [];
  // The e2e harness only uses t.after: feed it a shim and run teardowns here.
  const stack = await startSandboxStack(
    { after: (fn: () => Promise<void>) => void teardowns.push(fn) } as never,
    { chainId: opts.chainId },
  );
  const owner = privateKeyToAddress(new SecretKey(OWNER_KEY));
  const provider = privateKeyToAddress(new SecretKey(PROVIDER_KEY));
  const dir = mkdtempSync(path.join(tmpdir(), "dashboard-e2e-"));
  const networkFile = path.join(dir, "networks-local.json");
  writeFileSync(
    networkFile,
    JSON.stringify({
      name: "local",
      environment: "sandbox",
      chainId: opts.chainId,
      caip2: `eip155:${opts.chainId}`,
      chainName: opts.chainName,
      rpcUrl: stack.rpcUrl,
      explorer: null,
      explorerName: null,
      registryAddress: stack.registryAddress,
      contracts: stack.contracts,
      assetSymbol: "tANE",
      assetDecimals: 18,
    }),
  );
  const outDir = path.join(dir, "site");
  execFileSync(process.execPath, [
    path.join(REPO_ROOT, "scripts", "dashboard-env.cjs"),
    "--network-file",
    networkFile,
    outDir,
    "--api-url",
    stack.sandbox.url,
  ]);
  const served = await serveDirectory(outDir);
  teardowns.push(served.close);
  return {
    stack,
    url: served.url,
    owner,
    provider,
    close: async () => {
      for (const fn of teardowns.splice(0).reverse()) await fn();
    },
  };
}
