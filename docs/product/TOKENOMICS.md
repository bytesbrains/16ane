# Token units, test economics and future INR peg

## Historical anchor and proposed units
Historically 16 annas = 1 rupee. Proposed real-value target: **16 ANE = ₹1**; **1 ANE = ₹0.0625**; **1,600 ANE = ₹100**. This is a **target denomination**, not a market guarantee. Contract decimals (likely standard EVM 18, to be decided) are independent of human-readable units.

## tANE: public sandbox only
- Faucet-minted, unbacked testnet ERC-20-style asset. Supply can be increased for experiments, subject to transparent mint authority.
- No redemption, no reserve, no guaranteed purchasing power, no claim on issuer, no airdrop/convertibility into real ANE.
- Free test tokens may buy **only voluntarily sponsored/simulated** services that explicitly accept them.
- No resale, fiat exchange, exchange listings, liquidity promises or marketing as an investment.
- Publish token contract, admin roles, faucet supply, burns, issuance logs and any upgrades.

## Separate accounting systems
1. **tANE balance**: transferable test asset held in wallet.
2. **Delegated allowance**: authorization constraint, not necessarily a token balance.
3. **Provider service quota**: entitlement to provider-funded compute; not transferable tANE and not cash.
4. **Revenue**: tANE received for delivered service; may be non-spendable under fixed mode.
5. **Future ANE reserve liability**: only if separately authorized and issued in production.

## Sponsored service example
Faucet grants 1,600 tANE. Provider quotes 16 tANE for a sandbox model call but limits each wallet to 20 calls/day and sets global $20/day equivalent actual compute expense. A user with 1M tANE still cannot bypass provider compute limits. Provider accepts test token voluntarily and bears its own operating cost.

## Future reserve accounting (research, not launch authorization)
Target eligible INR reserves >= outstanding ANE / 16 **plus any separate unsettled obligations** as required by the final legal/accounting structure. Define treatment of fees, pending redemption, bank chargebacks, insolvency, liquidity, and reserves held for others. Mint only after acceptable payment finality; burn/payout needs recoverable state machine. Proof-of-reserves reports require independent bank/custodian attestations; on-chain supply alone cannot prove fiat holdings.

## Explicit risk
A fully backed reserve and a contractual redemption promise do not by themselves guarantee secondary-market peg, instant redemption, legal permissibility or bank availability. Never use tANE as a proxy for regulated real-value issuance.
