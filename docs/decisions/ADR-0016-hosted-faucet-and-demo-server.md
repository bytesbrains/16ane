# ADR-0016: Hosting the public faucet and reference demo server

- **Status:** Accepted (2026-10-20). The maintainer chose **Option A (Fly.io)**, built as a portable Docker image so it can move to another platform if needed.
- **Date and owners:** 2026-10-20 | 16ane Maintainers
- **Related requirements:** REQ-001 (no hosted dependency for core transfers), REQ-002 (faucet), REQ-011 (five-minute quickstart), REQ-012 (no-value disclosures), REQ-014 (sponsored-compute caps), REQ-105 (metered relayer)
- **Related issues:** #36 (sandbox go-live), #18 (self-hostable facilitator and indexer), #16 (sponsored trials), #61 (agent-speed limits), #67 (SDK read consistency)
- **Related ADRs:** `ADR-0006` (gas funding and faucet abuse policy, amended by #61), `ADR-0008` (sponsored credits), `ADR-0010` (API auth, limits and privacy), `ADR-0015` (16ane.com on Cloudflare)
- **Launch gate:** `G1-13` (public hosted faucet and reference demo server), the last open sandbox gate.

## Context
The sandbox contracts are live and source-verified on Base Sepolia (`G1-12`, registry
`0x01d5daB670DE5868305eB862721ebE62772C3Df3`). Today anyone with Base Sepolia ETH can claim from `AneFaucet`
directly, but there is no hosted **gasless faucet** (the five-minute quickstart, REQ-011) and no hosted
**reference demo API** (`/v1/demo/*`) for agents to pay. Both live in `services/sandbox-server`, which so far
runs only inside the E2E harness.

Facts about the server that constrain where it can run (checked against `main`, 2026-10-20):
1. **It runs Foundry's `cast` as a child process** to send every transaction (`AneClient.sendContractTx`).
   The host must run a Node process **and** the Foundry binary. A Workers-style runtime can't spawn processes.
2. **All state is in memory:** faucet cooldowns (`RecipientCooldowns`), claim records, the service directory,
   trial quotas (`TrialQuotaTracker`), and x402 idempotency records and receipts (`AnePaymentVerifier`). A restart
   or second instance loses them: cooldowns reset, and idempotency stops protecting against double charges.
3. **No start command:** only `e2e/harness.ts` constructs the server. `server.listen` is hard-coded to
   `127.0.0.1`, so a container couldn't accept traffic as is.
4. **It holds hot keys:** a relayer key (pays gas for gasless claims and settlements) and a provider key (receives
   demo payments). Both need platform secret storage, and the relayer needs Base Sepolia ETH.
5. **#61's rules apply:** no protocol limits on paying agents; operator-paid resources are limited by cost. For the
   relayer that means a **daily gas budget with a circuit breaker** (ADR-0006). That budget isn't implemented yet.
6. **REQ-001 / AGENTS.md:** hosted infrastructure must never be required for core token transfers, and a
   self-hosted path must exist. Whatever we host should therefore be the **same artifact** anyone can run themselves.

## Options
All options start from one **portable Docker image** (Node 24 + Foundry + the server, with a real entrypoint).
That image is also the self-hosting deliverable for #18.

- **A. A small always-on container VM (for example Fly.io), with a persistent volume for SQLite state.**
  The server runs nearly unchanged; state moves to a SQLite file on the volume. Cloudflare stays in front for
  DNS and TLS (`api.16ane.com` → the app). A second vendor and bill.
- **B. Cloudflare Containers, fronted by a Worker and Durable Object.** One vendor, already used for 16ane.com
  (the `bytesbrains` account), with native secrets and Turnstile. Containers are generally available on the
  Workers Paid plan. But container instances sleep and are ephemeral, so state must live in Durable Object
  storage (more porting), and cold starts add latency to the first call.
- **C. Google Cloud Run** (request-based, scale to zero). Low cost at low traffic, but cold starts, and
  scale-to-zero makes in-process state impossible: it needs an external database (Firestore, Cloud SQL), which
  is more moving parts.
- **D. Rewrite for Cloudflare Workers with native signing** (no `cast`): sign EIP-1559 transactions in the SDK,
  and keep state in Durable Objects. The leanest long-term runtime, and native signing would also simplify the npm
  SDK. But it's a substantial rewrite, so it's not the way to launch `G1-13`.

## Evidence and sources (checked 2026-10-20; prices change, verify before committing)
- **Cloudflare Containers** became generally available on the Workers Paid plan, billing active CPU, provisioned memory and disk in 10 ms increments, with monthly allowances included ([changelog, 2026-04-13](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/); [Containers changelog](https://developers.cloudflare.com/changelog/product/containers/)). I found no primary source for the Durable Object integration details or current CPU architectures; check the Containers docs before choosing B.
- **Fly.io** lists a `shared-cpu-1x` 256 MB machine at about $1.94/month always-on ([resource pricing](https://fly.io/docs/about/pricing/)). Volume pricing (commonly cited as $0.15/GB/month) wasn't confirmed on the live page.
- **Cloud Run** has request-based and instance-based billing, each with a monthly free allowance of vCPU-seconds, GiB-seconds (and requests, for request-based) ([pricing](https://cloud.google.com/run/pricing)).

## Recommendation
**Option A for launch, behind Cloudflare, built from the portable image.** It's the fastest honest path to
`G1-13`: the server runs almost as is, SQLite on a volume fixes the state problem with one file, and the image is
the self-hosting deliverable #18 needs anyway. Option D stays the long-term direction; revisit B or D when native
signing lands.

If the maintainer prefers a single vendor, **B** is the alternative: the same image, plus a Durable Object state
adapter instead of SQLite.

## Decision (maintainer, 2026-10-20)
1. **Host: Option A, Fly.io:** a small always-on VM with a volume for SQLite state, behind Cloudflare for DNS and
   TLS. It's built as a **portable Docker image**, so the same service can move to Cloudflare Containers, Cloud Run
   or a self-hosted machine without code changes. The maintainer owns the Fly.io account and its bill.

**Still open:**
1. **Monthly budget ceiling** for hosting, and for relayer gas (ADR-0006 starts at 0.05 Base Sepolia ETH/day).
2. **Hostnames:** `api.16ane.com` for the API and gasless faucet; `faucet.16ane.com` only if a web faucet page is
   wanted (#17 covers the dashboard).
3. **Keys:** separate, dedicated relayer and provider keys, created for the host and never reused from the deployer.

## Work (tracked as issues)
1. **Entrypoint and config** (#73): a `services/sandbox-server` start command reading env (RPC URL, registry, keys from
   secrets, port), listening on a configurable host (`0.0.0.0` in containers), plus a health endpoint.
2. **Persistent state** (#75): a storage interface for cooldowns, claims, directory, trial quotas and idempotency/receipts,
   with SQLite (A) or Durable Objects (B). Idempotency must survive restarts.
3. **Relayer gas budget** (#76; ADR-0006, #61): track ETH spent per UTC day; above the budget, stop sponsoring gas and
   tell callers to self-relay. No per-agent count limits.
4. **Docker image** (#74): Node 24 + a pinned Foundry release, non-root user, run in CI, published for self-hosting (#18).
5. **Abuse controls for the anonymous web faucet** (#79): Turnstile, and a signed-challenge path for agents (ADR-0006 as amended).
6. **Read consistency on public RPCs** (#67 part 2): the server reads right after it writes, as the smoke test did.
7. **Operations** (#78): secrets set-up, alerts on relayer balance and budget, logs without secrets (ADR-0010), and the
   runbook in `OPERATIONS.md`.
8. **Go-live** (#78): DNS, a smoke test against the hosted API, `G1-13` → PASS, and site and README updates.
9. **Gasless use** (#77): sponsored signed actions (EIP-3009 transfers, vault signatures), so `tANE` holders never need ETH.

## Implementation notes
- **State store (#75):** a synchronous `KeyValueStore` interface (SDK) with a SQLite implementation in the server,
  using Node's built-in `node:sqlite`, so there's no npm dependency or native build. Node 24 still labels
  `node:sqlite` experimental; the image pins the exact Node version by digest, so its behaviour can't change
  under us, and the interface lets the backend be swapped. The file lives at `/data/sandbox.sqlite`, the Fly.io
  volume mount (`synchronous = FULL`, so recorded idempotency entries and consumed proofs survive a crash).

- **Deployment (#78):** `fly.toml` (app `16ane-sandbox-api`, org `bytesbrains`, region `sin`, one always-on
  `shared-cpu-1x` machine, volume `sandbox_state` at `/data`, health check on `/healthz`) and
  `docs/operations/DEPLOY_API.md`. **`api.16ane.com` is DNS-only to Fly (no Cloudflare proxy),** with Fly
  terminating TLS, so `Fly-Client-IP`, which Fly's proxy sets, is the real client address
  (`ANE_CLIENT_IP_HEADER`). Behind Cloudflare's proxy every request would carry a Cloudflare address, and
  per-client quotas would break. Keys are generated straight into Fly secrets and never printed.

- **Faucet claim proofs (#79):** the agents' "signed challenge" is the EIP-712 `FaucetClaim` that
  `AneFaucet.relayedClaim` already verifies, signed by the recipient with a random nonce and a deadline 30 s to
  1 h ahead. The contract enforces the nonce, so the server issues and stores nothing, and any relayer can
  submit the same signature. Before sending, the server checks the signer, the deadline, the cooldown and
  `relayedNonceUsed`, so a refused claim costs no gas. The web faucet sends a Turnstile token checked with
  `siteverify` (`ANE_TURNSTILE_SECRET_KEY`, optionally `ANE_TURNSTILE_HOSTNAME`). Claims with no proof are
  refused unless `ANE_FAUCET_OPEN_CLAIMS=true` (local or private servers). A signature proves key control, not
  personhood, so fresh keys can still claim up to the contract's daily cap; the relayer gas budget bounds that cost.

## Security and legal impacts
- **Hot keys on a hosted machine:** keep relayer and provider balances small, set the gas budget, rotate the keys
  if the host is compromised, and never reuse the deployer or admin key.
- **Disclosures:** demo endpoints are deterministic and sponsor no real compute; responses keep the
  "TEST TOKENS (tANE) - NO CASH VALUE" disclosure (REQ-012), and sponsored trials disclose quotas (ADR-0008).
- **Core transfers stay independent:** the API is a convenience. Claiming from `AneFaucet` and paying through
  `AneAgentVault` keep working without it (REQ-001), and the same image is published for self-hosting.

## Consequences
- `G1-13` becomes achievable, with a clear list of work items.
- The project takes on a running service: uptime, key custody and a small monthly bill.
