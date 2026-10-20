import test from "node:test";
import assert from "node:assert/strict";
import type { AneClient } from "../../../packages/sdk-ts/src/index.ts";
import { functionSelector } from "../../../packages/sdk-ts/src/index.ts";
import { readFaucetConfig, RecipientCooldowns } from "../src/faucet.ts";

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);

test("the cooldown is per recipient, as AneFaucet enforces it", () => {
  const cooldowns = new RecipientCooldowns(3600);
  assert.equal(cooldowns.remainingSeconds(A, 1_000), 0);
  cooldowns.record(A, 1_000);
  assert.equal(cooldowns.remainingSeconds(A, 1_000), 3600);
  assert.equal(cooldowns.remainingSeconds(A.toUpperCase().replace("0X", "0x"), 1_600), 3000, "address case does not matter");
  assert.equal(cooldowns.remainingSeconds(B, 1_000), 0, "another recipient is not affected");
  assert.equal(cooldowns.remainingSeconds(A, 4_600), 0, "the cooldown expires");
});

test("readFaucetConfig reads claimAmount and cooldownSeconds from the deployed faucet", async () => {
  const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
  const answers = new Map([
    [functionSelector("claimAmount()"), word(16_000n * 10n ** 18n)],
    [functionSelector("cooldownSeconds()"), word(3600n)],
  ]);
  const calls: string[] = [];
  const client = {
    ethCall: async (to: string, data: string) => {
      calls.push(to);
      return answers.get(data) ?? "0x";
    },
  } as unknown as AneClient;
  const config = await readFaucetConfig(client, "0xFaucet");
  assert.deepEqual(config, { claimAmount: 16_000n * 10n ** 18n, cooldownSeconds: 3600 });
  assert.deepEqual(calls, ["0xFaucet", "0xFaucet"]);
});
