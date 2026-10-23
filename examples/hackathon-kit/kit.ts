// Shared helpers for the hackathon kit (#20): where the kit keeps its state, which network it talks to,
// and how keys are stored. Every script reads .kit/network.json, written by local-sandbox.ts (local
// Anvil) or by `owner.ts setup --network sandbox` (the public Base Sepolia sandbox).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  AneClient,
  generateKeypair,
  privateKeyToAddress,
  SANDBOX_DISCLAIMER,
  SecretKey,
} from "../../packages/sdk-ts/src/index.ts";

export { SANDBOX_DISCLAIMER };

/** One whole tANE in base units (18 decimals). */
export const ONE_TANE = 10n ** 18n;

export const KIT_DIR = import.meta.dirname;
export const REPO_ROOT = path.resolve(KIT_DIR, "..", "..");
/** Kit state: network settings and keys. Gitignored; delete it to start over. */
export const STATE_DIR = process.env.KIT_STATE_DIR ?? path.join(KIT_DIR, ".kit");

export interface KitNetwork {
  name: "local" | "sandbox";
  rpcUrl: string;
  chainId: number;
  registryAddress: string;
  /** The sandbox API: faucet, gasless relay and the reference demo endpoints. */
  apiUrl: string;
  /** An x402 facilitator the Python seller settles through. Only the local sandbox starts one. */
  facilitatorUrl?: string;
}

/** The public sandbox on Base Sepolia, from the committed network file. */
export function publicSandbox(): KitNetwork {
  const net = JSON.parse(readFileSync(path.join(REPO_ROOT, "networks", "sandbox-sepolia.json"), "utf8")) as {
    rpcUrl: string;
    chainId: number;
    registryAddress: string;
  };
  return {
    name: "sandbox",
    rpcUrl: net.rpcUrl,
    chainId: net.chainId,
    registryAddress: net.registryAddress,
    apiUrl: "https://api.16ane.com",
    ...(process.env.FACILITATOR_URL ? { facilitatorUrl: process.env.FACILITATOR_URL } : {}),
  };
}

function statePath(name: string): string {
  return path.join(STATE_DIR, name);
}

export function writeNetwork(net: KitNetwork): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(statePath("network.json"), JSON.stringify(net, null, 2) + "\n");
}

export function readNetwork(): KitNetwork {
  const file = statePath("network.json");
  if (!existsSync(file)) {
    throw new Error(
      "No network chosen yet. Start a local sandbox (npm run kit:sandbox) or run " +
        "`npm run kit:owner -- setup --network sandbox` for the public one.",
    );
  }
  return JSON.parse(readFileSync(file, "utf8")) as KitNetwork;
}

export function clientFor(net: KitNetwork): AneClient {
  return new AneClient({ rpcUrl: net.rpcUrl, chainId: net.chainId, registryAddress: net.registryAddress });
}

/**
 * Loads a key from .kit/<name>.key, creating it on first use. Key files are mode 600 and the key is
 * only ever held as a SecretKey, which never prints its value. Never paste these into a prompt or a log.
 */
export function loadOrCreateKey(name: string): SecretKey {
  const file = statePath(`${name}.key`);
  if (existsSync(file)) return new SecretKey(readFileSync(file, "utf8").trim());
  mkdirSync(STATE_DIR, { recursive: true });
  const { secretKey } = generateKeypair();
  writeFileSync(file, secretKey.unsafeUnwrap() + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return secretKey;
}

export function addressOf(key: SecretKey): string {
  return privateKeyToAddress(key);
}

/** The vault and agent session the owner set up; the session key itself stays in .kit/agent.key. */
export interface AgentState {
  vaultAddress: string;
  sessionAddress: string;
}

export function writeAgent(state: AgentState): void {
  writeFileSync(statePath("agent.json"), JSON.stringify(state, null, 2) + "\n");
}

export function readAgent(): AgentState {
  const file = statePath("agent.json");
  if (!existsSync(file)) throw new Error("No agent yet. Run `npm run kit:owner -- setup` first.");
  return JSON.parse(readFileSync(file, "utf8")) as AgentState;
}

/** 1234500000000000000 -> "1.2345 tANE". */
export function tane(amount: bigint | string): string {
  const v = BigInt(amount);
  const whole = v / ONE_TANE;
  const frac = (v % ONE_TANE).toString().padStart(18, "0").replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""} tANE`;
}

/** Local Anvil only: gives an address test ETH for gas. Real testnets need a faucet instead. */
export async function fundGasIfLocal(net: KitNetwork, address: string): Promise<void> {
  if (net.name !== "local") return;
  await clientFor(net).rpcCall("anvil_setBalance", [address, "0x" + (10n * ONE_TANE).toString(16)]);
}
