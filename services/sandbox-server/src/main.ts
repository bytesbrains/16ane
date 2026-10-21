// Starts the reference sandbox server from environment variables (ADR-0016). Used by the Docker image and
// for self-hosting (#18):
//   ANE_RPC_URL=... ANE_REGISTRY_ADDRESS=0x... ANE_RELAYER_PRIVATE_KEY=0x... \
//     node --experimental-strip-types services/sandbox-server/src/main.ts
// Optional: ANE_PROVIDER_PRIVATE_KEY, ANE_HOST (default 127.0.0.1; 0.0.0.0 in containers), ANE_PORT (8787),
// ANE_CHAIN_ID (84532), ANE_TRUST_PROXY (false), ANE_TRIAL_FREE_CALLS_PER_CALLER, ANE_TRIAL_GLOBAL_DAILY_CAP,
// ANE_TRIAL_COST_BUDGET_MICROS, ANE_TRIAL_ESTIMATED_COST_MICROS_PER_CALL, ANE_TRIAL_MAX_TOKENS_PER_REQUEST,
// ANE_TRIAL_ONLY_PATHS, ANE_STATE_PATH (SQLite file; without it state is in memory and lost on restart).
import { ConfigError, parseServerConfig } from "./config.ts";
import { createSandboxServer } from "./server.ts";
import { SqliteKeyValueStore } from "./sqlite-store.ts";

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

  // Without ANE_STATE_PATH, cooldowns, claims, quotas and x402 idempotency records and consumed proofs are lost
  // on every restart; a hosted instance must set it (ADR-0016, #75).
  const store = config.statePath ? new SqliteKeyValueStore(config.statePath) : undefined;
  if (!store) console.warn("[16ane-sandbox] ANE_STATE_PATH is not set: state is kept in memory only");
  const sandbox = await createSandboxServer({ ...config, store });
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
      () => {
        store?.close();
        process.exit(0);
      },
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
