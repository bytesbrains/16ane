# Permanent sandbox, faucet and sponsored introductory credits

## Two environments
- **Public Sandbox:** stable, long-lived testnet deployments; published versioning, migration notice, deprecation policy; worldwide participation. Testnet itself may reset/fork, so avoid promising absolute permanence of chain history.
- **Dev/Test:** isolated staging for breaking changes, simulated settlement failures and destructive tests.

## Faucet
Public web/API + CLI. Request input: wallet address, optional campaign code, captcha/proof-of-personhood or signed challenge. Configurable claim size (default 16,000 tANE, #61), cooldown, IP/device/wallet/risk quotas, abuse appeals, availability dashboard. Never require a paid deposit to claim. Publish faucet funding/minting authority. Do not make wallet identity claims stronger than Sybil defenses warrant.

## One sandbox currency across providers
The public sandbox is meant to be a shared playground across platforms, not a single demo: platforms, service providers, agent developers and researchers use it to test an economy that agents run themselves, buying from, selling to and paying each other across services. Any platform that runs a sandbox, demo, trial or introductory/offer-credit tier can accept tANE for it:
- **Providers** publish a signed service manifest with prices in tANE (`DISCOVERY.md`) and accept x402 payments. They choose which tiers accept tANE, at what price and within which limits, and they bear any real compute they sponsor (`ADR-0008`).
- **Agents** pay every participating provider from one vault and one tANE balance, within the budget their owner set. tANE claimed from the faucet or received for serving other agents can be spent at any participating provider.
- **Separate credits stay separate.** A provider may also grant its own off-chain introductory credits; those are metering entitlements on its side, not tANE (`TOKENOMICS.md`, "Separate accounting systems").
- **No value, no obligation.** tANE stays a free test token with no cash value: it is not sold, not exchangeable for money and never converts to ANE, and no provider is obliged to accept it. Pricing and limits follow the agent-speed principle in #61: providers cap the cost they sponsor, not how fast a paying agent can call.

## Provider-sponsored trials
A provider advertises price in tANE and separate hard limits: calls/wallet/day, aggregate calls/day, tokens/request, hourly service cost velocity, lifetime provider spend, eligibility, campaign window and refunds. Credits may be off-chain metering entitlements; do not falsely present them as transferable tANE. Provider must be able to stop sponsored usage without blocking chain settlement.

Quotas limit only the provider's sponsored cost (#61): past a quota the call is not sponsored and falls back to the endpoint's normal paid `402` quote, and a paying agent is served at full speed. Paid calls are never capped and never consume trial quota. Rejection (`429 QuotaExceeded` / `503 SponsorBudgetExhausted`) applies only where the provider explicitly marked an endpoint trial-only. Either way the quota gate runs before any upstream compute is spent, pre-reserving the estimated request cost so concurrent requests cannot overspend the sponsor cap.

## Campaign example
`campaign_id`, `provider_id`, `service_id`, `endpoints`, `test_token_price`, `max_calls_per_wallet`, `max_calls_global_per_day`, `max_tokens_per_request`, `provider_cost_budget` (USD micros, lifetime), `service_hourly_cost_cap`, `starts_at`, `expires_at`, `eligibility`, `terms_url`, `refund_policy`, `status` (`ACTIVE`, `PAUSED`, `PAUSED_BUDGET_EXHAUSTED`, `EXPIRED`), `trial_only_endpoints`. No hidden auto-upgrade to paid production.

The reference implementation is the SDK's `SponsoredQuotaEngine` (`packages/sdk-ts/src/campaigns.ts`), wired into the sandbox server (`services/sandbox-server/src/campaigns.ts`): `GET /v1/campaigns` lists campaigns with quotas, spend and live status, and the provider's circuit breaker (`POST /v1/campaigns/{id}/pause|resume`, authorized by the provider's key) stops or restarts sponsorship without touching paid settlement. A restart never unpauses a campaign. `/healthz` reports each campaign's spend and remaining budget.

## Abuse scenarios
Faucet farming, botnets, replaying vouchers, wallets selling claims, wash trading, expensive inference spam, prompt injection, laundering fake reputation, denial of service. Rate-limit at hosted resource layer; use service quota independent of tANE. Do not claim zero-cost global compute.

## Demonstration requirements
A new user with no card/bank account can fund a test wallet, execute at least one paid demo call, list a sample service, receive a payment and return balance. Provide deterministic simulated endpoint so demonstration survives sponsor outages. Display 'TEST TOKENS — NO CASH VALUE' on every balance and pricing screen.
