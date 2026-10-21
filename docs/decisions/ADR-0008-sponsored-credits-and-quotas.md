# ADR-0008: Provider-Sponsored Introductory Credits and Quota Accounting

- **Status:** Accepted (2026-10-19); amended 2026-10-20 (#61)
- **Date and owners:** 2026-10-19 | 16ane Product & Infrastructure Maintainers
- **Related requirements:** REQ-012, REQ-014, REQ-103
- **Related epics:** E02, E10, E14, E15

## Context
In the 16ane public sandbox, `tANE` is free and worthless (`REQ-012`). However, AI labs and API providers want to offer real or simulated sandbox trials priced in `tANE` without exposing themselves to unbounded real compute bills when Sybil bots farm `tANE` (`docs/product/SANDBOX_AND_CREDITS.md`, `docs/product/TOKENOMICS.md`). `REQ-014` mandates independent per-user, per-service, and aggregate real-compute cost caps, and `REQ-103` requires sponsored campaigns with quotas, eligibility, expiry, and accounting strictly separate from `tANE` supply.

## Options
1. **Option A: Off-Chain Atomic Quota Gatekeeper (Cloudflare Durable Objects / SQLite or Redis/Postgres Reference Middleware) Enforced Before & Alongside On-Chain `tANE` Settlement, Plus Deterministic Zero-Cost Fallback Demo Endpoint.**
2. **Option B: On-Chain ERC-20 Quota Tokens Minted Per Provider.**
3. **Option C: Relying on `tANE` Faucet Rate Limits Alone to Bound Provider Compute.**

## Evidence and sources
- **Repo Specifications (`docs/product/SANDBOX_AND_CREDITS.md`, "Provider-sponsored trials" to "Demonstration requirements"; `docs/product/TOKENOMICS.md`, "tANE: public sandbox only" and "Separate accounting systems"):**
  - Five separate accounting systems must never be conflated: (1) `tANE` balance, (2) Delegated allowance, (3) Provider service quota, (4) Revenue, (5) Future ANE reserve liability.
  - "A user with 1M tANE still cannot bypass provider compute limits."
  - "Provide deterministic simulated endpoint so demonstration survives sponsor outages."
- **Operations Runbook (`docs/operations/OPERATIONS.md`, "Runbooks": sponsor budget exceeded):**
  - "Sponsor budget exceeded: immediately stop real compute while retaining simulated settlement and refund policy."

## Security and legal impacts
- **Faucet farming cannot drain sponsor compute (`THREAT_MODEL.md`, "High-priority abuse cases": faucet farming):** Even if an attacker accumulates millions of `tANE` across 1,000 wallets over months, the provider's campaign middleware enforces hard atomic counters on `provider_cost_budget_usd_micros` (aggregate real compute cost), `max_calls_per_wallet_per_day`, `max_tokens_per_request`, and `concurrency_limit` **before** invoking any upstream paid LLM/compute API.
- **No charge on quota rejection:** Quota checks execute during the HTTP `402` quote phase **and** immediately prior to calling `settlePayment`. If a campaign's real-compute budget is exhausted, the merchant returns `429 Too Many Requests` / `503 SponsorQuotaExhausted` **before** settling `tANE`, so the agent's `tANE` is not taken for an undeliverable sponsored call (or if client-settled, triggers an immediate documented refund/fallback per `ADR-0009`).
- **Truthful disclosure (`AGENTS.md`, "Invariants and prohibitions"):** Every sponsored response header and receipt includes `sponsor_campaign_id`, `is_simulated`, `remaining_wallet_quota`, and `"TEST TOKENS — NO CASH VALUE"`.

## Decision
Adopt **Option A**:
1. **Two Distinct Reference Demo Tiers (`E10`, `E14`):**
   - **Tier 1 — Deterministic Zero-Cost Reference Endpoints (`E10`, P0):** Stateless, deterministic services (`demo.summarize.v1`, `demo.clean-json.v1`, `demo.price-feed.v1`) that require zero external LLM API spend, guaranteeing the 5-minute quickstart (`REQ-011`) works 24/7 even when all external sponsor budgets are `$0`.
   - **Tier 2 — Sponsored Real-Compute Campaign Engine (`E14`, P1):** Reference quota guard middleware implementing the `Campaign` schema from `SANDBOX_AND_CREDITS.md` (`campaign_id`, `provider_id`, `service_id`, `test_token_price`, `max_calls_per_wallet`, `max_tokens_per_request`, `provider_cost_budget`, `starts_at`, `expires_at`, `eligibility`, `terms_url`, `refund_policy`, `status`).
2. **Hard Three-Level Circuit Breaker (`REQ-014`):**
   - Level 1: Per-wallet / per-agent-vault daily cap on **sponsored** calls and tokens. When it is reached the call is no longer sponsored and falls back to the endpoint's normal paid `402` quote; paid calls are never capped (#61).
   - Level 2: Per-service hourly real-cost velocity cap.
   - Level 3: Global campaign `provider_cost_budget` hard ceiling; trips atomically to `PAUSED_BUDGET_EXHAUSTED` when reached.

## Consequences
- Providers can safely sponsor live inference trials in the 16ane sandbox with a mathematically bounded dollar/rupee compute ceiling (e.g., `$20/day`).
- Core sandbox onboarding never breaks when a sponsor pauses a campaign because Tier 1 deterministic endpoints always remain live.

## Alternatives rejected
- **Option B (On-chain quota ERC-20 tokens):** Confuses transferable tokens with non-transferable provider compute entitlements (`TOKENOMICS.md`, "Separate accounting systems" item 3) and cannot track real-time millisecond LLM token usage without off-chain state.
- **Option C (Relying on faucet limits alone):** Explicitly forbidden by `TOKENOMICS.md`, "Sponsored service example" ("A user with 1M tANE still cannot bypass provider compute limits").

## Open risks
- Concurrent requests racing for the last unit of a sponsor's compute budget; mitigated by atomic reservation (pre-debiting estimated max request cost before upstream invocation and reconciling actual cost on completion).

## Validation plan
- Automated tests (`THREAT_MODEL.md` #8 & `SCENARIOS.md` S3, #16): `e2e/flows/sponsored-budget.test.ts` funds an agent with `1,000,000 tANE` and verifies the 6th call past `max_calls_per_wallet = 5`, or the call past `provider_cost_budget = $1.00`, is not sponsored but falls back to the paid `402` quote (#61); trial-only endpoints answer `429`/`503` with no tANE settled. `packages/sdk-ts/test/campaigns.test.ts` covers the atomic budget race, velocity, tokens, window, eligibility and pause/resume.
