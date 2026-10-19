# ADR-0011: Contract Upgrade Philosophy, Role Separation, and Emergency Response

- **Status:** Proposed (Phase 0 review required)
- **Date and owners:** 2026-10-19 | 16ane Protocol & Security Maintainers
- **Related requirements:** REQ-001, REQ-003, REQ-004, REQ-005, REQ-010, REQ-013, REQ-SEC
- **Related epics:** E02, E03, E04, E11

## Context
Smart contracts for `tANE`, `AneAgentVault`, `AneVaultFactory`, `AneFaucet`, and `AneRegistry` must balance security invariants (`REQ-001` permissionless transfers, `REQ-003`/`REQ-004`/`REQ-005` owner custody and revocation) with the practical need to roll out new contract versions on the public sandbox testnet (`docs/architecture/SYSTEM.md` lines 37–38, `docs/security/THREAT_MODEL.md` line 16).

## Options
1. **Option A: Immutable Implementation Contracts + Versioned Pointer Registry (`AneRegistry`, adapted from `copra/src/CopraRegistry.sol`) + Non-Upgradeable EIP-1167 Agent Vault Clones.**
2. **Option B: UUPS / Transparent Upgradeable Proxies (`ERC-1967`) on `tANE` and `AneAgentVault`.**
3. **Option C: Hardcoded Unversioned Deployments without a Registry.**

## Evidence and sources
- **Repo Architecture (`docs/architecture/SYSTEM.md` lines 37–38):**
  - "Prefer minimal immutable components. Any proxy/upgrade authority must be documented, time-locked where appropriate, monitored and explicitly disclosed."
- **Sibling `copra` Architecture (`/Users/nandal/Desktop/desk/repos/copra/src/CopraRegistry.sol`, `src/CopraVault.sol`):**
  - Uses immutable, non-proxy implementation contracts (`CopraToken`, `CopraVault`, `CopraOracle`) discovered through a single `CREATE2`-deployed `CopraRegistry` contract (`Ownable2Step`) that validates cross-contract wiring before incrementing `version` and emitting `DeploymentUpdated`.
  - `CopraVault` intentionally avoids `Pausable` on user redemptions and has no admin drain function so an admin key compromise cannot steal or freeze user funds.

## Security and legal impacts
- **Eliminates proxy upgrade rug risk (`THREAT_MODEL.md` line 16):** Because `tANE` and `AneAgentVault` are non-upgradeable contracts (not ERC-1967 proxies), a compromised protocol admin key can **never** upgrade `AneAgentVault` bytecode to steal owner funds or add a transfer freeze to `tANE`.
- **Emergency response boundaries (`OPERATIONS.md` lines 10–15):**
  - If `AneFaucet` is abused or its relayer key is compromised, the protocol admin can call `AneFaucet.pause()` or revoke `MINTER_ROLE` from the old faucet on `tANE` without affecting any existing `tANE` balances, transfers (`REQ-001`), or `AneAgentVault` withdrawals (`REQ-005`).
  - If a bug is discovered in `AneVaultFactory` or `AneAgentVault`, a patched `AneVaultFactory v2` is deployed and registered in `AneRegistry.setDeployment(...)`. Existing owners can still call `withdraw()` / `revokeAndSweep()` directly on their v1 vaults and migrate to v2 at their discretion.

## Decision
Adopt **Option A**:
1. **No Upgradeable Proxies (`ERC-1967` / `UUPS` / `TransparentUpgradeableProxy` forbidden in P0):**
   - `tANE`, `AneAgentVault` (master implementation + EIP-1167 clones), `AneVaultFactory`, `AneFaucet`, and `AneServiceDirectory` are deployed as immutable bytecode contracts with `solc 0.8.28`, `bytecode_hash = "none"`, and `cbor_metadata = false`.
2. **Versioned Discovery via `AneRegistry` (`Ownable2Step`):**
   - Deployed via `CREATE2` so its address is deterministic across local Anvil and Base Sepolia (`ADR-0001`).
   - Stores `(taneToken, vaultFactory, faucet, serviceDirectory, version, updatedAt)` and validates cross-contract references on `setDeployment()`.
3. **Strict Admin Role Separation (`AccessControlDefaultAdminRules` / `Ownable2Step`):**
   - `tANE`: `DEFAULT_ADMIN_ROLE` (2-step transfer with delay) can grant/revoke `MINTER_ROLE` (held by `AneFaucet`). Admin cannot pause transfers, burn user balances, or blacklist addresses.
   - `AneFaucet`: `PAUSER_ROLE` / `owner` can pause faucet drips and adjust cooldowns/caps (`ADR-0006`).
   - `AneAgentVault`: Controlled exclusively by the vault's individual `owner` (`Ownable2Step`). Protocol maintainers have **zero** privileges on user-created agent vaults.

## Consequences
- Users and security reviewers can verify once that `AneAgentVault` and `tANE` contain no proxy upgrade hooks or admin backdoors.
- Protocol upgrades on the sandbox are clean, explicit version bumps in `AneRegistry`.

## Alternatives rejected
- **Option B (UUPS/Transparent Proxies on Vaults):** Gives the proxy admin god-mode authority over every user's vault logic, violating self-custody trust boundaries.
- **Option C (No Registry):** Breaks SDK/web client discovery whenever a new faucet or factory version is deployed.

## Open risks
- Migrating `tANE` itself (if a bug were ever found in the token contract) requires deploying `tANE v2` and updating `AneRegistry`; acceptable on a zero-value testnet sandbox.

## Validation plan
- Foundry trust-assumption tests (`test_TrustAssumption_AdminCannotFreezeTransfers`, `test_TrustAssumption_AdminCannotAccessAgentVault`, `test_RegistryRevertsOnMismatchedWiring`) modeled after `copra/test/CopraProtocol.t.sol`.
