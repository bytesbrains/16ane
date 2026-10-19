# ADR-0007: Signed Service Manifests, A2A/ERC-8004 Alignment, and Discovery Indexing

- **Status:** Accepted (2026-10-19)
- **Date and owners:** 2026-10-19 | 16ane Protocol & Ecosystem Maintainers
- **Related requirements:** REQ-001, REQ-010, REQ-101, REQ-106, REQ-202, REQ-203
- **Related epics:** E02, E12, E16, E19

## Context
Agents need to discover priced services, inspect input/output schemas, verify payment terms (`tANE` price, network, recipient address, refund policy, sponsored quota), and verify that a service listing was genuinely signed by the merchant provider (`docs/protocol/DISCOVERY.md`). At the same time, discovery must not require a centralized 16ane marketplace (`REQ-001`, `REQ-101`, `REQ-106`), and merchant manifests must be treated as untrusted advertisements that could contain prompt-injection strings (`THREAT_MODEL.md`).

## Options
1. **Option A: Portable Signed HTTPS Manifest (`/.well-known/16ane-service.json` + A2A v1.0 `/.well-known/agent-card.json` Extension) with Optional On-Chain Hash Anchor (`AneServiceAnchor`) and Self-Hostable Indexer.**
2. **Option B: Mandatory On-Chain Full-Text Service Registry.**
3. **Option C: Centralized 16ane Database Directory Only.**

## Evidence and sources
- **A2A Protocol v1.0 (`https://a2a-protocol.org/latest/specification/`, checked 2026-10-19):**
  - Standardizes agent discovery at `https://<domain>/.well-known/agent-card.json` with `skills[]`, `capabilities.extensions[]`, and JWS signature support.
- **ERC-8004 Trustless Agents (`https://eips.ethereum.org/EIPS/eip-8004`, checked 2026-10-19):**
  - Draft ERC (created 2025-08-13) defining an ERC-721 Identity Registry (`tokenURI` pointing to off-chain JSON registration with A2A/MCP endpoints and `eip155:84532:0x...` wallet addresses), Reputation Registry, and Validation Registry.
- **Repo Spec (`docs/protocol/DISCOVERY.md` & `examples/SCENARIOS.md` S5):**
  - Requires `service_id`, `name`, `description`, `provider_id`, `endpoint`, `capabilities`, `input_schema`, `output_schema`, `pricing`, `payment_protocols`, `refund_policy`, `quota`, `terms_url`, `contact`, `signature`, `updated_at`, `expires_at`, `version`.
  - Scenario `S5`: "Disable 16ane hosted registry and facilitator; agent still transfers tANE directly and can discover merchant from signed manifest URL and verify settlement via alternate RPC."

## Security and legal impacts
- **Prompt-injection defense (`THREAT_MODEL.md`, "High-priority abuse cases": malicious registry manifests):** Free-text fields (`name`, `description`, `terms_url`) in manifests are untrusted external inputs. SDKs and MCP tools (`list_services`) must validate manifests against a strict JSON Schema, enforce length limits (`description <= 500 chars`), strip control characters, and wrap text in explicit untrusted-data delimiters before passing to an LLM.
- **Cryptographic binding between manifest and payment recipient (`THREAT_MODEL.md`, "High-priority abuse cases": changed payment address):** The manifest `signature` must be an EIP-712 signature by `provider_id` (or the `pricing.recipient` wallet address) over the canonical SHA-256 / EIP-712 hash of the manifest fields, including `endpoint` and `pricing.recipient`. When an agent receives an HTTP `402` challenge from `endpoint`, the SDK verifies that the `402` `payTo` address matches the signed manifest's `pricing.recipient`, preventing man-in-the-middle or DNS-hijack payment redirection!
- **No PII on-chain (`REQ-PRIV`):** On-chain anchoring stores only `serviceIdHash`, `providerAddress`, `manifestUrl`, and `manifestContentHash` (`bytes32`), never PII.

## Decision
Adopt **Option A**:
1. **Canonical Manifest Schema (`16ane-service-manifest/v0`):**
   - Published at `https://<merchant-host>/.well-known/16ane-service.json` (or any direct HTTPS URL passed to `ane pay` / `session.purchase`).
   - Also publishable as an `AgentExtension` block inside an A2A v1.0 `/.well-known/agent-card.json` document for dual A2A + 16ane compatibility.
   - Signed via EIP-712 (`ServiceManifest`) by `provider_address` so clients can verify authenticity offline without calling any registry server (`SCENARIOS.md` S5).
2. **Optional On-Chain Anchor (`AneServiceDirectory.sol`, `E12`):**
   - Lightweight contract on Base Sepolia emitting `ServiceAnchored(bytes32 indexed serviceIdHash, address indexed provider, string manifestUri, bytes32 manifestHash, uint64 expiresAt, uint8 status)`.
   - Anyone can index `ServiceAnchored` events from standard RPC logs (`REQ-101`, `REQ-106`).
3. **ERC-8004 Compatibility (`E19`, P2):**
   - Keep ERC-8004 Identity and Reputation registries as an optional P2 adapter (`REQ-202`) because ERC-8004 is still a Draft ERC and on-chain reputation on a free-token testnet is vulnerable to Sybil wash trading (`DISCOVERY.md`).

## Consequences
- Zero-coordination merchant onboarding: a developer can run `ane service sign manifest.json`, host the JSON file on any static URL or FastAPI/Worker server, and agents can immediately verify and pay it (`SCENARIOS.md` S5).
- Prevents payment address swapping between discovery and HTTP `402` checkout.

## Alternatives rejected
- **Option B (Storing full JSON schemas on-chain):** Prohibitive gas cost and rigid schema evolution.
- **Option C (Centralized database only):** Violates `REQ-001`, `REQ-101`, `REQ-106`, and Scenario `S5`.

## Open risks
- Stale manifests cached by indexers after a merchant changes prices; mitigated by `expires_at`, `version`, and HTTP `402` quote verification at request time.

## Validation plan
- Schema validation tests for valid and malformed manifests.
- Security test verifying that if an endpoint's HTTP `402` challenge specifies a different `recipient` (`payTo`) than the signed manifest, the SDK aborts payment with `RecipientMismatchError`.
