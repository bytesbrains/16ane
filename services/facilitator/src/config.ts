import type { FacilitatorServerConfig } from "./server.ts";

// Standalone x402 facilitator settings from the environment (#18). Every problem is collected and
// reported together, and no error ever contains a key's value. Mirrors the sandbox server's config.
export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid facilitator configuration:\n- ${problems.join("\n- ")}`);
    this.problems = problems;
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

export function parseFacilitatorConfig(env: Record<string, string | undefined>): FacilitatorServerConfig & {
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

  const relayerPrivateKey = get("ANE_RELAYER_PRIVATE_KEY");
  if (!relayerPrivateKey) problems.push("ANE_RELAYER_PRIVATE_KEY is required");
  else if (!PRIVATE_KEY.test(relayerPrivateKey)) problems.push("ANE_RELAYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");

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
  const port = integer("ANE_PORT", 8788, 1, 65535);
  const chainId = integer("ANE_CHAIN_ID", 84532, 1, Number.MAX_SAFE_INTEGER);

  const host = get("ANE_HOST") ?? "127.0.0.1";
  const statePath = get("ANE_STATE_PATH");
  const budgetRaw = get("ANE_RELAYER_GAS_BUDGET_WEI");
  let relayerGasBudgetWei: bigint | undefined;
  if (budgetRaw !== undefined) {
    if (/^\d+$/.test(budgetRaw)) relayerGasBudgetWei = BigInt(budgetRaw);
    else problems.push("ANE_RELAYER_GAS_BUDGET_WEI must be a whole number of wei");
  }
  const maxFeeRaw = get("ANE_RELAYER_MAX_FEE_WEI");
  let relayerMaxFeeWei: bigint | undefined;
  if (maxFeeRaw !== undefined) {
    if (/^\d+$/.test(maxFeeRaw)) relayerMaxFeeWei = BigInt(maxFeeRaw);
    else problems.push("ANE_RELAYER_MAX_FEE_WEI must be a whole number of wei");
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return {
    rpcUrl: rpcUrl!,
    registryAddress: registryAddress!,
    relayerPrivateKey: relayerPrivateKey!,
    port,
    host,
    statePath,
    relayerGasBudgetWei,
    relayerMaxFeeWei,
    chainId,
  };
}
