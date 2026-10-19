# ADR-0009: Refunds, Idempotency, Asynchronous Delivery, and Escrow Boundary

- **Status:** Proposed (Phase 0 review required)
- **Date and owners:** 2026-10-19 | 16ane Protocol Maintainers
- **Related requirements:** REQ-006, REQ-007, REQ-008, REQ-015, REQ-201
- **Related epics:** E02, E06, E10, E18

## Context
On an EVM chain, a finalized token transfer (`tANE.transfer` or `AneAgentVault.settlePayment`) cannot be unilaterally reversed by the payer (`docs/protocol/PAYMENTS.md` line 18). However, distributed HTTP calls between agents and merchants experience network timeouts, dropped responses, upstream service failures, and asynchronous long-running jobs. We must define exact idempotency semantics, honest refund mechanics (`REQ-008`), and the boundary between P0 synchronous settlement and P2 asynchronous escrow (`REQ-201`).

## Options
1. **Option A: P0 Synchronous Settlement with Mandatory Idempotency-Key + Verifiable On-Chain Refund Reference (`refundPayment`), and P2 Optional Milestone Escrow Contract (`AneTaskEscrow`) for Async Jobs.**
2. **Option B: Mandatory Escrow for All HTTP 402 Calls in P0.**
3. **Option C: Off-Chain IOUs Only.**

## Evidence and sources
- **Repo Specs (`docs/protocol/PAYMENTS.md` lines 14–19, `docs/product/REQUIREMENTS.md` REQ-008 & REQ-201, `examples/SCENARIOS.md` S4):**
  - "A finalized on-chain transfer cannot be reversed unilaterally. Merchant-initiated refund is a new transfer or escrow release. Reference refund to original `payment_id`, show original and refund tx hashes, and disclose partial/nonrefundable cases."
  - Scenario `S4`: "Client times out after confirmed payment; retry with same idempotency key must not cause second charge. Merchant cannot deliver; merchant sends refund transfer with original payment reference."

## Security and legal impacts
- **Honest finality disclosure (`REQ-008`, `THREAT_MODEL.md` #10):** Never claim automatic chargebacks exist for direct transfers. When an agent pays directly via `AneAgentVault.settlePayment`, the merchant holds the `tANE` upon block confirmation; a refund requires the merchant to execute a voluntary refund transfer (or the parties to use `AneTaskEscrow` in P2).
- **Refunding into `AneAgentVault` without corrupting `FIXED` budget accounting:** If an agent spends `16 tANE` from its `320 tANE` fixed budget (`cumulativeSpent = 16`, `authorizedRemaining = 304`) and the merchant immediately refunds `16 tANE` via `AneAgentVault.refundSettledPayment(bytes32 originalPaymentId, uint256 refundAmount)`, should `cumulativeSpent` be restored by `16 tANE`?
  - **Security rule:** Only if `AneAgentVault.refundSettledPayment` verifies on-chain that: (a) `originalPaymentId` was genuinely paid by this vault to `msg.sender` (or for `originalPayment.merchant`), (b) `totalRefunded[originalPaymentId] + refundAmount <= originalPayment.amount`, and (c) `tANE` is atomically transferred from the merchant back into the vault! Because a merchant can only refund up to the exact amount the vault previously paid it (`<= originalPayment.amount`), restoring `cumulativeSpent -= refundAmount` on a verified refund **cannot** be used to inflate `maxTotalSpend` beyond the owner's signed cap!

## Decision
Adopt **Option A**:
1. **Idempotency & Safe Retries (`E06`, P0):**
   - Every paid request includes a deterministic `Idempotency-Key` (defaulting to the `quote_id` + `nonce` of the signed `SpendIntent`).
   - Merchant middleware stores a receipt record keyed by `payment_id = keccak256(chainId, vault, merchant, quoteId, nonce)`.
   - If the client retries with the same `Idempotency-Key` or `PAYMENT-SIGNATURE` after settlement, the merchant checks its receipt store (or on-chain `isPaymentSettled(paymentId)` view), skips re-charging, and returns the cached response (or re-executes idempotent computation) with the original `PAYMENT-RESPONSE` receipt (`SCENARIOS.md` S4).
2. **Verifiable Merchant Refunds (`REQ-008`, `E06`, P0):**
   - `AneAgentVault` exposes `refundPayment(bytes32 paymentId, uint256 amount)`:
     - Checks recorded outbound payment `payments[paymentId]` (`merchant`, `amountPaid`, `amountRefunded`).
     - Requires `amount > 0 && amountRefunded + amount <= amountPaid`.
     - Pulls `amount` of `tANE` from `msg.sender` into `AneAgentVault` via `safeTransferFrom`.
     - Increments `amountRefunded` and decrements `cumulativeSpent` by `amount` (restoring the failed call's budget without ever allowing `cumulativeSpent` to go below `0` or `authorizedRemaining` to exceed `maxTotalSpend`).
     - Emits `PaymentRefunded(address indexed vault, address indexed merchant, bytes32 indexed paymentId, uint256 amount)`.
3. **Asynchronous Escrow Boundary (`REQ-201`, `E18`, P2):**
   - Synchronous HTTP calls (`<= 30s`) use direct `settlePayment`.
   - Long-running asynchronous tasks (`> 30s` or multi-step jobs) use a separate `AneTaskEscrow` contract in Phase 3 (`E18`), where `settlePayment` locks `tANE` in escrow with a `deliveryDeadline`; merchant claims upon submitting a signed delivery receipt, or agent/owner reclaims after `deliveryDeadline` expiry.

## Consequences
- Eliminates double-charging on network timeouts (`SCENARIOS.md` S4).
- Gives merchants a cryptographically verifiable way to refund failed deliveries (`PaymentRefunded` event linked to `paymentId` and original `tx_hash`) that cleanly restores the agent's failed-call budget without opening a wash-trading loophole.

## Alternatives rejected
- **Option B (Mandatory escrow for every synchronous HTTP call):** Doubles gas cost and latency (lock tx + release tx) for simple 2-second API calls.
- **Option C (Raw `tANE.transfer` refund without `paymentId` link):** Leaves no on-chain link to `originalPaymentId` and cannot safely restore the agent's `cumulativeSpent` quota in `FIXED` mode.

## Open risks
- A malicious merchant can still refuse to call `refundPayment` after taking a direct P0 payment; mitigated by explicit documentation (`REQ-008`), low `maxPerTx` caps in `AneAgentVault`, and P2 `AneTaskEscrow` for untrusted/high-value tasks.

## Validation plan
- Foundry test verifying `refundPayment` reverts if `amount > amountPaid - amountRefunded` or if `paymentId` does not exist, and verifying that a valid refund restores `cumulativeSpent` by the exact refunded amount.
- Integration test for Scenario `S4` (timeout retry returns identical receipt with zero second charge; failed delivery triggers `refundPayment` with linked `original_tx_hash` and `refund_tx_hash`).
