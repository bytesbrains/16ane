// One agent, one vault per asset (#133, REQ-204, ADR-0020). Each asset's vault keeps its own budget, so a cap is
// only ever set and checked in that asset's base units; this class only decides which vault pays. It routes across
// the vaults' assets in the caller's preference order and hands the purchase to the vault for the winning asset,
// which then verifies the receipt against that asset.
import type { AneClient } from "./client.ts";
import { routeOffers, type AcceptedAsset, type RankedOffer, type RouteResult } from "./routing.ts";
import type { AgentSession, ProviderCandidate } from "./session.ts";
import { toChecksumAddress } from "./secp256k1.ts";
import type { PurchaseOptions, PurchaseResult } from "./x402.ts";

/** A cap for one asset, in that asset's base units. */
export interface AssetCap {
  asset: string;
  maxPayment: bigint | string;
}

export interface MultiAssetConstraints {
  /** In preference order: across assets the first listed wins, never the lower raw amount. */
  caps: AssetCap[];
  maxLatencyMs?: number;
  /** Within one asset: lowest price first (default), or lowest latency first. */
  prefer?: "price" | "latency";
}

export class MultiAssetSession {
  readonly client: AneClient;
  readonly sessions: readonly AgentSession[];
  #byAsset?: Promise<Map<string, AgentSession>>;

  /** One session per vault; every vault must be on the same client and hold a different asset. */
  constructor(sessions: AgentSession[]) {
    if (sessions.length === 0) throw new Error("MultiAssetSession needs at least one vault session");
    const client = sessions[0].client;
    if (sessions.some((s) => s.client.chainId !== client.chainId)) {
      throw new Error("Every vault session must be on the same chain");
    }
    const vaults = new Set(sessions.map((s) => s.vaultAddress));
    if (vaults.size !== sessions.length) throw new Error("The same vault is listed twice");
    this.client = client;
    this.sessions = [...sessions];
  }

  /** Each vault's asset, read from the vault itself. */
  async vaultAssets(): Promise<Array<{ asset: string; vaultAddress: string }>> {
    const byAsset = await this.#assetMap();
    return [...byAsset].map(([asset, s]) => ({ asset, vaultAddress: s.vaultAddress }));
  }

  /** Probes each candidate once and ranks the offers that one of these vaults can pay, under its asset's cap. */
  async chooseProvider(candidates: ProviderCandidate[], constraints: MultiAssetConstraints): Promise<RouteResult> {
    const assets = await this.#accepted(constraints.caps);
    // The probe carries the most-preferred vault's headers; the purchase sends the paying vault's own.
    const offers = await (await this.#sessionFor(assets[0].asset)).probeProviders(candidates);
    return routeOffers(offers, { assets, maxLatencyMs: constraints.maxLatencyMs, prefer: constraints.prefer });
  }

  /** Buys a routed offer from the vault that holds its asset, pinned to its amount and payee. */
  async purchaseRouted<T = unknown>(
    chosen: RankedOffer,
    options: Omit<PurchaseOptions, "maxPayment" | "expectedPayTo"> = {},
  ): Promise<PurchaseResult<T>> {
    if (chosen.accepted.chainId !== this.client.chainId) {
      throw new Error(`ANE-E-3003: Offer is on eip155:${chosen.accepted.chainId}, not eip155:${this.client.chainId}`);
    }
    return (await this.#sessionFor(chosen.accepted.asset)).purchaseRouted<T>(chosen, options);
  }

  /** Buys from one URL in the most-preferred asset it quotes within that asset's cap. */
  async purchase<T = unknown>(
    url: string,
    options: Omit<PurchaseOptions, "maxPayment" | "expectedPayTo"> & { caps: AssetCap[] },
  ): Promise<PurchaseResult<T>> {
    const { caps, ...purchaseOptions } = options;
    const route = await this.chooseProvider(
      [{ url, method: options.method, headers: options.headers, body: options.body }],
      { caps },
    );
    if (!route.chosen) {
      throw new Error(`ANE-E-3003: No 402 quote is payable from these vaults: ${route.rejected.map((r) => r.reason).join("; ")}`);
    }
    return this.purchaseRouted<T>(route.chosen, purchaseOptions);
  }

  #assetMap(): Promise<Map<string, AgentSession>> {
    this.#byAsset ??= Promise.all(this.sessions.map(async (s) => [await s.vaultAsset(), s] as const)).then((pairs) => {
      const map = new Map<string, AgentSession>();
      for (const [asset, s] of pairs) {
        // Two vaults in one asset would make "which vault pays" a guess.
        if (map.has(asset)) throw new Error(`Vaults ${map.get(asset)!.vaultAddress} and ${s.vaultAddress} both hold ${asset}`);
        map.set(asset, s);
      }
      return map;
    });
    this.#byAsset.catch(() => {
      this.#byAsset = undefined;
    });
    return this.#byAsset;
  }

  async #sessionFor(asset: string): Promise<AgentSession> {
    const session = (await this.#assetMap()).get(toChecksumAddress(asset));
    if (!session) throw new Error(`No vault in this session holds ${toChecksumAddress(asset)}`);
    return session;
  }

  async #accepted(caps: AssetCap[]): Promise<AcceptedAsset[]> {
    if (caps.length === 0) throw new Error("At least one asset cap is required");
    const seen = new Set<string>();
    const accepted: AcceptedAsset[] = [];
    for (const cap of caps) {
      const asset = toChecksumAddress(cap.asset);
      if (seen.has(asset)) throw new Error(`Asset ${asset} has two caps`);
      seen.add(asset);
      await this.#sessionFor(asset);
      accepted.push({ chainId: this.client.chainId, asset, maxAmount: BigInt(cap.maxPayment) });
    }
    return accepted;
  }
}
