# Public sandbox operations and observability

## SLOs to define before launch
Public API availability, faucet claim success, median and p95 paid-demo response latency, settlement-to-delivery delay, indexer freshness, provider quota enforcement, and support response target. Publish measured numbers rather than invented targets.

## Operational components
RPC provider and alternate, contract explorer, faucet wallet and mint authority, indexer, hosted facilitator, demo provider, quota engine, documentation, status page, incident response contact and backup procedures.

## Runbooks
- Faucet depleted: pause grants, replenish transparently, keep transfers functioning.
- RPC degraded: fail over; warn of indexer lag; never claim payment failure solely from stale index.
- Payment stuck: expose pending state; retry verification not payment; reconcile by idempotency key.
- Sponsor budget exceeded: immediately stop real compute while retaining simulated settlement and refund policy.
- Agent signer compromised: owner revokes and rotates; disclose already settled transactions.
- Contract vulnerability: publish impact, admin capabilities, pause/migration plan, independent review and user notices.
- Chain reset: publish migration/version strategy; testnet tokens carry no value or continuity guarantee.

## Metrics and dashboards
On-chain transfer counts, unique wallets (not unique humans), agent task completion, payments verified, merchant delivery success, provider sponsored actual costs, faucet claims/abuse rate, RPC latency, revocations, refunds and unresolved disputes. Clearly separate testnet activity from real economic transactions.

## Privacy
No secret keys, API tokens, prompts containing personal data, or raw model outputs in on-chain events. Publish log retention and opt-out where feasible. Protect provider credentials server-side.
