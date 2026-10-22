# ADR-0017: High-Frequency Settlement via Vault-Native Cumulative Vouchers

- **Status:** Proposed (2026-10-22)
- **Date and owners:** 2026-10-22 | 16ane Protocol Maintainers
- **Related requirements:** REQ-001, REQ-004, REQ-005, REQ-006, REQ-007, REQ-008, REQ-015
- **Related epics:** E02, E06
- **Supersedes:** nothing. **Amends:** REQ-015's receipt shape (addendum below, no breaking change to settled receipts).

## Context

After #61 the protocol adds no payment-path limits, so the remaining ceiling is the chain: every x402 payment today is one `AneAgentVault` settlement transaction on Base Sepolia. An agent making many small calls per second pays one transaction's gas and latency per call. #62 asks how an agent can pay at its own speed while the vault still enforces the owner's budget on-chain, under four constraints: (1) settled spend never exceeds the budget, across merchants and outstanding authorizations; (2) revocation stops new spending immediately, with explicit outstanding-authorization semantics; (3) merchant risk is bounded and disclosed; (4) settlement stays verifiable without a hosted facilitator (REQ-001, REQ-005).

Two existing facts shape the answer. First, `AneAgentVault.settlePayment` already binds every off-chain authorization to `policyVersion`, and both `revoke()` and `rotateAgentSigner()` bump `policyVersion` (`src/AneAgentVault.sol`), so any voucher design that binds the same field gets immediate, on-chain invalidation of outstanding authorizations for free. Second, REQ-007 already licenses the model: a merchant may "explicitly opt into bounded credit risk" instead of verifying settlement before serving.

## Options

1. **Option A (recommended): vault-native cumulative vouchers.** The agent signs cumulative off-chain vouchers per merchant; merchants verify locally, serve immediately, and settle the latest voucher on-chain periodically through a new vault entry point that reuses the existing policy checks.
2. **Option B: adopt x402 `batch-settlement` (EVM) with tANE escrow.** Use the canonical `x402BatchSettlement` escrow, per-merchant channels, and standard facilitator tooling.
3. **Option C: x402 `upto` per-request authorizations.** Buyer signs a per-request maximum; seller settles actual usage.
4. **Option D (deferred): per-merchant funded streams inside the vault.** Reserve a per-merchant allocation from spendable balance; vouchers draw down only the reservation.

## Evidence and sources (checked 2026-10-22)

- **x402 payment schemes overview (`https://docs.x402.org/schemes/overview`):** four schemes exist — `exact` (fixed price), `upto` (per-request max, settle actual), `batch-settlement` (high-volume micropayments against a reusable channel), `auth-capture` (escrow hold/release). `upto` and `batch-settlement` support the `authorization` flow only: verify before serving, settle after.
- **`upto` (`https://docs.x402.org/schemes/upto`):** one settlement per request; the seller chooses a final amount up to the signed maximum via settlement overrides. Solves metering, not throughput.
- **`batch-settlement` (`https://docs.x402.org/schemes/batch-settlement`):** EVM binding uses stateless unidirectional payment channels: one escrow deposit (EIP-3009 or Permit2, facilitator-sponsored), cumulative off-chain vouchers per request, batched on-chain claims of the latest voucher per channel, a separate settle sweep to the receiver, cooperative refunds, and timed-withdrawal escape hatches (`withdrawDelay`, 15 min–30 days). Voucher signing may be delegated to a dedicated EOA committed as `payerAuthorizer` (fast ECDSA verification instead of an EIP-1271 check). TS and Go SDKs ship it; Python planned (FAQ, same site).
- **EVM spec (`https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement_evm.md`):** `channelId = EIP712Hash(ChannelConfig)`; channel tracks `balance` and `totalClaimed`; vouchers carry cumulative `maxClaimableAmount` (monotonic, old vouchers superseded, no nonces); `Voucher`/`Refund`/`ClaimBatch` use distinct EIP-712 type hashes against cross-replay; **vouchers carry no expiry** — claimable while escrow remains; over-claiming up to the signed ceiling is "a trust violation, not a protocol violation"; timed withdrawal lets the payer reclaim `balance - totalClaimed` after the delay. Canonical `x402BatchSettlement` deployment is CREATE2-deterministic; requires EIP-1153 chains.
- **Cantina audit of x402 batch settlement, May 2026 (secondary: search-result snippet only; PDF not independently read):** flags that any signed voucher stays valid for the channel's full lifetime and that no on-chain primitive invalidates outstanding vouchers without fully withdrawing and migrating to a new channel. Treat as directionally consistent with the spec's no-expiry rule, not as a verified finding.
- **Adoption caveat (secondary: `https://www.fretchen.eu/agent-onboarding/`):** the EVM wire binding is effectively defined by `@x402/evm` code rather than a ratified cutoff, and ecosystem adoption is thin. Interop value today is moderate, not decisive.

## Decision

Adopt **Option A**: vault-native cumulative vouchers settled through `AneAgentVault`.

### 1. Voucher format (EIP-712, agent-signed, off-chain)

```solidity
struct Voucher {
    address vault;              // must equal address(this) at settle time
    address merchant;           // the paid endpoint's payTo
    uint256 cumulativeAmount;   // total the merchant may have claimed after this voucher
    uint256 validBefore;        // short expiry (hours, not days); no validAfter
    uint64  policyVersion;      // must equal the vault's current policyVersion
    bytes32 serviceIdHash;      // scope of the calls this voucher covers
}
```

- Signed by `agentSigner` under the vault's existing EIP-712 domain with a **new struct typehash** (`Voucher(...)`), so a voucher can never replay as a `SpendIntent` and vice versa (mirroring the x402 distinct-typehash rule).
- Cumulative within `(vault, merchant, policyVersion)`: each request's voucher sets `cumulativeAmount = previouslyVouchered + thisCallMax`. No nonces: monotonicity supersedes old vouchers, as in x402.
- `validBefore` is mandatory and short. It bounds the merchant's claim window and the oversell window (section 5). Unlike x402 vouchers, ours expire.

### 2. Settlement entry point (one transaction per merchant per batch window)

New `settleVoucher(Voucher calldata v, bytes calldata signature)`:

1. Checks `v.vault == address(this)`, `v.policyVersion == policyVersion`, `block.timestamp < v.validBefore`, and ECDSA recovery to `agentSigner`.
2. Computes `delta = v.cumulativeAmount - claimedCumulative[v.merchant]` (treating a new `policyVersion` epoch or a first voucher as zero claimed); reverts `NothingToClaim` unless `delta > 0`, which makes replays and stale vouchers revert without state changes.
3. Calls the **existing** `_executeSpend` with `amount = delta` and claim-scoped ids derived as `keccak256(vault, merchant, policyVersion, cumulativeAmount)` (domain-separated for `quoteId` vs `nonce`), so every claim reuses the deployed uniqueness, limit, ceiling, balance, accounting, refund-record, and event machinery unchanged.

Limit semantics are therefore unchanged and need no new policy surface: `active`, `expiry`, `maxPerTx`, daily limit, and the authorized ceiling all apply to the **claim amount**. Consequences, stated explicitly:

- A merchant whose accumulated delta would exceed `maxPerTx` splits its claims; with `maxPerTx = 0` (none, per #61) claims are unbounded. Batch size is owner-controlled through existing knobs.
- Per-request increments are verified **off-chain by the merchant** against mirrored policy (serve a request only if the voucher delta respects `maxPerTx` and headroom); the contract enforces the claim totals. A merchant that serves an over-limit increment cannot claim it — its loss, disclosed in section 5.
- Daily limits accrue across a day's claims exactly as across today's per-call settlements.

No escrow is created and no capital is locked: unclaimed value never leaves the vault, so expiry and revocation need no refund path — the funds were never moved.

### 3. Merchant verification without a facilitator (REQ-001, REQ-007)

A merchant verifies each voucher with local cryptography plus public reads, mirroring x402's EOA fast path with our `agentSigner` as the committed key:

1. ECDSA-recover the voucher: signer must equal the vault's `agentSigner` (one `eth_call`, cached per `policyVersion`).
2. Mirror policy: `policyVersion`, `active`, `expiry`, `cumulativeSpent`, ceiling, and `claimedCumulative[merchant]` must leave headroom for the new cumulative; `maxPerTx` bounds each increment.
3. Monotonicity: `cumulativeAmount` strictly exceeds the last voucher seen from this vault.

No hosted 16ane service is consulted. A merchant that serves on a verified-but-unclaimed voucher is exercising REQ-007's "explicitly opts into bounded credit risk" — the bounds are section 5.

### 4. Revocation, rotation, withdrawal (REQ-005)

- `revoke()` / `revokeWithSig()` / `rotateAgentSigner()` bump `policyVersion` (and revoke clears `active`): **outstanding vouchers become unsettleable immediately** — strictly stronger than x402 batch-settlement, which has no on-chain voucher invalidation (see audit note above).
- The owner may `withdraw()` available balance at any time; a later claim that exceeds the remaining balance reverts (`InsufficientVaultBalance`) like any underfunded settlement today.
- Honouring rule, stated explicitly per #62: an outstanding voucher is honoured **only** if claimed before its `validBefore`, before any revocation/rotation/expiry, and within the remaining budget and balance at claim time (**first-settle-wins** across merchants). Anything else is merchant loss under section 5, never a vault debt.

### 5. Merchant risk: bounds and disclosure (the core accepted risk)

The vault guarantees **settled spend never exceeds the budget** unconditionally (existing `_executeSpend` checks run on every claim). What the vault cannot guarantee without locking capital is that every *served* call gets *claimed*: vouchers outstanding to merchant A and merchant B can jointly exceed the remaining budget, and the later claim reverts. This cross-merchant oversell is inherent to any no-escrow off-chain authorization and is the exact risk #62 names. Bounds:

1. **Serve-at-risk exposure caps (merchant-side, mandatory to configure):** stop serving a vault past $X unclaimed; the reference merchant implementation ships a default and refuses to run unbounded.
2. **Short voucher TTL:** merchants require `validBefore` within a bounded horizon (recommended hours) and claim well inside it; expiry voids the voucher with no on-chain trace needed.
3. **Vault-state mirroring:** serve only while mirrored headroom (`ceiling - cumulativeSpent`, token balance) covers the new cumulative; re-check on a cadence the merchant chooses against its risk appetite.
4. **Claim promptly:** claim cadence must beat voucher TTL and any plausible revocation reaction time; unclaimed value at revoke/expire/withdraw is lost.
5. **Disclosure:** merchants must disclose voucher acceptance, TTL policy, exposure caps, and that unclaimed value is at risk; the sandbox docs carry the same disclosure for agents choosing voucher-accepting endpoints.

Trigger to revisit: evidence of systematic merchant losses, or mainnet readiness work, reopens **Option D** (per-merchant reservations) — the lockup cost buys exactly this risk away.

### 6. Receipts addendum (REQ-015, backward compatible)

- Per-request responses carry a **quasi-receipt**: `settled: false`, voucher `cumulativeAmount`, merchant, and the claim linkage (`vault`, `policyVersion`); no `tx_hash` is claimed.
- Each claim emits the standard `Spent` event and mints a standard settlement receipt whose `quoteId`/`paymentId` derive from the claim scope (section 2), linking one claim to its covered voucher range.
- Indexers join quasi-receipts to claim receipts on `(vault, merchant, policyVersion, cumulative range)`. Settled-receipt consumers see no format change.

### 7. x402 wire shape (new scheme, existing lifecycle)

- New scheme name `ane-voucher-v1` in `accepts`, alongside `ane-vault-v1`/`exact`; same `402 → PAYMENT-SIGNATURE → PAYMENT-RESPONSE` lifecycle and facilitator `/verify`–`/settle` split (verify = section 3 checks; settle = submit `settleVoucher`).
- `PAYMENT-SIGNATURE` carries `{ voucher, signature }` per request; `PAYMENT-RESPONSE` carries the quasi-receipt; `extra` advertises voucher terms (max TTL accepted, claim cadence). Full payload schemas are an implementation-issue deliverable, not this ADR.

## Security and legal impacts

Threat additions (also appended to `docs/security/THREAT_MODEL.md`):

- **Cross-merchant voucher oversell:** a compromised agent double-commits budget across merchants; later claims revert. Mitigated by merchant exposure caps, TTLs, and mirroring (section 5); vault-level guarantee (settled ≤ budget) holds regardless. No silent budget expansion: accounting equations unchanged.
- **Stale-mirror serving:** a merchant serving on outdated vault state over-extends credit. Mitigated by mandatory re-mirror cadence in the reference implementation; worst case is bounded by its own exposure cap.
- **Revocation/rotation voiding served calls:** by design (section 4); bounded by TTL + claim cadence; disclosed, not silent.
- **Over-claiming is protocol-impossible** (stronger than x402's trust-based actuals): claims pay `signedCumulative - claimed`, so a merchant cannot inflate beyond what the agent signed, and increments are agent-signed.
- **Voucher replay / cross-replay:** same-voucher resubmission and old vouchers revert on `delta <= 0`; distinct EIP-712 struct typehash prevents `SpendIntent`↔`Voucher` cross-replay (mirrors x402's typehash separation).
- **Agent-key compromise:** attacker-signed vouchers are bounded by the remaining budget, TTL, and immediate revocation — equivalent to today's compromised-signer exposure, minus per-call friction.
- **No new legal surface:** tANE stays valueless testnet scrip; cumulative accounting changes no monetary promise. Mainnet ANE re-examines section 5 under `BLOCKED-LEGAL`.

## Consequences

- Agents pay at request speed with zero per-call chain latency; merchants trade immediate finality for bounded, disclosed credit risk with periodic claims.
- One new vault entry point plus per-merchant claimed tracking; all policy, accounting, refund, and event machinery reused — the smallest contract delta of the options.
- New merchant obligations (mirroring, exposure caps, claim cadence, durable latest-voucher storage like x402's per-channel state) become reference-implementation and docs work, not consensus work.

## Alternatives rejected

- **Option B (x402 `batch-settlement` with tANE escrow):** rejected as the primary design. Per-merchant escrow deposits fragment the owner-global budget (moving budget between merchants needs on-chain refund + deposit); funding escrow from vault custody has no clean path (the vault cannot EIP-3009-sign as an EOA, and Permit2 approval from a contract owner is awkward); our facilitator would need full tANE batch-settlement support anyway (CDP serves USDC only per ADR-0005), which is comparable work without the budget-model fit; and x402's lack of voucher invalidation plus 15-minute-to-30-day withdrawal delays directly conflicts with REQ-005's immediate revocation and reclaim. Borrowed instead: cumulative vouchers, distinct typehashes, authorizer-role thinking.
- **Option C (`upto`):** rejected for throughput — it still settles on-chain once per request. Passed to follow-ups as a possible metering scheme for single usage-based calls, orthogonal to this ADR.
- **Option D (per-merchant funded streams):** deferred, not rejected. Reservations eliminate cross-merchant oversell but add funding/close transactions and locked-capital UX per merchant relationship. Revisit trigger: merchant-loss evidence or mainnet readiness (section 5).

## Open risks

- First-settle-wins under adversarial multi-merchant oversell is accepted for the sandbox; quantify with the validation e2e before any mainnet conversation.
- Facilitator economics for submitting third-party claims (gas sponsorship policy) are undefined; default is merchants/self-relay submit their own claims (no new relayer dependency).
- `ane-voucher-v1` is 16ane-specific wire format; ecosystem facilitators will not serve it until/unless proposed upstream.

## Validation plan

- Contract tests: claim-delta math, replay/stale-voucher reverts, revoke/rotate/expiry voiding, oversell revert with budget intact, `maxPerTx`/daily/ceiling enforcement on claims, per-epoch claimed reset, `SpendIntent`↔`Voucher` cross-replay rejection, fuzzed cumulative monotonicity.
- E2E scenario: N high-frequency requests across two merchants, one claim each, one oversold claim reverting, revocation voiding the rest; receipts join quasi→claim.
- Threat-model tests for the additions above.

## Follow-up implementation issues (proposed)

1. `[contract][security] Implement vault voucher settlement (settleVoucher, claimed tracking, delta math)` — contract change + Foundry tests from the validation plan.
2. `[sdk] Voucher signing, verification, and claim helpers (TS + Python)` — EIP-712 voucher type, merchant-side mirror/verify, claim submission, quasi-receipt types.
3. `[infra][docs] Reference merchant voucher policy: mirroring, exposure caps, claim cadence, durable voucher store` — merchant guide + sample implementation.
4. `[sdk][docs] Register ane-voucher-v1 across the x402 lifecycle (accepts, PAYMENT-SIGNATURE/RESPONSE, facilitator verify/settle, receipt addendum)` — wire schemas + docs.
5. `[demo][security] High-frequency e2e scenario + voucher threat tests` — N-requests/one-claim flows, oversell/revoke/expiry cases.
6. `[research] Revisit per-merchant reservations (Option D) on merchant-loss evidence or mainnet readiness` — blocked on data, not scheduled.
