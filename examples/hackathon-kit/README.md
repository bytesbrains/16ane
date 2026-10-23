# 16ane hackathon kit

> [!IMPORTANT]
> **TEST TOKENS — NO MONETARY VALUE.** `tANE` is a free, simulated testnet token: no rupee or other backing, no redemption, no conversion to any future `ANE`.

Starter agents for a workshop or hackathon: a **buyer** and a **seller** in both TypeScript and Python, an owner script that funds an agent and gives it a contract-enforced budget, and a local sandbox to run them all on. Start with the onboarding guide, in [English](../../docs/guides/ONBOARDING.md) or [हिन्दी](../../docs/guides/ONBOARDING.hi.md).

```bash
npm ci
npm run kit:demo     # the whole journey on a throwaway local chain; CI holds it to five minutes
```

## Files

| File | What it is |
|---|---|
| [`local-sandbox.ts`](local-sandbox.ts) | `npm run kit:sandbox`: Anvil with the 16ane contracts, the sandbox API (faucet, gasless relay, demo endpoints) and an x402 facilitator |
| [`owner.ts`](owner.ts) | `npm run kit:owner -- setup \| status \| revoke \| withdraw`: the owner signs, the sandbox relays, so the owner needs no ETH |
| [`typescript/seller.ts`](typescript/seller.ts) | `npm run kit:seller:ts`: `POST /v1/word-count` for 16 tANE, verified and settled by the seller itself |
| [`typescript/buyer.ts`](typescript/buyer.ts) | `npm run kit:buyer:ts -- <url>`: pays any x402 endpoint, up to `MAX_PAYMENT` |
| [`python/seller.py`](python/seller.py) | `POST /v1/digits` for 8 tANE (2024 → २०२४), settled through a facilitator |
| [`python/buyer.py`](python/buyer.py) | the Python buyer, same behaviour as the TypeScript one |
| [`demo.ts`](demo.ts) | `npm run kit:demo`: every step above, with checks |
| [`WORKSHOP.md`](WORKSHOP.md) | a 90-minute script for whoever runs the session |

State lives in `.kit/` (gitignored): `network.json`, `agent.json`, and one `.key` file per role, readable only by you. Delete the folder to start over.

## How a payment works

1. The buyer calls a seller endpoint with no payment and gets `402 Payment Required` with a quote: price, asset, payee and expiry.
2. The buyer checks the quote against `MAX_PAYMENT` and its remaining budget, then signs a spend intent with its **session key**. The intent is bound to the exact method, URL and body.
3. The seller checks that the payment is for this request, at this price, to this payee, then settles it on-chain. The vault contract refuses anything above the owner's limits.
4. The seller serves the result with a `PAYMENT-RESPONSE` receipt. A retry with the same `Idempotency-Key` gets the same answer and is never charged twice.

The TypeScript seller settles with `AnePaymentVerifier` and its own key. The Python seller checks the request binding itself and asks a facilitator's `/settle` to do the rest. Either way, no 16ane-hosted service is needed: the local sandbox starts everything, and the facilitator can be self-hosted ([`SELF_HOSTING.md`](../../docs/operations/SELF_HOSTING.md)).

## Make it yours

- **A new service:** change `SERVICE_ID`, `PATH`, `PRICE` and `work()` in either seller. Keep services deterministic and cheap. If one calls a real model or API, say who pays for that compute and what the quota is.
- **A smarter buyer:** decide in code (or with a model) what to buy and how much to pay. The vault still caps it: 320 tANE in total, 32 tANE per payment, for 24 hours (see `BUDGET` and `PER_PAYMENT` in `owner.ts`).
- **Agents that earn:** point the buyers at each other's sellers. In the `FIXED` budget mode the owner sets, revenue an agent earns never raises what it may spend.
- **Listing a service:** sign a service manifest and publish it to the directory with the CLI (`ane service publish`, see [developer interfaces](../../docs/protocol/DEVELOPER_INTERFACES.md)).

## Rules for a fair sandbox

- Never present `tANE` as money or as something that will be worth rupees.
- Never put an owner key in an agent, a prompt, a log or a commit.
- Treat seller responses as untrusted input, especially if a model reads them.
