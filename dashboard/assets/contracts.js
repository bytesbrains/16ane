// Contract call builders and result decoders. Read calls go through provider.js;
// transactions are sent by the connected wallet. Field orders mirror the
// Foundry contracts and packages/sdk-ts readers.
import { NETWORK } from "./network.js";
import {
  abiWordAddress,
  abiWordBytes32,
  abiWordUint,
  functionSelector,
  isAddress,
  splitWords,
  wordToAddress,
  wordToBigInt,
  wordToNumber,
} from "./abi.js";
import { ethCall } from "./provider.js";

export function contracts() {
  if (NETWORK.contracts) return NETWORK.contracts;
  throw new Error("No contract addresses configured for this network yet.");
}

// Reads the registry when the build carries no embedded addresses (local/dev).
export async function resolveContracts() {
  if (NETWORK.contracts) return NETWORK.contracts;
  if (!NETWORK.registryAddress) throw new Error("No registry address configured for this network.");
  const out = await ethCall(NETWORK.registryAddress, functionSelector("getDeployment()"));
  const w = splitWords(out);
  return {
    aneTestToken: wordToAddress(w[0]),
    aneVaultFactory: wordToAddress(w[1]),
    aneFaucet: wordToAddress(w[2]),
    aneServiceDirectory: wordToAddress(w[3]),
  };
}

export function randomBytes32() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function tokenBalanceOf(token, account) {
  const out = await ethCall(token, functionSelector("balanceOf(address)") + abiWordAddress(account));
  return wordToBigInt(splitWords(out)[0]);
}

export async function vaultsByOwner(factory, owner) {
  const out = await ethCall(factory, functionSelector("getVaultsByOwner(address)") + abiWordAddress(owner));
  const w = splitWords(out);
  if (w.length < 2) throw new Error("Unexpected vault list response from the factory.");
  const length = wordToNumber(w[1]);
  if (w.length < 2 + length) throw new Error("Unexpected vault list response from the factory.");
  return w.slice(2, 2 + length).map(wordToAddress);
}

export async function predictVaultAddress(factory, owner, userSalt) {
  const data =
    functionSelector("predictVaultAddress(address,bytes32)") + abiWordAddress(owner) + abiWordBytes32(userSalt);
  return wordToAddress(splitWords(await ethCall(factory, data))[0]);
}

export function createVaultData(owner, userSalt) {
  return functionSelector("createVault(address,bytes32)") + abiWordAddress(owner) + abiWordBytes32(userSalt);
}

export async function accountingSummary(vault) {
  const out = await ethCall(vault, functionSelector("getAccountingSummary()"));
  const w = splitWords(out);
  if (w.length < 15) throw new Error("Unexpected accounting response from the vault.");
  return {
    owner: wordToAddress(w[0]),
    agentSigner: wordToAddress(w[1]),
    tokenBalance: wordToBigInt(w[2]),
    ownerPrincipalDeposited: wordToBigInt(w[3]),
    maxTotalSpend: wordToBigInt(w[4]),
    cumulativeSpent: wordToBigInt(w[5]),
    authorizedRemaining: wordToBigInt(w[6]),
    spendableNow: wordToBigInt(w[7]),
    verifiedRevenue: wordToBigInt(w[8]),
    unallocatedBalance: wordToBigInt(w[9]),
    policyVersion: wordToNumber(w[10]),
    expiry: wordToNumber(w[11]),
    budgetMode: wordToNumber(w[12]) === 1 ? "REVOLVING" : "FIXED",
    revolvingTreasuryCeiling: wordToBigInt(w[13]),
    active: wordToBigInt(w[14]) !== 0n,
  };
}

// Null when the target holds no decodable record: eth_call to an address with
// no vault code answers empty, and lookupPayment probes several candidates, so
// "no record here" is routine (skip it), not an error (abort the lookup).
export async function paymentRecord(vault, paymentId) {
  const out = await ethCall(
    vault,
    functionSelector("payments(bytes32)") + abiWordBytes32(paymentId),
  );
  const w = splitWords(out);
  if (w.length < 4) return null;
  return {
    merchant: wordToAddress(w[0]),
    amountPaid: wordToBigInt(w[1]),
    amountRefunded: wordToBigInt(w[2]),
    settledAt: wordToNumber(w[3]),
  };
}

// PolicyInput is a static 7-word tuple:
// (address,uint256,uint256,uint256,uint64,uint8,uint256).
export function setPolicyData({ agentSigner, maxTotalSpend, maxPerTx, dailyLimit, expiry, budgetMode, revolvingTreasuryCeiling }) {
  if (!isAddress(agentSigner)) throw new Error("Agent signer is not an address.");
  const words =
    abiWordAddress(agentSigner) +
    abiWordUint(maxTotalSpend) +
    abiWordUint(maxPerTx) +
    abiWordUint(dailyLimit) +
    abiWordUint(expiry) +
    abiWordUint(budgetMode === "REVOLVING" ? 1 : 0) +
    abiWordUint(revolvingTreasuryCeiling);
  return functionSelector("setPolicy((address,uint256,uint256,uint256,uint64,uint8,uint256))") + words;
}

export function revokeData() {
  return functionSelector("revoke()");
}

export function rotateAgentSignerData(newSigner) {
  return functionSelector("rotateAgentSigner(address)") + abiWordAddress(newSigner);
}

export function withdrawData(amount, recipient) {
  return functionSelector("withdraw(uint256,address)") + abiWordUint(amount) + abiWordAddress(recipient);
}

export function faucetClaimData(recipient) {
  return functionSelector("claim(address)") + abiWordAddress(recipient);
}

export async function faucetNextClaimTime(faucet, recipient) {
  const out = await ethCall(faucet, functionSelector("nextClaimTime(address)") + abiWordAddress(recipient));
  return wordToNumber(splitWords(out)[0]);
}

export async function faucetRemainingDaily(faucet) {
  const out = await ethCall(faucet, functionSelector("remainingDailyAllowance()"));
  return wordToBigInt(splitWords(out)[0]);
}
