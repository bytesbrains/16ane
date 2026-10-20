<img src="https://raw.githubusercontent.com/bytesbrains/16ane/main/web/mark.png" alt="16ane" width="68">

# @16ane/sdk (TypeScript)

TypeScript SDK for the 16ane agent-economy sandbox: owner and agent-session wallets, budgets enforced by
`AneAgentVault`, x402 v2 payments, signed service manifests, merchant-side payment verification, and direct
on-chain receipt verification.

> **TEST TOKENS (tANE) — NO CASH VALUE.** `tANE` is a free, simulated testnet token. It is not
> backed by INR, not redeemable, and not convertible to any future `ANE`.

Status: `0.1.0`, not published to npm. The `@16ane` npm scope belongs to the project; nothing is released under
it yet. The sandbox contracts are live on Base Sepolia: pass `registryAddress: "0x01d5daB670DE5868305eB862721ebE62772C3Df3"`
(all addresses in [`networks/sandbox-sepolia.json`](https://github.com/bytesbrains/16ane/blob/main/networks/sandbox-sepolia.json)), or use a local Anvil chain.

## Requirements

- **Node.js with TypeScript type stripping.** The package ships TypeScript source (`main` is `./src/index.ts`)
  and has no build step. CI runs it on Node 24 with `node --experimental-strip-types`.
- **Foundry's `cast` on `PATH`** for anything that sends a transaction (vault deployment, funding, delegation,
  settlement). Reads go straight to the JSON-RPC endpoint.
- No runtime npm dependencies: Keccak-256, secp256k1 and ABI encoding are implemented in `src/`.

## Use from a checkout

```bash
npm run test:sdk-ts        # from the repository root
```

```ts
import { AneClient, AgentSession, OwnerWallet, SecretKey } from "./packages/sdk-ts/src/index.ts";

const ONE_TANE = 10n ** 18n; // tANE has 18 decimals

const client = new AneClient({ rpcUrl: "http://127.0.0.1:8545", chainId: 84532, registryAddress: "0x..." });

// The owner deploys a vault, funds it and delegates a fixed budget to an agent's session key.
const owner = new OwnerWallet(client, new SecretKey(process.env.OWNER_KEY!));
const { vaultAddress } = await owner.ensureVaultDeployed(0n);
await owner.fundVault(vaultAddress, 1600n * ONE_TANE);

const session = new AgentSession({ client, vaultAddress, sessionKey: new SecretKey(process.env.SESSION_KEY!) });
await owner.delegateSession(vaultAddress, session.sessionAddress, {
  mode: "FIXED",                 // revenue never raises the spending cap
  allowanceCap: 320n * ONE_TANE, // total the agent may ever spend
  perTxLimit: 32n * ONE_TANE,
  expiry: Math.floor(Date.now() / 1000) + 3600,
});

// The agent pays for an x402 endpoint; the vault contract enforces the budget.
const res = await session.purchase("http://127.0.0.1:8787/v1/demo/summarize", {
  method: "POST",
  body: JSON.stringify({ text: "..." }),
  maxPayment: 32n * ONE_TANE, // refuses to sign if the quote is higher
});
console.log(res.status, res.receipt);

// The owner can revoke the session at any time.
await owner.revokeSession(vaultAddress);
```

## What's in it

| Export | Purpose |
|---|---|
| `AneClient` | JSON-RPC reads (balances, vault accounting, payment records), contract resolution through `AneRegistry`, transaction sending, on-chain settlement verification, service-manifest signing and verification |
| `OwnerWallet` | Owner actions: `ensureVaultDeployed`, `fundVault`, `delegateSession`, `revokeSession`, `revokeAndSweep`, `withdrawPrincipal` |
| `AgentSession` | Agent actions with a delegated session key: `purchase` (x402 flow), `signSpendIntent`, `settleDirectSpend` |
| `AnePaymentVerifier` | Merchant side: verify and settle x402 payment proofs, idempotency, receipts |
| `TrialQuotaTracker` | Per-caller and global quotas for provider-sponsored trial calls |
| `SecretKey`, `redactSecrets`, `generateKeypair` | Key handling: a `SecretKey` never prints or serializes its value (`toString`, `toJSON` and `util.inspect` show `[REDACTED_PRIVATE_KEY]`) |
| `hashSpendIntent`, `hashServiceManifest`, `computeRequestHash`, … | EIP-712 hashing and x402 helpers, matching the Solidity contracts |

Budgets are enforced by the vault contract, not by the SDK: a session cannot spend past its `allowanceCap` or
`perTxLimit`, and in `FIXED` mode incoming revenue never increases what it may spend. `maxPayment` is an extra,
client-side guard.

See the [repository README](https://github.com/bytesbrains/16ane#readme) for the protocol, threat model and
ADRs, and [`e2e/`](https://github.com/bytesbrains/16ane/tree/main/e2e) for complete flows against a local chain.
