// Multi-asset quote selection and provider routing (#23, REQ-203, REQ-204, ADR-0019). An amount is only ever
// compared with a cap set for the same asset on the same chain, in that asset's base units. The router never
// converts between assets, never takes decimals from a quote, and treats every quote as untrusted input.
import { abiReadWord, functionSelector } from "./abi.ts";
import type { AneClient } from "./client.ts";
import { toChecksumAddress } from "./secp256k1.ts";
import type { X402PaymentRequirements } from "./x402.ts";

/** One asset the caller is willing to pay in, with its own cap. */
export interface AcceptedAsset {
  chainId: number;
  asset: string;
  /** Base units of this asset. A quote above it is refused. */
  maxAmount: bigint;
  /** Read from the token contract (`readAssetDecimals`); used only to parse and display amounts. */
  decimals?: number;
}

const MAX_UINT256 = (1n << 256n) - 1n;
const BASE_UNITS = /^(0|[1-9]\d*)$/;
const HUMAN_AMOUNT = /^(0|[1-9]\d*)(\.\d+)?$/;
const PROBE_HEADERS_STRIPPED = new Set(["payment-signature", "x-payment", "x-trial-request"]);
// Quote fields are provider text and may end up in logs or an LLM's context: quoted and cut short.
const show = (value: unknown) => JSON.stringify(String(value).slice(0, 48));

/** Reads `decimals()` from the token itself: a quote's own symbol or decimals are never trusted. */
export async function readAssetDecimals(client: Pick<AneClient, "ethCall">, asset: string): Promise<number> {
  const decimals = abiReadWord(await client.ethCall(toChecksumAddress(asset), functionSelector("decimals()")), 0);
  // uint8 by ERC-20 convention; anything wider is not a token this SDK can price.
  if (decimals > 36n) throw new Error(`Token ${asset} reports ${decimals} decimals`);
  return Number(decimals);
}

function checkDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error(`Invalid decimals: ${decimals}`);
}

/** "1.5" with 6 decimals is 1500000n. Refuses more fractional digits than the asset has instead of rounding. */
export function parseAssetAmount(value: string, decimals: number): bigint {
  checkDecimals(decimals);
  if (!HUMAN_AMOUNT.test(value)) throw new Error(`Invalid amount: ${JSON.stringify(value)}`);
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`${value} has more than ${decimals} decimal places`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** A base-unit amount as a uint256: the same canonical form a quote's `amount` must take, so "0x10" is not 16. */
export function parseBaseUnits(value: bigint | string): bigint {
  if (typeof value === "string" && !BASE_UNITS.test(value)) throw new Error(`Invalid base-unit amount: ${show(value)}`);
  const amount = BigInt(value);
  if (amount < 0n || amount > MAX_UINT256) throw new Error(`Base-unit amount ${amount} is outside uint256`);
  return amount;
}

export function formatAssetAmount(amount: bigint, decimals: number): string {
  checkDecimals(decimals);
  if (amount < 0n) throw new Error("Negative amount");
  const unit = 10n ** BigInt(decimals);
  const padded = (amount % unit).toString().padStart(decimals, "0");
  // A linear trim of trailing zeros: /0+$/ backtracks quadratically on "000…01".
  let end = padded.length;
  while (end > 0 && padded[end - 1] === "0") end--;
  const fraction = padded.slice(0, end);
  return fraction ? `${amount / unit}.${fraction}` : `${amount / unit}`;
}

/** An accepted asset with a cap in whole units, e.g. `"0.5"`, scaled by the decimals the token reports. */
export async function acceptAsset(
  client: Pick<AneClient, "ethCall" | "chainId">,
  asset: string,
  maxAmount: string,
): Promise<AcceptedAsset> {
  const decimals = await readAssetDecimals(client, asset);
  return { chainId: client.chainId, asset: toChecksumAddress(asset), maxAmount: parseAssetAmount(maxAmount, decimals), decimals };
}

export interface RequirementMatch {
  requirement: X402PaymentRequirements;
  accepted: AcceptedAsset;
  amount: bigint;
}

/** Checks one quote entry against the accepted assets: the scheme, the exact (chain, asset) pair, and the cap. */
export function matchRequirement(
  requirement: unknown,
  accepted: AcceptedAsset[],
  schemes: readonly string[] = ["ane-vault-v1"],
): { match: RequirementMatch } | { reason: string } {
  if (typeof requirement !== "object" || requirement === null) return { reason: "not an object" };
  const r = requirement as Record<string, unknown>;
  if (!schemes.includes(String(r.scheme))) return { reason: `scheme ${show(r.scheme)} is not accepted` };
  let asset: string, payTo: string;
  try {
    asset = toChecksumAddress(String(r.asset));
    payTo = toChecksumAddress(String(r.payTo));
  } catch {
    return { reason: "malformed asset or payTo address" };
  }
  const candidates = accepted.filter((a) => toChecksumAddress(a.asset) === asset);
  if (candidates.length === 0) return { reason: `asset ${asset} is not accepted` };
  const onChain = candidates.find((a) => r.network === `eip155:${a.chainId}`);
  if (!onChain) return { reason: `asset ${asset} is not accepted on ${show(r.network)}` };
  // Base units only: no sign, exponent, fraction, hex or padding, so "1e18" can never be read as 1.
  if (typeof r.amount !== "string" || !BASE_UNITS.test(r.amount)) return { reason: "amount is not a base-unit integer" };
  const amount = BigInt(r.amount);
  if (amount > MAX_UINT256) return { reason: "amount exceeds uint256" };
  if (amount > onChain.maxAmount) return { reason: `amount ${amount} exceeds the cap ${onChain.maxAmount} for ${asset}` };
  return { match: { requirement: { ...(r as unknown as X402PaymentRequirements), asset, payTo }, accepted: onChain, amount } };
}

/**
 * Picks the quote entry to pay from a 402 envelope's `accepts`: the first accepted asset that any entry matches
 * (the caller's list is its preference order), then the lowest amount in that asset.
 */
export function selectRequirement(
  accepts: unknown,
  accepted: AcceptedAsset[],
  schemes: readonly string[] = ["ane-vault-v1"],
): { match?: RequirementMatch; rejected: string[] } {
  const rejected: string[] = [];
  const matches: RequirementMatch[] = [];
  for (const entry of Array.isArray(accepts) ? accepts : []) {
    const result = matchRequirement(entry, accepted, schemes);
    if ("match" in result) matches.push(result.match);
    else rejected.push(result.reason);
  }
  if (!Array.isArray(accepts) || accepts.length === 0) rejected.push("no payment options offered");
  matches.sort((a, b) => accepted.indexOf(a.accepted) - accepted.indexOf(b.accepted) || compareBigInt(a.amount, b.amount));
  return { match: matches[0], rejected };
}

/** One provider's answer to an unpaid request: its quote, and how long the quote took to arrive. */
export interface ProviderOffer {
  providerId: string;
  url: string;
  /** The envelope's `accepts`, untrusted. Empty when the provider sent no usable quote. */
  accepts: unknown[];
  /**
   * Milliseconds, measured by the caller: by `probeOffer` (time to the 402 quote, a lower bound on service time)
   * or from the caller's own past purchases. Never a provider's claim.
   */
  latencyMs?: number;
  /** Why `accepts` is empty, when it is. */
  error?: string;
}

export interface RouteConstraints {
  /** In preference order. A quote in any other asset, or on another chain, is refused. */
  assets: AcceptedAsset[];
  maxLatencyMs?: number;
  /** Within one asset: lowest price first (default), or lowest latency first. */
  prefer?: "price" | "latency";
  schemes?: readonly string[];
}

export interface RankedOffer extends RequirementMatch {
  providerId: string;
  url: string;
  latencyMs?: number;
}

export interface RouteResult {
  chosen?: RankedOffer;
  ranked: RankedOffer[];
  rejected: Array<{ providerId: string; url: string; reason: string }>;
}

/**
 * Ranks provider offers under the caller's constraints. Offers in different assets are ordered by the caller's
 * asset preference, never by converting prices; within one asset, by price then latency (or the reverse).
 */
export function routeOffers(offers: ProviderOffer[], constraints: RouteConstraints): RouteResult {
  const ranked: RankedOffer[] = [];
  const rejected: RouteResult["rejected"] = [];
  for (const offer of offers) {
    const reject = (reason: string) => rejected.push({ providerId: offer.providerId, url: offer.url, reason });
    if (constraints.maxLatencyMs !== undefined) {
      if (offer.latencyMs === undefined) {
        reject("no latency measurement");
        continue;
      }
      if (offer.latencyMs > constraints.maxLatencyMs) {
        reject(`latency ${offer.latencyMs}ms exceeds ${constraints.maxLatencyMs}ms`);
        continue;
      }
    }
    const { match, rejected: reasons } = selectRequirement(offer.accepts, constraints.assets, constraints.schemes);
    if (!match) {
      reject(offer.error ?? reasons.join("; "));
      continue;
    }
    ranked.push({ ...match, providerId: offer.providerId, url: offer.url, latencyMs: offer.latencyMs });
  }
  const latency = (o: RankedOffer) => o.latencyMs ?? Number.POSITIVE_INFINITY;
  const byLatency = (a: RankedOffer, b: RankedOffer) => latency(a) - latency(b);
  const byPrice = (a: RankedOffer, b: RankedOffer) => compareBigInt(a.amount, b.amount);
  const [first, second] = constraints.prefer === "latency" ? [byLatency, byPrice] : [byPrice, byLatency];
  ranked.sort(
    (a, b) =>
      constraints.assets.indexOf(a.accepted) - constraints.assets.indexOf(b.accepted) ||
      first(a, b) ||
      second(a, b) ||
      a.providerId.localeCompare(b.providerId) ||
      a.url.localeCompare(b.url),
  );
  return { chosen: ranked[0], ranked, rejected };
}

/**
 * Asks a provider for a quote without paying: the same request the purchase will send, minus any payment or
 * trial headers, so it can neither settle nor spend a sponsored call. Measures the round trip to the 402.
 */
export async function probeOffer(
  url: string,
  options: {
    providerId?: string;
    method?: "GET" | "POST" | "PUT" | "DELETE";
    headers?: Record<string, string>;
    body?: string;
    fetchImpl?: typeof fetch;
    now?: () => number;
  } = {},
): Promise<ProviderOffer> {
  const now = options.now ?? (() => performance.now());
  const headers = Object.fromEntries(
    Object.entries(options.headers ?? {}).filter(([k]) => !PROBE_HEADERS_STRIPPED.has(k.toLowerCase())),
  );
  if (options.body && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
    headers["content-type"] = "application/json";
  }
  let providerId = options.providerId ?? url;
  try {
    providerId = options.providerId ?? new URL(url).origin;
  } catch {
    return { providerId, url, accepts: [], error: "invalid URL" };
  }
  const offer: ProviderOffer = { providerId, url, accepts: [] };
  const started = now();
  let res: Response;
  try {
    res = await (options.fetchImpl ?? fetch)(url, {
      method: options.method ?? (options.body ? "POST" : "GET"),
      headers,
      body: options.body,
    });
  } catch (err) {
    return { ...offer, error: `request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  offer.latencyMs = Math.max(0, Math.round(now() - started));
  // Not needed, and a provider could make it arbitrarily large.
  await res.body?.cancel().catch(() => {});
  if (res.status !== 402) return { ...offer, error: `expected a 402 quote, got HTTP ${res.status}` };
  const header = res.headers.get("payment-required");
  if (!header) return { ...offer, error: "402 without a PAYMENT-REQUIRED header" };
  try {
    const envelope = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts?: unknown };
    if (!Array.isArray(envelope?.accepts)) throw new Error("no accepts array");
    return { ...offer, accepts: envelope.accepts };
  } catch (err) {
    return { ...offer, error: `unreadable PAYMENT-REQUIRED: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function compareBigInt(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
