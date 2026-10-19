# Functional and nonfunctional requirements

Status values: `P0` public sandbox minimum, `P1` adoption, `P2` expansion. IDs are stable for traceability.

## P0 requirements
- **REQ-001**: Anyone with a compatible wallet can transfer tANE on the designated public EVM testnet without hosted service approval.
- **REQ-002**: Faucet distributes bounded tANE per eligible claimant; abuse mitigation cannot restrict ordinary token transfers.
- **REQ-003**: Owner creates an isolated agent account and funds it; agent never receives owner's root private key.
- **REQ-004**: Delegated spending limited by enforceable balance/authority; overspend and unauthorized withdrawal revert.
- **REQ-005**: Owner can revoke future agent authority and reclaim available funds; define finality and in-flight transaction behavior.
- **REQ-006**: Agent can pay a priced API with signed, replay-resistant payment proof and receive machine-readable result.
- **REQ-007**: Merchant independently verifies payment settlement before providing paid service, or explicitly opts into bounded credit risk.
- **REQ-008**: Merchant can receive tANE and refund under documented semantics; do not promise forced refunds after final transfer.
- **REQ-009**: Python and TypeScript client examples support balances, delegation, payment, receipt verification and transaction history.
- **REQ-010**: OpenAPI/JSON schemas, ABI, addresses, chain ID, source code, versioning and error catalog published.
- **REQ-011**: At least one end-to-end demo performs fund -> buy -> deliver -> earn -> return.
- **REQ-012**: tANE and all public interfaces conspicuously state no cash value, backing, redemption or future conversion.
- **REQ-013**: Separate unstable development environment from stable public sandbox.
- **REQ-014**: Provider-funded real compute has independent per-user, per-service and aggregate cost caps.
- **REQ-015**: Transaction IDs, chain ID, merchant, asset, amount, status and receipt are inspectable without private logs.

## P1 requirements
- **REQ-101**: Service discovery through open metadata and independently indexable listings.
- **REQ-102**: MCP adapter exposing constrained discovery/purchase/balance operations.
- **REQ-103**: Sponsored campaigns with quotas, eligibility, expiry and settlement/accounting separate from tANE supply.
- **REQ-104**: Owner dashboard for wallet creation, budget, earnings, revoke and withdrawals.
- **REQ-105**: Optional gas sponsorship with metered policy and no unlimited subsidy.
- **REQ-106**: Self-hosted facilitator and registry reference implementation.
- **REQ-107**: Fixed and revolving earning modes, with explicit accounting and caps.

## P2 requirements
- **REQ-201**: Escrow/milestone payment flows for asynchronous tasks.
- **REQ-202**: Portable agent identity/reputation and optional validation.
- **REQ-203**: Provider catalog with real capability/latency/price disclosures.
- **REQ-204**: Interoperability with additional assets/rails; no mandatory tANE dependency.

## Nonfunctional acceptance
- **SEC**: security review, invariant/property testing, fuzzing and external assessment before substantial live-value use; public testnet also needs adversarial tests.
- **REL**: publish SLOs for hosted APIs and faucet; provider failures cannot prevent on-chain transfers.
- **OBS**: correlate purchase intent, chain tx, settlement and delivery without leaking secrets.
- **PORT**: SDK test matrix covers supported language/runtime versions and wallet transports.
- **PRIV**: no PII in immutable on-chain metadata; minimize IP/log retention; secrets never logged.
- **DOC**: runnable quickstarts with reproducible testnet setup and documented failure cases.
- **ACC**: web UI keyboard accessible and screen-reader usable.

## Example acceptance journey
Given owner funds an agent with 1,600 tANE and delegates a max total of 320 tANE, when agent pays 16 tANE for a demo endpoint and sells a 32 tANE result, then receipt is verifiable, owner sees balances, and spending beyond the authorized cap is rejected (regardless of agent prompt or earned revenue under fixed mode). Confirm exact cap semantics via ADR.
