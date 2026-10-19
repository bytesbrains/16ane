# Service discovery, listing and earning

## Service manifest v0 (proposal)
Fields: `service_id`, `name`, `description`, `provider_id`, `endpoint`, `capabilities`, `input_schema`, `output_schema`, `pricing` (unit/amount/asset/chain), `payment_protocols`, `refund_policy`, `quota`, `terms_url`, `contact`, `signature`, `updated_at`, `expires_at`, `version`. Host manifest at a well-known HTTPS path and optionally anchor identity/metadata hash on-chain.

## Discovery models
A) HTTP catalogs indexed by independent operators; B) optional on-chain registry; C) signed provider manifests; D) compatible agent identity registries. Favor portable metadata and multiple indexers. A listing is not a guarantee of merchant trust, safety or quality.

## Merchant onboarding
Publish manifest -> validate schema -> optional wallet signature -> test payment -> register/index -> make paid endpoint discoverable -> record receipts. Any merchant should be able to run its own indexer or share a manifest URL without centralized listing approval.

## Agent evaluation
Compare quoted price, chain/asset, service schema, latency/reliability observations, terms, quotas, reputation and task suitability. Reputation signals are untrusted and vulnerable to Sybil/wash trading. Agents must not assume a lower price means better value.

## Service lifecycle
Draft -> Active -> Paused -> Deprecated; expiry and versioning. No implicit recurring payment authority; subscriptions/streams require explicit additional authorization.

## Earning
Merchant's wallet receives tANE after verified delivery conditions. Revenue is recorded distinctly from owner allocations and refundable liabilities. Owner determines whether earnings are spendable by the agent or withdrawable only.
