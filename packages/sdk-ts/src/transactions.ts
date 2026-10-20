// Contract transactions AneClient sends on a caller's behalf: x402 settlement, refunds and faucet claims. Each one
// goes through AneClient.sendContractTx (keystore handling, nonce retries, send hooks, the read floor).
import type { AneClient } from "./client.ts";
import {
  hashClaimAuthorization,
  randomBytes32Hex,
  type SignedFaucetClaim,
  type SpendIntent,
  type TransferWithAuthorization,
} from "./crypto.ts";
import type { SecretKey } from "./secret.ts";
import { privateKeyToAddress, signDigest, toChecksumAddress } from "./secp256k1.ts";

export async function settleSpendIntentOnChain(
  client: AneClient,
  relayerKey: SecretKey,
  intent: SpendIntent,
  signatureHex: string,
): Promise<{ txHash: string; blockNumber: number }> {
  const tupleArg = `(${intent.vault},${intent.merchant},${intent.amount.toString()},${intent.quoteId},${intent.serviceIdHash},${intent.validAfter.toString()},${intent.validBefore.toString()},${intent.nonce},${intent.policyVersion.toString()})`;
  const res = await client.sendContractTx(
    relayerKey,
    intent.vault,
    "settlePayment((address,address,uint256,bytes32,bytes32,uint256,uint256,bytes32,uint64),bytes)",
    [tupleArg, signatureHex],
  );
  return { txHash: res.txHash, blockNumber: res.blockNumber };
}

export async function settleExactAuthorizationOnChain(
  client: AneClient,
  relayerKey: SecretKey,
  auth: TransferWithAuthorization,
  signatureHex: string,
): Promise<{ txHash: string; blockNumber: number }> {
  const { aneTestToken } = await client.resolveContracts();
  const res = await client.sendContractTx(
    relayerKey,
    aneTestToken,
    "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)",
    [
      auth.from,
      auth.to,
      auth.value.toString(),
      auth.validAfter.toString(),
      auth.validBefore.toString(),
      auth.nonce,
      signatureHex,
    ],
  );
  return { txHash: res.txHash, blockNumber: res.blockNumber };
}

export async function refundPaymentOnChain(
  client: AneClient,
  merchantKey: SecretKey,
  vaultAddress: string,
  paymentId: string,
  amount: bigint | string,
): Promise<{ txHash: string; blockNumber: number }> {
  const { aneTestToken } = await client.resolveContracts();
  await client.sendContractTx(merchantKey, aneTestToken, "approve(address,uint256)", [
    vaultAddress,
    amount.toString(),
  ]);
  const res = await client.sendContractTx(
    merchantKey,
    vaultAddress,
    "refundPayment(bytes32,uint256)",
    [paymentId, amount.toString()],
  );
  return { txHash: res.txHash, blockNumber: res.blockNumber };
}

export async function executeFaucetClaimOnChain(
  client: AneClient,
  relayerKey: SecretKey,
  recipient: string,
): Promise<{ txHash: string; blockNumber: number }> {
  const { aneFaucet } = await client.resolveContracts();
  const res = await client.sendContractTx(
    relayerKey,
    aneFaucet,
    "claim(address)",
    [toChecksumAddress(recipient)],
  );
  return { txHash: res.txHash, blockNumber: res.blockNumber };
}

export async function signFaucetClaim(
  client: AneClient,
  recipientKey: SecretKey,
  options: { deadline?: number; nonce?: string } = {},
): Promise<SignedFaucetClaim> {
  const { aneFaucet } = await client.resolveContracts();
  const claim = {
    recipient: privateKeyToAddress(recipientKey),
    campaignId: "0x" + "00".repeat(32),
    deadline: options.deadline ?? Math.floor(Date.now() / 1000) + 600,
    nonce: options.nonce ?? randomBytes32Hex(),
  };
  const { digest } = hashClaimAuthorization(client.chainId, aneFaucet, claim);
  return { ...claim, signature: signDigest(digest, recipientKey).serialized };
}

export async function executeRelayedFaucetClaimOnChain(
  client: AneClient,
  relayerKey: SecretKey,
  claim: SignedFaucetClaim,
): Promise<{ txHash: string; blockNumber: number }> {
  const { aneFaucet } = await client.resolveContracts();
  const res = await client.sendContractTx(
    relayerKey,
    aneFaucet,
    "relayedClaim(address,bytes32,uint256,bytes32,bytes)",
    [toChecksumAddress(claim.recipient), claim.campaignId, claim.deadline.toString(), claim.nonce, claim.signature],
  );
  return { txHash: res.txHash, blockNumber: res.blockNumber };
}
