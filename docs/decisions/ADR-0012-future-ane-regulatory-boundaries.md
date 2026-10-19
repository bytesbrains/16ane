# ADR-0012: Future Regulated ANE Boundaries and Sandbox Isolation

- **Status:** Proposed — `BLOCKED-LEGAL` for any real-value implementation (Sandbox-only isolation rules active immediately)
- **Date and owners:** 2026-10-19 | 16ane Maintainers & External Legal Counsel (Future Track)
- **Related requirements:** REQ-012, REQ-103
- **Related epics:** E02, E22

## Context
16ane's long-term vision explores whether a future INR-referenced token (`16 ANE = ₹1`) could be issued in partnership with an appropriately licensed financial institution (`docs/research/MAINNET_AND_REGULATORY.md`, `docs/product/TOKENOMICS.md`). However, `AGENTS.md` strictly mandates:
- "`tANE` is **free, simulated and worthless**: never advertise it as ₹-backed, redeemable, investable or convertible to ANE."
- "Never assert that reserve attestations are cryptographic proof of a bank balance."
- "Any regulatory interpretation must be presented as an open legal question, not legal advice."
- "Do not execute real-value deployments, accept INR, create tradable mainnet tokens, or handle private keys without explicit maintainer authorization."

## Options
1. **Option A: Strict Technical, Contractual, and Branding Air-Gap Between Public Sandbox (`tANE`) and Future Research Track (`E22`), Gating Any Mainnet/INR Code Behind External Legal Opinion and Licensed Institutional Partnership (`BLOCKED-LEGAL`).**
2. **Option B: Building Mainnet Mint/Redeem/Bridge Contracts Now Ahead of Legal & Institutional Sign-Off.**
3. **Option C: Allowing Testnet `tANE` Balances to Convert or Qualify for Future `ANE` Allocations.**

## Evidence and sources
- **Repo Policy (`AGENTS.md`, `README.md`, `docs/research/MAINNET_AND_REGULATORY.md`, `docs/product/TOKENOMICS.md`):**
  - Explicitly forbids live INR deposits, mainnet minting, bridging `tANE` to `ANE`, or presenting regulatory discussions as legal advice.
- **Sibling `copra` Mainnet Safety Guard (`/Users/nandal/Desktop/desk/repos/copra/script/DeployCopra.s.sol` line 76 & `script/DeployCopraMainnet.s.sol` line 132):**
  - Demonstrates programmatic chain-ID refusal (`require(block.chainid != 8453)`) in testnet deployment scripts and `_hasNoFaucet` refusal checks.

## Security and legal impacts
- **Open legal questions requiring independent Indian legal counsel (`docs/research/MAINNET_AND_REGULATORY.md` lines 16–24, NOT legal advice):**
  1. Permissibility and licensing classification under Reserve Bank of India (RBI) rules, Payment and Settlement Systems Act, 2007 (PSS Act), Master Directions on Prepaid Payment Instruments (PPIs), or Virtual Digital Asset (VDA) frameworks.
  2. Entity structure for legal issuance, redemption liability, bankruptcy-remote INR reserve custody, and customer insolvency protection.
  3. Applicability of Prevention of Money Laundering Act (PMLA) / FIU-IND registration, KYC/AML/CFT obligations, Income Tax Act Section 194S (1% TDS on VDA transfers) and Section 115BBH, GST, and FEMA cross-border transfer restrictions.
- **Technical air-gap:** No smart contract, SDK method, CLI command, or documentation page in the sandbox repository may implement fiat deposit intake, bank webhook minting, mainnet token deployment, or `tANE -> ANE` conversion/bridging.

## Decision
Adopt **Option A**:
1. **Complete Technical Separation:**
   - All P0/P1/P2 engineering in this repository targets only the unbacked testnet sandbox (`tANE`).
   - Deployment scripts (`DeploySandbox.s.sol`) enforce `require(block.chainid == 84532 || block.chainid == 31337, "SandboxTestnetOnly")`.
   - No `bridge`, `redeemForINR`, `convertToANE`, or fiat on-ramp endpoints may be built.
2. **Mandatory Disclaimers (`REQ-012`):**
   - Every UI view, CLI output (`ane wallet balance`, `ane faucet claim`, `ane pay`), SDK README, and token contract metadata must display: `"TEST TOKENS (tANE) — SIMULATED SANDBOX ONLY — NO CASH VALUE, NO INR BACKING, NO REDEMPTION OR CONVERSION."`
3. **`E22` Research Gate (`BLOCKED-LEGAL`):**
   - Epic `E22` produces only a structured legal-counsel questionnaire, institutional partner requirements brief, and conceptual reserve/redemption risk register (`docs/research/MAINNET_AND_REGULATORY.md`). No production code for `ANE` may be merged unless and until qualified legal sign-off, institutional authorization, and external security audits are completed.

## Consequences
- Developers, educators, and AI providers can safely use and contribute to the global `tANE` sandbox immediately without regulatory ambiguity or financial compliance exposure.
- Clear, auditable checklist of open questions prepared for future discussions with legal counsel and licensed financial institutions.

## Alternatives rejected
- **Option B (Speculative mainnet/INR contract implementation):** Violates `AGENTS.md` authority boundaries and risks building non-compliant workflows before legal/banking requirements are known.
- **Option C (`tANE` conversion/airdrop promises):** Violates `AGENTS.md` line 16, `TOKENOMICS.md` line 8, and `MAINNET_AND_REGULATORY.md` line 29.

## Open risks
- Third-party users or unofficial forks attempting to wrap or trade `tANE` on testnet/DEX pools; mitigated by explicit contract metadata (`"16ane Sandbox Test Token (NO CASH VALUE)"`), unrestricted faucet minting (`REQ-002` renders `tANE` abundant and valueless), and prominent UI/docs warnings.

## Validation plan
- Automated CI lint check verifying required no-value disclaimers exist in CLI, web UI, and README, and verifying `DeploySandbox.s.sol` reverts on mainnet chain IDs (`1`, `8453`, `10`, `42161`, `137`).
