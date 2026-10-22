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
| `ANE_TURNSTILE_SECRET_KEY` | no | Cloudflare Turnstile secret for a web faucet page: claims may then carry a `turnstileToken` instead of a signature. Unset: only signed claims |
| `ANE_TURNSTILE_HOSTNAME` | no | The site your Turnstile widget runs on (e.g. `app.16ane.com`); tokens issued for other sites are refused |
| `ANE_FAUCET_OPEN_CLAIMS` | no | `true` accepts claims with no proof at all. For a local or private server only; never on a public one |
| `ANE_TRIAL_FREE_CALLS_PER_CALLER`, `ANE_TRIAL_GLOBAL_DAILY_CAP` | no | Sponsored-trial quotas (ADR-0008) |
| `ANE_RELAYER_MAX_FEE_WEI` | no | The relayer's gas-price ceiling in wei (`ADR-0006`). Before each sponsored send the server reads `eth_gasPrice`; above this it sends nothing and answers `503 ANE-E-1205` with `Retry-After: 60`. Unset: no ceiling |
| `ANE_RELAYER_GAS_BUDGET_WEI` | no | Most the relayer may spend on gas per UTC day, in wei (default `50000000000000000` = 0.05 ETH, `ADR-0006`). Counts the full fee, including Base's L1 data fee. Once reached, sponsored claims and settlements get `503 ANE-E-1006` with `Retry-After` until 00:00 UTC and a hint to pay their own gas |
| `ANE_STATE_PATH` | no | SQLite file for state that must survive restarts: faucet cooldowns and claims, the service directory, trial quotas, x402 idempotency records, consumed payment proofs and receipts. The image sets `/data/sandbox.sqlite`; mount a volume at `/data` to keep it across container re-creation. Unset outside the image: memory only, with a startup warning |
| `ANE_SENTRY_DSN` | no | Sentry project DSN for scrubbed `sendLoggedError` events (#90). **Unset means off** (self-host default). Posts only `code`, `errorId` and a URL/key-redacted message — never request bodies, headers, query strings, client IPs, signatures or Turnstile tokens. No npm Sentry SDK; the server posts Sentry's envelope HTTP API directly |

A bad configuration exits with code 2 and lists every problem, without printing key values.

Inside the container the server listens on `0.0.0.0`; it has to, or the published port can't reach it.
**Who can reach it is decided by how you publish the port.** `-p 127.0.0.1:8787:8787` (above) keeps it on your
machine; `-p 8787:8787` or a public platform exposes it to everyone.

## Before exposing it publicly
The gasless faucet pays gas from the relayer key for every claim, and it has no login. Each claim needs a proof
(#79): a claim signed by the recipient (agents, the CLI and SDKs), or a Cloudflare Turnstile token from a web page
(`ANE_TURNSTILE_SECRET_KEY`). The server checks the proof, the cooldown and, for a signed claim, that its nonce
is unused on-chain, all **before** the relayer sends anything, so a refused claim costs no gas. A signature
proves only that the caller holds the recipient's key, so nobody can claim to an address they don't control, but
new keys are free. Someone generating fresh keys can still make the relayer pay for up to the faucet contract's
daily mint cap: **10,000 claims/day** with the sandbox defaults, about 0.02 Base Sepolia ETH at 2026-10-20 gas
prices. Core transfers are unaffected.

The relayer gas budget (`ANE_RELAYER_GAS_BUDGET_WEI`, #76) caps that loss per day: once it's spent, the
server stops sponsoring until 00:00 UTC. Each sponsored send holds back up to 0.0001 ETH of the budget while it
waits for its receipt, so concurrent requests can't overshoot it. `GET /healthz` shows the budget, today's spend
and holds, the relayer's balance, and `lowBalance` (the balance is below one day's budget). Fund the relayer with
only what you're prepared to lose, and watch `/healthz`. Leave `ANE_FAUCET_OPEN_CLAIMS` unset.

## Check it
- `GET /healthz`: `200 {"status":"ok", …}` when the RPC answers, `503` otherwise. The image's Docker
  `HEALTHCHECK` uses it.
- `ANE_OWNER_PRIVATE_KEY=0x… ane wallet fund --test --api-url http://127.0.0.1:8787`: signs a faucet claim and
  mints 16,000 `tANE` to that key's address. The recipient pays no gas; the relayer does. From code:
  `AneClient.signFaucetClaim(key)`, then `POST /v1/faucet/claims` with
  `{"recipient", "authorization": {"deadline", "nonce", "signature"}}`.
- `scripts/docker-smoke.sh` runs the whole check against a local Anvil chain. CI runs it on every PR.

## Not yet
The web faucet page that shows the Turnstile widget is part of the dashboard (#17).

---

# Running the standalone facilitator yourself

`services/facilitator` is the x402 facilitator third-party operators and merchants run instead of
16ane's servers (REQ-106, ADR-0005): `POST /verify`, `POST /settle` and `GET /supported` for the
`ane-vault-v1` and `exact` schemes on `eip155:84532`, plus `GET /healthz` and receipt lookup at
`GET /v1/payments/:id`. The wire shapes follow the x402 facilitator interface
(`openapi/standalone.yaml`); verdicts answer HTTP 200 with the canonical body, and 4xx/5xx are
reserved for requests that cannot be evaluated. There are no per-agent or per-wallet count limits
anywhere on this path (#61): the only limits are cost-based (below).

> `tANE` is a free test token with no cash value. Run this only against the sandbox (Base Sepolia,
> `84532`) or a local chain.

## Build

```bash
docker build -f services/facilitator/Dockerfile -t 16ane-facilitator .
```

The image holds Node 24, a checksum-verified Foundry `cast` (settlements are sent with it), and the
facilitator, SDK and shared server-module sources. It contains **no secrets**.

Without Docker, run it straight from a checkout (needs `cast` on `PATH` for settlements):

```bash
ANE_RPC_URL=... ANE_REGISTRY_ADDRESS=0x... ANE_RELAYER_PRIVATE_KEY=0x... \
  node --experimental-strip-types services/facilitator/src/main.ts
```

## Run

```bash
docker run --rm -p 127.0.0.1:8788:8788 \
  -e ANE_RPC_URL=https://sepolia.base.org \
  -e ANE_REGISTRY_ADDRESS=0x01d5daB670DE5868305eB862721ebE62772C3Df3 \
  -e ANE_RELAYER_PRIVATE_KEY \
  16ane-facilitator
```

| Variable | Required | Meaning |
|---|---|---|
| `ANE_RPC_URL` | yes | Base Sepolia (or local) JSON-RPC endpoint |
| `ANE_REGISTRY_ADDRESS` | yes | `AneRegistry`; the sandbox's is in `networks/sandbox-sepolia.json` |
| `ANE_RELAYER_PRIVATE_KEY` | yes | Pays the gas for settlements. Use a **dedicated** key with a small amount of Base Sepolia ETH, never an admin or deployer key |
| `ANE_HOST` / `ANE_PORT` | no | Listen address and port (`0.0.0.0` / `8788` in the image) |
| `ANE_CHAIN_ID` | no | Defaults to `84532`; the facilitator serves only this chain's CAIP-2 network |
| `ANE_RELAYER_MAX_FEE_WEI` | no | The relayer's gas-price ceiling in wei (`ADR-0006`). Above it, `/settle` sends nothing and answers `503 ANE-E-1205` with `Retry-After: 60`. Unset: no ceiling |
| `ANE_RELAYER_GAS_BUDGET_WEI` | no | Most the relayer may spend on gas per UTC day, in wei (default `50000000000000000` = 0.05 ETH). Once reached, settlements get `503 ANE-E-1006` with `Retry-After` until 00:00 UTC and a hint to settle with your own gas |
| `ANE_STATE_PATH` | no | SQLite file for consumed payment proofs, receipts and gas spend. The image sets `/data/facilitator.sqlite`; mount a volume at `/data` to keep it across container re-creation. Unset outside the image: memory only, with a startup warning — and a restart would let a settled proof settle again |

A bad configuration exits with code 2 and lists every problem, without printing key values.

**Settling costs real gas from your relayer key for whoever asks.** Before exposing it publicly,
set a gas budget you can afford to lose per day and watch `/healthz` (`spentTodayWei`,
`remainingTodayWei`, `lowBalance`). Every settlement is simulated from the relayer's address first,
so what would revert is refused (`402 ANE-E-4011`) without spending gas; vault intents settle only
to factory-registered vaults (`403 ANE-E-4013` otherwise), and exact authorizations only to `tANE`.

## Check it

- `GET /healthz`: `200 {"status":"ok", …}` when the RPC answers, `503` otherwise. The image's
  Docker `HEALTHCHECK` uses it.
- `GET /supported`: both schemes on your network, with the relayer in `signers`.
- `POST /verify` then `POST /settle` with a canonical x402 payment: see `openapi/standalone.yaml`.
  A settled proof retried after a lost response gets its stored receipt back (`extra.replayed`).
- `scripts/docker-smoke-standalone.sh` runs the whole acceptance check (both schemes end to end
  plus the indexer below) against a local Anvil chain. CI runs it on every PR.

Trust boundary to keep in mind: the facilitator never sees the merchant's request, so it does not
check resource/request binding — merchants still must, at delivery time
(`AnePaymentVerifier.verifyAndSettle` does). A receipt only attests that the authorization settled.

---

# Running the standalone indexer yourself

`services/indexer` polls `ServiceAnchored` events from standard RPC logs and serves the anchor set
at `GET /v1/services` (with `?provider=` and `?status=` filters), `GET /v1/services/:serviceIdHash`
and `GET /healthz` (REQ-101, REQ-106, ADR-0007). It is read-only and needs **no private keys**.

Anchors are untrusted advertisements: fetch the manifest from `manifestUri` yourself and verify its
signature offline with the SDK (`AneClient.verifyServiceManifest`). The indexer never fetches
third-party URLs and never judges a manifest.

## Build

```bash
docker build -f services/indexer/Dockerfile -t 16ane-indexer .
```

The image holds Node 24 and the indexer, SDK and shared server-module sources (no `cast`: it never
sends). Without Docker:

```bash
ANE_RPC_URL=... ANE_REGISTRY_ADDRESS=0x... \
  node --experimental-strip-types services/indexer/src/main.ts
```

## Run

```bash
docker run --rm -p 127.0.0.1:8789:8789 \
  -e ANE_RPC_URL=https://sepolia.base.org \
  -e ANE_REGISTRY_ADDRESS=0x01d5daB670DE5868305eB862721ebE62772C3Df3 \
  16ane-indexer
```

| Variable | Required | Meaning |
|---|---|---|
| `ANE_RPC_URL` | yes | Base Sepolia (or local) JSON-RPC endpoint |
| `ANE_REGISTRY_ADDRESS` | yes | `AneRegistry`; the sandbox's is in `networks/sandbox-sepolia.json` |
| `ANE_HOST` / `ANE_PORT` | no | Listen address and port (`0.0.0.0` / `8789` in the image) |
| `ANE_CHAIN_ID` | no | Defaults to `84532` |
| `ANE_INDEX_FROM_BLOCK` | no | Where a fresh store starts scanning: a block number, `latest` (no backfill, the default) or `earliest`. On Base Sepolia set the directory's deployment block; the scan advances in `ANE_INDEX_MAX_RANGE` chunks so public-RPC range caps are respected |
| `ANE_INDEX_POLL_MS` | no | Milliseconds between scans (default `5000`, minimum `1000`) |
| `ANE_INDEX_MAX_RANGE` | no | Most blocks per `eth_getLogs` call (default `2000`) |
| `ANE_STATE_PATH` | no | SQLite file for the anchor set and scan cursor. The image sets `/data/indexer.sqlite`; mount a volume at `/data` to keep it across container re-creation. Unset: a restart rescans from `ANE_INDEX_FROM_BLOCK` |

## Check it

- `GET /healthz`: `200 {"status":"ok", …}` with `latestBlock`, `lastScannedBlock`, `services`,
  `lastScanAt` and, when the last scan failed, `lastError` (a failed scan is retried, never fatal).
- Anchor a service on-chain (`AneServiceDirectory.anchorService`) and watch it appear in
  `GET /v1/services`; pause it (`setServiceStatus`) and watch the record follow. The standalone
  smoke script above does exactly this.
