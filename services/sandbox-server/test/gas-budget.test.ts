import test from "node:test";
import assert from "node:assert/strict";
import { MemoryKeyValueStore } from "../../../packages/sdk-ts/src/index.ts";
import { RelayerGasBudget, RelayerGasBudgetExceededError } from "../src/gas-budget.ts";

const at = (iso: string) => () => Date.parse(iso);

test("sponsoring stops exactly when today's spend reaches the budget", () => {
  const budget = new RelayerGasBudget(new MemoryKeyValueStore(), 100n, at("2026-10-20T10:00:00Z"), 10n);
  budget.settle(budget.reserve(), 60n);
  budget.settle(budget.reserve(), 40n); // 60 < 100
  assert.equal(budget.spentTodayWei(), 100n);
  assert.equal(budget.remainingTodayWei(), 0n);
  assert.throws(() => budget.reserve(), (err: unknown) => {
    assert.ok(err instanceof RelayerGasBudgetExceededError);
    assert.equal(err.retryAfterSeconds, 14 * 3600, "retry after 00:00 UTC");
    return true;
  });
});

test("concurrent sends can't all pass before any of them records its fee", () => {
  const budget = new RelayerGasBudget(new MemoryKeyValueStore(), 100n, at("2026-10-20T10:00:00Z"), 30n);
  // Four sends in flight hold 30 + 30 + 30 + 10: the budget is fully held, so a fifth is refused.
  const holds = [budget.reserve(), budget.reserve(), budget.reserve(), budget.reserve()];
  assert.deepEqual(holds.map((h) => h.wei), [30n, 30n, 30n, 10n]);
  assert.equal(budget.remainingTodayWei(), 0n);
  assert.throws(() => budget.reserve(), RelayerGasBudgetExceededError);
  // Receipts come back cheaper than the holds; the difference is free again.
  for (const hold of holds) budget.settle(hold, 5n);
  assert.equal(budget.spentTodayWei(), 20n);
  assert.equal(budget.reservedTodayWei(), 0n);
  assert.equal(budget.remainingTodayWei(), 80n);
});

test("a send that never got a receipt gives its hold back", () => {
  const budget = new RelayerGasBudget(new MemoryKeyValueStore(), 10n, at("2026-10-20T10:00:00Z"), 10n);
  const hold = budget.reserve();
  assert.throws(() => budget.reserve(), RelayerGasBudgetExceededError);
  budget.release(hold);
  assert.equal(budget.spentTodayWei(), 0n);
  budget.reserve();
});

test("a send that starts before midnight counts toward the day it started", () => {
  const store = new MemoryKeyValueStore();
  let now = Date.parse("2026-10-20T23:59:59Z");
  const budget = new RelayerGasBudget(store, 100n, () => now, 10n);
  const hold = budget.reserve();
  now = Date.parse("2026-10-21T00:00:02Z");
  budget.settle(hold, 7n);
  assert.equal(budget.spentTodayWei(), 0n, "the new day starts clean");
  assert.equal(new RelayerGasBudget(store, 100n, at("2026-10-20T12:00:00Z")).spentTodayWei(), 7n);
});

test("a new UTC day starts from zero, and spend survives a restart (same store)", () => {
  const store = new MemoryKeyValueStore();
  const today = new RelayerGasBudget(store, 100n, at("2026-10-20T23:59:00Z"));
  today.settle(today.reserve(), 100n);
  assert.throws(() => new RelayerGasBudget(store, 100n, at("2026-10-20T23:59:30Z")).reserve(), RelayerGasBudgetExceededError);
  const tomorrow = new RelayerGasBudget(store, 100n, at("2026-10-21T00:00:01Z"));
  tomorrow.reserve();
  assert.equal(tomorrow.spentTodayWei(), 0n);
});

test("lowBalance flags an empty relayer even when today's budget is used up", () => {
  const budget = new RelayerGasBudget(new MemoryKeyValueStore(), 100n, at("2026-10-20T10:00:00Z"));
  budget.settle(budget.reserve(), 100n);
  assert.equal(budget.remainingTodayWei(), 0n);
  assert.equal(budget.isLowBalance(0n), true);
  assert.equal(budget.isLowBalance(99n), true);
  assert.equal(budget.isLowBalance(100n), false);
});
