// 16ane MCP server entry point: stdio (for Claude/Cursor local configs) or
// Streamable HTTP (remote `POST /mcp`). Usage:
//   node --experimental-strip-types src/main.ts [--transport stdio|http] [--help]
// Configuration comes from ANE_* environment variables; see README.md.

import { McpProtocolHandler, SERVER_NAME, SERVER_VERSION } from "./protocol.ts";
import { SixteenAneAdapter } from "./tools.ts";
import { runStdio } from "./stdio.ts";
import { createStreamableHttpServer } from "./http.ts";
import { loadConfig, verifyDelegation, wireLiveBackend } from "./config.ts";

function usage(): string {
  return [
    `${SERVER_NAME} v${SERVER_VERSION} — 16ane sandbox wallet adapter (MCP 2026-07-28)`,
    "",
    "Usage: node --experimental-strip-types src/main.ts [--transport stdio|http]",
    "",
    "Required environment:",
    "  ANE_RPC_URL              Chain JSON-RPC endpoint",
    "  ANE_CHAIN_ID             84532 (Base Sepolia) or 31337 (local Anvil)",
    "  ANE_VAULT_ADDRESS        The delegated agent vault",
    "  ANE_AGENT_PRIVATE_KEY    The delegated agentSigner key (never an owner key)",
    "  ANE_REGISTRY_ADDRESS     or the four ANE_*_ADDRESS contract addresses",
    "",
    "Optional:",
    "  ANE_API_BASE_URL         Sandbox REST API (service listing, publishing, receipts)",
    "  ANE_MCP_MAX_PAYMENT      Server-side per-call purchase ceiling (base units)",
    "  ANE_MCP_TRANSPORT        stdio (default) or http (overridden by --transport)",
    "  ANE_MCP_HOST             HTTP bind address (default 127.0.0.1)",
    "  ANE_MCP_PORT             HTTP port (default 8786)",
    "  ANE_MCP_ENDPOINT         HTTP endpoint path (default /mcp)",
    "  ANE_MCP_ALLOWED_ORIGINS  Comma-separated allowed Origin values (HTTP)",
    "  ANE_MCP_AUTH_TOKEN       Required Bearer token for HTTP (strongly recommended remotely)",
  ].join("\n");
}

async function main(argv: string[]): Promise<number> {
  let transportOverride: "stdio" | "http" | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (arg === "--version" || arg === "-v") {
      process.stdout.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);
      return 0;
    }
    if (arg === "--transport") {
      const value = argv[i + 1];
      if (value !== "stdio" && value !== "http") {
        process.stderr.write("--transport must be 'stdio' or 'http'\n");
        return 2;
      }
      transportOverride = value;
      i++;
      continue;
    }
    process.stderr.write(`Unknown argument: ${arg}\n${usage()}\n`);
    return 2;
  }

  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    process.stderr.write(`Configuration error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const transport = transportOverride ?? config.transport;

  let wiring;
  try {
    wiring = await wireLiveBackend(config);
    await verifyDelegation(wiring.client, config);
  } catch (err) {
    process.stderr.write(`Startup check failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const handler = new McpProtocolHandler(new SixteenAneAdapter(wiring.backend));
  if (transport === "stdio") {
    await runStdio(handler, {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    });
    return 0;
  }

  const server = createStreamableHttpServer(handler, {
    endpoint: config.httpEndpoint,
    allowedOrigins: config.allowedOrigins,
    authToken: config.authToken,
  });
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(config.httpPort, config.httpHost, () => {
      process.stderr.write(
        `${SERVER_NAME} listening on http://${config.httpHost}:${config.httpPort}${config.httpEndpoint}\n`,
      );
      resolve();
    });
  });
  const shutdown = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise<void>(() => {});
  return 0;
}

const code = await main(process.argv.slice(2));
process.exit(code);
