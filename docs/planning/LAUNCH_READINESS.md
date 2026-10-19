# Launch-Readiness Report and Assumptions Register

- **Date:** 2026-10-19
- **Current Phase:** Phase 1 `P0` Sandbox Implementation Complete & Verified Locally (`forge test`, `@16ane/sdk`, `ane_sdk`, `ane` CLI, and E2E Scenarios `S1`–`S6` passing)
- **Repository Revision:** `bytesbrains/16ane`

---

## 1. Launch-Readiness Gate Matrix (`PASS` / `FAIL` / `UNKNOWN`)

Per `AGENTS.md` ("Never claim endpoints, contracts, package names, audit results, partner approvals, reserves, token listings or regulatory permissions already exist... Do not make up benchmarks, audits, integrations or transaction counts"), the table below records the **honest, factual state** of every gate as of 2026-10-19:

### Gate Group A — Phase 0 Planning & Architecture Readiness

| Gate ID | Gate Description | Status | Evidence / Blocker |
|---|---|---|---|
| **G0-01** | Product vision, personas, and explicit non-goals documented | **PASS** | `README.md`, `docs/product/VISION.md` |
| **G0-02** | Functional (`REQ-001`–`REQ-204`) and nonfunctional (`SEC`–`ACC`) requirements defined | **PASS** | `docs/product/REQUIREMENTS.md` |
| **G0-03** | Repository & sibling `copra` capability/gap audit completed with file/commit citations | **PASS** | `docs/planning/CAPABILITY_GAP_REPORT.md` (audited `copra` @ `465dd8be`) |
| **G0-04** | Primary standards researched with source URLs, date checked (2026-10-19), and Base Sepolia (`84532`) support verified | **PASS** | `docs/planning/CAPABILITY_GAP_REPORT.md` |
| **G0-05** | All 14 ADRs (`ADR-0001`–`ADR-0014`) drafted with security/legal impacts and validation plans | **PASS** | `docs/decisions/ADR-0001-*.md` through `ADR-0014-*.md` |
| **G0-06** | Dependency-ordered epics (`E01`–`E22`), actionable issues (`ISS-001`–`ISS-024`), and traceability matrix created | **PASS** | `docs/planning/EPIC_DEPENDENCY_GRAPH.md`, `docs/planning/PROPOSED_ISSUES.md`, `docs/planning/TRACEABILITY.md` |
| **G0-07** | Maintainer review and ratification of Phase 0 ADRs & P0 backlog (`AGENTS.md` Step 7) | **PASS** | Ratified on 2026-10-19 (`ADR-0001`–`ADR-0014` Accepted) |

### Gate Group B — Phase 1 Public Sandbox Launch Gates (`P0`)

| Gate ID | Gate Description | Status | Evidence / Blocker |
|---|---|---|---|
| **G1-01** | Secret scanning (`.gitleaks.toml`), git hooks, and CI workflow active in repo | **PASS** | `.gitleaks.toml`, `.githooks/`, `scripts/check-committed-files.sh`, `.github/workflows/test.yml` (`ISS-003`) |
| **G1-02** | `AneRegistry` and `tANE` (`AneTestToken.sol`) implemented, tested, and verified for Base Sepolia (`84532`) | **PASS** | `src/AneRegistry.sol`, `src/AneTestToken.sol`, `script/DeploySandbox.s.sol`, `test/AneTestToken.t.sol`, `test/AneRegistry.t.sol` (`ISS-004`, `ISS-005`) |
| **G1-03** | `AneAgentVault` & `AneVaultFactory` enforcing `FIXED` budget cap, revenue isolation, revoke, withdraw, and refund | **PASS** | `src/AneAgentVault.sol`, `src/AneVaultFactory.sol`, `test/AneAgentVault.t.sol`, `test/AneAgentVault.invariant.t.sol` (`ISS-006`) |
| **G1-04** | All 10 security tests from `docs/security/THREAT_MODEL.md` automated and passing in CI | **PASS** | `test/AneAgentVault.t.sol`, `test/AneAgentVault.invariant.t.sol`, `packages/sdk-ts/test/sdk.test.ts`, `e2e/run-scenarios.ts` (`ISS-006`, `ISS-008`, `ISS-013`) |
| **G1-05** | `AneFaucet` on-chain cooldowns/caps and bounded gasless claim endpoint live | **PASS** | `src/AneFaucet.sol`, `test/AneFaucet.t.sol`, `services/sandbox-server/src/server.ts` (`POST /v1/faucet/claims`) (`ISS-007`) |
| **G1-06** | x402 v2 payment verification (`ane-vault-v1` & `exact`), idempotency, and verifiable receipts implemented | **PASS** | `packages/sdk-ts/src/merchant.ts`, `schemas/*.schema.json`, `e2e/run-scenarios.ts` (`ISS-008`) |
| **G1-07** | Runnable Python SDK (`16ane-sdk`, import `ane_sdk`), TypeScript SDK (`@16ane/sdk`), and `ane` CLI passing E2E | **PASS** | `packages/sdk-ts/`, `packages/sdk-py/`, `packages/cli/bin/ane.mjs`, `e2e/run-scenarios.ts` (`ISS-009`, `ISS-010`, `ISS-012`) |
| **G1-08** | Deterministic zero-cost paid demo endpoints (`/v1/demo/summarize`, `/v1/demo/clean-data`, `/v1/demo/simulate-failure`) and Scenarios `S1`–`S6` passing | **PASS** | `services/sandbox-server/src/demo.ts`, `e2e/run-scenarios.ts` (`ISS-011`, `ISS-013`, `ISS-014`) |
| **G1-09** | Conspicuous `"TEST TOKENS (tANE) - NO CASH VALUE"` disclosures verified across contract, CLI, SDK, and docs (`REQ-012`) | **PASS** | `AneTestToken.sol` (`name = "16ane Sandbox (NO CASH VALUE)"`, `disclaimer()`), `SANDBOX_DISCLAIMER` in SDKs, CLI, and server responses (`ISS-005`, `ISS-011`, `ISS-012`) |
| **G1-10** | Direct RPC transfer & verification proven without relying on a hosted facilitator (`REQ-001`, `REQ-005`, Scenario `S5`) | **PASS** | `AgentSession.purchase({ settleDirectOnChain: true, verifyReceiptOnChain: true })` and `ane receipt verify` verified in `e2e/run-scenarios.ts` (`S5`) |
| **G1-11** | Operational runbooks, incident contact (`SECURITY.md`), and OpenAPI v1 contract published | **PASS** | `docs/operations/OPERATIONS.md`, `SECURITY.md`, `openapi/v1.yaml` (`ISS-013`) |

### Gate Group C — Future Regulated Real-Money `ANE` Track (`E22` — `BLOCKED-LEGAL`)

| Gate ID | Gate Description | Status | Evidence / Blocker |
|---|---|---|---|
| **G2-01** | Independent Indian legal opinion on RBI / PSS Act / PPI / VDA / FEMA / Tax classification (`MAINNET_AND_REGULATORY.md`) | **UNKNOWN** | Open legal questions documented (`ADR-0012`, `ISS-024`); requires external legal counsel engagement |
| **G2-02** | Licensed bank / payment institution partnership and ring-fenced reserve custody agreement | **FAIL** | No institutional partner agreement exists (`AGENTS.md` authority boundary) |
| **G2-03** | External independent smart contract security audit and formal verification for production value | **FAIL** | No audit exists; mainnet deployment strictly prohibited (`AGENTS.md`) |

---

## 2. Assumptions Register

| ID | Category | Assumption Statement | Impact if False | Verification / Mitigation Action | Status |
|---|---|---|---|---|---|
| **ASM-001** | Chain & Infra | Base Sepolia (`eip155:84532`) remains an active, publicly accessible OP Stack testnet with 2s block times and working public RPCs (`https://sepolia.base.org`, `https://base-sepolia-rpc.publicnode.com`). | Public sandbox would need to migrate to an alternate EVM testnet (e.g., Ethereum Sepolia `11155111` or OP Sepolia `11155420`). | Parameterize `chainId` and `AneRegistry` across all contracts, SDKs, and manifests; maintain deterministic `CREATE2` deploy scripts (`ADR-0001`). | Verified active on 2026-10-19 |
| **ASM-002** | Protocol (`x402`) | Coinbase's hosted CDP x402 facilitator restricts Base Sepolia settlement to Circle USDC and does not natively settle arbitrary custom ERC-20 tokens like `tANE`. | If relied upon blindly, `tANE` x402 payments would fail. | Verified on 2026-10-19 (`CAPABILITY_GAP_REPORT.md`). Mitigated in `ADR-0005` by providing a self-hostable 16ane x402 facilitator + direct merchant RPC verification + client-settled `txHash` proof mode. | Verified & mitigated in `ADR-0005` |
| **ASM-003** | Smart Contracts | `IERC1271.isValidSignature` is invoked via a read-only EVM `STATICCALL` during EIP-3009 `transferWithAuthorization`, so a smart contract wallet cannot mutate its `cumulativeSpent` counter inside `isValidSignature`. | Relying on stateless `IERC1271` signatures for sub-balance agent allowances would let an agent sign parallel EIP-3009 authorizations draining the entire vault balance (`REQ-004` violation). | Verified in EVM / EIP-1271 spec. Mitigated in `ADR-0003` and `ADR-0005` by routing bounded agent spends through state-updating `AneAgentVault.settlePayment(SpendIntent, sig)`. | Verified & mitigated in `ADR-0003` |
| **ASM-004** | Economics & Quotas | Because `tANE` is free (`REQ-002`), Sybil attackers can accumulate arbitrarily large `tANE` balances over time across multiple wallets. | Any provider offering real AI/compute trials priced solely in `tANE` without off-chain compute quotas would suffer real financial loss. | Mitigated in `ADR-0008` (`REQ-014`, `REQ-103`): P0 demo endpoints are 100% deterministic/zero-cost (`ISS-011`), and P1 sponsored endpoints enforce atomic per-wallet and global dollar cost caps independent of `tANE` balance (`ISS-016`). | Mitigated in `ADR-0008` |
| **ASM-005** | Toolchain Reuse | Foundry (`solc 0.8.28`), OpenZeppelin Contracts (`v5.7.0`), `forge-std` (`v1.17.0`), `.gitleaks.toml`, and Docker Compose E2E patterns from `/Users/nandal/Desktop/desk/repos/copra` (`465dd8be`) can be cleanly adapted under the MIT License. | Would require configuring build/test tooling from scratch if incompatible. | Verified in `copra` audit (`CAPABILITY_GAP_REPORT.md` Section 2) and `ADR-0013` (MIT License). | Verified on 2026-10-19 |
| **ASM-006** | Standards (`ERC-8004`) | `ERC-8004` (Trustless Agents) remains a Draft ERC whose ABI may evolve before finalization, and on-chain reputation on a free-token testnet is vulnerable to wash trading. | Hardcoding P0 discovery on ERC-8004 could cause breaking ABI churn and misleading trust signals. | Verified on 2026-10-19 (`https://eips.ethereum.org/EIPS/eip-8004` is `Draft`). Mitigated in `ADR-0007` by using signed HTTPS manifests (`/.well-known/16ane-service.json` + A2A v1.0 `/.well-known/agent-card.json`) and `AneServiceDirectory` for P0/P1, keeping ERC-8004 as an optional P2 adapter (`ISS-022`). | Verified & mitigated in `ADR-0007` |
| **ASM-007** | Legal & Regulatory | Unbacked, non-redeemable, non-convertible testnet tokens (`tANE`) used strictly for software testing and developer education with conspicuous `"NO CASH VALUE"` disclosures are distinct from regulated payment instruments, while any future INR-referenced `ANE` requires formal legal counsel review and a licensed institutional arrangement. | Misleading marketing or blurring `tANE` and `ANE` could create regulatory or consumer-protection risk. | Mitigated by hard technical and branding air-gap in `ADR-0012`, mandatory disclaimers (`REQ-012`), and keeping `E22` strictly `BLOCKED-LEGAL`. | Enforced via `ADR-0012` |
