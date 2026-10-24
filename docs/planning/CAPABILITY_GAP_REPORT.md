# Capability Gap Report and Standards Audit (`E01`)

- **Date Checked:** 2026-10-19
- **Target Repository:** `bytesbrains/16ane` (commit `53f0ee8`)
- **Reference Sibling Repository:** [`bytesbrains/copra`](https://github.com/bytesbrains/copra/tree/465dd8be027c27eada5fcd83aa69f893eb1037bb) (commit `465dd8be027c27eada5fcd83aa69f893eb1037bb`)
- **Out-of-Scope Repository:** the legacy `16ane` marketplace codebase (separate and not public) (ignored per maintainer instruction and `ADR-0014`)

---

## 1. Current Repository State (`bytesbrains/16ane` @ `53f0ee8`)

The `16ane-agent-economy` repository currently contains **planning specifications and governance documentation only** (23 files, 0 lines of executable smart contract, SDK, CLI, or backend code):
- Root governance: `README.md`, `AGENTS.md`, `LICENSE-NOTE.md`, `assets/16ane_logo.png`.
- Product specifications: `docs/product/VISION.md`, `docs/product/REQUIREMENTS.md` (`REQ-001`–`REQ-204` + nonfunctional `SEC`, `REL`, `OBS`, `PORT`, `PRIV`, `DOC`, `ACC`), `docs/product/SANDBOX_AND_CREDITS.md`, `docs/product/TOKENOMICS.md`.
- Architecture & protocol specs: `docs/architecture/SYSTEM.md`, `docs/protocol/WALLET.md`, `docs/protocol/PAYMENTS.md`, `docs/protocol/DISCOVERY.md`, `docs/protocol/DEVELOPER_INTERFACES.md`.
- Research, security & operations: `docs/research/STANDARDS_AND_ADRS.md`, `docs/research/MAINNET_AND_REGULATORY.md`, `docs/security/THREAT_MODEL.md`, `docs/operations/OPERATIONS.md`.
- Planning & issue templates: `docs/planning/ROADMAP.md`, `docs/planning/EPICS.md`, `docs/planning/ISSUE_GENERATION.md`, `examples/SCENARIOS.md`, `.github/ISSUE_TEMPLATE/feature.yml`, `.github/ISSUE_TEMPLATE/research.yml`.
- **Open GitHub Issues:** `0` (verified on `bytesbrains/16ane`).

---

## 2. Reusable Engineering Evidence from Sibling `copra` Repo (`465dd8be027c27eada5fcd83aa69f893eb1037bb`)

Per `README.md` ("Reuse open wallet/payment infrastructure where possible; do not merge monetary policies or imply COPRA backing"), we audited [`bytesbrains/copra`](https://github.com/bytesbrains/copra/tree/465dd8be027c27eada5fcd83aa69f893eb1037bb):

| Capability Area | `copra` Evidence (File Paths & Revisions) | Reusability in `16ane-agent-economy` | Gaps to Fill for `16ane` |
|---|---|---|---|
| **Foundry & Deterministic Builds** | `foundry.toml` (lines 1–12: `solc_version = "0.8.28"`, `bytecode_hash = "none"`, `cbor_metadata = false`), `foundry.lock` (`forge-std v1.17.0`, `openzeppelin-contracts v5.7.0`) | **Direct Reuse:** Identical compiler and bytecode settings guarantee deterministic `CREATE2` addresses across Anvil and Base Sepolia (`ADR-0001`). | Add contract targets for `tANE`, `AneAgentVault`, `AneVaultFactory`, `AneFaucet`, `AneServiceDirectory`. |
| **On-Chain Deployment Registry** | `src/CopraRegistry.sol` (lines 1–64), `script/DeployCopra.s.sol` (lines 21–151) | **Adaptable Pattern:** `Ownable2Step` deterministic `CREATE2` registry with on-chain cross-contract wiring assertions (`setDeployment`) and mainnet chain-ID refusal guards (`require(block.chainid != 8453)`). | Rename to `AneRegistry` with salt `keccak256("16ane.registry.sandbox.v1")` (`ADR-0014`) and register `(taneToken, vaultFactory, faucet, serviceDirectory)`. |
| **ERC-20 Token & Faucet** | `src/CopraToken.sol` (lines 1–52), `src/testnet/TestnetUSDC.sol` (lines 1–35) | **Partial Skeleton Only:** Basic OpenZeppelin v5.7.0 `ERC20` / `ERC20Burnable`. | `TestnetUSDC` has 6 decimals, no cooldown/rate-limit, and neither contract implements **EIP-2612 (`ERC20Permit`)** or **EIP-3009 (`transferWithAuthorization`)** required by `ADR-0002` and `ADR-0005`. |
| **Vault / Custody Math** | `src/CopraVault.sol` (lines 1–223) | **Pattern Reference Only:** `Ownable2Step`, `ReentrancyGuard`, `SafeERC20`, and `Math.mulDiv` / `ceilDiv` patterns. | `CopraVault` is a collateral-to-commodity mint/redeem vault. `16ane` needs **`AneAgentVault`** (`ADR-0003`, `ADR-0004`) enforcing per-agent delegated spending caps, `FIXED` vs `REVOLVING` revenue isolation, owner revocation, and EIP-712 `SpendIntent` settlement. |
| **Web & Cloudflare Hosting** | `wrangler.jsonc` (lines 1–10), `web/_headers` (lines 1–16), `scripts/web-env.cjs` (lines 1–95), `web/assets/quote.js`, `web/assets/chain.js`, `web/assets/wallet.js` | **High Reuse for UI/Security Headers:** Strict CSP, security headers, `networks/<env>.json` generator, EIP-1193 wallet connection, and Node `vm` unit tests (`test/web/`). | `copra` is static-assets-only; `16ane` additionally needs backend/self-hostable services for gasless faucet relay, x402 facilitator, reference paid demo APIs, and sponsor quota metering (`E05`, `E06`, `E10`, `E14`). |
| **CI, Secret Scanning & E2E Stack** | `.gitleaks.toml`, `test/gitleaks/allowlist.test.sh`, `.githooks/pre-commit`, `.githooks/pre-push`, `scripts/check-committed-files.sh`, `.github/workflows/test.yml`, `e2e/docker-compose.yml` | **Direct Reuse:** SHA-pinned GitHub Actions, gitleaks 32-byte key scanner with 20-byte address allowlist, committed-file hygiene checks, and containerized Anvil + Playwright E2E harness. | Extend E2E scenarios (`e2e/scenarios/`) to run 16ane reference scenarios `S1`–`S6` (`examples/SCENARIOS.md`). |

---

## 3. Missing Capabilities Inventory (Must Be Built in `16ane-agent-economy`)

| Capability | Requirement IDs | Target Epic | Current Status | Priority |
|---|---|---|---|---|
| **`tANE` Smart Contract (18 decimals, EIP-2612, EIP-3009, explicit no-value metadata)** | REQ-001, REQ-010, REQ-012 | E03 | Missing | P0 |
| **`AneAgentVault` & `AneVaultFactory` (isolated treasury, fixed/revolving caps, revoke, withdraw, refund)** | REQ-003, REQ-004, REQ-005, REQ-008, REQ-107 | E04, E17 | Missing | P0 (Fixed) / P1 (Revolving) |
| **`AneFaucet` Contract & Gasless Relayer API (cooldowns, daily cap, Turnstile/challenge)** | REQ-002, REQ-012, REQ-105 | E05 | Missing | P0 |
| **x402 v2 Payment Adapter, `ane-vault-v1` + `exact` Verifier, Idempotency & Receipt Engine** | REQ-006, REQ-007, REQ-008, REQ-015 | E06 | Missing | P0 |
| **Python SDK (`16ane` client, wallet delegation, x402 auto-pay, receipt verification)** | REQ-009, REQ-010, REQ-PORT | E07 | Missing | P0 |
| **TypeScript SDK (`@16ane/sdk` client + merchant HTTP 402 middleware)** | REQ-009, REQ-010, REQ-PORT | E08 | Missing | P0 |
| **CLI (`ane`) & 5-Minute Developer Quickstart** | REQ-009, REQ-011, REQ-012, REQ-DOC | E09 | Missing | P0 |
| **Reference Paid Demo Services (deterministic zero-cost endpoints + merchant sample)** | REQ-006, REQ-007, REQ-011, REQ-014 | E10 | Missing | P0 |
| **CI/CD, `.gitleaks.toml`, Foundry Invariant Suite & Observability SLOs** | REQ-013, REQ-SEC, REQ-REL, REQ-OBS, REQ-PRIV | E11 | Missing in this repo (adaptable from `copra`) | P0 |
| **Signed Service Manifest (`/.well-known/16ane-service.json` + A2A AgentCard) & `AneServiceDirectory`** | REQ-101, REQ-203 | E12 | Missing | P1 |
| **MCP Server Adapter (`list_services`, `get_quote`, `wallet_balance`, `purchase_service`, etc.)** | REQ-102 | E13 | Missing | P1 |
| **Sponsored Trial Campaign & Real-Compute Quota Engine** | REQ-014, REQ-103 | E14 | Missing | P1 |
| **Owner & Provider Web Dashboard (`app.16ane.com` static + wallet UI)** | REQ-104, REQ-ACC | E15 | Missing | P1 |
| **Self-Hostable x402 Facilitator & Manifest Indexer Package** | REQ-001, REQ-106 | E16 | Missing | P1 |
| **Asynchronous Task Escrow Contract (`AneTaskEscrow`)** | REQ-201 | E18 | Implemented (#21); not yet deployed to the public sandbox | P2 |
| **ERC-8004 Portable Agent Identity & Reputation Adapter** | REQ-202 | E19 | Implemented (#22): identity and payment-backed reputation in the TS SDK against the canonical registries; Validation Registry deferred (ADR-0018) | P2 |
| **Multi-Asset / Cross-Rail Payment Adapter** | REQ-204 | E20 | Partial (#23): asset-aware quote selection and S3 provider routing in the SDKs; the vault still pays only tANE, multi-asset vault deferred (ADR-0019) | P2 |
| **India-First Multilingual Guides & Hackathon Kit** | REQ-DOC | E21 | Missing | P1 |
| **Future Regulated INR `ANE` Feasibility & Legal Questionnaire** | — (`MAINNET_AND_REGULATORY.md`) | E22 | Research only (`BLOCKED-LEGAL`) | Research |

---

## 4. Primary Standards Verification Summary (Checked 2026-10-19)

| Standard | Primary Source URL | Status / Version Checked | Key Technical Finding for 16ane |
|---|---|---|---|
| **ERC-20** | `https://eips.ethereum.org/EIPS/eip-20` | Final | Baseline fungible token interface for `tANE`. |
| **EIP-2612** | `https://eips.ethereum.org/EIPS/eip-2612` | Final | Enables gasless `permit()` approvals for one-tx vault funding and Permit2 setup (`ADR-0002`). |
| **EIP-3009** | `https://eips.ethereum.org/EIPS/eip-3009` | Final | `transferWithAuthorization` / `receiveWithAuthorization` uses random `bytes32` nonces; required for concurrent x402 `exact` payments without sequential nonce collisions (`ADR-0002`, `ADR-0005`). |
| **x402** | `https://www.x402.org/` & `https://github.com/coinbase/x402` | v2 Active Spec | Uses `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE` headers and CAIP-2 `eip155:84532`. Default hosted Coinbase CDP facilitator only supports USDC; `16ane` must provide its own self-hostable facilitator + direct merchant verification (`ADR-0005`). |
| **ERC-4337** | `https://eips.ethereum.org/EIPS/eip-4337` | Draft (EntryPoints v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da03` & v0.8 `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` live on `84532`) | Requires external bundler infrastructure (`eth_sendUserOperation`) and `IERC1271.isValidSignature` is a read-only `STATICCALL` that cannot increment `cumulativeSpent`. Dedicated `AneAgentVault` clones (`ADR-0003`) enforce policy state directly without bundler lock-in. |
| **EIP-7702** | `https://eips.ethereum.org/EIPS/eip-7702` | Final / Live on `84532` | Delegating an owner EOA exposes root assets (`REQ-003` violation), EOA private keys cannot be revoked by an owner (`REQ-005` violation), and `ecrecover` in EIP-3009 bypasses EIP-7702 code (`ADR-0003`). |
| **ERC-8004** | `https://eips.ethereum.org/EIPS/eip-8004` | Draft (Created 2025-08-13) | Defines Identity, Reputation, and Validation registries. Still in Draft status (re-checked 2026-10-24; canonical v2.0.0 registries live on `84532`, ADR-0018) and vulnerable to Sybil wash-trading on free testnets; positioned as optional P2 adapter (`ADR-0007`, `E19`). |
| **MCP** | `https://modelcontextprotocol.io/specification/` | Spec `2026-07-28` (and `2025-06-18` / `2025-03-26`) | JSON-RPC 2.0 `stdio` and `Streamable HTTP` transports map cleanly to constrained 16ane purchase/discovery tools (`E13`). |
| **A2A** | `https://a2a-protocol.org/latest/specification/` | v1.0 | Standardizes `/.well-known/agent-card.json` with JWS signatures and `capabilities.extensions[]`, aligning with `DISCOVERY.md` service manifests (`ADR-0007`). |
| **Base Sepolia** | `https://docs.base.org/chain/network-information` | Active Public Testnet (`84532`) | 2s block time, `https://sepolia.base.org` / `https://base-sepolia-rpc.publicnode.com`, `https://sepolia.basescan.org` (`ADR-0001`). |

---

## 5. Extracted Non-Goals and Open Questions

### Explicit Non-Goals (`docs/product/VISION.md`, `AGENTS.md`, `README.md`)
1. No monetary value, INR backing, redemption right, or `tANE -> ANE` conversion promise in the sandbox.
2. No profit guarantee, speculative token marketing, token listings, or investment claims.
3. No unrestricted free inference; provider-sponsored compute is strictly bounded by off-chain quotas independent of `tANE` holdings.
4. No mandatory 16ane-operated facilitator, registry, or custodial wallet for peer-to-peer transfers and settlement.
5. No automated resolution of subjective off-chain service quality disputes or forced chargebacks after finalized direct transfers.
6. No live INR deposits, mainnet token deployment, or legal advice in this repository.

### Resolved vs. Open Questions
- **Technical questions (`ADR-0001` through `ADR-0014`):** Drafted and proposed in `docs/decisions/ADR-0001-*.md` through `ADR-0014-*.md` for maintainer review prior to P0 implementation.
- **Regulatory and institutional questions (`E22`, `docs/research/MAINNET_AND_REGULATORY.md`):** Remain open legal questions for independent Indian legal counsel and prospective licensed financial institutions (`BLOCKED-LEGAL`); do not block the unbacked `tANE` public sandbox.
