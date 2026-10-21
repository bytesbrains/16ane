# Deploying the sandbox API to Fly.io (`api.16ane.com`)

Runbook for #78 (`ADR-0016`): the reference server (gasless faucet, x402 demo API, directory) on Fly.io, in the
`bytesbrains` organisation, from the same Docker image self-hosters run (`docs/operations/SELF_HOSTING.md`).
Configuration lives in `fly.toml`; keys live only in Fly secrets.

> **Gate:** the relayer gas budget (#76) and the faucet's claim proofs (#79) are in. Publish `api.16ane.com`
> only after steps 2 and 3 pass, including the `Fly-Client-IP` check. `16ane-sandbox-api.fly.dev` is reachable
> by anyone who finds the name; while it runs, the daily gas budget (`ANE_RELAYER_GAS_BUDGET_WEI`) caps what the
> relayer can spend. `fly scale count 0 --app 16ane-sandbox-api` stops it; `fly scale count 1` brings it back
> with its volume.

## 0. Once: account and app
1. A card on the `bytesbrains` organisation: https://fly.io/dashboard/bytesbrains/billing
2. Create the app and its volume (1 GB holds years of sandbox state):
   ```bash
   fly apps create 16ane-sandbox-api --org bytesbrains
   fly volumes create sandbox_state --app 16ane-sandbox-api --region sin --size 1
   ```

## 1. Keys: generated straight into Fly secrets
Two new, dedicated keys; never the deployer or any admin key. Each command prints only the **address**; the
private key goes from `cast` through a pipe into Fly, so it never appears in your terminal, shell history or
any process's arguments.
```bash
W=$(cast wallet new --json)
echo "relayer address: $(echo "$W" | jq -r '.[0].address')"
echo "$W" | jq -r '"ANE_RELAYER_PRIVATE_KEY=\(.[0].private_key)"' | fly secrets import --app 16ane-sandbox-api --stage
unset W

W=$(cast wallet new --json)
echo "provider address: $(echo "$W" | jq -r '.[0].address')"
echo "$W" | jq -r '"ANE_PROVIDER_PRIVATE_KEY=\(.[0].private_key)"' | fly secrets import --app 16ane-sandbox-api --stage
unset W
```
Turnstile, for the web faucet page (#17), when that page exists: create a widget for `app.16ane.com` in the
Cloudflare dashboard (`bytesbrains` account, Turnstile), then import its **secret** the same way, so it isn't
typed on a command line, and set `ANE_TURNSTILE_HOSTNAME = "app.16ane.com"` in `fly.toml`. Until then, leave
both unset: claims then need the recipient's signature.
```bash
pbpaste | sed 's/^/ANE_TURNSTILE_SECRET_KEY=/' | fly secrets import --app 16ane-sandbox-api --stage
```
Error tracking (#90): create a Sentry project and import its DSN the same way, so it isn't typed on a
command line. Unset stays off.
```bash
pbpaste | sed 's/^/ANE_SENTRY_DSN=/' | fly secrets import --app 16ane-sandbox-api --stage
```
Tag deploys (`release-api.yml`) need an app-scoped deploy token as the `FLY_API_TOKEN` repository secret,
once. The first command prints the token; the second prompts for the paste, so it never appears on a
command line:
```bash
fly tokens create deploy -a 16ane-sandbox-api -n github-release -x 8760h
gh secret set FLY_API_TOKEN
```
One year; renew with the same two commands before it lapses.

Fly can't show secrets back. If a key is lost or exposed, generate a new one the same way and redeploy;
both keys hold only test assets.

**Fund the relayer** with a little Base Sepolia ETH (0.01 ETH covers thousands of sponsored transactions at
2026-10-20 prices). The provider receives demo payments in `tANE` and needs no ETH.

## 2. Deploy: push a tag
Deploys run from GitHub, not laptops. Push a `sandbox-api-v*` tag on `main` — tags are deployment
markers, not versions (CONTRIBUTING.md), so any suffix works:
```bash
git tag sandbox-api-v0.1.0 && git push origin sandbox-api-v0.1.0
```
`release-api.yml` checks the tag is on `main`, builds the Dockerfile on Fly, deploys, smoke-tests the
live app with `scripts/smoke-api.ts` and records a GitHub release. Watch the run, then check `/healthz`
yourself:
```bash
fly status --app 16ane-sandbox-api
curl -s https://16ane-sandbox-api.fly.dev/healthz
```
`/healthz` must show `"status":"ok"`, the registry `0x01d5daB670DE5868305eB862721ebE62772C3Df3`, the relayer's
address and balance, and its daily gas budget. Fly's health check uses the same endpoint.
Manual fallback (same build, no smoke gate): `fly deploy --app 16ane-sandbox-api`.

## 3. Check it end to end
From a checkout of this repo (no key needed):
```bash
API_URL=https://16ane-sandbox-api.fly.dev node --experimental-strip-types scripts/smoke-api.ts
```
It checks `/healthz` (RPC, relayer balance, gas budget, the registry in `networks/sandbox-sepolia.json`); that a
claim with no proof gets `401`; that a claim signed by a fresh in-memory key gets `201` and lands on-chain, with
the recipient holding 0 ETH; the claim's status; `429` inside the cooldown; the `402` quote on a demo endpoint;
and the service manifest's signature. It ends with `[smoke-api] PASS`. Then run `scripts/smoke-sandbox.ts`
against Base Sepolia as before.

**Check that clients can't forge `Fly-Client-IP`.** Fly's docs say the header holds the client address "from the
perspective of Fly Proxy" but don't say a client-sent value is replaced, so test it. Each address gets one
sponsored trial call (`ANE_TRIAL_FREE_CALLS_PER_CALLER`, default 1). Spend yours, then claim another with a
forged header:
```bash
for ip in 192.0.2.1 192.0.2.2; do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST https://16ane-sandbox-api.fly.dev/v1/demo/summarize \
    -H 'x-trial-request: true' -H "Fly-Client-IP: $ip" -H 'content-type: text/plain' -d 'hello'
done
```
The first may return `200`; the second must return `402`. If both return `200`, the forged header reached the
server: remove `ANE_CLIENT_IP_HEADER` from `fly.toml` and redeploy before going public.

## 4. `api.16ane.com` (only after steps 2 and 3 pass)
```bash
fly certs add api.16ane.com --app 16ane-sandbox-api
```
In Cloudflare (`bytesbrains` account, `16ane.com` zone), add what `fly certs add` prints: by default an
**A + AAAA pair for `api` (Fly's current recommendation; see `fly certs setup` for the CNAME alternative, which
needs no updates if Fly ever changes IPs — that is what `api.16ane.com` uses). Either way DNS only (grey
cloud)**, no ACME or ownership records needed when traffic points straight at Fly. It must be DNS-only
so Fly terminates TLS and its `Fly-Client-IP` header carries the real client address
(`ANE_CLIENT_IP_HEADER` in `fly.toml`). Through Cloudflare's proxy, every request would appear to come from
Cloudflare, and per-client trial quotas would stop working.

Then: `fly certs check api.16ane.com`, run `scripts/smoke-api.ts` with `API_URL=https://api.16ane.com`, set
**G1-13** to PASS, and update the site and README.

## 5. Turn on the monitor
Set the repository variable `SANDBOX_API_URL` to `https://api.16ane.com` (Settings → Secrets and variables →
Actions → Variables, or `gh variable set SANDBOX_API_URL --body https://api.16ane.com`). The
[API monitor](../../.github/workflows/api-monitor.yml) then reads `/healthz` every 30 minutes and opens an
`api-alert` issue when something needs you; watch the repository's issues to be notified. Run it once by hand
(`gh workflow run api-monitor.yml`) to check it.

## Operations
What to do for each alert is in `docs/operations/OPERATIONS.md` ("Hosted sandbox API").
- **Watch `/healthz`:** `relayer.lowBalance` turns true when the balance can't cover what's left of today's
  gas budget. Top up the relayer before it empties. The monitor (step 5) alerts on it.
- **Logs:** `fly logs --app 16ane-sandbox-api`. They never contain keys (`ADR-0010`); errors show an
  `errorId` that matches the client's response.
- **One machine only:** state and the payment-replay guard assume a single process (#82). Don't
  `fly scale count` above 1 without a shared store.
- **Rollback:** `fly releases --app 16ane-sandbox-api`, then `fly deploy --image <previous image>`. State on
  the volume is kept. (Pushing a tag always deploys forward; to re-release older code, tag that commit
  with a new `sandbox-api-v*` name.)
