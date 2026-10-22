// EIP-1193 wallet access plus dependency-free JSON-RPC reads.
//
// Reads always go to the configured RPC over fetch: deterministic, pinned by
// the CSP, and working with no wallet connected. The injected wallet is used
// only for accounts, chain switching, signatures, and sending transactions —
// keys never enter this page.
import { NETWORK } from "./network.js";

export function hasWallet() {
  return typeof window !== "undefined" && typeof window.ethereum !== "undefined";
}

function ethereum() {
  if (!hasWallet()) throw new Error("No wallet found. Install MetaMask, Coinbase Wallet, or Rabby to continue.");
  return window.ethereum;
}

export function friendlyWalletError(err) {
  const code = err && typeof err === "object" ? err.code : undefined;
  if (code === 4001) return "Rejected in the wallet. Nothing was signed or sent.";
  if (code === 4902) return "The wallet does not know this network and refused to add it.";
  if (code === -32002) return "A wallet request is already pending. Open the wallet to answer it.";
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

export async function requestAccounts() {
  const accounts = await ethereum().request({ method: "eth_requestAccounts" });
  if (!accounts || accounts.length === 0) throw new Error("The wallet returned no accounts.");
  return accounts;
}

export async function walletChainId() {
  const hex = await ethereum().request({ method: "eth_chainId" });
  return Number.parseInt(hex, 16);
}

// Switches the wallet to the dashboard network, offering to add it (EIP-3085)
// when unknown. Returns once the wallet reports the expected chain.
export async function ensureChain() {
  const want = `0x${NETWORK.chainId.toString(16)}`;
  const current = await ethereum().request({ method: "eth_chainId" });
  if (current.toLowerCase() === want.toLowerCase()) return;
  try {
    await ethereum().request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  } catch (err) {
    if (err && err.code === 4902) {
      await ethereum().request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: want,
            chainName: NETWORK.chainName,
            nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
            rpcUrls: [NETWORK.rpcUrl],
            blockExplorerUrls: NETWORK.explorer ? [NETWORK.explorer] : [],
          },
        ],
      });
    } else {
      throw err;
    }
  }
  const after = await ethereum().request({ method: "eth_chainId" });
  if (after.toLowerCase() !== want.toLowerCase()) {
    throw new Error(`The wallet is on another network. Switch to ${NETWORK.chainName} (chain ${NETWORK.chainId}).`);
  }
}

let rpcId = 1;

export async function rpc(method, params = []) {
  const res = await fetch(NETWORK.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} failed: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC ${method} failed: ${body.error.message || body.error.code}`);
  return body.result;
}

export async function ethCall(to, data, block = "latest") {
  return rpc("eth_call", [{ to, data }, block]);
}

export async function sendTransaction({ from, to, data, value }) {
  const txHash = await ethereum().request({
    method: "eth_sendTransaction",
    params: [{ from, to, data, ...(value === undefined ? {} : { value }) }],
  });
  return waitReceipt(txHash);
}

export async function waitReceipt(txHash, { tries = 60, delayMs = 2000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const receipt = await ethereum().request({
      method: "eth_getTransactionReceipt",
      params: [txHash],
    });
    if (receipt) {
      if (receipt.status !== "0x1") throw new Error(`Transaction reverted: ${txHash}`);
      return { txHash, blockNumber: Number.parseInt(receipt.blockNumber, 16) };
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Still no receipt for ${txHash} after waiting. Check the explorer before retrying.`);
}

// EIP-191 personal_sign: signs the exact message bytes (the wallet adds the
// "\x19Ethereum Signed Message" prefix itself).
export async function personalSign(message, from) {
  return ethereum().request({ method: "personal_sign", params: [message, from] });
}

// EIP-747: offer the test token in the wallet's token list. The wallet fetches
// the image itself; nothing sensitive is sent.
export async function watchAsset({ address, symbol, decimals, image }) {
  const added = await ethereum().request({
    method: "wallet_watchAsset",
    params: { type: "ERC20", options: { address, symbol, decimals, image } },
  });
  if (!added) throw new Error("The wallet declined to list the token.");
}
