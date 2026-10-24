# ADR-0020: One Vault per Asset for Multi-Asset Agent Payments

- **Status:** Proposed (2026-10-24)
- **Date and owners:** 2026-10-24 | 16ane Protocol Maintainers
- **Related requirements:** REQ-204, REQ-004, REQ-001
- **Related epics:** E20 (#133, follow-up to ISS-023)
- **Builds on:** ADR-0019 (asset-aware quote selection and routing), ADR-0003 and ADR-0004 (vault custody and budget modes), ADR-0001 (continuity), ADR-0002 (test token). **Supersedes:** the "REQ-204 only partly met" limitation in ADR-0019.

## Context

ADR-0019 made quote selection and routing asset-aware, but left `AneAgentVault` paying exactly one token. That
token, `taneToken`, is immutable, set once per implementation (`src/AneAgentVault.sol:89`). As a result a
vault-funded agent could pay only in tANE, and `AgentSession.purchase` refused every other asset with `ANE-E-3003`.

Issue #133 asks for a choice between two options, then an implementation:
- **Option B:** a multi-asset vault, with a budget per token.
- **Option C:** one vault per asset.

An inventory at `067b99a` found:
- **The sandbox is live and source-verified on Base Sepolia** (`networks/sandbox-sepolia.json`, deployed 2026-10-20 from `e43ccc8`). ADR-0001 requires 30 days' notice before any redeployment. Since `e43ccc8`, the only change under `src/` is the new `AneTaskEscrow.sol`.
- **`AneVaultFactory` already takes its token as a constructor argument.** It deploys one `AneAgentVault` implementation for that token, and its `isRegisteredVault` covers only its own clones.
- **Two places treat "registered vault" as "same token as me":**
  - `AneAgentVault._executeSpend` credits revenue to a merchant that the factory has registered (`notifyVerifiedRevenue`).
  - `AneTaskEscrow._checkOpen` accepts any vault the factory has registered, then pays out its own token.

  Both are correct only while one factory produces vaults of one asset.
- **Option B would reach a long way.** `SpendIntent` would need an `asset` field. That changes the EIP-712 type that `packages/sdk-ts/src/crypto.ts`, `packages/sdk-py/ane_sdk/crypto.py`, the merchant verifier, the facilitator and the escrow all sign or check. Every piece of budget state would become a per-token mapping, and `policyVersion` would stop meaning one thing per budget.

## Options considered

1. **Option B: a multi-asset vault.**
   - *Pros:* one address and one signer per agent, and one revocation transaction.
   - *Cons:* a rewrite of the contract that enforces budgets, a change to the signed type everywhere it is used, and a full sandbox redeploy, with the 30-day notice.
2. **Option C1: one shared factory with an asset allow-list.**
   - *Pros:* one factory address.
   - *Cons:* it adds a privileged role to the factory. It also changes `AneAgentVault`, because revenue credit needs an asset check, and `AneTaskEscrow`, because it needs a same-asset check. Both are deployed contracts, so this still means a redeploy.
3. **Option C2: one factory per asset.** Each additional asset gets its own instance of the unchanged `AneVaultFactory`.

## Decision

**Option C, as C2.** The maintainer chose Option C on 2026-10-24. C2 is the variant that changes no deployed contract.

1. **One vault per asset, one factory per asset.**
   - A second asset is a new `AneVaultFactory(token)` deployment. The vault, factory, registry, faucet and escrow code are unchanged, and so is every deployed tANE address.
   - An agent that pays in two assets has two vaults, one from each factory. They can share an owner, a salt and an agent signer. Each vault has its own policy, cap, per-transaction limit, daily limit, budget mode and revenue account, in its own asset's base units.
   - **Invariant:** a factory never produces vaults of two assets. If a future change ever lets it, the revenue-credit and escrow checks below must gain an explicit same-asset test first.
2. **Assets stay isolated by construction. Nothing extra has to be enforced.**
   - **Spends:** a spend can move only the vault's own token, and only that vault's counters change.
   - **Revenue:** a vault credits revenue only to a merchant its own factory registered. That is always a vault of the same asset, so a cross-asset payment credits nothing. Without this, a 5e18 tANE payment read as tSIX would raise a revolving ceiling by five trillion tSIX.
   - **Foreign tokens:** a foreign token paid into a vault is a stray balance. It is never spendable, because `spendableBalance` reads only the vault's own token, and it is never withdrawable, because `withdraw` moves only the vault's own token. That is the same as any token sent to a vault today.
   - **Escrow:** the tANE `AneTaskEscrow` rejects a vault from another asset's factory as `UnregisteredVault`. Otherwise it would take in tSIX and release tANE that other tasks had locked. An escrow for another asset is a separate deployment and is not part of this ADR.
3. **Fixed-budget mode holds per asset.** Revenue cannot raise the spend authority of a FIXED vault in its own asset (ADR-0004). Revenue in another asset cannot reach that vault's accounting at all. A REVOLVING vault's ceiling grows only by verified revenue in its own asset.
4. **The second test asset is tSIX.** `AneSixDecimalTestToken` is free, unbacked and worthless, like tANE. It has 6 decimals so the decimals mismatch is exercised, and the same `isTestToken()` guard and `DISCLAIMER`. It also has EIP-2612 permit, burn and `AccessControlDefaultAdminRules`.
   - It has no EIP-3009, so the gasless relay stays tANE-only (ADR-0006).
   - It is not tANE, does not convert to tANE or ANE, and is not modelled on any real asset.
   - It had no faucet at first, because `AneFaucet`'s on-chain disclaimer names tANE. ADR-0021 adds `AneSixDecimalFaucet` on a shared faucet base; it is now tSIX's only minter.
5. **Deployment is additive.**
   - `script/DeploySecondAsset.s.sol` deploys tSIX and its factory and nothing else, so it needs no continuity notice. It refuses any chain except 84532 and 31337.
   - `DeploySandbox` deploys both after everything else, so no existing address moves.
   - Like the escrow, the registry has no slot for these contracts: clients take the addresses from the deploy output or the network file.
   - Broadcasting to Base Sepolia needs maintainer authorization (DEPLOY_SANDBOX.md section 0), and has not been done.
6. **SDK.**
   - **`MultiAssetSession`** combines one `AgentSession` per vault. It refuses two vaults in one asset, a vault listed twice, and mixed chains.
   - **Caps:** `chooseProvider` and `purchase` take `caps: AssetCap[]`, one cap per asset in base units, in preference order. As in ADR-0019, the preference order decides between assets, never the raw amounts.
   - **Paying:** `purchaseRouted` gives the winning offer to the vault that holds its asset. That vault pays its own token, and checks the receipt on-chain against that token (`verifyReceiptOnChain`).
   - **`vaultAssets()`** lists each vault's asset, read from the vault itself.
   - **Owner side:** `ensureVaultDeployed(salt, { vaultFactory })` and `computeVaultAddress(owner, salt, vaultFactory)` take another asset's factory. `fundVault` approves the vault's own token rather than assuming tANE.
   - **Client:** `AneClient.getVaultAsset` reads a vault's token and refuses an address with no code. `getTokenBalance(account, token)` takes a token.

## Consequences and limitations

- **REQ-204 is met for vault-funded agents on a local chain.** It is not yet met on the public sandbox: that needs the additive deploy, which now includes the tSIX faucet (ADR-0021).
- **Revocation is per vault.** An agent with two vaults has two policies, so revoking means two `revoke` transactions, which are not atomic. `revokeAndSweep` is also per vault.
- **Each additional asset adds a factory address** that clients must be told about, because the registry does not list it.
- **The facilitator, the reference sandbox server and the MCP server stay tANE-only.** The facilitator refuses other assets explicitly (`services/facilitator/src/facilitator.ts`). The Python SDK needed no change, because `AgentSession.purchase` there already pays only `vault_asset()`. It has no multi-vault router (ADR-0019 scope).
- **A foreign token sent to a vault is stuck.** Recovery would need a new vault function, which is out of scope.
- **Security review.** No enforcement code changed, but the isolation argument in Decision 2 is the security boundary. It must be reviewed before any public deploy. The invariant test below is evidence for that review, not a substitute for it.
- **Out of scope** (as the issue sets it): cross-asset price conversion and oracles, bridges, fiat rails, and any real-value or tradable asset.

## Validation

- **`test/AneMultiAsset.t.sol`:**
  - tSIX metadata and its mint role;
  - one owner and salt gives a different vault per factory, and each factory registers only its own vaults;
  - caps and per-transaction limits are in each asset's own base units;
  - cross-asset payments in both directions credit no revenue and leave both ceilings unchanged, while a same-asset peer still credits revenue (the control case);
  - the tANE escrow refuses a tSIX vault;
  - `DeploySandbox` adds tSIX without moving the registry wiring, and the registry refuses a tSIX factory in the tANE slot;
  - `DeploySecondAsset` works on testnet chains and refuses mainnet.
- **`test/AneMultiAsset.invariant.t.sol`:** a tANE vault in FIXED mode and a tSIX vault in REVOLVING mode, with the same owner and signer, under random spends, cross-asset payments both ways and same-asset peer revenue. The invariants are:
  - each vault's spend counter equals the total of its own-asset spends;
  - the tANE vault's revenue stays 0, and the tSIX vault's revenue equals what its same-asset peer paid it;
  - the FIXED ceiling is unchanged, and the REVOLVING ceiling stays within its cap plus same-asset revenue;
  - foreign tokens are exactly the cross-asset amounts paid in, and are never spendable.
- **`packages/sdk-ts/test/multi-asset.test.ts`:**
  - the preference order picks the paying vault;
  - a cap binds only its own asset;
  - routing across providers;
  - nothing payable is refused after the probe, before anything is signed;
  - misconfigurations are refused;
  - `getVaultAsset` refuses an address with no code.
- **`e2e/flows/provider-routing.test.ts`** (S3 on Anvil):
  - an owner deploys and funds a tSIX vault for the same salt;
  - with tANE preferred, the cheaper tANE seller wins;
  - with tSIX preferred, the tSIX seller wins and the tSIX vault pays it 2.5 tSIX, verified on-chain;
  - the tANE vault's budget is unchanged.
