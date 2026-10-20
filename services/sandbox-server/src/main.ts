// Starts the reference sandbox server from environment variables (ADR-0016). Used by the Docker image and
// for self-hosting (#18):
//   ANE_RPC_URL=... ANE_REGISTRY_ADDRESS=0x... ANE_RELAYER_PRIVATE_KEY=0x... \
//     node --experimental-strip-types services/sandbox-server/src/main.ts
// Optional: ANE_PROVIDER_PRIVATE_KEY, ANE_HOST (default 127.0.0.1; 0.0.0.0 in containers), ANE_PORT (8787),
// ANE_CHAIN_ID (84532), ANE_TRUST_PROXY (false), ANE_TRIAL_FREE_CALLS_PER_CALLER, ANE_TRIAL_GLOBAL_DAILY_CAP.
import { ConfigError, parseServerConfig } from "./config.ts";
import { createSandboxServer } from "./server.ts";

async function main(): Promise<void> {
  let config;
  try {
    config = parseServerConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }

  const sandbox = await createSandboxServer(config);
  // Public facts only: never the keys.
  console.log(
    `[16ane-sandbox] listening on ${config.host}:${sandbox.port}, chain ${config.chainId}, ` +
      `registry ${config.registryAddress}, provider ${sandbox.providerAddress}`,
  );

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[16ane-sandbox] ${signal} received, closing`);
    sandbox.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((err) => {
  // Startup failures (e.g. an unreachable RPC) - the message never contains key values (ADR-0010).
  console.error(`[16ane-sandbox] failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
