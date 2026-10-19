# Agent wallets, authority and accounting

## Core actors
**Owner** funds and revokes. **Agent signer** executes authorized operations. **Merchant** receives payment. **Relayer/paymaster** optionally sponsors gas. **Recovery authority** only if explicitly configured.

## Required wallet behavior
- Isolated agent treasury, not direct access to owner EOA/private key.
- Delegated authority can be scoped to total amount, expiration, per-transaction limit and optional recipient/method restrictions.
- Default: **finite prefunded budget**, no credit, no auto-replenishment, no unlimited token approval.
- Owner can revoke delegation, recover unencumbered funds, rotate compromised agent signer.
- Enforce nonce uniqueness, domain separation (chain ID, contract, version), deadline and replay resistance.
- Account for pending transactions and reorgs; avoid counting unconfirmed transfers as settled revenue.

## Modes
**Fixed**: maximum cumulative agent spending is defined at delegation; incoming revenue does not expand it. **Revolving**: owner explicitly authorizes earnings reuse with an aggregate treasury ceiling, time window and optional daily cap. Revocation must stop future delegated spending; already finalized transfers cannot be clawed back.

## Invariants to test
- Total authorized spend <= signed owner allowance; cannot bypass by self-transfer, nested calls, approval, token hooks or reentrancy.
- Agent cannot withdraw owner's other assets or change its own budget policy.
- No double-use of signed spend intents/nonces.
- Owner withdrawal cannot misrepresent already committed/in-flight funds.
- Fee payer and fee asset are disclosed; gas costs cannot silently exceed user limit.
- Agent can receive tANE regardless of spend permission, unless account policy explicitly blocks it.

## Alternatives to research
Dedicated escrow/vault contract vs ERC-4337 smart account vs EIP-7702-enabled delegated account (if applicable) vs session-key framework. Compare deployment cost, ecosystem support, upgrade/security risks, paymaster support, recoverability and implementation burden. Select via ADR and audited libraries where possible.

## State and events (conceptual)
`AgentCreated(owner, account)`, `Funded(account, asset, amount)`, `DelegationGranted(account, signer, policyHash, expiry)`, `Spent(account, merchant, amount, paymentId)`, `RevenueReceived(account, sender, amount)`, `DelegationRevoked(account, signer)`, `Withdrawn(account, owner, amount)`. Events cannot alone enforce limits; contracts must enforce state.
