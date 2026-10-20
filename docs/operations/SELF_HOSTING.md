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
docker run --rm -p 8787:8787 \
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
| `ANE_TRIAL_FREE_CALLS_PER_CALLER`, `ANE_TRIAL_GLOBAL_DAILY_CAP` | no | Sponsored-trial quotas (ADR-0008) |

A bad configuration exits with code 2 and lists every problem, without printing key values.

## Check it
- `GET /healthz`: `200 {"status":"ok", …}` when the RPC answers, `503` otherwise. The image's Docker
  `HEALTHCHECK` uses it.
- `POST /v1/faucet/claims` with `{"recipient":"0x…"}`: mints 16,000 `tANE` to that address. The recipient pays
  no gas; the relayer does.
- `scripts/docker-smoke.sh` runs the whole check against a local Anvil chain. CI runs it on every PR.

## Not yet
State (cooldowns, claims, x402 idempotency and receipts) is in memory until #75 adds SQLite, so a restart forgets
it. The relayer's daily gas budget (#76) and faucet abuse controls (#79) are also still to come.
