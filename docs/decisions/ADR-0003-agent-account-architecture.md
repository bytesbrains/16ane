# ADR-0003: Agent Account Architecture (Dedicated Policy Vault vs ERC-4337 vs EIP-7702)

- **Status:** Proposed (Phase 0 review required)
- **Date and owners:** 2026-10-19 | 16ane Protocol & Security Maintainers
- **Related requirements:** REQ-001, REQ-003, REQ-004, REQ-005, REQ-104, REQ-107
- **Related epics:** E02, E04, E06, E17

## Context
Owners must create isolated agent accounts, fund them with `tANE`, delegate bounded spending authority to an `agentSigner` without exposing the owner's root private key (`REQ-003`), enforce spending caps in smart contract state (`REQ-004`), separate incoming merchant revenue from spendable budget in fixed mode (`REQ-107`), and revoke/withdraw unencumbered funds at any time (`REQ-005`). Furthermore, core operations must not depend on hosted third-party infrastructure (`REQ-001`).

## Options
1. **Option A: Dedicated `AneAgentVault` (Deterministic Clones via `AneVaultFactory`) with Native Session-Key Policy Enforcement and Optional ERC-4337/ERC-1271 Adapter.**
2. **Option B: General-Purpose ERC-4337 + ERC-7579 Modular Smart Account (e.g., Safe7579 / Kernel v3) with External Bundler Required.**
3. **Option C: EIP-7702 Delegated EOA Account.**

## Evidence and sources
- **ERC-4337 (`https://eips.ethereum.org/EIPS/eip-4337`) & ERC-7579 (`https://eips.ethereum.org/EIPS/eip-7579`):** Checked 2026-10-19. Canonical EntryPoint v0.7 (`0x0000000071727De22E5E9d8BAf0edAc6f37da03`) and v0.8 (`0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108`) are live on Base Sepolia (`84532`). However, `UserOperation` submission requires an ERC-4337 bundler service, and standard ERC-7579 spending-limit hooks do not distinguish incoming ERC-20 `transfer()` revenue from owner-funded principal inside `tANE.balanceOf(account)`.
- **EIP-7702 (`https://eips.ethereum.org/EIPS/eip-7702`):** Checked 2026-10-19. Live on Base Sepolia. However, delegating an owner EOA directly violates `REQ-003` (shared storage/assets with owner root key), and if an agent holds an EOA private key, `ecrecover` in EIP-3009 `transferWithAuthorization` completely bypasses EIP-7702 delegated account code, and the owner cannot revoke the EOA private key (`REQ-005`).
- **EIP-1167 Minimal Proxy Clones (`OpenZeppelin Clones` v5.7.0 in `copra/lib/openzeppelin-contracts`):** Enables cheap (~45k gas) deterministic `CREATE2` deployment of isolated per-agent vaults with zero external bundler dependency.

## Security and legal impacts
- **Critical Finding on ERC-1271 / EIP-3009 Statelessness:** Because `IERC1271.isValidSignature` is invoked via a read-only `STATICCALL`, a smart contract wallet cannot increment `cumulativeSpent` inside `isValidSignature`. If a vault simply returned `0x1626ba7e` for any `transferWithAuthorization` <= remaining budget, a compromised agent could sign 100 parallel authorizations that all pass `STATICCALL` verification against the full vault balance!
- **Enforceable state mutation (`REQ-004`):** Spend execution must mutate vault state (`cumulativeSpent += amount` and mark `nonce`/`paymentId` used) in a state-changing call (`executeSpend` / `settleX402Spend`) on `AneAgentVault`.
- **No unlimited approvals (`THREAT_MODEL.md`):** The agent signer cannot call arbitrary contracts or `tANE.approve()`. The vault only permits bounded `tANE` transfers to valid recipients under active policy parameters.

## Decision
Adopt **Option A**: Build a dedicated, minimal, auditable **`AneAgentVault`** contract deployed via **`AneVaultFactory`** (`OpenZeppelin Clones.cloneDeterministic`):
1. **Actor Separation (`REQ-003`):**
   - `owner`: Immutable or `Ownable2Step` controller (the human/organization EOA or multisig). Only `owner` can call `setPolicy()`, `revoke()`, `rotateAgentSigner()`, and `withdraw()`.
   - `agentSigner`: A dedicated session EOA address generated for the agent runtime. Holds no owner keys.
2. **Enforced Policy State (`REQ-004`):**
   - `agentSigner` (address), `policyVersion` (uint64, incremented on revoke/update to invalidate all prior off-chain signatures instantly), `maxTotalSpend` (uint256), `cumulativeSpent` (uint256), `maxPerTx` (uint256), `dailyLimit` (uint256), `expiry` (uint64), `budgetMode` (`FIXED` or `REVOLVING`), `active` (bool), and optional `allowedRecipients` merkle root / allowlist flag.
3. **Execution Paths (`REQ-001`, `REQ-006`):**
   - **Direct / Relayed EIP-712 Spend (`settlePayment`):** `agentSigner` signs an EIP-712 `SpendIntent(address vault, address merchant, uint256 amount, bytes32 quoteId, bytes32 serviceIdHash, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint64 policyVersion)`. Anyone (the agent itself, the merchant server, or an x402 facilitator) can submit `vault.settlePayment(intent, signature)` over standard JSON-RPC without needing an ERC-4337 bundler.
   - **Direct `agentSigner` Call (`spend`):** If `agentSigner` holds testnet ETH, it can call `vault.spend(merchant, amount, quoteId, nonce)` directly.

## Consequences
- Small, self-contained Solidity surface (~250 LOC) where every invariant in `WALLET.md` (`REQ-003`, `REQ-004`, `REQ-005`, `REQ-107`) can be proven with Foundry property and fuzz tests.
- Zero dependency on hosted ERC-4337 bundlers (`REQ-001`).
- Instant O(1) revocation via `revoke()` (increments `policyVersion` and sets `active = false`), immediately invalidating any unsubmitted off-chain `SpendIntent` signatures.

## Alternatives rejected
- **Option B (Pure ERC-4337 + ERC-7579):** Requires a running ERC-4337 bundler for every agent payment and revocation, and standard session-key modules do not isolate incoming `tANE` revenue from spendable allowance in fixed mode. (Note: ERC-4337 compatibility can still be added as an optional P2 adapter on `AneAgentVault` if desired).
- **Option C (EIP-7702 Delegated EOA):** Cannot revoke a compromised EOA private key, and EIP-3009 `ecrecover` bypasses delegated code.

## Open risks
- In-flight transactions already submitted to the mempool before `revoke()` is mined may still execute before the `revoke()` transaction lands (`REQ-005`); this finality boundary must be documented clearly in SDKs and UI.

## Validation plan
- Foundry unit, fuzz, and invariant tests (`AneAgentVault.t.sol`) covering all 10 security tests in `docs/security/THREAT_MODEL.md` (overspend by 1 wei reverts, concurrent spends cannot exceed `maxTotalSpend`, replay of `nonce` or old `policyVersion` reverts, owner `revoke` blocks future spends, owner `withdraw` sweeps available balance).
