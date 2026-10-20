import test from "node:test";
import assert from "node:assert/strict";
import { MemoryKeyValueStore } from "../../../packages/sdk-ts/src/index.ts";
import { RelayerGasBudget, RelayerGasBudgetExceededError } from "../src/gas-budget.ts";

const at = (iso: string) => () => Date.parse(iso);

test("sponsoring stops exactly when today's spend reaches the budget", () => {
  const budget = new RelayerGasBudget(new MemoryKeyValueStore(), 100n, at("2026-10-20T10:00:00Z"));
  budget.check();
  budget.record(60n);
  budget.check(); // 60 < 100
  budget.record(40n);
  assert.equal(budget.spentTodayWei(), 100n);
  assert.equal(budget.remainingTodayWei(), 0n);
  assert.throws(() => budget.check(), (err: unknown) => {
    assert.ok(err instanceof RelayerGasBudgetExceededError);
    assert.equal(err.retryAfterSeconds, 14 * 3600, "retry after 00:00 UTC");
    return true;
  });
});

test("a new UTC day starts from zero, and spend survives a restart (same store)", () => {
  const store = new MemoryKeyValueStore();
  new RelayerGasBudget(store, 100n, at("2026-10-20T23:59:00Z")).record(100n);
  assert.throws(() => new RelayerGasBudget(store, 100n, at("2026-10-20T23:59:30Z")).check(), RelayerGasBudgetExceededError);
  const tomorrow = new RelayerGasBudget(store, 100n, at("2026-10-21T00:00:01Z"));
  tomorrow.check();
  assert.equal(tomorrow.spentTodayWei(), 0n);
});
