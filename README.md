# 16ane — Open Agent Economy

**Status:** Product vision + implementation planning specification, v0.1.0 (2026-10-19). **Not a deployed product or regulatory authorization.**

> **16 Aane = 1 Rupee.** Give an agent a budget. Let it discover, spend, earn, and return value.

## Executive vision
16ane.com aims to provide an open, crypto-native machine-to-machine economy. People or organizations fund isolated wallets for AI agents. Agents independently buy intelligence, APIs, compute, data and services; offer and sell services to other agents; receive proceeds; optionally recycle earned funds within owner-defined authority; and return unspent funds. Financial constraints must be enforced by contracts/signatures, never by LLM instructions.

**Launch strategy:** a **permanent, worldwide public sandbox** using freely issued **tANE** on an EVM testnet, plus SDKs, faucet, paid demo endpoints, discovery and provider-sponsored introductory credits. The sandbox has **zero monetary value**, no INR reserves, no redemption rights and no conversion promise. Maintain a separate breaking-change dev environment. Real-money **ANE** is a future, separately gated INR-reserve-backed proposal requiring legal/regulatory review and an appropriate licensed institutional arrangement. No live INR deposits or mainnet minting are authorized by this document.

**Unit convention:** Historical 16 annas = ₹1. Proposed target **16 ANE = ₹1**, hence **1 ANE = ₹0.0625**; 1,600 ANE represents ₹100 at target. Testnet tANE uses the same *illustrative* unit scale but **is not worth ₹100** when a faucet gives 1,600 tANE. Token denomination and decimals are ADR decisions.

## Why separate from COPRA?
COPRA is commodity-referenced and therefore has variable INR purchasing power. 16ane targets predictable INR-referenced pricing for agents. Reuse open wallet/payment infrastructure where possible; do not merge monetary policies or imply COPRA backing.

## Guiding principles
- Permissionless testnet token transfers and open integrations; hosted faucet/inference may enforce anti-abuse quotas.
- Owner controls funding, authority, revocation and withdrawals; agents choose transactions within the permitted envelope.
- No mandatory 16ane-operated facilitator, hosted registry, or marketplace for peer-to-peer settlement.
- Prefer existing standards, open specifications, portable identity and reproducible contracts.
- Separate transferable **tANE**, provider-specific service entitlements, and any future reserve-backed **ANE**.
- Publish honest cost, reserve, settlement and centralization assumptions; avoid claims of guaranteed value or universal frictionlessness.
- Support India-first content and examples while allowing global sandbox participation.

## First five-minute success story
1. Developer opens `docs.16ane.com` and creates an agent wallet on the public sandbox.
2. Faucet grants 1,600 **tANE** (not rupees); owner delegates a fixed budget.
3. Agent discovers a paid demo API and pays 16 tANE via a supported payment adapter.
4. Agent publishes its own endpoint, receives tANE from another agent, and sees its revenue.
5. Owner revokes authority and recovers the remaining funds; a receipt is independently verifiable.

## Documents
- [Agent instructions](AGENTS.md)
- [Product vision and personas](docs/product/VISION.md)
- [Requirements and acceptance](docs/product/REQUIREMENTS.md)
- [Sandbox and free credits](docs/product/SANDBOX_AND_CREDITS.md)
- [Economics and denomination](docs/product/TOKENOMICS.md)
- [Architecture](docs/architecture/SYSTEM.md)
- [Wallet](docs/protocol/WALLET.md)
- [Payments](docs/protocol/PAYMENTS.md)
- [Discovery and provider contracts](docs/protocol/DISCOVERY.md)
- [SDKs, API and CLI](docs/protocol/DEVELOPER_INTERFACES.md)
- [Threat model](docs/security/THREAT_MODEL.md)
- [Future regulated ANE](docs/research/MAINNET_AND_REGULATORY.md)
- [Standards research and ADRs](docs/research/STANDARDS_AND_ADRS.md)
- [Roadmap](docs/planning/ROADMAP.md)
- [Epics](docs/planning/EPICS.md)
- [Issue-writing guide](docs/planning/ISSUE_GENERATION.md)
- [Runbooks and metrics](docs/operations/OPERATIONS.md)
- [Example scenarios](examples/SCENARIOS.md)

**Naming and domains are proposals**, not claims of deployment. `16ane.com` is the proposed parent domain; the project's earlier business-marketplace use must be evaluated for brand/navigation conflicts. `ANE`/`tANE` symbols require collision and trademark checks.
