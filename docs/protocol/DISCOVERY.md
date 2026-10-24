# Service discovery, listing and earning

## Service manifest v0 (proposal)
Fields: `service_id`, `name`, `description`, `provider_id`, `endpoint`, `capabilities`, `input_schema`, `output_schema`, `pricing` (unit/amount/asset/chain), `payment_protocols`, `refund_policy`, `quota`, `terms_url`, `contact`, `signature`, `updated_at`, `expires_at`, `version`. Host manifest at a well-known HTTPS path and optionally anchor identity/metadata hash on-chain.

## Discovery models
A) HTTP catalogs indexed by independent operators; B) optional on-chain registry; C) signed provider manifests; D) compatible agent identity registries. Favor portable metadata and multiple indexers. A listing is not a guarantee of merchant trust, safety or quality.

## ERC-8004 identity and reputation (optional, ADR-0018)
An agent can also register in the canonical ERC-8004 registries on Base Sepolia with `registerAgentOnChain` (`packages/sdk-ts/src/erc8004/`). Its registration file is a `data:` URI that lists the A2A agent card, the signed service manifest (if any), and its own registry entry. The owner names the vault through the `16ane.vault` metadata key. `getAgentIdentity` treats that claim as verified only if the vault came from the 16ane factory and is owned by the identity's owner.

A buyer that paid an agent can write feedback with `giveFeedbackOnChain`, which attaches the settlement transaction as `proofOfPayment`. The SDK refuses to send a proof that the chain does not back. `readAgentFeedback` re-verifies every entry, including entries written straight to the registry, and returns `REPUTATION_CAVEAT` with every read. A verified entry shows only that a real tANE payment happened. tANE is free, so wash trading costs nothing: **ERC-8004 reputation is unverified and Sybil-exposed, and it must never gate trust, ranking or spending.** Registration and feedback files are untrusted publisher text.

## Merchant onboarding
Publish manifest -> validate schema -> optional wallet signature -> test payment -> register/index -> make paid endpoint discoverable -> record receipts. Any merchant should be able to run its own indexer or share a manifest URL without centralized listing approval.

## Agent evaluation
Compare quoted price, chain/asset, service schema, latency/reliability observations, terms, quotas, reputation and task suitability. Reputation signals are untrusted and vulnerable to Sybil/wash trading. Agents must not assume a lower price means better value.

The TypeScript SDK's `AgentSession.chooseProvider` does this for price, latency and asset (ADR-0019). It sends each candidate an unpaid request and ranks the quotes the vault can pay: its own token on this chain, at or under the agent's cap, within its latency bound. `purchaseRouted` then buys from the winner, refusing a fresh quote that costs more or pays someone else. Latency is the agent's own measurement, never the provider's claim; a probe measures only the time to the quote.

## Service lifecycle
Draft -> Active -> Paused -> Deprecated; expiry and versioning. No implicit recurring payment authority; subscriptions/streams require explicit additional authorization.

## Earning
Merchant's wallet receives tANE after verified delivery conditions. Revenue is recorded distinctly from owner allocations and refundable liabilities. Owner determines whether earnings are spendable by the agent or withdrawable only.
