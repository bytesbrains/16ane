# Deploying the sandbox contracts to Base Sepolia

Runbook for launch gate **G1-12** (`docs/planning/LAUNCH_READINESS.md`): deploy `AneRegistry`, `tANE`
(`AneTestToken`), `AneVaultFactory`, `AneFaucet` and `AneServiceDirectory` to Base Sepolia (`eip155:84532`),
verify them on Basescan, and publish the addresses.

> `tANE` is a free test token with no cash value. Nothing here touches a mainnet: `DeploySandbox.s.sol`
> reverts on any chain other than Base Sepolia (`84532`) or a local chain (`31337`).

## 0. Authorization (required)
A maintainer must explicitly authorize the broadcast (`AGENTS.md`; G1-12). Record who authorized it and when in
the PR that publishes the addresses.

## 1. Prerequisites
- **Foundry** (`forge`, `cast`) and **Node 24**, as in CI.
- **A dedicated deployer key, used only for this.** The deployer becomes:
  - `DEFAULT_ADMIN_ROLE` on `tANE`. It can grant `MINTER_ROLE`, but can't pause transfers, burn balances or blacklist (`ADR-0011`).
  - the owner of `AneFaucet`, which can pause and change the claim size, cooldown and daily cap (`setFaucetConfig`).
  - the owner of `AneRegistry` (`Ownable2Step`).
  
  Create it in an **encrypted keystore**, so the private key is never printed, exported or stored in a `.env` file:
  ```bash
  cast wallet new ~/.foundry/keystores sandbox-deployer     # prompts for a password
  cast wallet address --account sandbox-deployer            # the deployer address
  ```
- **Base Sepolia ETH** for the deployer, from a public Base Sepolia faucet. Step 3's dry run prints the
  estimated cost; fund a margin above it.
- **A Basescan API key** (Etherscan API v2), for source verification:
  `export ETHERSCAN_API_KEY=...`.

Don't set `PRIVATE_KEY`. The script uses it only for CI's dry run and the local E2E harness. When it's unset, the
script signs with the `--account` keystore.

## 2. Settings
```bash
export RPC_URL=https://sepolia.base.org          # fallback: https://base-sepolia-rpc.publicnode.com
export DEPLOYER=$(cast wallet address --account sandbox-deployer)
export ANE_ENV=sandbox                           # registry salt 16ane.registry.sandbox.v1 (ADR-0001); "dev" for staging
cast chain-id --rpc-url $RPC_URL                 # must print 84532
cast balance $DEPLOYER --rpc-url $RPC_URL --ether
```

## 3. Dry run (no broadcast)
```bash
forge script script/DeploySandbox.s.sol:DeploySandbox \
  --rpc-url $RPC_URL --account sandbox-deployer --sender $DEPLOYER
```
Check the simulated addresses and the estimated gas, and that the deployer has enough ETH.

## 4. Broadcast and verify
```bash
forge script script/DeploySandbox.s.sol:DeploySandbox \
  --rpc-url $RPC_URL --account sandbox-deployer --sender $DEPLOYER \
  --broadcast --verify --etherscan-api-key $ETHERSCAN_API_KEY
```
The console prints the five addresses (`AneRegistry: 0x…` and so on). The transaction log is in
`broadcast/DeploySandbox.s.sol/84532/run-latest.json`, which git ignores. **Copy it somewhere safe straight away:** the
E2E suite and local tests run Anvil with chain id `84532` too, so the next local run overwrites that file, and
`--resume` would then pick up the wrong deployment. The chain stays the source of truth: the deployer's nonces 0–6
are the deployment's transactions.
- **Public-RPC lag.** Load-balanced endpoints can briefly answer from a node that hasn't seen your last
  transaction. The SDK retries stale-nonce rejections (#68), and the smoke test waits for its own writes.
- **If verification fails or times out,** rerun the same command with `--resume --verify`. It doesn't redeploy.
  If the broadcast record has been overwritten (see above), verify each contract directly with its constructor
  arguments, as the 2026-10-20 deployment was, and remember the `AneAgentVault` implementation that
  `AneVaultFactory` deploys in its constructor (`cast call <factory> 'vaultImplementation()(address)'`):
  ```bash
  forge verify-contract <address> src/AneFaucet.sol:AneFaucet --chain 84532 --watch \
    --constructor-args $(cast abi-encode 'c(address,address,uint256,uint64,uint256)' <tANE> <deployer> <claim> <cooldown> <dailyCap>)
  ```
  `ETHERSCAN_API_KEY` in `.env` is picked up automatically; Etherscan API v2 uses one key for Basescan too.
- **If a broadcast fails partway,** use `--resume`. Don't start again from scratch: `AneRegistry` is deployed
  with `CREATE2`, so a fresh run would collide with the registry that's already there.

## 5. Check the deployment
```bash
export REGISTRY_ADDRESS=0x...                     # from step 4
cast call $REGISTRY_ADDRESS 'getDeployment()(address,address,address,address,uint64,uint64)' --rpc-url $RPC_URL
cast call $REGISTRY_ADDRESS 'owner()(address)' --rpc-url $RPC_URL   # must equal $DEPLOYER
```
Then run the end-to-end smoke test. It claims from the faucet, deploys and funds a vault, delegates to a fresh
session key, pays 16 tANE to a fresh address, verifies the payment on-chain, and revokes the session. It needs one
key with a little Base Sepolia ETH. Use a separate smoke-test key rather than the deployer:
```bash
read -rs SMOKE_OWNER_KEY && export SMOKE_OWNER_KEY  # paste the key; it isn't echoed or stored in history
RPC_URL=$RPC_URL REGISTRY_ADDRESS=$REGISTRY_ADDRESS \
  node --experimental-strip-types scripts/smoke-sandbox.ts
unset SMOKE_OWNER_KEY
```
It prints `[smoke] PASS` on success. The same script runs in the E2E suite against a local chain
(`e2e/smoke-script.ts`), so it stays in step with the contracts and SDK.

## 6. Publish (one PR)
- **`networks/sandbox-sepolia.json`:** add `"registryAddress"` and a `"contracts"` object with the five addresses,
  plus the deployment block number and the commit it was deployed from.
- **`docs/planning/LAUNCH_READINESS.md`:** set **G1-12** to PASS, with Basescan links for each contract.
- **README status line and 16ane.com:** move "Contracts on the Base Sepolia testnet" from *Not live yet* to live,
  with the registry address. Publish addresses only in places people trust (this repository and 16ane.com), and
  tell people to check the contract address, not the `tANE` symbol.
- **`CHANGELOG.md`,** and a comment on #36 recording who authorized the deploy, when, and from which commit.

From then on, `ADR-0001`'s continuity policy applies: at least 30 days' notice before any sandbox redeployment.

## Afterwards
- **Admin roles:** optionally move them to a multisig. `tANE` admin uses a two-step transfer with a delay; the
  registry uses `Ownable2Step`.
- **Faucet sizing:** change it on-chain with `AneFaucet.setFaucetConfig` (`ADR-0006`, #61); no redeploy is needed.
  The reference server reads the live values at startup.
