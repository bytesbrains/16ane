// Runtime shared by the self-hostable services (sandbox, facilitator, indexer): environment parsing,
// startup/shutdown, relayer client wiring, health shaping and error mapping. One home so the three
// servers cannot drift — a fix here (gas policy, error codes, config messages) reaches all of them.
// The sandbox server's directory hosts it because the other shared server modules (http, gas-budget,
// sqlite-store) already live here and the standalone services import them.
import type http from "node:http";
import {
  AneClient,
  privateKeyToAddress,
  SecretKey,
  type KeyValueStore,
} from "../../../packages/sdk-ts/src/index.ts";
import {
  DEFAULT_RELAYER_GAS_BUDGET_WEI,
  RelayerGasBudget,
  RelayerGasBudgetExceededError,
  sendBudgetExhausted,
  type GasReservation,
} from "./gas-budget.ts";
import { PayloadTooLargeError, sendError, sendLoggedError, type LoggedErrorSink } from "./http.ts";

// ---- environment parsing ------------------------------------------------------------------------
// Every problem is collected and reported together, and no error ever contains a key's value.

export class ServiceConfigError extends Error {
  readonly problems: string[];

  constructor(serviceLabel: string, problems: string[]) {
    super(`Invalid ${serviceLabel} configuration:\n- ${problems.join("\n- ")}`);
    this.problems = problems;
  }
}

export type EnvGetter = (name: string) => string | undefined;

export const makeEnvGetter =
  (env: Record<string, string | undefined>): EnvGetter =>
  (name: string) =>
    env[name]?.trim() || undefined;

export const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
export const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export function readRpcUrlSetting(get: EnvGetter, problems: string[]): string | undefined {
  const rpcUrl = get("ANE_RPC_URL");
  if (!rpcUrl) problems.push("ANE_RPC_URL is required");
  else if (!/^https?:\/\//.test(rpcUrl)) problems.push("ANE_RPC_URL must be an http(s) URL");
  return rpcUrl;
}

export function readRegistrySetting(get: EnvGetter, problems: string[]): string | undefined {
  const registryAddress = get("ANE_REGISTRY_ADDRESS");
  if (!registryAddress) problems.push("ANE_REGISTRY_ADDRESS is required");
  else if (!ADDRESS_PATTERN.test(registryAddress)) {
    problems.push("ANE_REGISTRY_ADDRESS must be a 0x-prefixed 20-byte address");
  }
  return registryAddress;
}

export function readKeySetting(
  get: EnvGetter,
  problems: string[],
  name: string,
  required: boolean,
): string | undefined {
  const value = get(name);
  if (!value) {
    if (required) problems.push(`${name} is required`);
    return undefined;
  }
  if (!PRIVATE_KEY_PATTERN.test(value)) problems.push(`${name} must be a 0x-prefixed 32-byte hex key`);
  return value;
}

export function readIntegerSetting(
  get: EnvGetter,
  problems: string[],
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = get(name);
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be an integer from ${min} to ${max}`);
    return fallback;
  }
  return n;
}

export function readWeiSetting(get: EnvGetter, problems: string[], name: string): bigint | undefined {
  const raw = get(name);
  if (raw === undefined) return undefined;
  if (/^\d+$/.test(raw)) return BigInt(raw);
  problems.push(`${name} must be a whole number of wei`);
  return undefined;
}

export function readHostSetting(get: EnvGetter): string {
  return get("ANE_HOST") ?? "127.0.0.1";
}

// ---- startup and shutdown ------------------------------------------------------------------------

/** SIGTERM/SIGINT close the server once, then exit 0 on a clean close and 1 otherwise. */
export function handleShutdownSignals(label: string, close: () => Promise<void>): void {
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[${label}] ${signal} received, closing`);
    close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

/** Startup failures (e.g. an unreachable RPC) - the message never contains key values (ADR-0010). */
export function reportMainFailure(label: string, err: unknown): never {
  console.error(`[${label}] failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// ---- relayer client wiring -----------------------------------------------------------------------

/**
 * A chain client whose relayer sends reserve gas from the daily budget before they go out and are
 * counted at their actual fee once mined. The only limit on the relayer path is cost (#61).
 */
export function createRelayerClient(opts: {
  rpcUrl: string;
  chainId: number;
  registryAddress: string;
  relayerPrivateKey: string | SecretKey;
  store: KeyValueStore;
  relayerGasBudgetWei?: bigint;
}): { client: AneClient; gasBudget: RelayerGasBudget; relayerKey: SecretKey; relayerAddress: string } {
  const relayerKey =
    opts.relayerPrivateKey instanceof SecretKey ? opts.relayerPrivateKey : new SecretKey(opts.relayerPrivateKey);
  const relayerAddress = privateKeyToAddress(relayerKey);
  const gasBudget = new RelayerGasBudget(opts.store, opts.relayerGasBudgetWei ?? DEFAULT_RELAYER_GAS_BUDGET_WEI);
  const client = new AneClient({
    rpcUrl: opts.rpcUrl,
    chainId: opts.chainId,
    registryAddress: opts.registryAddress,
    sendHooks: {
      before: (from) => (from === relayerAddress ? gasBudget.reserve() : undefined),
      after: (_from, feeWei, _txHash, ticket) => {
        if (ticket) gasBudget.settle(ticket as GasReservation, feeWei);
      },
      failed: (_from, ticket) => {
        if (ticket) gasBudget.release(ticket as GasReservation);
      },
    },
  });
  return { client, gasBudget, relayerKey, relayerAddress };
}

/** The chain head plus the relayer's balance and budget numbers that every /healthz reports. */
export async function fetchRelayerHealth(
  client: AneClient,
  gasBudget: RelayerGasBudget,
  relayerAddress: string,
): Promise<{
  blockNumber: number;
  relayer: {
    address: string;
    balanceWei: string;
    dailyGasBudgetWei: string;
    spentTodayWei: string;
    reservedTodayWei: string;
    remainingTodayWei: string;
    lowBalance: boolean;
  };
}> {
  const blockHex = await client.rpcCall<string>("eth_blockNumber", []);
  const balanceWei = BigInt(await client.rpcCall<string>("eth_getBalance", [relayerAddress, "latest"]));
  return {
    blockNumber: Number(BigInt(blockHex)),
    relayer: {
      address: relayerAddress,
      balanceWei: balanceWei.toString(),
      dailyGasBudgetWei: gasBudget.dailyBudgetWei.toString(),
      spentTodayWei: gasBudget.spentTodayWei().toString(),
      reservedTodayWei: gasBudget.reservedTodayWei().toString(),
      remainingTodayWei: gasBudget.remainingTodayWei().toString(),
      lowBalance: gasBudget.isLowBalance(balanceWei),
    },
  };
}

// ---- error mapping -------------------------------------------------------------------------------

/** The top-level catch every server funnels through: oversized and malformed input, gas policy, else 500. */
export function sendServerError(
  res: http.ServerResponse,
  err: unknown,
  selfServeHint: string,
  sink?: LoggedErrorSink,
): void {
  if (err instanceof PayloadTooLargeError) {
    res.setHeader("connection", "close");
    sendError(res, 413, "ANE-E-4130", err.message, false);
    return;
  }
  if (err instanceof RelayerGasBudgetExceededError) {
    sendBudgetExhausted(res, err, selfServeHint);
    return;
  }
  // JSON.parse and BigInt throw SyntaxError on malformed client input; their messages only echo that input.
  if (err instanceof SyntaxError) {
    sendError(res, 400, "ANE-E-4000", `Malformed request body: ${err.message}`, false);
    return;
  }
  sendLoggedError(res, 500, "ANE-E-5000", "Internal server error", true, err, sink);
}
