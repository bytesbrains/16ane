import type { SandboxServerConfig } from "./server.ts";
import {
  makeEnvGetter,
  readHostSetting,
  readIntegerSetting,
  readKeySetting,
  readRegistrySetting,
  readRpcUrlSetting,
  readWeiSetting,
  ServiceConfigError,
} from "./service-shared.ts";

// Server settings from the environment (ADR-0016).
export class ConfigError extends ServiceConfigError {
  constructor(problems: string[]) {
    super("sandbox server", problems);
  }
}

export function parseServerConfig(env: Record<string, string | undefined>): SandboxServerConfig & {
  port: number;
  host: string;
  /** SQLite file for state that must survive restarts (#75); unset means memory only. */
  statePath?: string;
} {
  const problems: string[] = [];
  const get = makeEnvGetter(env);

  const rpcUrl = readRpcUrlSetting(get, problems);
  const registryAddress = readRegistrySetting(get, problems);
  const relayerPrivateKey = readKeySetting(get, problems, "ANE_RELAYER_PRIVATE_KEY", true);
  const providerPrivateKey = readKeySetting(get, problems, "ANE_PROVIDER_PRIVATE_KEY", false);

  const port = readIntegerSetting(get, problems, "ANE_PORT", 8787, 1, 65535);
  const chainId = readIntegerSetting(get, problems, "ANE_CHAIN_ID", 84532, 1, Number.MAX_SAFE_INTEGER);
  const trialFreeCallsPerCaller = readIntegerSetting(get, problems, "ANE_TRIAL_FREE_CALLS_PER_CALLER", 1, 0, 1_000_000);
  const trialGlobalDailyCap = readIntegerSetting(get, problems, "ANE_TRIAL_GLOBAL_DAILY_CAP", 50, 0, 1_000_000_000);
  const trialMaxTokensPerRequest = readIntegerSetting(get, problems, "ANE_TRIAL_MAX_TOKENS_PER_REQUEST", 0, 0, 1_000_000_000);
  const micros = (name: string, fallback: bigint) => {
    const raw = get(name);
    if (raw === undefined) return fallback;
    if (/^\d+$/.test(raw)) return BigInt(raw);
    problems.push(`${name} must be a whole number of USD micros`);
    return fallback;
  };
  const trialCostBudgetMicros = micros("ANE_TRIAL_COST_BUDGET_MICROS", 20_000_000n);
  const trialEstimatedCostMicrosPerCall = micros("ANE_TRIAL_ESTIMATED_COST_MICROS_PER_CALL", 0n);
  const trialOnlyRaw = get("ANE_TRIAL_ONLY_PATHS");
  const trialOnlyPaths = trialOnlyRaw === undefined ? [] : trialOnlyRaw.split(",").map((p) => p.trim()).filter(Boolean);
  if (trialOnlyPaths.some((p) => !p.startsWith("/v1/demo/"))) {
    problems.push("ANE_TRIAL_ONLY_PATHS must be comma-separated /v1/demo/ paths");
  }

  const host = readHostSetting(get);
  const statePath = get("ANE_STATE_PATH");
  const relayerGasBudgetWei = readWeiSetting(get, problems, "ANE_RELAYER_GAS_BUDGET_WEI");
  const relayerMaxFeeWei = readWeiSetting(get, problems, "ANE_RELAYER_MAX_FEE_WEI");
  const trustProxyRaw = get("ANE_TRUST_PROXY") ?? "false";
  const clientIpHeader = get("ANE_CLIENT_IP_HEADER");
  if (clientIpHeader !== undefined && !/^[A-Za-z0-9-]+$/.test(clientIpHeader)) {
    problems.push("ANE_CLIENT_IP_HEADER must be a header name");
  }
  if (!["true", "false"].includes(trustProxyRaw)) problems.push("ANE_TRUST_PROXY must be true or false");
  const openClaimsRaw = get("ANE_FAUCET_OPEN_CLAIMS") ?? "false";
  if (!["true", "false"].includes(openClaimsRaw)) problems.push("ANE_FAUCET_OPEN_CLAIMS must be true or false");
  const turnstileSecretKey = get("ANE_TURNSTILE_SECRET_KEY");
  const turnstileExpectedHostname = get("ANE_TURNSTILE_HOSTNAME");
  if (turnstileExpectedHostname !== undefined && !turnstileSecretKey) {
    problems.push("ANE_TURNSTILE_HOSTNAME needs ANE_TURNSTILE_SECRET_KEY");
  }
  // Optional; an unusable value is ignored at report time with a startup-style warning from the reporter.
  const sentryDsn = get("ANE_SENTRY_DSN");
  if (sentryDsn !== undefined && !/^https?:\/\//.test(sentryDsn)) {
    problems.push("ANE_SENTRY_DSN must be an http(s) Sentry DSN when set");
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return {
    rpcUrl: rpcUrl!,
    registryAddress: registryAddress!,
    relayerPrivateKey: relayerPrivateKey!,
    providerPrivateKey,
    port,
    host,
    statePath,
    relayerGasBudgetWei,
    relayerMaxFeeWei,
    chainId,
    trustProxy: trustProxyRaw === "true",
    clientIpHeader,
    faucetOpenClaims: openClaimsRaw === "true",
    turnstileSecretKey,
    turnstileExpectedHostname,
    trialFreeCallsPerCaller,
    trialGlobalDailyCap,
    trialMaxTokensPerRequest,
    trialCostBudgetMicros,
    trialEstimatedCostMicrosPerCall,
    trialOnlyPaths,
    sentryDsn,
  };
}
