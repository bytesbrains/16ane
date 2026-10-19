# ADR-0013: Open-Source Licensing, Dependency Policy, and Contribution Governance

- **Status:** Proposed (Phase 0 review required)
- **Date and owners:** 2026-10-19 | 16ane Repository Maintainers
- **Related requirements:** REQ-001, REQ-010, REQ-106
- **Related epics:** E01, E02, E11

## Context
`LICENSE-NOTE.md` states: "Choose and commit explicit code and documentation licenses before external contributions. Do not assume this planning package grants rights to third-party code or standards. ADR-013 covers license, contributor policy, trademark and branding rules." To maximize developer adoption of the 16ane SDKs, reference contracts, CLI, and self-hostable facilitator/indexer (`REQ-001`, `REQ-010`, `REQ-106`), we need clear open-source licensing and dependency governance.

## Options
1. **Option A: Permissive MIT License for All Code, Contracts, and SDKs + CC-BY-4.0 (or MIT) for Specifications/Documentation + Explicit Trademark Notice + Permissive Dependency Allowlist.**
2. **Option B: Copyleft GPLv3 / AGPLv3 License.**
3. **Option C: Source-Available / BSL License.**

## Evidence and sources
- **Repo File (`LICENSE-NOTE.md` lines 1–3):** Calls for `ADR-013` to resolve code, documentation, contributor policy, and trademark rules.
- **Sibling `copra` Repo (`/Users/nandal/Desktop/desk/repos/copra/LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`):**
  - Uses the **MIT License** (`LICENSE` lines 1–22), with OpenZeppelin Contracts v5.7.0 (`MIT`) and forge-std v1.17.0 (`MIT`/`Apache-2.0`).
- **Ecosystem Standards (`coinbase/x402`, `@modelcontextprotocol/sdk`, `a2a-protocol`):**
  - Licensed under `Apache-2.0` and `MIT`.

## Security and legal impacts
- **Permissive adoption (`REQ-001`, `REQ-106`):** MIT licensing allows any agent developer, AI provider, or enterprise to embed the 16ane Python/TypeScript SDKs, verify contracts, and self-host the reference facilitator/indexer without copyleft contagion concerns.
- **Trademark separation:** Granting an MIT copyright license to the source code does not grant permission to use the `16ane` name, logo (`assets/16ane_logo.png`), or branding to misrepresent an unofficial token as endorsed by 16ane or backed by INR (`REQ-012`).
- **Supply-chain security (`E11`):** Dependencies must use permissive licenses (`MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `CC0-1.0`) and pinned lockfiles (`foundry.lock`, `package-lock.json`, `uv.lock` / `requirements.lock`), with SHA-pinned GitHub Actions in CI.

## Decision
Adopt **Option A**:
1. **Code & Smart Contracts License:** Commit root `LICENSE` under the **MIT License** covering all smart contracts, SDKs, CLI, facilitator, and demo services.
2. **Documentation & Specifications:** Licensed under MIT (with optional attribution) so protocol schemas (`16ane-service-manifest`, receipt schemas) can be freely implemented by third parties.
3. **Trademark & No-Endorsement Policy (`TRADEMARK.md` / `CONTRIBUTING.md`):**
   - Explicitly reserve the `16ane` wordmark and logo (`assets/16ane_logo.png`).
   - Prohibit any fork or third-party deployment from claiming official 16ane endorsement or representing `tANE` as having monetary value.
4. **Contributor Governance (`CONTRIBUTING.md`, `SECURITY.md`):**
   - Inbound=Outbound (contributions submitted under MIT).
   - Mandatory `.gitleaks.toml` pre-commit check, `scripts/check-committed-files.sh` hygiene gate, and security disclosure instructions (`SECURITY.md` + `web/.well-known/security.txt`, adapted from `copra`).

## Consequences
- Aligns licensing across `copra` and `16ane-agent-economy`, allowing direct legal reuse of `copra` scripts, CI workflows, and contract patterns under MIT.
- Unblocks external developer and hackathon contributions (`VISION.md` persona #4).

## Alternatives rejected
- **Option B (GPL/AGPL):** Discourages commercial AI providers and agent framework authors from integrating the Python/TS SDKs.
- **Option C (Proprietary / BSL):** Contradicts the open agent economy principles in `README.md`.

## Open risks
- Unofficial forks reusing the `16ane` logo; mitigated by explicit trademark reservation in `LICENSE-NOTE.md` / `CONTRIBUTING.md` and domain/contract verification via `AneRegistry`.

## Validation plan
- Commit `LICENSE`, `CONTRIBUTING.md`, and `SECURITY.md` once Phase 0 ADRs are approved, and verify dependency licenses in CI.
