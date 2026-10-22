# Deploying the dashboard to Workers (`app.16ane.com`)

Runbook for #17 (REQ-104, ADR-0015 addendum 2026-10-22): the owner/provider
dashboard as an assets-only Worker, separate from `16ane-site`, so the
marketing site stays script-free while the dashboard runs its own first-party
scripts. Configuration lives in `wrangler.dashboard.jsonc`; deploys come from
Cloudflare Workers Builds on `main`, and CI (`.github/workflows/dashboard.yml`)
checks the build without deploying it.

> **Gate:** `app.16ane.com` serves the committed `dashboard/` build, which
> points at the public sandbox (Base Sepolia contracts, `https://api.16ane.com`).
> Connect Workers Builds only on a `main` where the dashboard workflow is
> green. Until step 1 is done, the app does not exist: every other subdomain
> besides the apex/`www` is still a proposal (README).

## 0. Once: Worker and custom domain

1. Create the Worker (or let the first deploy create it) and attach the custom
   domain, from a commit on `main`, with the `bytesbrains` Wrangler profile —
   the same account that holds the zone (`account_id` is pinned in
   `wrangler.dashboard.jsonc`, so a deploy cannot land in a personal account):
   ```bash
   npx wrangler deploy --config wrangler.dashboard.jsonc
   ```
   This creates the proxied `app` DNS record the custom domain needs. After
   this one hand deploy, never run `wrangler deploy` for the dashboard again.
2. In the Cloudflare dashboard, connect Workers Builds for `16ane-dashboard`
   to `bytesbrains/16ane`, production branch `main`, build command empty (the
   committed `dashboard/` is already the sandbox-sepolia build — there is
   nothing to build), deploy command `npx wrangler deploy --config
   wrangler.dashboard.jsonc`. Turn off builds for non-production branches
   (Workers Builds → Previews), as for `16ane-site`: only `main` deploys, and
   no branch or pull request gets a preview URL (`preview_urls: false`).
3. Check through the Cloudflare edge:
   - `https://app.16ane.com/` returns 200 with the dashboard CSP
     (`script-src 'self'`, `connect-src` limited to the sandbox RPC/API),
     HSTS, `nosniff`, `Referrer-Policy` and `frame-ancestors 'none'`.
   - A bad path serves `dashboard/404.html` with a 404 status.
   - `http://app.16ane.com/` upgrades to `https://` (zone *Always Use HTTPS*,
     shared with the apex).

## 1. Promoting between environments

`dashboard/` is always the sandbox-sepolia build. To preview another
environment, build it to a scratch directory and serve that — never commit a
non-sandbox build over `dashboard/` (`site.test.ts` fails if the two generated
files drift):

```bash
# Local Anvil stack (dashboard-env needs the deployed addresses; the e2e tiers
# write this file for themselves — see test/dashboard/e2e/fixtures.ts):
node scripts/dashboard-env.cjs --network-file /tmp/networks-local.json /tmp/app-local --api-url http://127.0.0.1:PORT
# Staging on Base Sepolia (registry/contracts stay null until a dev deployment exists):
node scripts/dashboard-env.cjs dev-sepolia /tmp/app-dev --api-url https://<dev-api-host>
```

`--rpc-url` overrides the chain endpoint for any env (must be `https` outside
`local`). `--api-url` defaults to `https://api.16ane.com` for
`sandbox-sepolia` and is required elsewhere.

## 2. Rollback

Workers Builds redeploys `main` on every merge; to roll back, revert the
dashboard commit on `main` (or roll the Worker back to a previous deployment in
the Cloudflare dashboard → `16ane-dashboard` → Deployments). There is no
database and no Worker script: every deploy is a static asset set.
