# Deploying the sandbox API to Fly.io (`api.16ane.com`)

Runbook for #78 (`ADR-0016`): the reference server (gasless faucet, x402 demo API, directory) on Fly.io, in the
`bytesbrains` organisation, from the same Docker image self-hosters run (`docs/operations/SELF_HOSTING.md`).
Configuration lives in `fly.toml`; keys live only in Fly secrets.

> **Gate:** don't make it public until the relayer gas budget (#76) and the abuse controls (#79) are merged.
> Until then, deploying is fine for testing, but don't publish `api.16ane.com` or link to it.

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
Fly can't show secrets back. If a key is lost or exposed, generate a new one the same way and redeploy;
both keys hold only test assets.

**Fund the relayer** with a little Base Sepolia ETH (0.01 ETH covers thousands of sponsored transactions at
2026-10-20 prices). The provider receives demo payments in `tANE` and needs no ETH.

## 2. Deploy
```bash
fly deploy --app 16ane-sandbox-api          # builds the Dockerfile remotely for amd64
fly status --app 16ane-sandbox-api
curl -s https://16ane-sandbox-api.fly.dev/healthz
```
`/healthz` must show `"status":"ok"`, the registry `0x01d5daB670DE5868305eB862721ebE62772C3Df3`, the relayer's
address and balance, and its daily gas budget. Fly's health check uses the same endpoint.

## 3. Check it end to end
```bash
# A gasless claim for a fresh address: it must receive 16,000 tANE and still hold 0 ETH.
curl -s -X POST https://16ane-sandbox-api.fly.dev/v1/faucet/claims \
  -H 'content-type: application/json' -d '{"recipient":"0x…"}'
```
Then check the balance on Basescan, and run `scripts/smoke-sandbox.ts` against Base Sepolia as before.

## 4. `api.16ane.com` (only after the gate above)
```bash
fly certs add api.16ane.com --app 16ane-sandbox-api
```
In Cloudflare (`bytesbrains` account, `16ane.com` zone), add the records `fly certs add` prints: a **CNAME
`api` → `16ane-sandbox-api.fly.dev`, DNS only (grey cloud)**, plus the ACME validation record. It must be DNS-only
so Fly terminates TLS and its `Fly-Client-IP` header carries the real client address
(`ANE_CLIENT_IP_HEADER` in `fly.toml`). Through Cloudflare's proxy, every request would appear to come from
Cloudflare, and per-client trial quotas would stop working.

Then: `fly certs check api.16ane.com`, `curl -s https://api.16ane.com/healthz`, set **G1-13** to PASS, and
update the site and README.

## Operations
- **Watch `/healthz`:** `relayer.lowBalance` turns true when the balance can't cover what's left of today's
  gas budget. Top up the relayer before it empties.
- **Logs:** `fly logs --app 16ane-sandbox-api`. They never contain keys (`ADR-0010`); errors show an
  `errorId` that matches the client's response.
- **One machine only:** state and the payment-replay guard assume a single process (#82). Don't
  `fly scale count` above 1 without a shared store.
- **Rollback:** `fly releases --app 16ane-sandbox-api`, then `fly deploy --image <previous image>`. State on
  the volume is kept.
