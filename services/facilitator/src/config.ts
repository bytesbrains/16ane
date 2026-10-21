import {
  makeEnvGetter,
  readHostSetting,
  readIntegerSetting,
  readKeySetting,
  readRegistrySetting,
  readRpcUrlSetting,
  readWeiSetting,
  ServiceConfigError,
} from "../../sandbox-server/src/service-shared.ts";
import type { FacilitatorServerConfig } from "./server.ts";

// Standalone x402 facilitator settings from the environment (#18).
export class ConfigError extends ServiceConfigError {
  constructor(problems: string[]) {
    super("facilitator", problems);
  }
}

export function parseFacilitatorConfig(env: Record<string, string | undefined>): FacilitatorServerConfig & {
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
  const port = readIntegerSetting(get, problems, "ANE_PORT", 8788, 1, 65535);
  const chainId = readIntegerSetting(get, problems, "ANE_CHAIN_ID", 84532, 1, Number.MAX_SAFE_INTEGER);
  const host = readHostSetting(get);
  const statePath = get("ANE_STATE_PATH");
  const relayerGasBudgetWei = readWeiSetting(get, problems, "ANE_RELAYER_GAS_BUDGET_WEI");
  const relayerMaxFeeWei = readWeiSetting(get, problems, "ANE_RELAYER_MAX_FEE_WEI");

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
