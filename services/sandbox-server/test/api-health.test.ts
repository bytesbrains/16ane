import test from "node:test";
import assert from "node:assert/strict";
import { assessHealth, checkApiHealth, type HealthReport } from "../../../scripts/api-health.ts";

const REGISTRY = "0x01d5daB670DE5868305eB862721ebE62772C3Df3";
const healthy: HealthReport = {
  status: "ok",
  chainId: 84532,
  registry: REGISTRY,
  relayer: {
    address: "0x00000000000000000000000000000000000000Aa",
    balanceWei: "40000000000000000",
    dailyGasBudgetWei: "50000000000000000",
    remainingTodayWei: "30000000000000000",
    lowBalance: false,
  },
};

test("a healthy server raises nothing", () => {
  assert.deepEqual(assessHealth(200, healthy, REGISTRY.toLowerCase()), []);
});

test("RPC down, low relayer balance, a used-up budget and the wrong registry are each named", () => {
  assert.match(assessHealth(503, { status: "unavailable" })[0], /503 \(unavailable\).*RPC/);
  const low = assessHealth(200, { ...healthy, relayer: { ...healthy.relayer, lowBalance: true } });
  assert.equal(low.length, 1);
  assert.match(low[0], /top it up/);
  const spent = assessHealth(200, { ...healthy, relayer: { ...healthy.relayer, remainingTodayWei: "0" } });
  assert.match(spent[0], /used up: sponsorship is paused until 00:00 UTC/);
  const other = assessHealth(200, healthy, "0x" + "11".repeat(20));
  assert.match(other[0], /another deployment/);
  assert.match(assessHealth(200, { status: "ok" })[0], /no relayer section/);
});

test("an unreachable API is a problem, not a crash", async () => {
  const problems = await checkApiHealth("http://127.0.0.1:1");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unreachable/);
});
