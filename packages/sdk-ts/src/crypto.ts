// EIP-712 typed-data hashing and x402 resource/request hashing
import crypto from "node:crypto";
import { abiWordAddress, abiWordBytes32, abiWordUint } from "./abi.ts";
import { keccak256, keccak256Utf8 } from "./keccak.ts";

const EIP712_DOMAIN_TYPEHASH = keccak256Utf8(
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
);

export const SPEND_INTENT_TYPEHASH = keccak256Utf8(
  "SpendIntent(address vault,address merchant,uint256 amount,bytes32 quoteId,bytes32 serviceIdHash,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint64 policyVersion)",
);

export const TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256Utf8(
  "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
);

export const FAUCET_CLAIM_TYPEHASH = keccak256Utf8(
  "FaucetClaim(address recipient,bytes32 campaignId,uint256 deadline,bytes32 nonce)",
);

export const SERVICE_MANIFEST_TYPEHASH = keccak256Utf8(
  "ServiceManifest(string serviceId,string version,uint256 chainId,address payTo,address tokenAddress,bytes32 endpointsHash,uint64 updatedAt)",
);

export interface Eip712DomainInput {
  name: string;
  version: string;
  chainId: bigint | number;
  verifyingContract: string;
}

export function hashEip712Domain(domain: Eip712DomainInput): string {
  const encoded =
    "0x" +
    abiWordBytes32(EIP712_DOMAIN_TYPEHASH) +
    abiWordBytes32(keccak256Utf8(domain.name)) +
    abiWordBytes32(keccak256Utf8(domain.version)) +
    abiWordUint(domain.chainId) +
    abiWordAddress(domain.verifyingContract);
  return keccak256(encoded);
}

export function hashTypedDataDigest(domainSeparator: string, structHash: string): string {
  return keccak256("0x1901" + abiWordBytes32(domainSeparator) + abiWordBytes32(structHash));
}

export interface SpendIntent {
  vault: string;
  merchant: string;
  amount: string | bigint;
  quoteId: string;
  serviceIdHash: string;
  validAfter: number | bigint;
  validBefore: number | bigint;
  nonce: string;
  policyVersion: number | bigint;
}

export function hashSpendIntentStruct(intent: SpendIntent): string {
  const encoded =
    "0x" +
    abiWordBytes32(SPEND_INTENT_TYPEHASH) +
    abiWordAddress(intent.vault) +
    abiWordAddress(intent.merchant) +
    abiWordUint(intent.amount) +
    abiWordBytes32(intent.quoteId) +
    abiWordBytes32(intent.serviceIdHash) +
    abiWordUint(intent.validAfter) +
    abiWordUint(intent.validBefore) +
    abiWordBytes32(intent.nonce) +
    abiWordUint(intent.policyVersion);
  return keccak256(encoded);
}

export function computePaymentId(
  chainId: bigint | number,
  vault: string,
  merchant: string,
  quoteId: string,
  nonce: string,
): string {
  return keccak256(
    "0x" +
      abiWordUint(chainId) +
      abiWordAddress(vault) +
      abiWordAddress(merchant) +
      abiWordBytes32(quoteId) +
      abiWordBytes32(nonce),
  );
}

export function hashSpendIntent(chainId: bigint | number, intent: SpendIntent): {
  domainSeparator: string;
  structHash: string;
  digest: string;
  paymentId: string;
} {
  const domainSeparator = hashEip712Domain({
    name: "AneAgentVault",
    version: "1",
    chainId,
    verifyingContract: intent.vault,
  });
  const structHash = hashSpendIntentStruct(intent);
  const digest = hashTypedDataDigest(domainSeparator, structHash);
  const paymentId = computePaymentId(
    chainId,
    intent.vault,
    intent.merchant,
    intent.quoteId,
    intent.nonce,
  );
  return { domainSeparator, structHash, digest, paymentId };
}

export interface TransferWithAuthorization {
  from: string;
  to: string;
  value: string | bigint;
  validAfter: number | bigint;
  validBefore: number | bigint;
  nonce: string;
}

export function hashTransferWithAuthorization(
  chainId: bigint | number,
  tokenAddress: string,
  auth: TransferWithAuthorization,
  tokenName = "16ane Sandbox (NO CASH VALUE)",
): {
  domainSeparator: string;
  structHash: string;
  digest: string;
} {
  const domainSeparator = hashEip712Domain({
    name: tokenName,
    version: "1",
    chainId,
    verifyingContract: tokenAddress,
  });
  const structHash = keccak256(
    "0x" +
      abiWordBytes32(TRANSFER_WITH_AUTHORIZATION_TYPEHASH) +
      abiWordAddress(auth.from) +
      abiWordAddress(auth.to) +
      abiWordUint(auth.value) +
      abiWordUint(auth.validAfter) +
      abiWordUint(auth.validBefore) +
      abiWordBytes32(auth.nonce),
  );
  const digest = hashTypedDataDigest(domainSeparator, structHash);
  return { domainSeparator, structHash, digest };
}

export interface ClaimAuthorization {
  recipient: string;
  campaignId?: string;
  deadline: number | bigint;
  nonce: string;
}

export function hashClaimAuthorization(
  chainId: bigint | number,
  faucetAddress: string,
  claim: ClaimAuthorization,
): {
  domainSeparator: string;
  structHash: string;
  digest: string;
} {
  const domainSeparator = hashEip712Domain({
    name: "AneFaucet",
    version: "1",
    chainId,
    verifyingContract: faucetAddress,
  });
  const campaignId = claim.campaignId ?? "0x" + "00".repeat(32);
  const structHash = keccak256(
    "0x" +
      abiWordBytes32(FAUCET_CLAIM_TYPEHASH) +
      abiWordAddress(claim.recipient) +
      abiWordBytes32(campaignId) +
      abiWordUint(claim.deadline) +
      abiWordBytes32(claim.nonce),
  );
  const digest = hashTypedDataDigest(domainSeparator, structHash);
  return { domainSeparator, structHash, digest };
}

export interface ServiceManifestEndpoint {
  id: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  priceAmount: string;
  scheme: "ane-vault-v1" | "exact";
  description?: string;
}

export interface ServiceManifestPayload {
  schemaVersion: "16ane-manifest-v0";
  serviceId: string;
  name: string;
  description?: string;
  version: string;
  network: "eip155:84532" | "eip155:31337";
  chainId: number;
  payTo: string;
  tokenAddress: string;
  tokenSymbol: "tANE";
  updatedAt: number;
  endpoints: ServiceManifestEndpoint[];
  trialQuota?: {
    enabled: boolean;
    freeCallsPerCaller: number;
    globalDailyCap: number;
    sponsorDisclosure: string;
  };
  signer?: string;
  signature?: string;
}

export function hashManifestEndpoints(endpoints: ServiceManifestEndpoint[]): string {
  const canonical = endpoints
    .map((e) => `${e.id}:${e.method}:${e.path}:${e.priceAmount}:${e.scheme}`)
    .join("|");
  return keccak256Utf8(canonical);
}

export function hashServiceManifest(
  manifest: ServiceManifestPayload,
  verifyingDirectory = "0x0000000000000000000000000000000000000000",
): {
  domainSeparator: string;
  structHash: string;
  digest: string;
  endpointsHash: string;
} {
  const endpointsHash = hashManifestEndpoints(manifest.endpoints);
  const domainSeparator = hashEip712Domain({
    name: "16ane.ServiceManifest",
    version: "1",
    chainId: manifest.chainId,
    verifyingContract: verifyingDirectory,
  });
  const structHash = keccak256(
    "0x" +
      abiWordBytes32(SERVICE_MANIFEST_TYPEHASH) +
      abiWordBytes32(keccak256Utf8(manifest.serviceId)) +
      abiWordBytes32(keccak256Utf8(manifest.version)) +
      abiWordUint(manifest.chainId) +
      abiWordAddress(manifest.payTo) +
      abiWordAddress(manifest.tokenAddress) +
      abiWordBytes32(endpointsHash) +
      abiWordUint(manifest.updatedAt),
  );
  const digest = hashTypedDataDigest(domainSeparator, structHash);
  return { domainSeparator, structHash, digest, endpointsHash };
}

export function computeResourceHash(method: string, canonicalUrl: string): string {
  const u = new URL(canonicalUrl);
  const normalized = `${method.toUpperCase()}:${u.origin.toLowerCase()}${u.pathname}${u.search}`;
  return keccak256Utf8(normalized);
}

export function computeRequestHash(body: string | Uint8Array | undefined | null): string {
  if (!body) {
    return keccak256Utf8("");
  }
  return typeof body === "string" ? keccak256Utf8(body) : keccak256(body);
}

export function randomBytes32Hex(): string {
  return "0x" + crypto.randomBytes(32).toString("hex");
}
