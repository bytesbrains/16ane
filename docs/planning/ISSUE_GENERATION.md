# Agent issue-generation playbook

## Input order
Read `AGENTS.md`, `README.md`, requirements, architecture, ADR queue, roadmap and epics. Then inspect actual repository and GitHub issues. Do not duplicate existing work or fabricate implemented endpoints.

## Generate outputs
1. `CAPABILITY_GAP_REPORT.md` — existing implementation evidence, missing capabilities, risks.
2. `ADR_PROPOSALS/` — prioritized architectural decisions with source citations.
3. `EPIC_DEPENDENCY_GRAPH.md` — phase and blocking edges.
4. GitHub epic issues — outcome, dependencies, linked requirements and measurable exit gates.
5. Child issues — sized for one reviewable PR where feasible, with tests and docs.
6. `TRACEABILITY.md` — REQ ID -> epic -> issue -> test -> deployment evidence.

## Issue template
**Title:** `[E04][contract] Enforce cumulative agent spending cap`

**Context:** Why this is needed and where it fits.

**Scope:** Exact deliverables, interfaces and expected behavior.

**Out of scope:** Avoid creeping into real-money ANE or unrelated features.

**Dependencies:** ADRs, contracts, prior issues.

**Acceptance criteria:** Given/when/then with positive and negative paths.

**Security/privacy:** Abuse cases, secret handling, tests.

**Documentation/observability:** Docs, metrics, logging, dashboards.

**Evidence:** Code paths, specs, standards sources.

**Done:** CI, reviews, deployment verification if applicable.

## Prioritization rubric
P0 = necessary for safe end-to-end public sandbox. P1 = external adoption and sponsored credits. P2 = advanced commerce. `BLOCKED-LEGAL` = real-INR mint/redeem/issuance until qualified approval. Include estimates as ranges and label uncertainty.

## Planning prompt
'Inspect this repo, read AGENTS.md and all 16ane specs, verify current standards, identify gaps and ADRs, then propose a dependency-ordered epic/issue backlog with testable acceptance criteria. Do not implement or deploy until reviewed. Never treat tANE as real INR.'
