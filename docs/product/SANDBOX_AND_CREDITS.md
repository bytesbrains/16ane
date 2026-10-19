# Permanent sandbox, faucet and sponsored introductory credits

## Two environments
- **Public Sandbox:** stable, long-lived testnet deployments; published versioning, migration notice, deprecation policy; worldwide participation. Testnet itself may reset/fork, so avoid promising absolute permanence of chain history.
- **Dev/Test:** isolated staging for breaking changes, simulated settlement failures and destructive tests.

## Faucet
Public web/API + CLI. Request input: wallet address, optional campaign code, captcha/proof-of-personhood or signed challenge. Configurable claim size (example 1,600 tANE), cooldown, IP/device/wallet/risk quotas, abuse appeals, availability dashboard. Never require a paid deposit to claim. Publish faucet funding/minting authority. Do not make wallet identity claims stronger than Sybil defenses warrant.

## Provider-sponsored trials
A provider advertises price in tANE and separate hard limits: requests/day, tokens/request, monthly provider spend, concurrency, eligibility, campaign expiry and refunds. Credits may be off-chain metering entitlements; do not falsely present them as transferable tANE. Provider must be able to stop sponsored usage without blocking chain settlement.

## Campaign example
`campaign_id`, `provider_id`, `service_id`, `test_token_price`, `max_calls_per_wallet`, `provider_cost_budget`, `starts_at`, `expires_at`, `eligibility`, `terms_url`, `refund_policy`, `status`. No hidden auto-upgrade to paid production.

## Abuse scenarios
Faucet farming, botnets, replaying vouchers, wallets selling claims, wash trading, expensive inference spam, prompt injection, laundering fake reputation, denial of service. Rate-limit at hosted resource layer; use service quota independent of tANE. Do not claim zero-cost global compute.

## Demonstration requirements
A new user with no card/bank account can fund a test wallet, execute at least one paid demo call, list a sample service, receive a payment and return balance. Provide deterministic simulated endpoint so demonstration survives sponsor outages. Display 'TEST TOKENS — NO CASH VALUE' on every balance and pricing screen.
