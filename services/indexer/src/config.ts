import type { IndexerServerConfig } from "./server.ts";

// Standalone service-directory indexer settings from the environment (#18). Every problem is collected
// and reported together. Read-only: the indexer needs no private keys at all.
export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid indexer configuration:\n- ${problems.join("\n- ")}`);
    this.problems = problems;
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function parseIndexerConfig(env: Record<string, string | undefined>): IndexerServerConfig & {
  port: number;
  host: string;
  /** SQLite file for the anchor set and scan cursor (#75); unset means memory only. */
  statePath?: string;
} {
  const problems: string[] = [];
  const get = (name: string) => env[name]?.trim() || undefined;

  const rpcUrl = get("ANE_RPC_URL");
  if (!rpcUrl) problems.push("ANE_RPC_URL is required");
  else if (!/^https?:\/\//.test(rpcUrl)) problems.push("ANE_RPC_URL must be an http(s) URL");

  const registryAddress = get("ANE_REGISTRY_ADDRESS");
  if (!registryAddress) problems.push("ANE_REGISTRY_ADDRESS is required");
  else if (!ADDRESS.test(registryAddress)) problems.push("ANE_REGISTRY_ADDRESS must be a 0x-prefixed 20-byte address");

  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = get(name);
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be an integer from ${min} to ${max}`);
      return fallback;
    }
    return n;
  };
  const port = integer("ANE_PORT", 8789, 1, 65535);
  const chainId = integer("ANE_CHAIN_ID", 84532, 1, Number.MAX_SAFE_INTEGER);
  const pollMs = integer("ANE_INDEX_POLL_MS", 5000, 1000, 3600_000);
  const maxRange = integer("ANE_INDEX_MAX_RANGE", 2000, 1, 100_000);

  const fromRaw = get("ANE_INDEX_FROM_BLOCK") ?? "latest";
  let fromBlock: number | "latest" | "earliest" = "latest";
  if (fromRaw === "latest" || fromRaw === "earliest") fromBlock = fromRaw;
  else if (/^\d+$/.test(fromRaw)) fromBlock = Number(fromRaw);
  else problems.push("ANE_INDEX_FROM_BLOCK must be a block number, 'latest' or 'earliest'");

  const host = get("ANE_HOST") ?? "127.0.0.1";
  const statePath = get("ANE_STATE_PATH");

  if (problems.length > 0) throw new ConfigError(problems);
  return { rpcUrl: rpcUrl!, registryAddress: registryAddress!, port, host, statePath, chainId, pollMs, maxRange, fromBlock };
}
