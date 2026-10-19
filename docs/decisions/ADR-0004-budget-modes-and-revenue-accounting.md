# ADR-0004: Fixed and Revolving Budget Semantics and Revenue Accounting

- **Status:** Proposed (Phase 0 review required)
- **Date and owners:** 2026-10-19 | 16ane Protocol Maintainers
- **Related requirements:** REQ-004, REQ-005, REQ-008, REQ-107
- **Related epics:** E02, E04, E17

## Context
An agent in the 16ane economy both **spends** `tANE` (buying intelligence/APIs) and **earns** `tANE` (selling services to other agents). A core invariant in `AGENTS.md` and `docs/protocol/WALLET.md` states:
"An agent's revenue does not silently increase its spend authority under fixed-budget mode."
Because standard ERC-20 `transfer(vault, amount)` directly increases `tANE.balanceOf(vault)` without calling a hook on `vault`, we must define exact on-chain accounting equations so that incoming `tANE` transfers (including wash trades or unsolicited transfers) can never expand spend authority under `FIXED` mode, while still allowing owner-authorized earnings recycling under `REVOLVING` mode (`REQ-107`).

## Options
1. **Option A: Dual-Tracked Principal & Allowance Accounting in `AneAgentVault` with Explicit Revenue Recognition (`recordRevenue` / Balance-Delta Accounting).**
2. **Option B: Separate Receiver Vault (`MerchantVault` vs `SpendVault`) requiring two addresses per agent.**
3. **Option C: Custom `tANE` transfer hook (`ERC-1363` / `ERC-777` style callback on every `transfer`).**

## Evidence and sources
- **Repo Requirements (`docs/product/REQUIREMENTS.md` line 47, `docs/protocol/WALLET.md` lines 15–23):**
  - Example journey: Owner funds agent with `1,600 tANE` and delegates `maxTotal = 320 tANE`. Agent spends `16 tANE` and earns `32 tANE`. Under `FIXED` mode, remaining spend authority must be `320 - 16 = 304 tANE` (NOT `336 tANE`), while total vault token balance is `1,600 - 16 + 32 = 1,616 tANE`.
  - Invariant: "Agent can receive tANE regardless of spend permission, unless account policy explicitly blocks it."
- **Threat Model (`docs/security/THREAT_MODEL.md` line 13):**
  - "Fake 'earnings' via wash trades used to evade fixed-budget spending cap."

## Security and legal impacts
- **Wash-trade immunity in `FIXED` mode:** Under `FIXED` mode, `spendableRemaining` is strictly `min(maxTotalSpend - cumulativeSpent, ownerFundedBalanceRemaining)`. Even if an attacker or colluding agent transfers `1,000,000 tANE` to the vault, `maxTotalSpend - cumulativeSpent` does not change.
- **Bounded exposure in `REVOLVING` mode (`REQ-107`):** If an owner explicitly enables `REVOLVING` mode, an agent is permitted to recycle verified revenue up to an owner-signed `revolvingCeiling` and `dailySpendCap`. Even in `REVOLVING` mode, total net loss of owner principal can never exceed the initial owner-funded allocation.

## Decision
Adopt **Option A**: Single `AneAgentVault` address per agent with explicit state variables that decouple **token custody** from **spending authorization**:

### 1. Core Accounting Variables in `AneAgentVault`
- `uint256 public ownerPrincipalDeposited`: Total `tANE` deposited via `fund(amount)` by the owner (minus owner principal withdrawals).
- `uint256 public maxTotalSpend`: Cumulative spend cap signed/configured by the owner for the current policy epoch.
- `uint256 public cumulativeSpent`: Cumulative `tANE` spent by `agentSigner` in the current policy epoch.
- `uint256 public verifiedRevenue`: Cumulative `tANE` received through `receiveServicePayment(...)` or reconciled from `tANE.balanceOf(address(this))`.
- `BudgetMode public budgetMode`: Enum `{ FIXED, REVOLVING }`.
- `uint256 public revolvingTreasuryCeiling`: Maximum spendable allowance ceiling when `budgetMode == REVOLVING`.

### 2. Spend Authority Equations
- **In `FIXED` Mode (Default, P0):**
  - `authorizedRemaining = maxTotalSpend - cumulativeSpent`
  - `actualBalance = tANE.balanceOf(address(this))`
  - `spendableAmount = min(authorizedRemaining, actualBalance)`
  - Incoming `tANE` (whether via `tANE.transfer` or `settlePayment`) increases `actualBalance` (and `unallocatedRevenue = actualBalance - (ownerPrincipalDeposited - min(cumulativeSpent, ownerPrincipalDeposited))`), which is **withdrawable by `owner`** via `withdraw()`, but **never increases `authorizedRemaining`**.
- **In `REVOLVING` Mode (Owner Opt-In, P1 `E17`):**
  - Owner sets `budgetMode = REVOLVING`, `baseAllowance`, `revolvingTreasuryCeiling`, and `dailySpendCap`.
  - Verified incoming payments (`settlePayment` where `recipient == address(vault)`) increment `verifiedRevenue`.
  - `effectiveCap = min(baseAllowance + verifiedRevenue, cumulativeSpent + revolvingTreasuryCeiling)`
  - `authorizedRemaining = effectiveCap - cumulativeSpent`
  - Direct raw `tANE.transfer()` without a settled payment receipt is treated as `unverifiedDeposit` (withdrawable by owner, does not auto-increment `verifiedRevenue` unless owner opts in) to prevent wash-deposit cap manipulation.

### 3. Owner Withdrawal & Revocation (`REQ-005`)
- `withdraw(uint256 amount, address to)` (`onlyOwner`): Transfers `amount` of `tANE` to `to`. If `actualBalance` after withdrawal is less than `authorizedRemaining`, `spendableAmount` is automatically bounded by `actualBalance`.
- `revokeAndSweep(address to)` (`onlyOwner`): Sets `active = false`, increments `policyVersion`, and transfers full `tANE.balanceOf(address(this))` to `to` in a single atomic transaction.

## Consequences
- Agents have a single canonical address on Base Sepolia to both pay merchants and receive payments as a merchant.
- `FIXED` mode guarantees mathematically that `cumulativeSpent <= maxTotalSpend` regardless of incoming transfers (`THREAT_MODEL.md` Security Test #6).
- Owners can inspect `ownerPrincipalDeposited`, `cumulativeSpent`, `authorizedRemaining`, and `earnedRevenue` via a single `getAccountingSummary()` view call (`REQ-015`).

## Alternatives rejected
- **Option B (Two separate contracts per agent):** Doubles deployment gas and forces developers to manage separate buyer and seller addresses for the same agent.
- **Option C (ERC-777/ERC-1363 transfer hooks):** Introduces reentrancy vectors on token transfers and breaks standard ERC-20 / EIP-3009 simplicity.

## Open risks
- Unconfirmed incoming transfers could be reorged on L2 if an agent immediately re-spends them in `REVOLVING` mode; mitigated by requiring on-chain settlement in the same or prior finalized block before `verifiedRevenue` is credited.

## Validation plan
- Property test: Under `FIXED` mode, fuzz arbitrary sequences of `fund()`, `settlePayment()` (outbound), raw `tANE.transfer(vault, x)` (inbound), and `settlePayment()` (inbound to vault); assert `cumulativeSpent <= maxTotalSpend` always holds.
- Unit test for `README.md` / `REQUIREMENTS.md` acceptance journey (`fund 1,600 -> delegate 320 -> spend 16 -> earn 32 -> verify remaining spendable is 304 and total balance is 1,616`).
