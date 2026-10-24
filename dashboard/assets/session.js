// Shared dashboard session: the connected account, resolved contracts, the
// open vault, and the per-account vault memory kept in localStorage.
import { NETWORK } from "./network.js";
import { isAddress } from "./abi.js";
import { friendlyWalletError } from "./provider.js";
import { resolveContracts } from "./contracts.js";
import { setStatus } from "./ui.js";

export const state = { account: null, contracts: null, openVault: null };

export function storeKey(suffix) {
  return `16ane.dashboard.${suffix}.${NETWORK.chainId}.${(state.account ?? "anon").toLowerCase()}`;
}

export function recentVaults() {
  try {
    const ids = JSON.parse(localStorage.getItem(storeKey("vaults")) ?? "[]");
    return Array.isArray(ids) ? ids.filter(isAddress) : [];
  } catch {
    return [];
  }
}

export function rememberVault(address) {
  const ids = [address, ...recentVaults().filter((v) => v.toLowerCase() !== address.toLowerCase())].slice(0, 12);
  try {
    localStorage.setItem(storeKey("vaults"), JSON.stringify(ids));
    localStorage.setItem(storeKey("open"), address);
  } catch {
    // Private mode: the dashboard works, it just forgets.
  }
}

export function fail(err, what) {
  console.error(what, err);
  setStatus(`${what}: ${friendlyWalletError(err)}`, "error");
}

export async function withContracts() {
  if (!state.contracts) state.contracts = await resolveContracts();
  return state.contracts;
}

export function requireAccount() {
  if (!state.account) {
    setStatus("Connect a wallet first.", "error");
    return false;
  }
  return true;
}
