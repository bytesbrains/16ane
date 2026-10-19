# Instructions for AI research, architecture and implementation agents

## Authority and scope
These are **planning specifications**, not verified implementation facts. Never claim endpoints, contracts, package names, audit results, partner approvals, reserves, token listings or regulatory permissions already exist. Inspect actual repository, deployments and open issues first. Do not execute real-value deployments, accept INR, create tradable mainnet tokens, or handle private keys without explicit maintainer authorization.

## Work sequence
1. Read README and all docs; extract requirement IDs, open questions, assumptions and non-goals.
2. Inventory code, chain settings, dependencies, existing wallets, infra and issue backlog. Cite file paths and revisions.
3. Research current standards using primary specifications and implementation documentation. Record source URLs, date checked, limitations and chain support; do not assume older standards remain current.
4. Draft ADRs for unresolved decisions before implementation (wallet type, payment protocol, facilitator, registry, gas sponsorship, chain, faucet, tANE decimals, upgrades, reserve path).
5. Build dependency-ordered epics and small actionable issues. Label each `research`, `adr`, `security`, `contract`, `sdk`, `infra`, `docs`, `demo`, `legal-review` as appropriate.
6. For each issue: motivation, scope/non-scope, dependencies, testable acceptance criteria, threat considerations, docs updates, observable outputs.
7. Request review of architecture and backlog; only then implement approved P0 work behind testnet configuration.

## Invariants and prohibitions
- `tANE` is **free, simulated and worthless**: never advertise it as ₹-backed, redeemable, investable or convertible to ANE.
- A funded agent cannot exceed its enforceable authorized balance or policy; prompt text does not count as enforcement.
- Never embed owner keys in prompts, logs, demo source, analytics or MCP outputs.
- An agent's revenue does not silently increase its spend authority under fixed-budget mode.
- Do not rely on hosted infrastructure for core token transfers; demonstrate alternate self-hosted path.
- Never assert that reserve attestations are cryptographic proof of a bank balance.
- All simulated services must disclose real compute sponsorship and quotas.
- Any regulatory interpretation must be presented as an open legal question, not legal advice.

## Expected planning outputs
`docs/decisions/ADR-XXXX-*.md`, a traceability table (requirement -> epic -> issue -> test), proposed GitHub issues, and a launch-readiness report with PASS/FAIL/UNKNOWN gates. Maintain an assumptions register. Do not make up benchmarks, audits, integrations or transaction counts.
