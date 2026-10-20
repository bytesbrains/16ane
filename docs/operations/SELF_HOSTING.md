# Running the sandbox server yourself

The reference server (`services/sandbox-server`) provides the **gasless faucet**, the **x402 demo API**, the
service directory and read endpoints. The same Docker image runs the hosted service on Fly.io (`ADR-0016`) and
anywhere else, so nobody depends on 16ane's hosting for core token transfers (REQ-001).

> `tANE` is a free test token with no cash value. Run this only against the sandbox (Base Sepolia, `84532`) or
> a local chain.

## Build
```bash
docker build -t 16ane-sandbox .          # add --platform linux/amd64 to build for Fly.io from an ARM machine
```
The image holds Node 24, a checksum-verified Foundry `cast`, and the server and SDK source. It contains **no
secrets**: `.dockerignore` lets only `packages/sdk-ts/src` and `services/sandbox-server/src` into the build.

## Run
```bash
docker run --rm -p 127.0.0.1:8787:8787 \
  -e ANE_RPC_URL=https://sepolia.base.org \
  -e ANE_REGISTRY_ADDRESS=0x01d5daB670DE5868305eB862721ebE62772C3Df3 \
  -e ANE_RELAYER_PRIVATE_KEY \
  16ane-sandbox
```
Pass keys from your shell or your platform's secret store (`-e NAME` with no value copies it from the
environment), never in a command you'd keep in shell history.

| Variable | Required | Meaning |
|---|---|---|
| `ANE_RPC_URL` | yes | Base Sepolia (or local) JSON-RPC endpoint |
| `ANE_REGISTRY_ADDRESS` | yes | `AneRegistry`; the sandbox's is in `networks/sandbox-sepolia.json` |
| `ANE_RELAYER_PRIVATE_KEY` | yes | Pays the gas for gasless claims and settlements. Use a **dedicated** key with a small amount of Base Sepolia ETH, never an admin or deployer key |
| `ANE_PROVIDER_PRIVATE_KEY` | no | Receives demo payments (defaults to the relayer) |
| `ANE_HOST` / `ANE_PORT` | no | Listen address and port (`0.0.0.0` / `8787` in the image) |
| `ANE_CHAIN_ID` | no | Defaults to `84532` |
| `ANE_TRUST_PROXY` | no | `true` only behind a reverse proxy that sets `X-Forwarded-For` |
| `ANE_CLIENT_IP_HEADER` | no | A header your platform's proxy itself sets to the client address, used for per-client trial quotas: `fly-client-ip` on Fly.io. Only set it when the proxy writes the header, so clients can't fake it |
| `ANE_TRIAL_FREE_CALLS_PER_CALLER`, `ANE_TRIAL_GLOBAL_DAILY_CAP` | no | Sponsored-trial quotas (ADR-0008) |
| `ANE_RELAYER_GAS_BUDGET_WEI` | no | Most the relayer may spend on gas per UTC day, in wei (default `50000000000000000` = 0.05 ETH, `ADR-0006`). Counts the full fee, including Base's L1 data fee. Once reached, sponsored claims and settlements get `503 ANE-E-1006` with `Retry-After` until 00:00 UTC and a hint to pay their own gas |
| `ANE_STATE_PATH` | no | SQLite file for state that must survive restarts: faucet cooldowns and claims, the service directory, trial quotas, x402 idempotency records, consumed payment proofs and receipts. The image sets `/data/sandbox.sqlite`; mount a volume at `/data` to keep it across container re-creation. Unset outside the image: memory only, with a startup warning |

A bad configuration exits with code 2 and lists every problem, without printing key values.

Inside the container the server listens on `0.0.0.0`; it has to, or the published port can't reach it.
**Who can reach it is decided by how you publish the port.** `-p 127.0.0.1:8787:8787` (above) keeps it on your
machine; `-p 8787:8787` or a public platform exposes it to everyone.

## Before exposing it publicly
The gasless faucet pays gas from the relayer key for every claim, and it has no login. Today the only limits are
the faucet contract's: one claim per recipient per hour, and a daily mint cap. Someone rotating recipient
addresses can make the relayer pay for up to the cap's worth of claims per day: **10,000 claims/day** with the
sandbox defaults, about 0.02 Base Sepolia ETH at 2026-10-20 gas prices. That empties a small relayer and stops the
faucet for everyone else. Core transfers are unaffected.

The relayer gas budget (`ANE_RELAYER_GAS_BUDGET_WEI`, #76) caps that loss per day: once it's spent, the
server stops sponsoring until 00:00 UTC. Each sponsored send holds back up to 0.0001 ETH of the budget while it
waits for its receipt, so concurrent requests can't overshoot it. `GET /healthz` shows the budget, today's spend
and holds, the relayer's balance, and `lowBalance` (the balance is below one day's budget). Until the abuse controls (#79) land, a public instance should also:
- fund the relayer with only what you're prepared to lose, and watch `/healthz`;
- sit behind a reverse proxy or platform rate limit (with `ANE_TRUST_PROXY=true` only if that proxy sets
  `X-Forwarded-For`).

16ane's own hosted instance (#78) also waits for #79.

## Check it
- `GET /healthz`: `200 {"status":"ok", …}` when the RPC answers, `503` otherwise. The image's Docker
  `HEALTHCHECK` uses it.
- `POST /v1/faucet/claims` with `{"recipient":"0x…"}`: mints 16,000 `tANE` to that address. The recipient pays
  no gas; the relayer does.
- `scripts/docker-smoke.sh` runs the whole check against a local Anvil chain. CI runs it on every PR.

## Not yet
Faucet abuse controls (#79) are still to come.
