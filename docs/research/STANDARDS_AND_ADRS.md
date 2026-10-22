# Standards research and architecture decisions

## Research matrix (verify current versions and support)
- **ERC-20** token interface — https://eips.ethereum.org/EIPS/eip-20
- **ERC-4337** account abstraction — https://eips.ethereum.org/EIPS/eip-4337
- **EIP-7702** EOA code delegation — https://eips.ethereum.org/EIPS/eip-7702
- **ERC-8004** agent identity/reputation — https://eips.ethereum.org/EIPS/eip-8004
- **x402** HTTP payments — https://www.x402.org/
- **MCP** — https://modelcontextprotocol.io/
- **A2A** — https://a2a-protocol.org/
- **Base** developer docs — https://docs.base.org/
Research compatibility, token/chain restrictions, audit maturity, deployment availability, licensing, cost and maintainers. Do not assume all standards are finalized, universally adopted, or support tANE out of the box.

## Research log
- **2026-10-22, x402 schemes re-check (#62, ADR-0017):** `https://docs.x402.org/schemes/overview`, `/schemes/upto`, `/schemes/batch-settlement`, and the EVM spec at `https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement_evm.md`. Four schemes now exist (`exact`, `upto`, `batch-settlement`, `auth-capture`); `upto` still settles once per request; `batch-settlement` (EVM) uses escrow deposits plus cumulative off-chain vouchers with batched claims, no voucher expiry, and timed-withdrawal exits. Limitations: EVM wire details live mostly in `@x402/evm` code with thin adoption (secondary practitioner report); the May 2026 Cantina audit was seen only as a snippet (vouchers valid for full channel lifetime, no on-chain invalidation without migration) and is cited as directional only. Custom-ERC-20/tANE support on hosted facilitators was not re-verified — ADR-0005's USDC-only finding stands until rechecked.

## ADR queue
- **ADR-001** Testnet chain and continuity policy.
- **ADR-002** tANE ERC-20 mint roles, decimals, supply and metadata.
- **ADR-003** Agent account: dedicated vault vs ERC-4337 vs delegated EOA.
- **ADR-004** Fixed and revolving budget semantics including revenue treatment.
- **ADR-005** Payment adapter, x402 scheme, settlement verification and finality.
- **ADR-006** Gas funding and paymaster budget policy.
- **ADR-007** Signed service manifest, on-chain anchor and indexing.
- **ADR-008** Provider-sponsored credits and quota accounting.
- **ADR-009** Refunds, asynchronous delivery and escrow boundary.
- **ADR-010** API auth, rate limits, privacy and logging retention.
- **ADR-011** Upgrade authority, ownership and emergency response.
- **ADR-012** Future ANE issuance/redemption and regulated partner boundaries.
- **ADR-013** Open-source licenses and contribution governance.
- **ADR-014** Brand/domain collision with existing 16ane business marketplace.
- **ADR-015** Web hosting and DNS.
- **ADR-016** Hosted faucet and demo server.
- **ADR-017** High-frequency settlement via vault-native cumulative vouchers (proposed, #62).

## ADR template
`Context`, `Options`, `Evidence and sources`, `Security and legal impacts`, `Decision`, `Consequences`, `Alternatives rejected`, `Open risks`, `Validation plan`, `Date and owners`.
