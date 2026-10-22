# Threat model and security requirements

## Assets and adversaries
Assets: owner principal, delegated tANE, provider compute budget, service results, signer keys, receipts, availability, future fiat reserves. Adversaries: compromised agent/LLM, prompt injection in retrieved content, malicious merchant, Sybil faucet claimant, colluding agents, compromised relayer/indexer, phishing front-end, privileged contract operator, chain reorg and service outage.

## High-priority abuse cases
- Agent tricked into paying attacker by malicious tool output or changed payment address.
- Replayed payment intent across services, chains or expired quotes.
- Unlimited ERC-20 approval or arbitrary contract call drains wallet.
- Double-spend race with parallel agent workers.
- Merchant takes payment then refuses service; idempotent retries accidentally double-pay.
- Faucet farming burns sponsor's real compute budget.
- Fake 'earnings' via wash trades used to evade fixed-budget spending cap.
- Malicious registry manifests include prompt-injection instructions.
- Sponsor or paymaster suffers gas-draining denial of service.
- Contract upgrade/admin key compromise.
- Future issuer reports reserves without independent corroboration.

## Required mitigations
Minimal delegated scopes; enforce limits in contract; allowlist contract methods where appropriate; signer isolation; hardware-backed owner keys where practical; deadlines, chain ID and nonce binding; reentrancy guards; safe token interaction; quote recipient confirmation; idempotency; transaction finality policy; service cost caps; rate limits; event monitoring; reproducible deployments; role separation; documented emergency pause boundaries; fuzz/property tests and independent review.

## Security tests
1. Agent overspends exact budget by one base unit -> revert.
2. Two concurrent spends exceed cumulative cap -> at most one succeeds.
3. Reuse signed payment proof -> reject second use.
4. Wrong recipient/asset/chain/expiry -> reject.
5. Owner revokes signer -> future delegated spends reject.
6. Revenue deposit under fixed mode -> no spending cap increase.
7. Malicious service response requests seed phrase -> agent ignores and keys remain isolated.
8. Faucet claims across Sybil identities -> rate limits and provider spend caps still bound exposure.
9. Indexer outage -> direct on-chain verification path works.
10. Delivery failure after settlement -> documented refund/claim workflow, no fictitious automatic rollback.

## Voucher settlement additions (ADR-0017, proposed)

- Vouchers outstanding to several merchants jointly exceed the remaining budget; later claims revert and merchants go uncompensated. Vault guarantee (settled spend never exceeds budget) holds regardless; merchants bound the risk with exposure caps, short voucher TTLs, vault-state mirroring, and prompt claims.
- Merchant serves on stale mirrored vault state and over-extends credit. Reference implementation re-mirrors on a mandatory cadence; loss bounded by the merchant's own exposure cap.
- Revocation, signer rotation, or expiry voids served-but-unclaimed vouchers. By design; bounded by TTL and claim cadence and disclosed to merchants and agents.
- Same-voucher resubmission or stale voucher claim reverts on non-positive delta; distinct EIP-712 struct typehash prevents `SpendIntent`/`Voucher` cross-replay.
- Over-claiming beyond the signed cumulative is protocol-impossible (claims pay `signedCumulative - claimed`), unlike trust-based actuals.
- Compromised agent key mints vouchers up to the remaining budget until revocation: equivalent to today's compromised-signer exposure, bounded additionally by voucher TTL.

## Launch gates
Threat model reviewed, tests automated, secrets scanned, source verified, contract roles disclosed, rollback/migration rehearsed, hosted spend caps configured, abuse reporting contact live. For future real-value mainnet, require external security audits and explicit legal/compliance sign-off; a public testnet launch does not satisfy those requirements.
