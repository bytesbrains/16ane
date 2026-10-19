# ADR-0001: Testnet Chain Selection and Continuity Policy

- **Status:** Accepted (2026-10-19)
- **Date and owners:** 2026-10-19 | 16ane Protocol & Infrastructure Maintainers
- **Related requirements:** REQ-001, REQ-010, REQ-013, REQ-015
- **Related epics:** E01, E02, E03, E11

## Context
16ane requires a public EVM testnet for its permanent worldwide sandbox (`tANE`) plus an isolated development environment for breaking changes (`REQ-013`). The selected chain must support low-latency block times, reliable public and commercial RPC endpoints, contract verification, x402 payment settlement (`eip155:<chainId>`), and deterministic deployment patterns (`CREATE2`), without implying any continuity guarantee if the underlying public testnet resets or deprecates.

## Options
1. **Option A: Base Sepolia (`eip155:84532`) for Public Sandbox + Local Anvil (`84532` fork/local) & Ephemeral Staging Namespace for Dev/Test.**
2. **Option B: Ethereum Sepolia (`eip155:11155111`) L1 Testnet.**
3. **Option C: Arbitrum Sepolia (`eip155:421614`) or Optimism Sepolia (`eip155:11155420`).**
4. **Option D: Custom Hosted Private Chain / Rollup.**

## Evidence and sources
- **Base Network Documentation** (`https://docs.base.org/chain/network-information`, `https://docs.base.org/chain/base-contracts`, checked 2026-10-19):
  - Chain ID: `84532` (`0x14a34`), 2-second OP Stack block time, public RPC `https://sepolia.base.org` and community RPC `https://base-sepolia-rpc.publicnode.com`, explorer `https://sepolia.basescan.org`.
  - Canonical contracts deployed on `84532`: Permit2 (`0x000000000022D473030F116dDEE9F6B43aC78BA3`), Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`), ERC-4337 EntryPoints v0.6, v0.7 (`0x0000000071727De22E5E9d8BAf0edAc6f37da03`), v0.8 (`0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108`), and v0.9.
- **x402 Protocol Ecosystem** (`https://www.x402.org/`, `https://github.com/coinbase/x402`, checked 2026-10-19):
  - First-class support for `eip155:84532` (Base Sepolia) in reference TypeScript and Python packages.
- **Sibling `copra` Repository Evidence** (`/Users/nandal/Desktop/desk/repos/copra` @ commit `465dd8be027c27eada5fcd83aa69f893eb1037bb`):
  - Proven Foundry deployment pipeline (`script/DeployCopra.s.sol`), deterministic `CREATE2` registry pattern (`src/CopraRegistry.sol`), network definitions (`networks/sepolia.json`, `networks/local.json`), and Docker Compose Anvil E2E stack (`e2e/docker-compose.yml`) already targeting Base Sepolia (`84532`).

## Security and legal impacts
- **No monetary value:** Base Sepolia ETH and `tANE` have zero monetary value (`REQ-012`).
- **RPC availability and censorship resistance (`REQ-001`):** Public RPC (`https://sepolia.base.org`) enforces rate limits. Clients, SDKs, and self-hosted facilitators must accept user-supplied RPC URLs (`https://base-sepolia-rpc.publicnode.com`, Alchemy, QuickNode, Infura) so no 16ane server is required for token transfers or verification.
- **Reorg and finality handling (`REQ-007`):** Base Sepolia 2s blocks are sequencer soft-confirmations; L1 finality lags until batch submission to Ethereum Sepolia. High-value or irreversible actions must check confirmation depth or `safe`/`finalized` block tags.
- **Mainnet separation:** Selection of Base Sepolia (`84532`) for the sandbox does not authorize or pre-commit a mainnet deployment (`8453` or otherwise). Deploy scripts must explicitly revert if executed against mainnet chain IDs (`require(block.chainid == 84532)`).

## Decision
Adopt **Option A**:
1. **Public Sandbox Environment:** Base Sepolia (`eip155:84532`) using a deterministic `CREATE2` registry contract (`AneRegistry` with salt `keccak256("16ane.registry.sandbox.v1")`) to resolve active contract addresses.
2. **Dev/Test Environment (`REQ-013`):**
   - Local deterministic CI/dev stack running containerized Foundry Anvil (`chainId: 84532` or `31337`) via Docker Compose (reusing the `copra/e2e` pattern).
   - Staging deployments on Base Sepolia bound to a separate `CREATE2` salt (`keccak256("16ane.registry.dev.v1")`) and distinct `dev` configuration file (`networks/dev-sepolia.json`) so breaking contract migrations never overwrite the public sandbox registry.
3. **Continuity & Migration Policy:** Parameterize `chainId` and `registryAddress` across all SDKs, CLI commands, and manifests. Publish at least 30 days' deprecation notice for scheduled sandbox contract upgrades, and document state-redeployment runbooks in case Base Sepolia is ever reset or succeeded by a new testnet.

## Consequences
- Fast (~2s) block times for interactive agent demos and x402 payment settlements.
- Direct reuse of `copra` Foundry configuration (`solc 0.8.28`, `bytecode_hash = "none"`, `cbor_metadata = false`), network validator scripts, and Docker E2E harness.
- Requires dual-RPC configuration in hosted faucet/facilitator services to avoid public RPC rate limits.

## Alternatives rejected
- **Option B (Ethereum Sepolia L1):** 12-second block times degrade interactive HTTP 402 agent tool calls, and Sepolia L1 gas faucet scarcity creates higher developer friction.
- **Option C (Arbitrum/OP Sepolia):** Viable secondary targets, but lack existing local repo deployment scripts (`copra`) and have smaller x402 reference Mindshare compared to Base Sepolia.
- **Option D (Custom Private Chain):** Violates `REQ-001` and `AGENTS.md` prohibition against relying on hosted infrastructure for core token transfers.

## Open risks
- Base Sepolia sequencer downtime or L1 Sepolia reorgs could delay finality; mitigated by explicit RPC health checks and configurable confirmation depth in `ADR-0005`.
- Testnet ETH scarcity for new developers; mitigated by gasless EIP-3009 / EIP-2612 spend authorizations (`ADR-0002`, `ADR-0006`).

## Validation plan
- Verify deployment script reverts on any chain ID other than `84532` (or local test chain `31337`) unless explicitly overridden in dev mode.
- Verify `AneRegistry` deploys to the identical `CREATE2` address on local Anvil and Base Sepolia.
- Execute Scenario `S5` (disable 16ane hosted RPC/services; transfer `tANE` and verify receipt using an independent public Base Sepolia RPC).
