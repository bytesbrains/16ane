import type http from "node:http";
import type { KeyValueStore } from "../../../packages/sdk-ts/src/index.ts";
import { sendError } from "./http.ts";

/** ADR-0006's starting budget: 0.05 Base Sepolia ETH per UTC day. */
export const DEFAULT_RELAYER_GAS_BUDGET_WEI = 50_000_000_000_000_000n;

// The relayer's daily gas budget (ADR-0006 as amended by #61; #76). The only limit on what the operator pays:
// once a UTC day's spend reaches the budget, the server stops sponsoring gas and points callers at
// paying their own. No per-agent or per-wallet counts. Spend is kept in the store, so it survives restarts.
export class RelayerGasBudgetExceededError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Today's relayer gas budget is used up");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const utcDay = (nowMs: number) => new Date(nowMs).toISOString().slice(0, 10);

export class RelayerGasBudget {
  readonly dailyBudgetWei: bigint;
  readonly #store: KeyValueStore;
  readonly #now: () => number;

  constructor(store: KeyValueStore, dailyBudgetWei: bigint, now: () => number = Date.now) {
    this.#store = store;
    this.dailyBudgetWei = dailyBudgetWei;
    this.#now = now;
  }

  spentTodayWei(): bigint {
    return BigInt(this.#store.get<string>("relayer.gas", utcDay(this.#now())) ?? "0");
  }

  remainingTodayWei(): bigint {
    const left = this.dailyBudgetWei - this.spentTodayWei();
    return left > 0n ? left : 0n;
  }

  /** Throws RelayerGasBudgetExceededError once today's spend has reached the budget. */
  check(): void {
    if (this.spentTodayWei() < this.dailyBudgetWei) return;
    const now = this.#now();
    const nextMidnight = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate() + 1,
    );
    throw new RelayerGasBudgetExceededError(Math.ceil((nextMidnight - now) / 1000));
  }

  record(feeWei: bigint): void {
    const day = utcDay(this.#now());
    const spent = BigInt(this.#store.get<string>("relayer.gas", day) ?? "0") + feeWei;
    this.#store.set("relayer.gas", day, spent.toString());
  }
}

/** 503 with Retry-After (until 00:00 UTC) and how to proceed without the relayer. */
export function sendBudgetExhausted(
  res: http.ServerResponse,
  err: RelayerGasBudgetExceededError,
  selfServe: string,
): void {
  res.setHeader("retry-after", String(err.retryAfterSeconds));
  sendError(res, 503, "ANE-E-1006", `Today's relayer gas budget is used up; ${selfServe}, or retry after 00:00 UTC`, true);
}
