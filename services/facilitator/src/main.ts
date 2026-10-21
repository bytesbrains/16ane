// Starts the standalone x402 facilitator from environment variables (#18). Used by the Docker image and
// for self-hosting:
//   ANE_RPC_URL=... ANE_REGISTRY_ADDRESS=0x... ANE_RELAYER_PRIVATE_KEY=0x... \
//     node --experimental-strip-types services/facilitator/src/main.ts
// Optional: ANE_HOST (default 127.0.0.1; 0.0.0.0 in containers), ANE_PORT (8788), ANE_CHAIN_ID (84532),
// ANE_RELAYER_MAX_FEE_WEI, ANE_RELAYER_GAS_BUDGET_WEI, ANE_STATE_PATH (SQLite file; without it consumed
// proofs and receipts are in memory and a restart would let a used proof settle again).
import { ConfigError, parseFacilitatorConfig } from "./config.ts";
import { createFacilitatorServer } from "./server.ts";
import { SqliteKeyValueStore } from "../../sandbox-server/src/sqlite-store.ts";

async function main(): Promise<void> {
  let config;
  try {
    config = parseFacilitatorConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }

  // Without ANE_STATE_PATH, consumed payment proofs are lost on every restart and a settled proof
  // could settle again; a public instance must set it (#75).
  const store = config.statePath ? new SqliteKeyValueStore(config.statePath) : undefined;
  if (!store) console.warn("[16ane-facilitator] ANE_STATE_PATH is not set: state is kept in memory only");
  const facilitator = await createFacilitatorServer({ ...config, store });
  // Public facts only: never the keys.
  console.log(
    `[16ane-facilitator] listening on ${config.host}:${facilitator.port}, chain ${config.chainId}, ` +
      `registry ${config.registryAddress}, relayer ${facilitator.relayerAddress}`,
  );

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[16ane-facilitator] ${signal} received, closing`);
    facilitator.close().then(
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
  console.error(`[16ane-facilitator] failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
