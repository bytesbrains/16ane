# ADR-0014: Brand, Domain, and Token Symbol Isolation

- **Status:** Accepted (Scoped per maintainer confirmation on 2026-10-19)
- **Date and owners:** 2026-10-19 | 16ane Maintainers
- **Related requirements:** REQ-010, REQ-012, REQ-013
- **Related epics:** E01, E02

## Context
`README.md` (the "Naming and domains are proposals" note) and `docs/research/STANDARDS_AND_ADRS.md` (the `ADR-014` entry) note that `16ane.com` had an earlier unrelated business-marketplace codebase (legacy `16ane`, separate and not public) and require evaluating brand/domain isolation and symbol collisions (`tANE` / `ANE`), as well as clear separation from the commodity-referenced `COPRA` protocol ([`bytesbrains/copra`](https://github.com/bytesbrains/copra/tree/465dd8be027c27eada5fcd83aa69f893eb1037bb)).

## Options
1. **Option A: Complete Clean-Slate Code & Navigation Separation from Legacy `16ane` Marketplace Repo + Distinct Subdomain/Contract Namespace for the 16ane Open Agent Economy + Explicit Separation from `COPRA`.**
2. **Option B: Merging Code or Sharing Databases/Contracts with Legacy `16ane` or `COPRA`.**

## Evidence and sources
- **Maintainer Direction (2026-10-19):** Confirmed that the legacy `16ane` marketplace codebase (separate and not public) is unrelated to the current 16ane Open Agent Economy vision and must be ignored, while [`bytesbrains/copra`](https://github.com/bytesbrains/copra/tree/465dd8be027c27eada5fcd83aa69f893eb1037bb) (commodity-referenced crypto on Base) may be referenced strictly for reusable engineering patterns.
- **Repo Spec (`README.md`, "Why separate from COPRA?" and the "Naming and domains are proposals" note):**
  - "COPRA is commodity-referenced and therefore has variable INR purchasing power. 16ane targets predictable INR-referenced pricing for agents. Reuse open wallet/payment infrastructure where possible; do not merge monetary policies or imply COPRA backing."
- **Proposed Subdomain Topology (`docs/protocol/DEVELOPER_INTERFACES.md` lines 6–15):**
  - `16ane.com`, `docs.16ane.com`, `app.16ane.com`, `faucet.16ane.com`, `api.16ane.com/v1`, `registry.16ane.com`, `pay.16ane.com`, `mcp.16ane.com`, `status.16ane.com`.

## Security and legal impacts
- **Zero shared state with legacy `16ane`:** Do not import code, database schemas, user tables, or credentials from the legacy `16ane` marketplace codebase (separate and not public). When `16ane.com` DNS is pointed to the Open Agent Economy landing page, retire or redirect any legacy marketplace paths so users are never confused about the product's purpose.
- **Zero monetary coupling with `COPRA`:** While `16ane-agent-economy` adapts Foundry scripts, `Registry` patterns, CSP headers, and Docker E2E test harnesses from `copra`, `16ane` uses its own independent `CREATE2` registry salt (`keccak256("16ane.registry.sandbox.v1")`), its own contracts (`tANE`, `AneAgentVault`), and never implies `COPRA` backing or cross-collateralization.
- **Symbol collision avoidance:** On-chain clients, SDKs, and x402 quotes always identify `tANE` by its canonical `(chainId, contractAddress)` tuple (`eip155:84532:<tANE_ADDRESS>`) resolved from `AneRegistry`, never by ticker string `"tANE"` alone.

## Decision
Adopt **Option A**:
1. **Legacy `16ane` Repo Ignored:** Treat `bytesbrains/16ane` as a clean-slate repository with zero code, state, or navigation dependencies on the legacy `16ane` directory.
2. **Engineering Pattern Reuse from `copra` Only:** Reuse battle-tested infrastructure patterns from `copra` (Foundry `0.8.28` deterministic build config, `Ownable2Step` registry pattern, `.gitleaks.toml`, `.githooks`, Docker Compose Anvil + Playwright E2E harness, Cloudflare static security headers) with completely independent contract names, salts, and deployments.
3. **Canonical Asset Identification:** All protocols (`x402`, service manifests, SDKs, CLI) identify `tANE` by CAIP-19 / CAIP-2 chain ID + verified contract address (`eip155:84532/<address>`) rather than relying on ticker symbol uniqueness.

## Consequences
- Clean boundary between `16ane-agent-economy`, `copra`, and legacy projects.
- Eliminates ticker-spoofing attacks where an attacker deploys a fake token named `"tANE"` on Base Sepolia.

## Alternatives rejected
- **Option B (Sharing contracts, registries, or web origins with legacy `16ane` or `copra`):** Would create brand confusion, security coupling, and muddled accounting.

## Open risks
- Cached search engine results or old links pointing to `16ane.com` legacy paths; mitigated by returning explicit `410 Gone` or redirecting legacy routes to the new sandbox overview with clear product positioning.

## Validation plan
- Verify `AneRegistry` uses a distinct `CREATE2` salt (`keccak256("16ane.registry.sandbox.v1")`) from `copra`'s `keccak256("copra.registry.v1")`.
- Verify SDK and facilitator reject any token whose contract address does not match the registered `tANE` address in `AneRegistry`, even if its `symbol()` returns `"tANE"`.
