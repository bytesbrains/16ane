# Workshop facilitator script (90 minutes)

For whoever runs a 16ane session at a college, meetup or hackathon. Participants follow the onboarding guide in [English](../../docs/guides/ONBOARDING.md) or [हिन्दी](../../docs/guides/ONBOARDING.hi.md). You can run the session in either language. The commands are the same.

> [!IMPORTANT]
> **TEST TOKENS — NO MONETARY VALUE.** Say this out loud at the start and again at the end. `tANE` is free, simulated and worthless: it is not backed by rupees, cannot be redeemed or sold, and never converts to any future `ANE`. Do not offer prizes in `tANE`, and do not describe it as earnings, savings or an investment.

## Before the day

- [ ] Run `npm run kit:demo` on the machine you will present from. It should finish in seconds after `npm ci`.
- [ ] Send participants the prerequisites a few days ahead: Node.js 24+, Python 3.11+, Foundry and git. Installing Foundry is the slowest step on a venue network.
- [ ] Have a fallback: a few pre-installed machines, or pairs sharing one laptop.
- [ ] Decide **local** or **public sandbox**. Local needs no internet once installed and has no faucet limits. The public sandbox lets agents from different laptops trade, but each address can claim from the faucet only once per cooldown, and public sellers need testnet ETH or a facilitator (see the guide).
- [ ] If you will use a projector, practise reading the vault status line aloud: holds, spent, may still spend.

## Agenda

| Time | Segment | What happens |
|---|---|---|
| 0:00 | Why agents need budgets (10 min) | An agent that can pay needs a limit it cannot talk its way past. Prompts are not limits; contracts are. The "16 aane" story is an illustration only. |
| 0:10 | One-command demo (10 min) | Everyone runs `npm run kit:demo`. Walk through its seven steps on the projector. |
| 0:20 | Owner and agent (15 min) | `npm run kit:sandbox`, then `npm run kit:owner -- setup` and `status`. Who holds which key, and why the agent never sees the owner's. |
| 0:35 | Buy and sell (20 min) | Start both sellers, pay them with both buyers, watch `status` change. Look at a `402` quote and a receipt together. |
| 0:55 | Break the rules (10 min) | Try to overspend (see the exercises below). The contract says no. |
| 1:05 | Build (20 min) | Pairs change a seller's service or a buyer's choices ([make it yours](README.md#make-it-yours)). |
| 1:25 | Close (5 min) | `revoke` and `withdraw`. Repeat the disclaimer. Point to the [threat model](../../docs/security/THREAT_MODEL.md) and where to file issues. |

## Exercises that show the enforcement

1. **Overspend:** in `python/seller.py`, set `PRICE = 48 * ONE_TANE` and buy. The buyer refuses (`ANE-E-3002`) because its `MAX_PAYMENT` is 32. Raise `MAX_PAYMENT` to 64 and try again: now the vault contract refuses, because the owner's per-payment limit is 32.
2. **Drain the budget:** loop the buyer until `status` shows nothing left to spend. The next payment fails with `ANE-E-3001`, however the code is written.
3. **Revoke mid-session:** run `npm run kit:owner -- revoke` while a teammate's buyer is running. Their next payment fails.
4. **Replay:** send the same request twice with the same `Idempotency-Key`. The seller answers twice but charges once.

## Questions people ask

- **"Can I sell my tANE?"** No. It has no value, and nobody should pay for it. If someone offers to buy or sell it, that is a scam.
- **"Is this the real ANE?"** No. Any future real-value ANE is a separate proposal that needs legal and regulatory review. Nothing in this workshop relates to it.
- **"Where does the gas come from?"** On the local chain, Anvil gives test ETH for free. On the public sandbox, the sandbox's relayer pays for owner actions and demo payments, within daily limits.
- **"Why does the agent have its own key?"** So that a leaked or misbehaving agent can lose at most its budget, and the owner can revoke it at any time.

## After the session

- Ask participants to delete `examples/hackathon-kit/.kit/` from shared machines.
- Collect what was hard as GitHub issues, not in chat, so fixes reach the next session.
