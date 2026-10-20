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

/**
 * What one in-flight send holds back until its receipt: Base Sepolia transactions cost about 1e12–1e13 wei,
 * so 1e14 leaves a wide margin. It caps how far concurrent sends can overshoot the budget.
 */
export const DEFAULT_RELAYER_GAS_RESERVE_WEI = 100_000_000_000_000n;

/** A send's hold on the budget, counted against the UTC day it started on. */
export interface GasReservation {
  readonly day: string;
  readonly wei: bigint;
}

export class RelayerGasBudget {
  readonly dailyBudgetWei: bigint;
  readonly #store: KeyValueStore;
  readonly #now: () => number;
  readonly #reserveWei: bigint;
  // In-flight holds per day. In memory: the server is one process (#82), and a restart has no sends in flight.
  readonly #reserved = new Map<string, bigint>();

  constructor(
    store: KeyValueStore,
    dailyBudgetWei: bigint,
    now: () => number = Date.now,
    reserveWei: bigint = DEFAULT_RELAYER_GAS_RESERVE_WEI,
  ) {
    this.#store = store;
    this.dailyBudgetWei = dailyBudgetWei;
    this.#now = now;
    this.#reserveWei = reserveWei;
  }

  #spent(day: string): bigint {
    return BigInt(this.#store.get<string>("relayer.gas", day) ?? "0");
  }

  #adjustReserved(day: string, delta: bigint): void {
    const left = (this.#reserved.get(day) ?? 0n) + delta;
    if (left > 0n) this.#reserved.set(day, left);
    else this.#reserved.delete(day);
  }

  spentTodayWei(): bigint {
    return this.#spent(utcDay(this.#now()));
  }

  /** Held back by sends still waiting for their receipt. */
  reservedTodayWei(): bigint {
    return this.#reserved.get(utcDay(this.#now())) ?? 0n;
  }

  remainingTodayWei(): bigint {
    const left = this.dailyBudgetWei - this.spentTodayWei() - this.reservedTodayWei();
    return left > 0n ? left : 0n;
  }

  /**
   * Holds back gas for one send, or throws RelayerGasBudgetExceededError once today's spend plus in-flight
   * holds reach the budget. Synchronous, so concurrent requests can't all pass before any of them records.
   */
  reserve(): GasReservation {
    const now = this.#now();
    const day = utcDay(now);
    const left = this.dailyBudgetWei - this.#spent(day) - (this.#reserved.get(day) ?? 0n);
    if (left <= 0n) {
      const d = new Date(now);
      const nextMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
      throw new RelayerGasBudgetExceededError(Math.ceil((nextMidnight - now) / 1000));
    }
    const wei = left < this.#reserveWei ? left : this.#reserveWei;
    this.#adjustReserved(day, wei);
    return { day, wei };
  }

  /** Swaps the hold for the fee actually paid, on the day the send started. */
  settle(reservation: GasReservation, feeWei: bigint): void {
    this.#adjustReserved(reservation.day, -reservation.wei);
    this.#store.set("relayer.gas", reservation.day, (this.#spent(reservation.day) + feeWei).toString());
  }

  /**
   * The balance can't cover a full day's budget: time to top up the relayer. Not "what's left of today": once
   * today's budget is used up that is 0, and an empty relayer would look fine until tomorrow's first send.
   */
  isLowBalance(balanceWei: bigint): boolean {
    return balanceWei < this.dailyBudgetWei;
  }

  /** Drops the hold of a send that never produced a receipt (e.g. cast refused it before broadcasting). */
  release(reservation: GasReservation): void {
    this.#adjustReserved(reservation.day, -reservation.wei);
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
