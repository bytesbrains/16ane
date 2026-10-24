# Threat model and security requirements

## Assets and adversaries
Assets: owner principal, delegated tANE, provider compute budget, service results, signer keys, receipts, availability, future fiat reserves. Adversaries: compromised agent/LLM, prompt injection in retrieved content, malicious merchant, Sybil faucet claimant, colluding agents, compromised relayer/indexer, phishing front-end, privileged contract operator, chain reorg and service outage.

## High-priority abuse cases
- Agent tricked into paying attacker by malicious tool output or changed payment address.
- Replayed payment intent across services, chains or expired quotes.
- Unlimited ERC-20 approval or arbitrary contract call drains wallet.
- Double-spend race with parallel agent workers.
- Merchant takes payment then refuses service; idempotent retries accidentally double-pay.
- Faucet farming burns sponsor's real compute budget.
- Fake 'earnings' via wash trades used to evade fixed-budget spending cap.
- Malicious registry manifests include prompt-injection instructions.
- Sponsor or paymaster suffers gas-draining denial of service.
- Contract upgrade/admin key compromise.
- Future issuer reports reserves without independent corroboration.

## Required mitigations
Minimal delegated scopes; enforce limits in contract; allowlist contract methods where appropriate; signer isolation; hardware-backed owner keys where practical; deadlines, chain ID and nonce binding; reentrancy guards; safe token interaction; quote recipient confirmation; idempotency; transaction finality policy; service cost caps; rate limits; event monitoring; reproducible deployments; role separation; documented emergency pause boundaries; fuzz/property tests and independent review.

## Security tests
1. Agent overspends exact budget by one base unit -> revert.
2. Two concurrent spends exceed cumulative cap -> at most one succeeds.
3. Reuse signed payment proof -> reject second use.
4. Wrong recipient/asset/chain/expiry -> reject.
5. Owner revokes signer -> future delegated spends reject.
6. Revenue deposit under fixed mode -> no spending cap increase.
7. Malicious service response requests seed phrase -> agent ignores and keys remain isolated.
8. Faucet claims across Sybil identities -> rate limits and provider spend caps still bound exposure.
9. Indexer outage -> direct on-chain verification path works.
10. Delivery failure after settlement -> documented refund/claim workflow, no fictitious automatic rollback.

## Voucher settlement additions (ADR-0017, proposed)

- Vouchers outstanding to several merchants jointly exceed the remaining budget; later claims revert and merchants go uncompensated. Vault guarantee (settled spend never exceeds budget) holds regardless; merchants bound the risk with exposure caps, short voucher TTLs, vault-state mirroring, and prompt claims.
- Merchant serves on stale mirrored vault state and over-extends credit. Reference implementation re-mirrors on a mandatory cadence; loss bounded by the merchant's own exposure cap.
- Revocation, signer rotation, or expiry voids served-but-unclaimed vouchers. By design; bounded by TTL and claim cadence and disclosed to merchants and agents.
- Same-voucher resubmission or stale voucher claim reverts on non-positive delta; distinct EIP-712 struct typehash prevents `SpendIntent`/`Voucher` cross-replay.
- Over-claiming beyond the signed cumulative is protocol-impossible (claims pay `signedCumulative - claimed`), unlike trust-based actuals.
- Compromised agent key mints vouchers up to the remaining budget until revocation: equivalent to today's compromised-signer exposure, bounded additionally by voucher TTL.

## Task escrow additions (ADR-0009 addendum, ISS-021)

Each case below has a test in `test/AneTaskEscrow.t.sol`.

- **The seller (or anyone) tries to open a task on terms the agent did not sign:** a different seller, deadline or job. The `quoteId` commits to all three, so `openTask` reverts (`TermsMismatch`).
- **An agent locks more than its policy allows.** The lock is a vault `settlePayment`, so the vault's budget, per-payment and daily limits apply unchanged.
- **The buyer stalls after delivery to take the funds back.** No reclaim is possible on or before the deadline. Milestone releases limit what the seller has at risk.
- **The seller stalls to keep the funds locked.** After the deadline anyone can return them, and only to the vault. The deadline is capped at 30 days from the lock.
- **Someone settles the signed lock on the vault directly, skipping `openTask`.** `openTask` adopts the vault's payment record (amount and payee must match), so the funds are never stranded.
- **A third party pre-refunds the task's payment through `refundPayment`.** The return refunds only what is still refundable and transfers the rest, so it cannot revert.
- **Forged or replayed receipts.** The escrow accepts only the owner, or the agent while active. Receipts are bound to the escrow, the chain and the task. Cumulative amounts make a replay pay nothing more, and revoking the agent voids its receipts.
- **Reentrancy.** Every state-changing function is `nonReentrant`. The task is recorded before the vault call, and the token is tANE.

## ERC-8004 adapter additions (ADR-0018, ISS-022)

Each case below has a test in `packages/sdk-ts/test/erc8004.test.ts` or `e2e/flows/erc8004-reputation.test.ts`.

- **Someone claims a vault they do not own.** The registry stores any `16ane.vault` claim. `getAgentIdentity` treats the claim as verified only if the factory registered the vault and `vault.owner()` is the identity's owner.
- **A registration file copied from another agent.** `registrationBindsBack` is true only when the file's `registrations` names this registry and this id.
- **Feedback citing someone else's payment.** Both the SDK and the reader require the reviewer to be the payer, or the owner or agent signer of the paying vault. The payee must also be the agent's owner, wallet or verified vault.
- **One payment reused for many reviews.** One transaction proves at most one entry; later entries are marked unverified.
- **A tampered or misdirected feedback file.** The file must match `feedbackHash` and must name this registry, this agent and this reviewer. An off-chain file without a hash is never verified.
- **Self-review.** The registry refuses feedback from the agent's owner or operators.
- **Wash trading with free tANE.** Not preventable: someone can pay themselves through a second identity. Every read carries `REPUTATION_CAVEAT`, the SDK computes no score, and reputation must never gate trust or spending.
- **A hostile file URL (SSRF, size).** Only `data:` URIs are read unless the caller supplies a fetcher. Files are capped at 64 KiB, and their text is untrusted.
- **A third-party registry upgrade.** The registries are proxies owned by their maintainers. No funds pass through them. `npm run check:erc8004-fixture` detects a change of implementation.

## Quote selection and provider routing additions (ADR-0019, ISS-023)

Each case below has a test in `packages/sdk-ts/test/routing.test.ts`, `e2e/flows/provider-routing.test.ts` or `packages/sdk-py/tests/test_sdk.py`.

- **Decimal mismatch between assets.** Each cap belongs to one `(chain, asset)` pair and is compared only with amounts in that asset. An 18-decimal cap never admits a 6-decimal quote, and offers in different assets are never compared by raw amount. Decimals come from the token's `decimals()`, never from a quote, and human amounts are never rounded.
- **A quote in an asset the vault cannot pay, or on another chain.** `purchase` refuses it before signing (`ANE-E-3003`), even when the merchant lists it first. Receipts are verified against the vault's own token, not the asset the receipt names.
- **A malformed amount read as a smaller number.** Only canonical base-10 integers below 2^256 are accepted, so `"1e18"`, `"-1"`, `"0x10"`, `"1.0"` and padded strings are refused.
- **Bait and switch.** A provider could win the ranking with a cheap probe quote and then charge more, or name another payee. `purchaseRouted` pins the purchase to the winning amount and payee, and refuses either change before any payment.
- **A probe that pays or spends a trial.** Probes strip `payment-signature`, `x-payment` and `x-trial-request`, so a probe gets a quote and nothing else.
- **Provider-claimed latency.** Latency is measured by the caller and never taken from the provider. A probe measures only the time to the quote, which is a lower bound on how long the work takes.
- **Provider text in errors.** Rejection reasons quote provider fields as JSON strings cut to 48 characters, because they can reach logs and LLM context.

## One vault per asset additions (ADR-0020, #133)

Each case below has a test in `test/AneMultiAsset.t.sol`, `test/AneMultiAsset.invariant.t.sol`, `packages/sdk-ts/test/multi-asset.test.ts` or `e2e/flows/provider-routing.test.ts`.

- **Revenue credited in the wrong asset.** A vault credits revenue only to merchants its own factory registered. Each factory makes vaults of one asset, so a tANE payment into a tSIX vault (or the reverse) credits nothing, and a REVOLVING ceiling never grows by an amount read in the wrong units. This holds only while no factory produces two assets' vaults; ADR-0020 makes that an invariant.
- **Escrow paying out another asset.** The tANE escrow accepts only vaults its tANE factory registered, so a tSIX vault cannot lock tSIX and release other tasks' tANE.
- **A foreign token counted as budget.** Spendable balance, withdrawal and refunds read only the vault's own token. A foreign token paid in is inert, and it is also unrecoverable.
- **A cap applied to the wrong asset in the SDK.** `MultiAssetSession` takes one cap per asset, refuses a cap for an asset none of its vaults holds, a repeated asset, two vaults in one asset, and mixed chains. The winning offer is paid by the vault for its asset, which verifies the receipt against that asset.
- **Who may add an asset.** No contract role: a new asset is a new factory deployment by the operator. `DeploySecondAsset` refuses anything but Base Sepolia and Anvil, and tSIX carries `isTestToken()`. Fee-on-transfer, rebasing or otherwise hostile tokens are excluded by only deploying 16ane's own test tokens; nothing on-chain enforces that. tSIX, like tANE, has its faucet as its only minter (ADR-0021), and a relayed claim is bound to one faucet by its EIP-712 domain name.
- **Revocation of several vaults.** Each vault is revoked on its own, so an owner revoking an agent with two vaults sends two transactions, and the second is not atomic with the first.
- **Review gate.** No enforcement code changed, but the isolation argument is the boundary. It needs its own security review before the public deploy.

## Launch gates
Threat model reviewed, tests automated, secrets scanned, source verified, contract roles disclosed, rollback/migration rehearsed, hosted spend caps configured, abuse reporting contact live. For future real-value mainnet, require external security audits and explicit legal/compliance sign-off; a public testnet launch does not satisfy those requirements.
