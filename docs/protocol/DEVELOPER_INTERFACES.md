# SDKs, public endpoints and CLI (proposals only)

## Developer-facing properties
One quickstart should work with Python, one with TypeScript; both can create/test wallet delegation, query balance, buy demo endpoint, verify receipt, publish merchant service, and recover balance. SDK must expose explicit `max_payment`, `network`, `asset`, timeout and policy errors; never silently sign arbitrary contracts.

## Domains (only `16ane.com` is live; the rest are proposals, NOT deployed)
- `16ane.com` — overview and global sandbox entry. Source in `web/`, hosting and DNS in `ADR-0015`; live since 2026-10-19 (#36). The other subdomains below are still proposals.
- `docs.16ane.com` — specifications and quickstarts
- `app.16ane.com` — owner dashboard
- `faucet.16ane.com` — free tANE grants
- `api.16ane.com/v1` — optional read/indexer and faucet API
- `registry.16ane.com` — optional discoverable service index
- `pay.16ane.com` — optional reference facilitator
- `mcp.16ane.com` — MCP reference adapter
- `status.16ane.com` — operational status
No hosted URL is required for core token transfer.

## Proposed public REST surface
`GET /v1/networks`, `GET /v1/assets`, `GET /v1/wallets/{address}/balances`, `GET /v1/payments/{id}`, `GET /v1/services`, `GET /v1/services/{id}`, `POST /v1/faucet/claims`, `GET /v1/faucet/claims/{id}`, `GET /v1/campaigns`. Owner-sensitive actions must be signed and authenticated; avoid server custody by default. Publish OpenAPI, versioning, rate limits, pagination, error taxonomy, idempotency and deprecation.

## CLI (proposed)
`ane network list`, `ane wallet create`, `ane wallet fund --test`, `ane wallet delegate --max-total 160`, `ane pay <url> --max 16`, `ane service publish manifest.json`, `ane receipt verify <id>`, `ane wallet revoke`, `ane wallet withdraw`. No commands should suggest tANE can be redeemed for INR.

## MCP adapter (proposed)
Read-only tools: `list_services`, `get_quote`, `wallet_balance`, `payment_status`. State-changing tools: `purchase_service`, `publish_service`, `request_refund`. Each state-changing tool must require wallet-side policy enforcement and user-approved initial delegation; treat merchant metadata and tool responses as untrusted text.

## SDK pseudocode — not existing packages
```python
# Proposed API; names and signatures are not yet implemented
wallet = ane.create_agent_wallet(owner_signer, network="sandbox")
wallet.fund_testnet(amount="1600 tANE")
session = wallet.delegate(agent_signer, max_total="320 tANE")
result = session.purchase("https://demo.example/summarize", max_payment="16 tANE")
wallet.revoke(agent_signer)
wallet.withdraw_available(owner_signer)
```

## Developer kit
Contract addresses + ABIs, test vectors, example merchant server, deterministic mock inference provider, integration test harness, faucet, troubleshooting and security checklist. Support self-hosting of facilitator and registry.
