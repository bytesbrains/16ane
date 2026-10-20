# ADR-0006: Gas Funding, Relayer Sponsorship, and Faucet Abuse Policy

- **Status:** Accepted (2026-10-19); amended 2026-10-20 (#61, see *Amendments*)
- **Date and owners:** 2026-10-19 | 16ane Protocol & Operations Maintainers
- **Related requirements:** REQ-001, REQ-002, REQ-012, REQ-105
- **Related epics:** E02, E05, E06, E16

## Context
New developers onboarding to the 5-minute sandbox quickstart (`README.md`) may not initially hold Base Sepolia ETH (`eip155:84532`). In the sibling `copra` repo ([`web/assets/wallet.js`](https://github.com/bytesbrains/copra/blob/465dd8be027c27eada5fcd83aa69f893eb1037bb/web/assets/wallet.js#L217) `claimFaucet()`, `src/testnet/TestnetUSDC.sol`), the faucet requires the user to submit an on-chain transaction paying their own Base Sepolia ETH gas and has no cooldown or rate-limiting in the contract. For 16ane, `REQ-002` requires bounded faucet distributions with abuse controls that never restrict ordinary token transfers (`REQ-001`), and `REQ-105` requires optional gas sponsorship with metered policy and no unlimited subsidy.

## Options
1. **Option A: Dual-Mode Faucet & Gasless Meta-Transaction Settlement (On-Chain `AneFaucet` with Cooldowns + Hosted Cloudflare Worker Relayer with Turnstile/Signed Challenge & Hard Daily ETH Budget Cap).**
2. **Option B: Pure Client-Submitted Faucet (User must acquire Base Sepolia ETH externally before claiming `tANE`).**
3. **Option C: Open ERC-4337 Verifying Paymaster Sponsoring Arbitrary UserOperations.**

## Evidence and sources
- **Sibling `copra` Faucet Audit ([`copra/src/testnet/TestnetUSDC.sol`](https://github.com/bytesbrains/copra/blob/465dd8be027c27eada5fcd83aa69f893eb1037bb/src/testnet/TestnetUSDC.sol#L11-L33) lines 11–33):**
  - `TestnetUSDC.faucet()` allows any caller with Base Sepolia ETH to mint `10,000 * 1e6` per call with zero cooldown.
- **EIP-2612 (`https://eips.ethereum.org/EIPS/eip-2612`) & EIP-3009 (`https://eips.ethereum.org/EIPS/eip-3009`):** Checked 2026-10-19. Enable off-chain EIP-712 signatures from `owner` and `agentSigner` so a relayer/facilitator can submit vault creation, delegation, and payment settlement transactions without the agent holding ETH.
- **Threat Model (`docs/security/THREAT_MODEL.md`, "High-priority abuse cases": gas-draining denial of service):**
  - "Sponsor or paymaster suffers gas-draining denial of service."

## Security and legal impacts
- **Bounded relayer gas exposure (`REQ-105`, `THREAT_MODEL.md`):** Hosted relayer/faucet only calls allowlisted contract methods (`AneFaucet.drip`, `AneVaultFactory.createAndDelegateWithSig`, `AneAgentVault.settlePayment`, `tANE.transferWithAuthorization`) with a hard `maxFeePerGas` ceiling and a global daily Sepolia ETH spend circuit breaker. There is no per-wallet transaction quota (#61).
- **On-chain faucet enforcement (`REQ-002`):** Even if someone calls `AneFaucet` directly on-chain paying their own ETH gas, the smart contract enforces `claimAmount` (default `16,000 * 10^18` `tANE`), `cooldownSeconds` (default `1 hour` per recipient address), and `maxDailyMint` (default `160,000,000 * 10^18` `tANE`/day).
- **Transfer independence (`REQ-001`):** Faucet cooldowns and relayer rate limits apply exclusively to `AneFaucet` and hosted relayer endpoints; standard `tANE` transfers and self-relayed `AneAgentVault` calls remain 100% permissionless.

## Decision
Adopt **Option A**:
1. **On-Chain `AneFaucet` Contract (`E05`):**
   - Holds `MINTER_ROLE` on `tANE` (or draws from a pre-minted faucet reserve).
   - Enforces on-chain `claimAmount = 16_000e18` (`16,000 tANE`), `cooldownSeconds = 3_600` (1 hour per `recipient`; the contract keys the cooldown on the recipient only, so a shared relayer is not throttled), and `maxDailyMint = 160_000_000e18` (~10,000 claims/day, a runaway stop rather than a throttle). The owner can change all three with `setFaucetConfig` without a redeploy.
   - Exposes both `claim(address recipient)` (permissionless on-chain call for users who already have Base Sepolia ETH) and `relayedClaim(address recipient, bytes32 campaignId, uint256 deadline, bytes signature)` for gasless web/CLI claims.
2. **Gasless Agent & Owner Onboarding (`E04`, `E05`, `E06`):**
   - `AneVaultFactory` and `AneAgentVault` accept EIP-712 owner signatures (`setPolicyWithSig`, `revokeWithSig`) and `agentSigner` signatures (`settlePayment`), allowing either the hosted sandbox facilitator or a self-hosted relayer to pay the L2 gas (~$0.0001 testnet ETH equivalent on Base Sepolia), while users with Base Sepolia ETH can always submit transactions directly.
3. **Metered Relayer Quotas (`REQ-105`):**
   - The hosted relayer's only limit is cost: a hard daily ETH gas budget (`0.05` Base Sepolia ETH/day to start, resized from measured gas use after deployment) with automatic circuit-breaker fallback to self-relayed mode, plus a `maxFeePerGas` ceiling. Implemented in the reference server (#76): `ANE_RELAYER_GAS_BUDGET_WEI`, counted from each receipt's full fee (L2 gas plus Base's L1 data fee), kept per UTC day in the server's persistent store; each send holds back gas before it is sent (synchronously, so concurrent sends can't all pass the check) and is counted on the UTC day it started; over budget, callers get `503 ANE-E-1006` with `Retry-After` and a self-serve hint. The `maxFeePerGas` ceiling isn't implemented yet. There are no per-wallet or per-agent transaction-count limits. A CAPTCHA (Turnstile) applies only to the anonymous web faucet; agents and the CLI use a signed-challenge path. Anyone can bypass the relayer by paying their own gas.

## Amendments
- **2026-10-20 (#61): limits sized for agent-speed use.** 16ane is an economy for agents, so the payment path carries no protocol rate limits or count caps; the only spending limits are the ones a vault owner sets. Limits apply only to resources the operator pays for, and they limit cost, not actions. Changes: faucet defaults raised from 1,600 tANE / 24 h / 1.6 M per day to 16,000 tANE / 1 h / 160 M per day (claims are sized in notional rupees: 16,000 tANE is ₹1,000 at the 16 ANE = ₹1 illustration, enough for 1,000 calls at 16 tANE); the "25 sponsored transactions per wallet per day" relayer quota is removed; the cooldown is described as per recipient, which is what `AneFaucet` implements.

## Consequences
- True 5-minute zero-ETH onboarding for developers using the CLI or web sandbox, while preserving a 100% permissionless on-chain path (`AneFaucet.claim`) if the hosted relayer is offline or rate-limited.
- Eliminates gas-draining griefing attacks against the sandbox operator.

## Alternatives rejected
- **Option B (User must bring Base Sepolia ETH first):** Breaks the 5-minute onboarding story (`README.md`, "First five-minute success story") for developers who do not have mainnet ETH balances required by third-party Sepolia ETH faucets.
- **Option C (Unrestricted ERC-4337 Paymaster):** Vulnerable to gas-draining attacks via expensive calldata or repeated failed `UserOperation` simulations.

## Open risks
- Base Sepolia L1 blob/calldata fee spikes during testnet congestion; mitigated by `maxFeePerGas` / `maxPriorityFeePerGas` caps in the relayer.

## Validation plan
- Foundry tests verifying `AneFaucet` reverts when claiming twice within `cooldownSeconds` or exceeding `maxDailyMint`, while `tANE.transfer` remains unaffected.
- Integration test verifying gasless claim + gasless `settlePayment` succeed when `agentSigner` has `0 ETH` balance.
