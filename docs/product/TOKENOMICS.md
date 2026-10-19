# Token units, test economics and future INR peg

## Historical anchor and proposed units
The name **16ane** comes from the historical **anna** (*ānna*), a monetary subunit used in India until currency decimalisation in 1957:
- **Etymology:** Derived from the Sanskrit **अन्न** (*anna*), meaning *"grain"* — the foundational unit of sustenance and everyday exchange. In Indian usage, *"solah aane"* (16 annas) also denotes completeness (`16/16 = 100%`).
- **Pre-1957 subdivision hierarchy:**
  - **1 Rupee = 16 Annas** (`1 Anna = 1/16 Rupee`)
  - **1 Anna = 4 Pices** (`64 Pices = 1 Rupee`)
  - **1 Pice = 3 Pies** (`12 Pies = 1 Anna`, `192 Pies = 1 Rupee`)
  - **Classical four-part notation (`Rs R-A-P-Pi`):** Written as `Rupees - Annas (1/16) - Pices (1/64) - Pies (1/192)` — for example, `Rs 1-4` (`₹1.25`, 1 rupee and 4 annas), `Rs 1-8` (`₹1.50`, 1 rupee and 8 annas).
- **Decimal equivalence:** When India decimalised the rupee into 100 paise in 1957, **1 Anna equaled exactly $6\frac{1}{4}$ paise (`6.25 paise` = `₹0.0625`)**.
- **Proposed target unit convention:** **16 ANE = ₹1** (`1 ANE = ₹0.0625 = 6.25 paise`; `4 ANE = ₹0.25`; `8 ANE = ₹0.50`; `1,600 ANE = ₹100`). This is a **target denomination**, not a market guarantee. Contract decimals (18 decimals per `ADR-0002`, where `1 ANE = 10^18` base units, so even `1/16`, `1/64`, and fractional per-token compute units divide cleanly) are independent of human-readable units.

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
