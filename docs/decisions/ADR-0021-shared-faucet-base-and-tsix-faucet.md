# ADR-0021: Shared Faucet Base and a tSIX Faucet

- **Status:** Proposed (2026-10-24)
- **Date and owners:** 2026-10-24 | 16ane Protocol Maintainers
- **Related requirements:** REQ-204, REQ-002, REQ-012, REQ-001
- **Related epics:** E20 (#133), E05
- **Builds on:** ADR-0020 (one vault per asset; tSIX), ADR-0006 (faucet), ADR-0001 (continuity), ADR-0002 (test token). **Supersedes:** ADR-0020's "tSIX has no faucet yet; the operator mints on request".

## Context

ADR-0020 added tSIX, a free, worthless 6-decimal test asset, but no way for testers to get it except asking the
operator, who held tSIX's `MINTER_ROLE`. REQ-204 is not met on the public sandbox until a tester can fund a tSIX
vault without that.

`AneFaucet` cannot simply be deployed again for tSIX:
- its on-chain `DISCLAIMER` is a constant naming tANE;
- its token is typed `AneTestToken` and exposed as `taneToken()`;
- its EIP-712 domain name is the literal `"AneFaucet"`, so two faucets would share a domain name and differ only
  by `verifyingContract`.

`AneFaucet` is deployed on Base Sepolia (`0xB1dAb3B54170b667Ac92aa7e584D0bf8570ffE1a`, from `e43ccc8`) and
source-verified. SDKs read `taneToken()` from it (`packages/sdk-ts/src/client.ts`, `packages/sdk-py/ane_sdk/client.py`),
and relayed claims are signed against its `("AneFaucet", "1")` domain.

## Options considered

1. **Shared abstract base, two thin faucets.** Move the claim, cooldown, daily-cap, relayed-claim and admin logic
   into `AneFaucetBase`. `AneFaucet` and a new `AneSixDecimalFaucet` each fix their token, disclaimer and EIP-712 name.
   - *Pros:* one copy of the logic; a fix applies to both faucets.
   - *Cons:* `src/AneFaucet.sol` changes, so the repository source no longer compiles to the bytecode deployed from `e43ccc8`.
2. **A standalone token-agnostic faucet, `AneFaucet.sol` untouched.**
   - *Pros:* the repository still matches the deployed tANE faucet.
   - *Cons:* about 150 lines of security-relevant claim and relay logic exist twice and must be fixed twice; the
     SonarCloud duplication gate fails.
3. **No faucet.** The operator keeps minting on request; REQ-204 stays local-only.

## Decision

**Option 1.** The maintainer chose it on 2026-10-24.

1. **`src/AneFaucetBase.sol`** is abstract and holds all faucet state and logic, unchanged in behaviour. It mints
   through `IFaucetMintable.mint(address,uint256)` and takes its token and EIP-712 name as constructor arguments.
2. **`AneFaucet` keeps its external surface exactly.** It passes `"AneFaucet"` as the EIP-712 name and keeps its tANE
   `DISCLAIMER` and a `taneToken()` getter. Checked at this change against `main` (`4383db6`):
   - the ABI (functions, events, errors) is identical;
   - the storage layout is identical, slot for slot;
   - the EIP-712 domain is unchanged, so existing relayed-claim signatures still verify (`test/AneFaucet.t.sol`).

   The runtime bytecode differs: it is 3 bytes longer. The deployed faucet stays as it is, and its Basescan
   verification remains valid for the source at `e43ccc8`.
3. **`src/AneSixDecimalFaucet.sol`** mints tSIX, with the disclaimer `"TEST TOKENS (tSIX) - NO CASH VALUE, NO INR BACKING,
   NO REDEMPTION OR CONVERSION."`, a `tsixToken()` getter and the EIP-712 domain `("AneSixDecimalFaucet", "1")`. A
   relayed claim signed for one faucet is refused by the other, even with the other's address substituted.
4. **Sizing** is the tANE faucet's (ADR-0006, #61) in tSIX's own base units: 16,000 tSIX per claim
   (`16_000 * 1e6`), a 1-hour cooldown per recipient, and a 160,000,000 tSIX daily cap. The owner can change them
   with `setFaucetConfig`.
5. **The faucet is tSIX's only minter.** `SecondAssetDeployment` grants `MINTER_ROLE` to the faucet and no longer
   to the deployer, matching tANE. The deployer keeps `DEFAULT_ADMIN_ROLE` and owns the faucet, so it can pause it,
   resize it, or grant a minter if ever needed.
6. **Deployment stays additive** (ADR-0020 Decision 5). `DeploySecondAsset` now deploys tSIX, its vault factory and
   its faucet. Nothing already deployed changes, and broadcasting to Base Sepolia still needs maintainer
   authorization (DEPLOY_SANDBOX.md section 0).

## Consequences and limitations

- **Source drift for the deployed tANE faucet.** Anyone rebuilding `AneFaucet` from `main` gets different bytecode
  from the chain. To verify or audit the deployed faucet, use the source at `e43ccc8`. The deploy runbook says so.
- **tSIX has no gasless funding path for a fresh wallet beyond the relayed claim.** The faucet's relayed claim works
  for tSIX, but tSIX has no EIP-3009, so vault funding still needs an approve transaction (ADR-0020).
- **Clients are not wired to the tSIX faucet yet.** The reference server's faucet endpoint, the CLI and the dashboard
  stay tANE-only; testers call `claim(address)` on the tSIX faucet directly. The address goes in
  `networks/sandbox-sepolia.json` after the deploy, as with the other tSIX contracts.
- **Security review.** The base is a move of reviewed logic, not new logic. The ABI, storage and domain checks above
  and the unchanged `AneFaucet` tests are evidence for the review that ADR-0020 already requires before any public
  deploy, not a substitute for it.

## Validation

- **`test/AneFaucet.t.sol`** passes unchanged, apart from referring to errors through `AneFaucetBase`. That covers
  cooldowns, the daily cap and its reset, pause never blocking transfers, and relayed claims against the
  `("AneFaucet", "1")` domain.
- **`test/AneSixDecimalFaucet.t.sol`:**
  - a claim mints 16,000 tSIX in 6-decimal units and no tANE, with the tSIX disclaimer;
  - the cooldown is per faucet;
  - a relayed claim signed for the tANE faucet's domain, or with its name at the tSIX faucet's address, is
    refused, and the reverse;
  - only the owner configures or pauses, and a pause never blocks tSIX transfers.
- **`test/AneMultiAsset.t.sol`:** `DeploySandbox` and `DeploySecondAsset` wire the faucet as tSIX's only minter, owned
  by the deployer, and a claim pays 16,000e6.
- **`e2e/flows/provider-routing.test.ts`:** the owner funds the tSIX vault from a faucet claim instead of an operator mint.
