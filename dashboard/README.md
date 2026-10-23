# Owner/provider dashboard (`app.16ane.com`)

REQ-104 (#17): the web app where owners create agent wallets, fund them with
faucet tANE, delegate fixed budgets, watch earnings, revoke agents, withdraw
leftovers, and look up payments — and where providers pause/resume sponsored
campaigns. Seven hash-routed screens: Overview, Fund, Vaults, Delegate, Earn,
Campaigns, Activity.

`tANE` is a free testnet token with **no cash value**: every screen that shows
an amount carries the disclosure, and `test/dashboard/*` enforces it in CI.

## Architecture

- **Static, zero-dependency.** `index.html` + `styles.css` + ES modules in
  `assets/` (raw EIP-1193 wallet calls, a verified keccak/ABI port —
  differential-tested against `packages/sdk-ts`). No bundler, no framework, no
  third-party script; the key never leaves the connected wallet.
- **Separate Worker from `16ane.com`.** The marketing site stays script-free
  (ADR-0015); the dashboard runs its own first-party scripts under a
  script-allowlisted CSP (`_headers`: `script-src 'self'`, no inline
  scripts/styles/handlers), served by an assets-only Worker
  (`wrangler.dashboard.jsonc`, `16ane-dashboard`).
- **One build per environment.** `dashboard/` itself is the sandbox-sepolia
  build, committed. `scripts/dashboard-env.cjs` regenerates it from
  `networks/<env>.json` (plus `--rpc-url`/`--api-url` overrides, the latter
  required outside `sandbox-sepolia`): only `assets/network.js` and the CSP
  `connect-src` differ per env, and `test/dashboard/site.test.ts` requires the
  two generated files (`assets/network.js`, `_headers`) to match the
  `sandbox-sepolia` build exactly.

## Environments

| Env | Chain | RPC / API | How |
|---|---|---|---|
| `local` | Anvil (e2e harness) | per-run URLs | built by the Playwright tiers from a network file |
| `dev-sepolia` | Base Sepolia | pinned RPC, dev API | `node scripts/dashboard-env.cjs dev-sepolia <outDir> --api-url …` |
| `sandbox-sepolia` | Base Sepolia | public RPC, `https://api.16ane.com` | this directory; what `app.16ane.com` serves |

Deployment (maintainer): `docs/operations/DEPLOY_APP.md`.

## Local development

```bash
# Serve this directory statically (any static server; headers below are advisory locally):
npx wrangler dev --config wrangler.dashboard.jsonc   # or: python3 -m http.server -d dashboard
# Point a scratch build at a local stack instead:
node scripts/dashboard-env.cjs --network-file <path> /tmp/app-local --api-url <url>
```

Connect a wallet on the matching chain (Base Sepolia for this build) with
testnet ETH for gas; the Fund screen's faucet needs no tANE to start.

## Tests

- `npm run test:dashboard` — hermetic Node tests: env reproduction, ABI/keccak
  differential checks, disclosure/CSP/link checks, fake-DOM screen tests.
- `npm run test:e2e:dashboard-smoke` — Playwright, no browser wallet needed:
  file-served smoke flows plus axe-core WCAG 2.1 A/AA over every route.
- `npm run test:e2e:dashboard-tier1` — Playwright + Anvil + sandbox server
  (CI): injected stub wallet whose signatures Anvil really produces; covers
  connect, fund, vault, delegate, revoke/withdraw, campaign pause/resume and
  payment lookup.
- `npm run test:e2e:dashboard-tier2` — Playwright + Anvil + a real MetaMask via Synpress
  (CI-only, headed under xvfb on Linux): the owner journey end to end on chain
  31337. Linux-only because Synpress reuses the wallet profile across browser
  relaunches, which macOS keychain behavior breaks; see `test/dashboard/e2e/metamask/tier2.spec.ts`
  for why Tier-2 lives in a CJS subdirectory with an ESM global setup.

CI: `.github/workflows/dashboard.yml` (static checks, smoke, Tier-1, Tier-2).
Type-check: `npm run typecheck` covers `test/dashboard/e2e` as its own
`bundler`-resolution project (Synpress ships extensionless `.d.ts` imports that
`nodenext` rejects).
