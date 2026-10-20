import { type AneClient, functionSelector } from "../../../packages/sdk-ts/src/index.ts";

export interface FaucetConfig {
  claimAmount: bigint;
  cooldownSeconds: number;
}

// Reads the deployed AneFaucet's claim size and cooldown, so the server can never drift from
// the contract (the defaults live in script/DeploySandbox.s.sol and can change with setFaucetConfig).
export async function readFaucetConfig(client: AneClient, faucet: string): Promise<FaucetConfig> {
  const word = async (signature: string) =>
    BigInt((await client.ethCall(faucet, functionSelector(signature))).slice(0, 66));
  return {
    claimAmount: await word("claimAmount()"),
    cooldownSeconds: Number(await word("cooldownSeconds()")),
  };
}

// Mirrors AneFaucet's cooldown, which is keyed on the recipient only (ADR-0006). Checking it
// here turns a claim the contract would revert into a clear 429 instead of a failed transaction.
export class RecipientCooldowns {
  readonly cooldownSeconds: number;
  readonly #lastClaimAt = new Map<string, number>();

  constructor(cooldownSeconds: number) {
    this.cooldownSeconds = cooldownSeconds;
  }

  remainingSeconds(recipient: string, nowSec: number): number {
    const last = this.#lastClaimAt.get(recipient.toLowerCase());
    return last === undefined ? 0 : Math.max(0, last + this.cooldownSeconds - nowSec);
  }

  record(recipient: string, nowSec: number): void {
    this.#lastClaimAt.set(recipient.toLowerCase(), nowSec);
  }
}
