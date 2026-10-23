// Reads the Tier-2 stack handoff file written by the ESM global setup. Read
// lazily (inside the wallet setup and the test, never at module top) so
// `--list` collection works without a booted stack.
import { readFileSync } from "node:fs";
import path from "node:path";

export interface Tier2StackFile {
  rpcUrl: string;
  chainId: number;
  registryAddress: string;
  sandboxUrl: string;
  dashboardUrl: string;
  owner: string;
  provider: string;
  ownerMnemonic: string;
  paymentId: string;
}

export function tier2StackFile(): string {
  // Resolved from the working directory (repo root): the wallet setup is also
  // loaded from Synpress's compiled cache dir, where __dirname differs.
  return path.resolve("test-results", "tier2-stack.json");
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function readTier2Stack(): Tier2StackFile {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(tier2StackFile(), "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(
      "tier2 stack not booted: run via `npm run test:e2e:dashboard-tier2` so the global setup writes test-results/tier2-stack.json",
    );
  }
  const { rpcUrl, chainId, registryAddress, sandboxUrl, dashboardUrl, owner, provider, ownerMnemonic, paymentId } =
    parsed;
  if (
    typeof rpcUrl !== "string" ||
    !rpcUrl.startsWith("http://127.0.0.1:") ||
    chainId !== 31337 ||
    !isAddress(registryAddress) ||
    typeof sandboxUrl !== "string" ||
    !sandboxUrl.startsWith("http://127.0.0.1:") ||
    typeof dashboardUrl !== "string" ||
    !dashboardUrl.startsWith("http://127.0.0.1:") ||
    !isAddress(owner) ||
    !isAddress(provider) ||
    typeof ownerMnemonic !== "string" ||
    !/^[a-z]+( [a-z]+){11}$/.test(ownerMnemonic) ||
    typeof paymentId !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(paymentId)
  ) {
    throw new Error("tier2 stack file is corrupt: delete test-results/tier2-stack.json and re-run");
  }
  return {
    rpcUrl,
    chainId,
    registryAddress,
    sandboxUrl,
    dashboardUrl,
    owner,
    provider,
    ownerMnemonic,
    paymentId,
  };
}
