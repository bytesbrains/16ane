import type { SandboxServerConfig } from "./server.ts";

// Server settings from the environment (ADR-0016). Every problem is collected and reported together, and no
// error ever contains a key's value.
export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid sandbox server configuration:\n- ${problems.join("\n- ")}`);
    this.problems = problems;
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

export function parseServerConfig(env: Record<string, string | undefined>): SandboxServerConfig & {
  port: number;
  host: string;
  /** SQLite file for state that must survive restarts (#75); unset means memory only. */
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

  const key = (name: string, required: boolean) => {
    const value = get(name);
    if (!value) {
      if (required) problems.push(`${name} is required`);
      return undefined;
    }
    if (!PRIVATE_KEY.test(value)) problems.push(`${name} must be a 0x-prefixed 32-byte hex key`);
    return value;
  };
  const relayerPrivateKey = key("ANE_RELAYER_PRIVATE_KEY", true);
  const providerPrivateKey = key("ANE_PROVIDER_PRIVATE_KEY", false);

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
  const port = integer("ANE_PORT", 8787, 1, 65535);
  const chainId = integer("ANE_CHAIN_ID", 84532, 1, Number.MAX_SAFE_INTEGER);
  const trialFreeCallsPerCaller = integer("ANE_TRIAL_FREE_CALLS_PER_CALLER", 1, 0, 1_000_000);
  const trialGlobalDailyCap = integer("ANE_TRIAL_GLOBAL_DAILY_CAP", 50, 0, 1_000_000_000);

  const host = get("ANE_HOST") ?? "127.0.0.1";
  const statePath = get("ANE_STATE_PATH");
  const trustProxyRaw = get("ANE_TRUST_PROXY") ?? "false";
  if (!["true", "false"].includes(trustProxyRaw)) problems.push("ANE_TRUST_PROXY must be true or false");

  if (problems.length > 0) throw new ConfigError(problems);
  return {
    rpcUrl: rpcUrl!,
    registryAddress: registryAddress!,
    relayerPrivateKey: relayerPrivateKey!,
    providerPrivateKey,
    port,
    host,
    statePath,
    chainId,
    trustProxy: trustProxyRaw === "true",
    trialFreeCallsPerCaller,
    trialGlobalDailyCap,
  };
}
