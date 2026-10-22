import {
  makeEnvGetter,
  readHostSetting,
  readIntegerSetting,
  readRegistrySetting,
  readRpcUrlSetting,
  ServiceConfigError,
} from "../../sandbox-server/src/service-shared.ts";
import type { IndexerServerConfig } from "./server.ts";

// Standalone service-directory indexer settings from the environment (#18). Read-only: no keys.
export class ConfigError extends ServiceConfigError {
  constructor(problems: string[]) {
    super("indexer", problems);
  }
}

export function parseIndexerConfig(env: Record<string, string | undefined>): IndexerServerConfig & {
  port: number;
  host: string;
  /** SQLite file for the anchor set and scan cursor (#75); unset means memory only. */
  statePath?: string;
} {
  const problems: string[] = [];
  const get = makeEnvGetter(env);

  const rpcUrl = readRpcUrlSetting(get, problems);
  const registryAddress = readRegistrySetting(get, problems);
  const port = readIntegerSetting(get, problems, "ANE_PORT", 8789, 1, 65535);
  const chainId = readIntegerSetting(get, problems, "ANE_CHAIN_ID", 84532, 1, Number.MAX_SAFE_INTEGER);
  const pollMs = readIntegerSetting(get, problems, "ANE_INDEX_POLL_MS", 5000, 1000, 3600_000);
  const maxRange = readIntegerSetting(get, problems, "ANE_INDEX_MAX_RANGE", 2000, 1, 100_000);

  const fromRaw = get("ANE_INDEX_FROM_BLOCK") ?? "latest";
  let fromBlock: number | "latest" | "earliest" = "latest";
  if (fromRaw === "latest" || fromRaw === "earliest") fromBlock = fromRaw;
  else if (/^\d+$/.test(fromRaw) && Number.isSafeInteger(Number(fromRaw))) fromBlock = Number(fromRaw);
  else problems.push("ANE_INDEX_FROM_BLOCK must be a block number, 'latest' or 'earliest'");

  const host = readHostSetting(get);
  const statePath = get("ANE_STATE_PATH");

  if (problems.length > 0) throw new ConfigError(problems);
  return { rpcUrl: rpcUrl!, registryAddress: registryAddress!, port, host, statePath, chainId, pollMs, maxRange, fromBlock };
}
