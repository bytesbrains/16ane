# ADR-0002: tANE ERC-20 Token Specification, Decimals, Roles, and Extensions

- **Status:** Accepted (2026-10-19)
- **Date and owners:** 2026-10-19 | 16ane Protocol Maintainers
- **Related requirements:** REQ-001, REQ-002, REQ-006, REQ-010, REQ-012
- **Related epics:** E02, E03, E05, E06

## Context
Historically in India (prior to the 1957 decimalisation of the rupee), **1 Rupee = 16 Annas** (`1 Anna = 1/16 Rupee = 6¼ paise = ₹0.0625`), further subdivided into **4 pices** (`1/64` rupee) and **12 pies** (`1/192` rupee), with the word *anna* derived from the Sanskrit **अन्न** (*anna*, meaning "grain").

In the 16ane architecture, `tANE` is the free, unbacked, worthless public sandbox token that mirrors this 1/16th unit scale (`16 tANE` illustrates `₹1` at target scale, `4 tANE` illustrates `25 paise`, `1,600 tANE` illustrates `₹100`, while carrying **zero monetary value or redemption rights**). We must decide its ERC-20 decimals, symbol/name metadata (ensuring explicit no-value disclosure), mint/burn role architecture, and signature extensions required for gasless agent payments (`x402`) and vault funding.

## Options
1. **Option A: 18 Decimals (`ERC20` + `ERC20Burnable` + `ERC20Permit` [EIP-2612] + `EIP-3009` [`transferWithAuthorization` / `receiveWithAuthorization` / `cancelAuthorization`] + `AccessControlDefaultAdminRules`).**
2. **Option B: 6 Decimals (USDC-style) with EIP-2612 and EIP-3009.**
3. **Option C: Minimal ERC-20 without EIP-2612 or EIP-3009 (similar to `copra/src/testnet/TestnetUSDC.sol`).**

## Evidence and sources
- **ERC-20 (`https://eips.ethereum.org/EIPS/eip-20`), EIP-2612 (`https://eips.ethereum.org/EIPS/eip-2612`), EIP-3009 (`https://eips.ethereum.org/EIPS/eip-3009`):** Checked 2026-10-19. All three are Final EIP standards.
- **x402 Payment Protocol (`https://www.x402.org/`, `https://github.com/coinbase/x402`):** Checked 2026-10-19. The reference x402 EVM `exact` scheme uses EIP-3009 `transferWithAuthorization` (with random `bytes32` nonces) because sequential nonces in EIP-2612 cause race conditions during concurrent agent HTTP calls. Supporting both `(v, r, s)` EOA signatures and `bytes signature` (ERC-1271) overloads in EIP-3009 matches the x402 verifier interface.
- **Existing Repo Spec (`docs/protocol/PAYMENTS.md` line 27):** Illustrates `"amount_base_units": "16000000000000000000"` (`16 * 10^18`) for 16 `tANE`.
- **Sibling `copra` Repo ([`copra/src/CopraToken.sol`](https://github.com/bytesbrains/copra/blob/465dd8be027c27eada5fcd83aa69f893eb1037bb/src/CopraToken.sol) & `src/testnet/TestnetUSDC.sol`):** Uses OpenZeppelin v5.7.0 (`lib/openzeppelin-contracts`), 18 decimals on `CopraToken`, 6 decimals on `TestnetUSDC`, and lacks EIP-2612/EIP-3009.

## Security and legal impacts
- **Permissionless transfer invariant (`REQ-001`):** `tANE` MUST NOT include a transfer pause, blacklist, freeze, or transfer fee on standard `transfer` / `transferFrom` / `transferWithAuthorization`. Only faucet minting (`MINTER_ROLE`) can be paused or rate-limited (`REQ-002`).
- **Explicit no-value metadata (`REQ-012`):** Token `name()` is `"16ane Sandbox (NO CASH VALUE)"` (29 bytes, fitting OpenZeppelin v5.7.0 `EIP712` `ShortStrings` 31-byte inline limit) and `symbol()` is `"tANE"`. A public constant `DISCLAIMER = "TESTNET SIMULATION TOKEN ONLY. NO INR BACKING, NO REDEMPTION, NO MONETARY VALUE."` and `isTestToken() == true` view function prevent confusion with any future token and allow mainnet scripts (like `copra`'s `_hasNoFaucet` check) to programmatically reject `tANE`.
- **Role separation:** Uses OpenZeppelin `AccessControlDefaultAdminRules` (2-step admin transfer with delay). `DEFAULT_ADMIN_ROLE` manages roles; `MINTER_ROLE` is granted strictly to the `AneFaucet` contract (and capped per-epoch mint ceiling) so no EOA needs hot minting privileges in normal operation.

## Decision
Adopt **Option A**:
- **Name:** `"16ane Sandbox (NO CASH VALUE)"`
- **Symbol:** `"tANE"`
- **Decimals:** `18` (`1 tANE = 10^18` base units; `16 tANE = 16 * 10^18` base units).
- **Standard Interfaces:**
  - `ERC20` & `ERC20Burnable` (OpenZeppelin v5.7.0)
  - `ERC20Permit` (EIP-2612 sequential permit for one-tx vault funding and Permit2 approval)
  - `EIP-3009` (`transferWithAuthorization`, `receiveWithAuthorization`, `cancelAuthorization`, `authorizationState(address authorizer, bytes32 nonce)`) with random `bytes32` nonces, supporting both `(uint8 v, bytes32 r, bytes32 s)` and `(bytes memory signature)` via OpenZeppelin `SignatureChecker` (ERC-1271 compatible)
  - `AccessControlDefaultAdminRules` with `MINTER_ROLE`
- **Core Transfer Freedom:** No `Pausable` modifier on token transfers; only minting can be halted or rate-capped if a faucet key/contract is compromised.

## Consequences
- Agents can sign concurrent off-chain EIP-3009 authorizations for x402 `exact` payments without holding ETH or suffering sequential nonce collisions.
- Owners can fund `AgentVault` in a single transaction using EIP-2612 `permit`.
- Sub-paise micro-pricing is natively representable without rounding loss (`1 ANE` target illustration = `0.0625 INR` = `6.25 paise`, which divides cleanly in 18 decimals).

## Alternatives rejected
- **Option B (6 decimals):** While USDC uses 6 decimals, `16 ANE = 1 INR` (`1 ANE = 0.0625 INR`) means sub-unit per-token LLM pricing splits more cleanly in standard 18-decimal EVM math, and `docs/protocol/PAYMENTS.md` already models 18 decimals.
- **Option C (Minimal ERC-20 without EIP-2612/3009):** Forces every agent payment to submit an on-chain `transfer` transaction paying ETH gas or requires a pre-approved Permit2 transaction, degrading the 5-minute onboarding experience.

## Open risks
- EIP-3009 `transferWithAuthorization` checks EOA signatures via `ecrecover` and contract signatures via read-only `STATICCALL` (`IERC1271.isValidSignature`). As documented in `ADR-0003` and `ADR-0005`, an agent's bounded spending cap cannot rely solely on `IERC1271.isValidSignature` because `STATICCALL` cannot increment `cumulativeSpent`. Bounded agent spending must settle through `AgentVault` or an authorized sub-allowance slice.

## Validation plan
- Unit and fuzz tests verifying ERC-20, EIP-2612 `permit`, and EIP-3009 `transferWithAuthorization` / `receiveWithAuthorization` / `cancelAuthorization` (including replay rejection, expired `validBefore`, premature `validAfter`, wrong signer, and random `bytes32` nonce independence).
- Verify non-minter cannot mint and admin cannot pause/block peer-to-peer `transfer`.
