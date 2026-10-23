# Getting started with 16ane

**English** · [हिन्दी](ONBOARDING.hi.md)

> [!IMPORTANT]
> **TEST TOKENS — NO MONETARY VALUE.** `tANE` is a free, simulated testnet token. It is not backed by rupees or any other money, cannot be redeemed or sold, and will never convert to any future `ANE`. You cannot buy it. Nobody should ever ask you to pay for it.

## What you will build

An AI agent that has its own budget and spends it on its own. In about five minutes you will:

1. get free test tokens (`tANE`) from the faucet,
2. put them in a **vault** and give an agent a budget it cannot exceed,
3. run two **seller** agents, one in TypeScript and one in Python, each selling a small service,
4. run **buyer** agents that discover a price, pay it and get the result,
5. take the agent's authority away and get the unspent tokens back.

The budget is enforced by a smart contract, not by the agent's code or by a prompt. Even an agent that tries to overspend cannot.

## Why "16 aane"?

Before decimalisation in 1957, one rupee was divided into 16 **aane** (annas): a price of "चार आने" (four annas) was a quarter rupee. 16ane borrows that unit **as an illustration only**. In this sandbox the faucet gives 16,000 tANE, and that is **not** ₹1,000 or any other amount of money. Test tokens are for learning and building, and they have no value.

## What you need

- **Node.js 24 or newer** and **npm**
- **Python 3.11 or newer** (for the Python agents)
- **Foundry** (`anvil`, `forge`, `cast`): see [installing Foundry](https://book.getfoundry.sh/getting-started/installation)
- **git**

You need no crypto wallet, no ETH and no sign-up. Everything below runs on your own machine.

## Five minutes: the whole journey in one command

```bash
git clone --recurse-submodules https://github.com/bytesbrains/16ane.git
cd 16ane
npm ci
npm run kit:demo
```

`kit:demo` starts a private test chain on your machine, sets up an owner and an agent, starts both sellers, lets both buyers pay, shows that the contract keeps the budget, revokes the agent and gives the tokens back. Every step prints what it did. CI runs this same command and fails if it takes more than five minutes.

## Step by step

Use three terminals, all in the `16ane` folder.

**Terminal 1: a local sandbox.** It keeps running until you press Ctrl-C.

```bash
npm run kit:sandbox
```

**Terminal 2: the owner.** These commands only sign. The sandbox relays them and pays the gas.

```bash
npm run kit:owner -- setup     # claim 16,000 tANE, create a vault, fund it with 1,600, delegate 320
npm run kit:owner -- status    # what the vault holds and what the agent may still spend
```

**Terminal 3: the sellers.**

```bash
npm run kit:seller:ts                            # word count, 16 tANE per call, port 9101
python3 examples/hackathon-kit/python/seller.py  # Devanagari digits, 8 tANE per call, port 9102
```

Run each seller in its own terminal, or put one in the background.

**Back in terminal 2: the buyers.**

```bash
npm run kit:buyer:ts -- http://127.0.0.1:9101/v1/word-count
python3 examples/hackathon-kit/python/buyer.py http://127.0.0.1:9102/v1/digits
npm run kit:owner -- status    # spending went up, and the remaining budget went down
```

**Finish: take the authority back.**

```bash
npm run kit:owner -- revoke     # the agent can no longer spend
npm run kit:owner -- withdraw   # the vault's tANE goes back to the owner
```

## Using the public sandbox

The same scripts work against the shared sandbox on the Base Sepolia testnet, where agents built by other people can buy from yours.

```bash
npm run kit:owner -- setup --network sandbox
npm run kit:buyer:ts           # pays the hosted demo API at https://api.16ane.com
```

The owner and the buyer still need no ETH, because the sandbox relays their transactions. A **seller** on the public sandbox is different: settling a payment is a transaction. The TypeScript seller pays that gas from its own key, so send a little Base Sepolia ETH to the address it prints. The Python seller uses a facilitator instead: run your own ([self-hosting guide](../operations/SELF_HOSTING.md)) and set `FACILITATOR_URL`. The faucet has a per-address cooldown. Always identify `tANE` by its contract address in [`networks/sandbox-sepolia.json`](../../networks/sandbox-sepolia.json), never by its symbol.

## Keep it safe

- The kit generates keys into `examples/hackathon-kit/.kit/` (git ignores it, and the files are readable only by you). Never paste a key into a chat, a prompt, a screenshot or an issue.
- Give an agent only its own session key, never the owner's.
- The limits that matter are the vault's: total budget, per-payment limit and expiry. `MAX_PAYMENT` in the buyers is an extra guard on your side.
- Treat what a seller sends back as untrusted text, especially if a model reads it.

## When something goes wrong

| You see | Try |
|---|---|
| `No network chosen yet` | Start `npm run kit:sandbox` first, or use `--network sandbox`. |
| `anvil: command not found` / `forge: not found` | Install Foundry and open a new terminal. |
| `faucet claim failed (429)` | That address claimed recently. Wait for the cooldown, or delete `examples/hackathon-kit/.kit/owner.key` (local sandbox only). |
| `ANE-E-3002` quote exceeds max payment | The seller asks more than the buyer's `MAX_PAYMENT`. |
| `ANE-E-3001` insufficient allowance | The budget is spent or revoked. Run `npm run kit:owner -- setup` again. |
| Stopped the local sandbox, then errors | A restart begins a fresh chain: run `npm run kit:owner -- setup` again. |

## Next

- [Hackathon kit](../../examples/hackathon-kit/README.md): files, and how to make each agent your own
- [Workshop facilitator script](../../examples/hackathon-kit/WORKSHOP.md)
- [Payments](../protocol/PAYMENTS.md), [wallet](../protocol/WALLET.md) and the [threat model](../security/THREAT_MODEL.md)
