# ADR-0005: HTTP Payment Protocol, x402 Compatibility, and Settlement Finality

- **Status:** Proposed (Phase 0 review required)
- **Date and owners:** 2026-10-19 | 16ane Protocol & SDK Maintainers
- **Related requirements:** REQ-006, REQ-007, REQ-008, REQ-015, REQ-106
- **Related epics:** E02, E06, E07, E08, E10, E16

## Context
Agents need a standard, machine-readable HTTP payment protocol to discover endpoint prices, sign replay-resistant payment proofs within their owner-delegated budget (`REQ-006`), allow merchants to independently verify settlement before delivering service (`REQ-007`), and produce inspectable receipts (`REQ-015`) without relying on a mandatory 16ane-hosted facilitator (`REQ-001`, `REQ-106`).

## Options
1. **Option A: x402 v2 Protocol (`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` headers) Supporting Both `exact` (EIP-3009) and `ane-vault-v1` (Bounded `AneAgentVault` Spend Intent) Schemes, with Self-Hostable Facilitator + Direct Merchant Verification.**
2. **Option B: Reliance on Coinbase Hosted CDP x402 Facilitator Only.**
3. **Option C: Bespoke Custom HTTP Payment Headers Unrelated to x402.**

## Evidence and sources
- **x402 Specification & Repo (`https://www.x402.org/`, `https://github.com/coinbase/x402`, `https://docs.cdp.coinbase.com/x402/welcome`):** Checked 2026-10-19.
  - x402 v2 uses HTTP status `402 Payment Required` with Base64-encoded JSON headers: `PAYMENT-REQUIRED` (challenge), `PAYMENT-SIGNATURE` (client payment payload), and `PAYMENT-RESPONSE` (settlement receipt).
  - Network identifier uses CAIP-2 (`eip155:84532` for Base Sepolia).
  - Facilitator REST surface uses `POST /verify`, `POST /settle`, and `GET /supported`.
  - **Crucial limitation verified:** Coinbase's hosted CDP facilitator restricts Base / Base Sepolia settlement to Circle USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) and rejects custom ERC-20 tokens like `tANE`. Furthermore, pure EIP-3009 `transferWithAuthorization` cannot enforce sub-balance spending caps on a smart vault via `STATICCALL` (`IERC1271.isValidSignature`), as documented in `ADR-0003`.

## Security and legal impacts
- **Replay resistance (`REQ-006`, `THREAT_MODEL.md`):** Every payment authorization binds `chainId` (`84532`), `verifyingContract` (`AneAgentVault` or `tANE`), `merchant` (`payTo`), `amount`, `quoteId`, `serviceIdHash`, `validAfter`, `validBefore` (expiry deadline), `nonce` (random `bytes32`), and `policyVersion`.
- **Idempotency on network timeout (`PAYMENTS.md`, `SCENARIOS.md` S4):** Clients send an `Idempotency-Key` header alongside `PAYMENT-SIGNATURE` (or derive idempotency from `(payer, quoteId, nonce)`). If a client retries after settlement succeeded but HTTP delivery timed out, the merchant recognizes the settled `nonce`/`quoteId` and returns the cached response and receipt without double-charging.
- **No mandatory facilitator (`REQ-001`, `REQ-007`):** A merchant can settle payments in three ways:
  1. **Direct On-Chain Settlement (Self-Relayed):** Merchant server calls `vault.settlePayment(...)` or `tANE.transferWithAuthorization(...)` directly via its own Base Sepolia RPC.
  2. **Client-Settled Proof (`txHash` proof):** Agent submits the transaction on-chain itself and passes the `txHash` + signed quote binding in `PAYMENT-SIGNATURE`; merchant verifies the confirmed transaction receipt and `PaymentSettled` event directly on Base Sepolia RPC (zero relayer gas cost to merchant!).
  3. **Self-Hosted or Community x402 Facilitator (`REQ-106`):** Merchant delegates `/verify` and `/settle` to a self-hosted 16ane x402 facilitator container.

## Decision
Adopt **Option A**:
1. **Wire Format:** Conform to **x402 v2** HTTP headers (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`) and JSON payload structures, plus backward-compatible header aliases (`X-PAYMENT-REQUIRED`, `X-PAYMENT`, `X-PAYMENT-RESPONSE`) and `Idempotency-Key`.
2. **Supported Payment Schemes on `eip155:84532`:**
   - **`ane-vault-v1` (Default for Bounded Agent Wallets):** `agentSigner` signs an EIP-712 `SpendIntent` for its `AneAgentVault`. Settlement executes `AneAgentVault.settlePayment(intent, signature)` (either via facilitator/merchant relayer or pre-broadcast by the agent with `txHash` verification), atomically enforcing `maxTotalSpend`, `maxPerTx`, `expiry`, and `FIXED`/`REVOLVING` accounting (`REQ-004`).
   - **`exact` (EIP-3009 Direct Token Authorization):** Supported natively by `tANE` (`transferWithAuthorization`) for compatible x402 tools when paying from an account whose entire `tANE` balance equals its spend budget.
3. **Finality Policy (`REQ-007`):**
   - **Tier 1 (Sandbox Demo / Micro-calls <= 160 tANE):** Sequencer confirmation (`1` confirmed block on Base Sepolia, ~2 seconds) with valid `PaymentSettled` / `Transfer` event log and unspent `quoteId`.
   - **Tier 2 (High-value / Owner Withdrawal / Escrow):** Configurable confirmation depth (`N` blocks or L1 `safe` tag).
4. **Verifiable Receipt Schema (`REQ-015`):**
   - Returned in `PAYMENT-RESPONSE` (Base64 JSON) and response body metadata: `receipt_id`, `quote_id`, `service_id`, `network` (`eip155:84532`), `asset` (`tANE` address), `payer_vault`, `agent_signer`, `merchant`, `amount_base_units`, `tx_hash`, `block_number`, `settled_at`, `delivery_hash` (SHA-256 of response payload), and `merchant_signature`.

## Consequences
- Full structural compatibility with the x402 v2 HTTP lifecycle (`402` -> sign -> retry -> `200` + receipt) while solving the two hard problems that stock x402 leaves open: custom ERC-20 support (`tANE`) and on-chain sub-balance budget enforcement (`AneAgentVault`).
- Client-settled (`txHash`) mode allows any developer to run a paid merchant API on Cloudflare Workers or FastAPI without holding relayer ETH on the server, while facilitator mode supports gasless agents.

## Alternatives rejected
- **Option B (Coinbase CDP Facilitator only):** Fails immediately because the hosted CDP facilitator only accepts USDC and violates `REQ-001` (no mandatory hosted dependency).
- **Option C (Custom non-x402 headers):** Loses ecosystem interoperability with x402 middleware and SDK tooling.

## Open risks
- Clock skew between agent and merchant could cause premature `validBefore` expiry; mitigated by allowing a 60-second clock-skew grace window on `validAfter` and minimum 5-minute quote TTLs.

## Validation plan
- Integration tests for all failure cases in `docs/protocol/PAYMENTS.md` (insufficient vault budget, expired quote, wrong chain/asset, wrong merchant recipient, replayed nonce, duplicate request with same `Idempotency-Key`, and direct RPC verification when facilitator is offline).
