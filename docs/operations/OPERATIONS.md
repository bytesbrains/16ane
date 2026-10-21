# Public sandbox operations and observability

## SLOs to define before launch
Public API availability, faucet claim success, median and p95 paid-demo response latency, settlement-to-delivery delay, indexer freshness, provider quota enforcement, and support response target. Publish measured numbers rather than invented targets.

## Operational components
RPC provider and alternate, contract explorer, faucet wallet and mint authority, indexer, hosted facilitator, demo provider, quota engine, documentation, status page, incident response contact and backup procedures.

## Runbooks
- Faucet depleted: pause grants, replenish transparently, keep transfers functioning.
- RPC degraded: fail over; warn of indexer lag; never claim payment failure solely from stale index.
- Payment stuck: expose pending state; retry verification not payment; reconcile by idempotency key.
- Sponsor budget exceeded: sponsorship stops by itself (the campaign latches `PAUSED_BUDGET_EXHAUSTED`, visible on `GET /v1/campaigns` and `/healthz`) while paid settlement keeps working. To stop sooner, `POST /v1/campaigns/{id}/pause` with the provider's key; to restart after raising the budget, `POST /v1/campaigns/{id}/resume`.
- Agent signer compromised: owner revokes and rotates; disclose already settled transactions.
- Contract vulnerability: publish impact, admin capabilities, pause/migration plan, independent review and user notices.
- Chain reset: publish migration/version strategy; testnet tokens carry no value or continuity guarantee.

## Hosted sandbox API (`api.16ane.com`, #78)
The [API monitor](../../.github/workflows/api-monitor.yml) reads `/healthz` every 30 minutes and keeps one open
`api-alert` issue while anything below is wrong; it closes the issue itself once the API is healthy again. Run
the same check by hand with `node --experimental-strip-types scripts/api-health.ts https://api.16ane.com`.
Deployment, secrets and rollback: `DEPLOY_API.md`.

| Alert | Meaning | Action |
|---|---|---|
| `… is unreachable` or `… the API isn't serving` | No answer, or an error page from Fly's proxy (no machine running) or the wrong host | `fly status` / `fly logs --app 16ane-sandbox-api`; restart with `fly apps restart 16ane-sandbox-api`; roll back if a deploy caused it |
| `… (unavailable): the server can't reach its RPC` | The server is up but its RPC calls fail | Check Base Sepolia status; point `ANE_RPC_URL` at the fallback in `networks/sandbox-sepolia.json` (`fly secrets set` or `fly.toml`) and redeploy |
| `relayer … top it up` | The relayer holds less than what's left of today's gas budget | Send Base Sepolia ETH to the address in the alert. Only the relayer's address is needed; never move its key |
| `gas budget … used up` | Sponsorship is paused until 00:00 UTC; transfers and self-paid claims still work | Look at `fly logs` and the faucet's `FaucetClaimed` events for one actor rotating keys; raise `ANE_RELAYER_GAS_BUDGET_WEI` only if the use is legitimate |
| `registry is …, expected …` | The server points at another deployment | Fix `ANE_REGISTRY_ADDRESS` in `fly.toml` and redeploy |

A relayer or provider key that may be exposed: generate a new one into Fly secrets (`DEPLOY_API.md` step 1),
redeploy, and move any remaining test ETH from the old address. Both hold only test assets.

### Error tracking (Sentry, #90)
Every 5xx already carries an `errorId` (ADR-0010). When `ANE_SENTRY_DSN` is set as a Fly secret
(`DEPLOY_API.md` step 1; self-host default: off), `sendLoggedError` also posts a scrubbed event tagged
with that `errorId`. Each event holds only `code`, `errorId`, and a URL/key-redacted message — never
request bodies, headers, query strings, client IPs, signatures, or Turnstile tokens.
On a new error kind (new fingerprint): find the `errorId` in `fly logs`, reproduce, fix, and redeploy;
a repeat with a new `errorId` but the same fingerprint is the same bug. Rotate nothing: the DSN is a
write-only ingest key, not a credential — but keep it in Fly secrets anyway.

## Metrics and dashboards
On-chain transfer counts, unique wallets (not unique humans), agent task completion, payments verified, merchant delivery success, provider sponsored actual costs, faucet claims/abuse rate, RPC latency, revocations, refunds and unresolved disputes. Clearly separate testnet activity from real economic transactions.

## Privacy
No secret keys, API tokens, prompts containing personal data, or raw model outputs in on-chain events. Publish log retention and opt-out where feasible. Protect provider credentials server-side.
