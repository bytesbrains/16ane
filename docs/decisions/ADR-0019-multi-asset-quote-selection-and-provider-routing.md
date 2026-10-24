# ADR-0019: Multi-Asset Quote Selection and Provider Routing

- **Status:** Proposed (2026-10-24)
- **Date and owners:** 2026-10-24 | 16ane Protocol Maintainers
- **Related requirements:** REQ-203, REQ-204, REQ-001
- **Related epics:** E20 (ISS-023)
- **Builds on:** ADR-0005 (x402 v2 wire format, `ane-vault-v1` scheme), ADR-0003 and ADR-0004 (vault custody and budget), ADR-0007 (signed manifests). **Supersedes:** nothing.

## Context

ISS-023 asks for three things:
- quote selection parameterized by `(chainId, assetAddress)`, so that no single token is mandatory (REQ-204);
- price and latency comparison across providers (REQ-203);
- for SCENARIOS.md S3, an agent that picks the provider meeting its `(max_price, max_latency, asset)` constraints, with no 6- versus 18-decimal mismatch.

An inventory at `bb58b36` found the following:
- `AneAgentVault` holds exactly one token, `taneToken`, set immutably in its constructor (`src/AneAgentVault.sol:89`). Its budget accounting assumes that token.
- `AgentSession.purchase` (`packages/sdk-ts/src/session.ts`) paid the first `ane-vault-v1` entry in a 402's `accepts`, or `accepts[0]` if there was none. It never compared the entry's `network` or `asset` with the vault.
- `maxPayment` was compared with that entry's `amount` whatever asset the amount was in. A cap meant as 1 tANE (`1e18` base units) would admit a quote of `1e18` base units of a 6-decimal token, which is a trillion units of that token.
- With `verifyReceiptOnChain`, the receipt was checked against `receipt.asset`, which the merchant chooses.
- The Python SDK paid `accepts[0]` unconditionally, and `int()` accepted amounts such as `" 16"` and `"-1"`.
- Nothing in either SDK compared providers.

## Options considered

1. **Option A: Asset-aware selection and routing in the SDKs; vault unchanged.** Every quote is matched to an exact `(CAIP-2 network, token address)` pair, and each pair has its own cap. A router ranks providers by caller-measured price and latency. The vault keeps paying only its own token.
2. **Option B: A multi-asset vault.** A new `AneAgentVault` version would keep a separate budget, cap and revenue account per token. This means new factory wiring, per-asset invariants, a sandbox redeploy, and a fresh security review of the contract that enforces budgets.
3. **Option C: One vault per asset.** Today's factory builds every vault against the registry's single token, so this also needs a new factory or a token parameter.

## Decision

Option A. The maintainer chose it on 2026-10-24 for this issue. Options B and C are deferred (see Consequences).

1. **An asset is a `(chain, address)` pair, matched exactly.** A quote entry matches only when its `network` is `eip155:<chainId>` and its checksummed `asset` equals an accepted asset. The quote's `assetSymbol`, and any decimals it claims, are display text and are ignored.
2. **Each cap belongs to one asset, in that asset's base units.** `AcceptedAsset { chainId, asset, maxAmount, decimals? }` holds one cap per asset. The router never converts between assets and has no price oracle. When offers come in different assets, the caller's list order decides between them, never the raw amounts. Within one asset, offers rank by price and then latency (`prefer: "latency"` reverses this), and ties break by provider id.
3. **Decimals come from the token.** `readAssetDecimals` calls `decimals()` and refuses anything above 36. `parseAssetAmount("1.5", 6)` gives `1500000n` and refuses extra fractional digits instead of rounding. `acceptAsset(client, asset, "2.5")` builds an accepted asset from a cap in whole units.
4. **Amounts must be canonical base-10 integers.** An amount must match `^(0|[1-9]\d*)$` and be below 2^256. Quoted `"1e18"`, `"-1"`, `"0x10"`, `"1.0"`, `" 16"`, `"016"` and JSON numbers are refused, so a malformed quote can never be read as a smaller number.
5. **A vault session pays only its vault's token.** `AgentSession.vaultAsset()` reads `taneToken()` from the vault itself, once. `purchase` pays the cheapest `ane-vault-v1` entry in that token on the client's chain. If there is none, it throws `ANE-E-3003` before signing anything. `verifyReceiptOnChain` checks the transfer against the vault's token, not the receipt's. The Python SDK's `purchase` applies the same rule through `select_vault_requirement`.
6. **Latency is measured by the caller, not claimed by the provider.** `probeOffer` sends the same request the purchase will send, minus `payment-signature`, `x-payment` and `x-trial-request`, so a probe can neither pay nor spend a sponsored trial. It records how long the 402 quote took to arrive. Callers can replace that figure with their own measurements, such as past purchase times. The signed manifest format (ADR-0007) is unchanged: a latency field in it would be the provider's own unverifiable claim, and adding one would change the signed hash in every verifier.
7. **A routed purchase is pinned to the quote that won.** `AgentSession.chooseProvider` probes the candidates and ranks the offers this vault can pay. `purchaseRouted(chosen)` then buys with `maxPayment` set to the winning amount and `expectedPayTo` set to the winning payee. A provider cannot win the ranking with one quote and charge with another: a higher price fails with `ANE-E-3002`, and a different payee fails with `ANE-E-5003`. Either way the failure comes before any payment.
8. **Quote text is untrusted.** Rejection reasons quote provider fields as JSON strings cut to 48 characters, because they can reach logs and LLM context through MCP (THREAT_MODEL.md).

## Consequences and limitations

- **REQ-204 is only partly met.** The router, the quote matcher and the merchant verifier (`assetAddress` per endpoint) are asset-agnostic. A 16ane vault, however, can still pay only tANE, so a vault-funded agent cannot yet buy in another token. Removing that limit needs Option B or C, with its own ADR and a vault redeploy (follow-up). *Update: ADR-0020 (#133) took Option C as one factory per asset, which needs no vault redeploy.*
- **Probe latency is a lower bound.** It measures the network and the provider's quote path, not the time to perform the work. Providers that answer quotes fast and work slowly will look better than they are, until callers feed in their own measurements.
- **Each probe is an extra unpaid request.** A probe adds no protocol rate limit (it follows the agent-speed principle in #61 and #62), but a provider is free to rate-limit its own quotes. A probe that fails or returns something unreadable is reported in `rejected` with its reason, never silently dropped.
- **The probe quote and the purchase quote are separate requests.** Pinning bounds the price and payee. A provider that refuses or raises its price at purchase time is not retried automatically. The caller can try the next entry in `ranked`.
- **Error codes.** `ANE-E-3003` (no payable quote) is new. `ANE-E-3002` (over the cap) and `ANE-E-5003` (payee mismatch) keep their meanings.
- **Out of scope:** cross-chain bridges and fiat rails (excluded by the issue); a router in the Python SDK; MCP tools, CLI and dashboard support for routing; provider-declared latency in manifests.

## Validation

- `packages/sdk-ts/test/routing.test.ts` checks:
  - amount parsing and formatting without rounding, and decimals read from the token;
  - an 18-decimal cap never admitting a 6-decimal quote;
  - refusal of the wrong chain, the wrong scheme and non-canonical amounts, with provider text truncated;
  - asset preference ordering within one envelope and across offers;
  - the S3 acceptance cases (cheapest, latency-bounded, latency-preferred, too tight, unmeasured);
  - a probe that strips payment and trial headers, times the 402, and reports what it could not read;
  - `purchase` refusing foreign-asset, foreign-chain and malformed quotes before signing, and paying the vault-token entry even when it is not listed first;
  - `purchaseRouted` refusing a raised price or a changed payee.
- `e2e/flows/provider-routing.test.ts` runs S3 on Anvil with SDK-built sellers. It checks:
  - with no latency bound, the cheaper seller wins;
  - with a latency bound, the faster seller wins, and the routed purchase pays it exactly its quote, verified on-chain;
  - a foreign-asset seller is refused;
  - with no seller under the cap, nothing is paid;
  - a seller that raises its price after winning the route is refused, with the vault's spendable balance and the seller's balance unchanged.
- `packages/sdk-py/tests/test_sdk.py` (`TestVaultQuoteSelection`) checks the same selection rule, and that `purchase` refuses a foreign-asset quote before signing.
