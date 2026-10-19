# Reference scenarios and integration tests

## S1: First autonomous purchase
Owner funds agent with 1,600 tANE, delegates max cumulative 160 tANE, agent purchases 16 tANE deterministic summarization, receipt links quote/payment/delivery. Check wrong recipient, replay, insufficient funds and failed delivery.

## S2: Agent earns and returns funds
Agent A publishes 32 tANE data-cleaning service; Agent B purchases; A receives 32 tANE; A's owner revokes delegation and withdraws available balance. In fixed mode A's allowed spend does not rise by 32 tANE.

## S3: Sponsored model comparison
Two providers list demo inference with distinct token prices and latency; agent chooses based on declared constraints. Real provider spend quotas remain enforced even if caller has millions of tANE.

## S4: Refund and idempotency
Client times out after confirmed payment; retry with same idempotency key must not cause second charge. Merchant cannot deliver; merchant sends refund transfer with original payment reference. Show limitations of irreversible transfers.

## S5: Independence
Disable 16ane hosted registry and facilitator; agent still transfers tANE directly and can discover merchant from signed manifest URL and verify settlement via alternate RPC.

## S6: Permanent sandbox continuity
Upgrade SDK with semver; old clients receive explicit deprecation notice and migration path. Breaking contract changes deployed to dev testnet first. Public sandbox state may be reset by underlying testnet; disclose risk.
