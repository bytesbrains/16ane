# Initial epic backlog (draft, dependency-ordered)

Each epic needs an ADR where indicated, requirements traceability, test plan, docs and security review. **Do not open all as issues blindly**: deduplicate against existing repository first.

| Epic | Priority | Depends on | Deliverable / exit condition |
|---|---|---|---|
| E01 Repository and standards audit | P0 | — | evidence-backed capability/gap inventory |
| E02 ADRs and chain decision | P0 | E01 | accepted wallet, token, payment and governance ADRs |
| E03 tANE test token | P0 | E02 | verified contract, roles, metadata, tests |
| E04 Agent wallet and delegation | P0 | E02,E03 | fixed allowance, revoke, withdraw, invariant tests |
| E05 Faucet and abuse control | P0 | E03 | bounded grants, metrics, disclaimers |
| E06 Payment verification and receipts | P0 | E03,E04 | one-time proof, finality, idempotency, refunds documented |
| E07 Python SDK | P0 | E04,E06 | runnable client integration tests |
| E08 TypeScript SDK | P0 | E04,E06 | runnable client integration tests |
| E09 CLI and quickstarts | P0 | E05,E07,E08 | developer five-minute path |
| E10 Reference paid demo services | P0 | E06 | deterministic demo + paid provider sample |
| E11 CI/security/observability | P0 | E03-E10 | test gates, secret scan, SLOs, alerts |
| E12 Service manifests and registry | P1 | E06 | open schema, index, self-hosting guide |
| E13 MCP agent integration | P1 | E07,E08,E12 | safe purchase tools with policy enforcement |
| E14 Sponsored trial credits | P1 | E05,E10 | quota/campaign engine with hard real cost caps |
| E15 Wallet and provider dashboard | P1 | E04,E12,E14 | allocation, revoke, receipts, sponsor metrics |
| E16 Self-hostable facilitator | P1 | E06 | independent operator can verify/settle |
| E17 Revolving budgets and accounting | P1 | E04 | owner-opt-in revenue reuse without cap escape |
| E18 Async escrow and refunds | P2 | E06,E12 | milestone and failure semantics |
| E19 Agent identity/reputation | P2 | E12 | portable metadata, abuse-resistant caveats |
| E20 Cross-asset and provider routing | P2 | E12,E16 | adapter architecture, no mandatory asset |
| E21 India-first education/community | P1 | E09 | multilingual onboarding, demos and hackathon kit |
| E22 Future INR issuer feasibility | Research | E01,E02 | legal opinion, institutional partner requirements, no live funds |

## Example issue split for E04
- Compare wallet architectures and sign-off ADR-003.
- Specify delegation policy schema and threat model.
- Implement wallet factory/vault using reviewed libraries.
- Implement bounded spending and nonce/expiry checks.
- Add owner revoke, key rotation and withdrawal flows.
- Property tests for overspend, reentrancy, parallel spends and revenue reuse.
- Publish ABI, deploy scripts, explorer verification and integration example.

## Definition of done
PR merged, requirements referenced, acceptance tests passing, adversarial tests where relevant, documentation updated, security reviewer sign-off, versioned deployment artifact, no unsubstantiated claims of regulatory approval or real value.
