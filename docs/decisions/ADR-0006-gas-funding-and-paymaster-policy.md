# ADR-0006: Gas Funding, Relayer Sponsorship, and Faucet Abuse Policy

- **Status:** Proposed (Phase 0 review required)
- **Date and owners:** 2026-10-19 | 16ane Protocol & Operations Maintainers
- **Related requirements:** REQ-001, REQ-002, REQ-012, REQ-105
- **Related epics:** E02, E05, E06, E16

## Context
New developers onboarding to the 5-minute sandbox quickstart (`README.md`) may not initially hold Base Sepolia ETH (`eip155:84532`). In the sibling `copra` repo (`web/assets/wallet.js` line 217, `src/testnet/TestnetUSDC.sol`), the faucet requires the user to submit an on-chain transaction paying their own Base Sepolia ETH gas and has no cooldown or rate-limiting in the contract. For 16ane, `REQ-002` requires bounded faucet distributions with abuse controls that never restrict ordinary token transfers (`REQ-001`), and `REQ-105` requires optional gas sponsorship with metered policy and no unlimited subsidy.

## Options
1. **Option A: Dual-Mode Faucet & Gasless Meta-Transaction Settlement (On-Chain `AneFaucet` with Cooldowns + Hosted Cloudflare Worker Relayer with Turnstile/Signed Challenge & Hard Daily ETH Budget Cap).**
2. **Option B: Pure Client-Submitted Faucet (User must acquire Base Sepolia ETH externally before claiming `tANE`).**
3. **Option C: Open ERC-4337 Verifying Paymaster Sponsoring Arbitrary UserOperations.**

## Evidence and sources
- **Sibling `copra` Faucet Audit (`/Users/nandal/Desktop/desk/repos/copra/src/testnet/TestnetUSDC.sol` lines 11–33):**
  - `TestnetUSDC.faucet()` allows any caller with Base Sepolia ETH to mint `10,000 * 1e6` per call with zero cooldown.
- **EIP-2612 (`https://eips.ethereum.org/EIPS/eip-2612`) & EIP-3009 (`https://eips.ethereum.org/EIPS/eip-3009`):** Checked 2026-10-19. Enable off-chain EIP-712 signatures from `owner` and `agentSigner` so a relayer/facilitator can submit vault creation, delegation, and payment settlement transactions without the agent holding ETH.
- **Threat Model (`docs/security/THREAT_MODEL.md` line 15):**
  - "Sponsor or paymaster suffers gas-draining denial of service."

## Security and legal impacts
- **Bounded relayer gas exposure (`REQ-105`, `THREAT_MODEL.md`):** Hosted relayer/faucet only calls allowlisted contract methods (`AneFaucet.drip`, `AneVaultFactory.createAndDelegateWithSig`, `AneAgentVault.settlePayment`, `tANE.transferWithAuthorization`) with a hard `maxFeePerGas` ceiling, per-wallet daily tx quota, and global daily Sepolia ETH spend circuit breaker.
- **On-chain faucet enforcement (`REQ-002`):** Even if someone calls `AneFaucet` directly on-chain paying their own ETH gas, the smart contract enforces `claimAmount` (default `1,600 * 10^18` `tANE`), `claimCooldown` (default `24 hours` per recipient address), and `globalDailyMintCap` (default `1,600,000 * 10^18` `tANE`/day).
- **Transfer independence (`REQ-001`):** Faucet cooldowns and relayer rate limits apply exclusively to `AneFaucet` and hosted relayer endpoints; standard `tANE` transfers and self-relayed `AneAgentVault` calls remain 100% permissionless.

## Decision
Adopt **Option A**:
1. **On-Chain `AneFaucet` Contract (`E05`):**
   - Holds `MINTER_ROLE` on `tANE` (or draws from a pre-minted faucet reserve).
   - Enforces on-chain `claimAmount = 1_600e18` (`1,600 tANE`), `cooldownSeconds = 86_400` (24h per `recipient` and per `msg.sender`), and `maxDailyMint = 1_600_000e18`.
   - Exposes both `claim(address recipient)` (permissionless on-chain call for users who already have Base Sepolia ETH) and `relayedClaim(address recipient, bytes32 campaignId, uint256 deadline, bytes signature)` for gasless web/CLI claims.
2. **Gasless Agent & Owner Onboarding (`E04`, `E05`, `E06`):**
   - `AneVaultFactory` and `AneAgentVault` accept EIP-712 owner signatures (`setPolicyWithSig`, `revokeWithSig`) and `agentSigner` signatures (`settlePayment`), allowing either the hosted sandbox facilitator or a self-hosted relayer to pay the L2 gas (~$0.0001 testnet ETH equivalent on Base Sepolia), while users with Base Sepolia ETH can always submit transactions directly.
3. **Metered Relayer Quotas (`REQ-105`):**
   - Hosted relayer enforces per-IP, per-wallet, and Turnstile/signed challenge limits, max `25` sponsored transactions per wallet per day, and a hard daily ETH gas budget cap (`0.05` Base Sepolia ETH/day) with automatic circuit-breaker fallback to self-relayed mode.

## Consequences
- True 5-minute zero-ETH onboarding for developers using the CLI or web sandbox, while preserving a 100% permissionless on-chain path (`AneFaucet.claim`) if the hosted relayer is offline or rate-limited.
- Eliminates gas-draining griefing attacks against the sandbox operator.

## Alternatives rejected
- **Option B (User must bring Base Sepolia ETH first):** Breaks the 5-minute onboarding story (`README.md` lines 26–32) for developers who do not have mainnet ETH balances required by third-party Sepolia ETH faucets.
- **Option C (Unrestricted ERC-4337 Paymaster):** Vulnerable to gas-draining attacks via expensive calldata or repeated failed `UserOperation` simulations.

## Open risks
- Base Sepolia L1 blob/calldata fee spikes during testnet congestion; mitigated by `maxFeePerGas` / `maxPriorityFeePerGas` caps in the relayer.

## Validation plan
- Foundry tests verifying `AneFaucet` reverts when claiming twice within `cooldownSeconds` or exceeding `maxDailyMint`, while `tANE.transfer` remains unaffected.
- Integration test verifying gasless claim + gasless `settlePayment` succeed when `agentSigner` has `0 ETH` balance.
