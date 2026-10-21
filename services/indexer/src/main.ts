// Starts the standalone service-directory indexer from environment variables (#18). Used by the Docker
// image and for self-hosting:
//   ANE_RPC_URL=... ANE_REGISTRY_ADDRESS=0x... \
//     node --experimental-strip-types services/indexer/src/main.ts
// Optional: ANE_HOST (default 127.0.0.1; 0.0.0.0 in containers), ANE_PORT (8789), ANE_CHAIN_ID (84532),
// ANE_INDEX_FROM_BLOCK (block number, "latest" or "earliest"; default "latest"), ANE_INDEX_POLL_MS (5000),
// ANE_INDEX_MAX_RANGE (2000), ANE_STATE_PATH (SQLite file; without it the anchor set and scan cursor
// are in memory and a restart rescans from ANE_INDEX_FROM_BLOCK).
import { ConfigError, parseIndexerConfig } from "./config.ts";
import { createIndexerServer } from "./server.ts";
import { handleShutdownSignals, reportMainFailure } from "../../sandbox-server/src/service-shared.ts";
import { SqliteKeyValueStore } from "../../sandbox-server/src/sqlite-store.ts";

async function main(): Promise<void> {
  let config;
  try {
    config = parseIndexerConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }

  const store = config.statePath ? new SqliteKeyValueStore(config.statePath) : undefined;
  if (!store) console.warn("[16ane-indexer] ANE_STATE_PATH is not set: state is kept in memory only");
  const indexer = await createIndexerServer({ ...config, store });
  console.log(
    `[16ane-indexer] listening on ${config.host}:${indexer.port}, chain ${config.chainId}, ` +
      `registry ${config.registryAddress}`,
  );

  handleShutdownSignals("16ane-indexer", async () => {
    await indexer.close();
    store?.close();
  });
}

main().catch((err) => reportMainFailure("16ane-indexer", err));
