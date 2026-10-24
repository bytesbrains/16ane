// Chain-reading checks a relayer runs before spending gas on a settlement:
// the settlement-target allowlist and an eth_call simulation of the exact send.

import { abiWordAddress, functionSelector } from "./abi.ts";
import { type AneClient } from "./client.ts";
import type { ExactPaymentPayload, VaultPaymentPayload } from "./payment-checks.ts";
import { settlePaymentCalldata, transferCalldata } from "./signed-actions.ts";

// The settlement target allowlist (#18): a vault intent settles only to a vault the 16ane factory
// registered. A send to any other address would succeed vacuously on-chain while settling nothing.
export async function vaultRegistrationFailure(
  client: AneClient,
  vault: string,
): Promise<{ status: number; code: string; message: string } | undefined> {
  const { aneVaultFactory } = await client.resolveContracts();
  const registered = await client.ethCall(
    aneVaultFactory,
    functionSelector("isRegisteredVault(address)") + abiWordAddress(vault),
  );
  if (BigInt(registered.slice(0, 66)) === 0n) {
    return {
      status: 403,
      code: "ANE-E-4013",
      message: `${vault} is not a vault created by the 16ane factory`,
    };
  }
  return undefined;
}

// Would the relayer's send succeed? Simulation runs the exact settlement from the relayer's address
// without spending gas, so an underfunded, expired or already-used authorization is refused up front.
export async function simulationFailure(
  client: AneClient,
  relayerAddress: string,
  scheme: "ane-vault-v1" | "exact",
  p: VaultPaymentPayload | ExactPaymentPayload,
  to: string,
): Promise<{ status: number; code: string; message: string } | undefined> {
  const data =
    scheme === "ane-vault-v1"
      ? settlePaymentCalldata(p as VaultPaymentPayload, (p as VaultPaymentPayload).signature)
      : transferCalldata(p as ExactPaymentPayload);
  try {
    await client.simulateCall(relayerAddress, to, data);
  } catch (err) {
    // A fetch-level failure (DNS, refused, reset) is the chain being unreachable, not a bad
    // payment: let it surface as a 500 "cannot evaluate" instead of a 402 rejection. An EVM
    // revert always arrives as an RPC error payload, never as a TypeError.
    if (err instanceof TypeError) throw err;
    const why = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    return { status: 402, code: "ANE-E-4011", message: `Settlement would revert, so nothing was sent: ${why}` };
  }
  return undefined;
}
