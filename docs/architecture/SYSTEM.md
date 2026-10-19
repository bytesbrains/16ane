# System architecture and trust boundaries

```text
Human / Organization (owner)
    | create, fund, revoke
Agent Account (on-chain budget + delegated session authority)
    | signed payment intent / token transfer
Payment adapter (x402-compatible where feasible) <---> Merchant endpoint
    |                                  | metered service
Facilitator (optional/self-hosted)       AI model / data / agent service
    | settlement proof                    |
EVM public testnet: tANE, wallets, tx receipts, optional registry
    ^                                   ^
Faucet (hosted, quota)            Registry indexer (optional/self-hosted)
    ^                                   ^
Developer portal / CLI / Python / TypeScript / MCP adapter
```

## Layers
- **Settlement:** public testnet chain, tANE contract, agent wallet/vault, transfers, events.
- **Authorization:** owner signatures, session keys/delegations, spending caps, revocation and nonce/replay control.
- **Commerce:** merchant price quote, proof of payment, verification, delivery, receipts, optional refunds.
- **Discovery:** portable signed/anchored service metadata, independently queryable indexes.
- **Developer:** SDK, CLI, MCP, dashboard, tutorials.
- **Sponsored access:** faucet and provider quota engines; intentionally centrally operated but replaceable.
- **Future issuer:** separate regulated INR reserve/mint/burn/redemption module, **not connected to sandbox value**.

## Trust boundaries
Owner key must not enter agent process. Agent process can be adversarial. Merchant can fail or deceive. Facilitator may censor/delay; clients must support direct verification where practical. Registry listings are untrusted advertisements. Indexers may lag/reorg. Hosted RPC can censor or fail; document alternate RPC. Fiat reserve custody is off-chain and cannot be made trustless by a smart contract.

## Availability
Core transfers require only chain access; hosted services are conveniences. Provide alternative RPC and independent facilitator/registry deployments. Publish all ABI and metadata needed to operate without 16ane servers.

## Chain selection ADR
Choose between Base Sepolia and other EVM testnets based on gas sponsorship, RPC availability, wallet support, x402 settlement support and continuity. Do not hard-code chain ID/address in docs before verifying deployment. Mainnet chain choice independent and future-gated.

## Contract upgrade philosophy
Prefer minimal immutable components. Any proxy/upgrade authority must be documented, time-locked where appropriate, monitored and explicitly disclosed. Production-value upgradeability requires separate approval.
