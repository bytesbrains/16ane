# Agent-to-agent and HTTP payment protocol

## Happy path
1. Agent discovers a merchant's endpoint and price/terms.
2. Agent sends request; merchant returns machine-readable payment requirement (e.g. HTTP 402) with network, asset, recipient, amount, expiry, quote ID and accepted scheme.
3. Client checks owner's enforceable policy and merchant identity, signs authorized payment, and submits settlement/proof.
4. Merchant or independent facilitator verifies network, contract, recipient, amount, finality, quote, nonce and non-reuse.
5. Merchant performs bounded service, returns result and settlement/delivery receipt.
6. Agent records cost, service outcome and optional refund request.

## Protocol compatibility
Research **x402** current version and supported EVM networks/assets; add tANE support through a conforming extension or adapter if existing facilitators reject arbitrary ERC-20 tokens. Never claim drop-in compatibility until integration tests pass. Prefer existing HTTP semantics and payment proof formats over custom headers.

## Required failure semantics
Insufficient balance, expired quote, wrong chain/asset, stale fee estimate, replay, delayed confirmation, chain reorg, payment succeeded but delivery failed, service succeeded but response lost, duplicate request, partial result, rate limit, refund failure. Use idempotency key and documented status query. Avoid retrying payment blindly.

## Refunds
A finalized on-chain transfer cannot be reversed unilaterally. Merchant-initiated refund is a new transfer or escrow release. Reference refund to original `payment_id`, show original and refund tx hashes, and disclose partial/nonrefundable cases.

## Micropayment economics
Benchmark fee/latency for one-shot transfers; add batching, payment channels or metered session settlement only if measured economics justify complexity. Hosted relay costs must be explicitly budgeted. Never assert sub-cent payment viability without data.

## Example conceptual quote
```json
{
  "quote_id": "q_demo_001", "network": "eip155:<TEST_CHAIN_ID>",
  "asset": "<TANE_CONTRACT_ADDRESS>", "amount_base_units": "16000000000000000000",
  "recipient": "<MERCHANT_ADDRESS>", "expires_at": "<ISO8601>",
  "service_id": "demo.summarize.v1", "scheme": "<SELECTED_SCHEME>"
}
```
The amount assumes 18 token decimals **only for illustration**. Schema is not yet a standard or implementation contract.
