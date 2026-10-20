# ADR-0010: API Authentication, Rate Limits, Privacy, and Log Retention

- **Status:** Accepted (2026-10-19); amended 2026-10-20 (#61)
- **Date and owners:** 2026-10-19 | 16ane Security & Operations Maintainers
- **Related requirements:** REQ-002, REQ-003, REQ-015, REQ-PRIV, REQ-OBS
- **Related epics:** E02, E05, E10, E11, E15

## Context
16ane exposes optional hosted conveniences (`faucet`, `indexer`, `facilitator`, `demo merchant endpoints`) alongside open SDKs and contracts (`docs/protocol/DEVELOPER_INTERFACES.md`, `docs/operations/OPERATIONS.md`). We must define authentication for owner/agent actions, rate-limiting against abuse, secret-handling rules (`AGENTS.md`, "Invariants and prohibitions": "Never embed owner keys in prompts, logs, demo source, analytics or MCP outputs"), and privacy/log retention (`REQ-PRIV`).

## Options
1. **Option A: Stateless EIP-712 / SIWE Wallet Signatures for State-Changing API Calls + Unauthenticated Read Endpoints + IP/Wallet Token-Bucket Rate Limits + Zero-PII On-Chain Events & 7-Day Ephemeral Operational Logs.**
2. **Option B: Server-Custodied User Accounts with Email/Password/OAuth Required for All Sandbox Actions.**
3. **Option C: Unauthenticated Write Endpoints without Rate Limits.**

## Evidence and sources
- **Repo Requirements (`docs/protocol/DEVELOPER_INTERFACES.md`, "Proposed public REST surface"; `docs/product/REQUIREMENTS.md` REQ-PRIV & REQ-OBS, `docs/operations/OPERATIONS.md`, "Privacy"):**
  - "Owner-sensitive actions must be signed and authenticated; avoid server custody by default."
  - "PRIV: no PII in immutable on-chain metadata; minimize IP/log retention; secrets never logged."
  - "OBS: correlate purchase intent, chain tx, settlement and delivery without leaking secrets."
- **Sibling `copra` Security Baseline ([`copra/web/_headers`](https://github.com/bytesbrains/copra/blob/465dd8be027c27eada5fcd83aa69f893eb1037bb/web/_headers), `.gitleaks.toml`):**
  - Enforces strict Content-Security-Policy, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and automated gitleaks scanning.

## Security and legal impacts
- **Key isolation (`AGENTS.md`, `REQ-003`):** Neither the owner's private key nor the `agentSigner` private key is ever transmitted to any server, logged by the SDK, or exposed to the LLM context in MCP tools. SDK configuration loaders redact private keys in `repr()` / `toString()` / error stack traces.
- **No PII on-chain (`REQ-PRIV`):** Smart contract events (`Spent`, `PaymentRefunded`, `ServiceAnchored`) emit only addresses, token amounts, and `bytes32` hashes (`paymentId`, `quoteId`, `serviceIdHash`), never raw prompts, user emails, IPs, or model outputs.
- **Data minimization:** Faucet abuse prevention hashes client IP addresses with a daily rotating salt (`HMAC-SHA256(ip, daily_salt)`) for 24-hour cooldown enforcement so raw IP addresses are not persisted in long-term storage.

## Decision
Adopt **Option A**:
1. **Authentication Model:**
   - **Public Read Endpoints (`GET /v1/networks`, `/v1/assets`, `/v1/wallets/{address}/balances`, `/v1/payments/{id}`, `/v1/services`, `/v1/campaigns`):** Unauthenticated, cacheable JSON responses with CORS enabled.
   - **Payment Settlement (`/v1/x402/verify`, `/v1/x402/settle` and Merchant `PAYMENT-SIGNATURE`):** Authenticated via the embedded EIP-712 `SpendIntent` or EIP-3009 signature.
   - **Faucet & Relayer Claims (`POST /v1/faucet/claims`):** Authenticated via a signed EIP-191/EIP-712 challenge from the claimant wallet address (plus optional Cloudflare Turnstile token on web UI).
2. **Rate Limits (`E05`, `E10`, `E16`):**
   - Read APIs: `120 req/min` per IP.
   - Facilitator `/verify` & `/settle`: no per-vault or per-agent request limit (#61): payments run at the agent's speed. The hosted facilitator is protected by its gas budget and circuit breaker (`ADR-0006`); agents can always verify and settle directly on-chain instead.
   - Faucet claims: `1 claim / hour` per recipient address (matching `AneFaucet`'s on-chain cooldown); the anonymous web faucet also keys on a salted IP hash.
   - Standard `Retry-After` and `X-RateLimit-*` headers returned on `429 Too Many Requests`.
3. **Observability & Log Retention (`REQ-OBS`, `REQ-PRIV`):**
   - Structured JSON logs correlate `correlation_id`, `quote_id`, `payment_id`, `tx_hash`, `service_id`, `latency_ms`, and `status`.
   - Automatic log scrubber strips `Authorization`, `X-API-Key`, private keys (`0x[0-9a-fA-F]{64}`), seed phrases, and request/response prompt bodies by default.
   - Ephemeral operational logs expire after `7 days`; salted faucet rate-limit keys expire after `24 hours`.

## Consequences
- Developers can use the sandbox immediately from CLI or SDK without creating a custodial account or handing over personal data.
- Complies with `REQ-PRIV` and prevents accidental leakage of private keys or user prompts in telemetry.

## Alternatives rejected
- **Option B (Mandatory email/OAuth accounts):** Adds onboarding friction, collects unnecessary PII, and violates wallet-native self-custody principles.
- **Option C (Unthrottled endpoints):** Exposes faucet, RPC, and sponsor compute budgets to trivial DoS exhaustion.

## Open risks
- Distributed botnets rotating residential IPs to farm the faucet; mitigated by on-chain `globalDailyMintCap` in `ADR-0006` and independent provider compute caps in `ADR-0008`.

## Validation plan
- Unit test verifying SDK and MCP logger redacts any 32-byte hex private key (`0x` + 64 hex chars) in error messages and config dumps.
- E2E test verifying rate-limit `429` responses include `Retry-After` and that on-chain events contain zero raw prompt or PII strings.
