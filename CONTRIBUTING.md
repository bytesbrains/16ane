# Contributing to 16ane Protocol

Thank you for your interest in contributing to **16ane — Open Agent Economy** ([16ane.com](https://16ane.com)).

Before contributing, please read [AGENTS.md](AGENTS.md), [README.md](README.md), and the Architecture Decision Records in [docs/decisions/](docs/decisions/).

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Core Invariants for All Contributions

1. **`tANE` Has Zero Monetary Value (`REQ-012`):** Never describe `tANE` as ₹-backed, redeemable, investable, or convertible to `ANE`. Every user-facing balance, quote, or CLI output must preserve the no-cash-value disclosure.
2. **Contract-Enforced Agent Budgets (`REQ-004`, `ADR-0003`, `ADR-0004`):** Spending limits must be enforced by on-chain contract state (`AneAgentVault`), never by LLM prompts alone. Incoming revenue must never increase spend authority in `FIXED` budget mode.
3. **Zero Secret Leakage (`AGENTS.md`, `ADR-0010`):** Never embed or log private keys in source files, tests, prompts, error stack traces, or MCP outputs.
4. **Permissionless Core Transfers (`REQ-001`):** Never introduce transfer pauses, blacklists, or mandatory hosted dependencies for core `tANE` transfers or verification.

## Development Setup

1. **Clone the repository**:
   ```bash
   git clone --recurse-submodules https://github.com/bytesbrains/16ane.git
   cd 16ane
   ```

2. **Enable git hooks** (`.githooks/`):
   ```bash
   scripts/setup_hooks.sh
   ```
   - `pre-commit`: runs `gitleaks protect --config .gitleaks.toml --staged` and `forge fmt --check`.
   - `pre-push`: scans the commits being pushed with `gitleaks git`, then runs `scripts/check-committed-files.sh` and `forge test`. Unlike `pre-commit`, it refuses to push if `gitleaks` is not installed.
   - CI's *Gitleaks secret scan* job scans every pull request's commits, so a commit made with `--no-verify` is still caught.

3. **Build and test**:
   ```bash
   make build
   make test
   make lint
   ```

## Coverage

CI's *Coverage report and thresholds* job (`#55`) collects LCOV for every suite — `forge coverage` for
`src/`, Node's built-in test coverage for the TypeScript suites, `coverage.py` for `packages/sdk-py` —
and writes per-group and total line/branch coverage plus changed-line coverage to the run summary. The
job fails below the thresholds in `scripts/coverage-report.ts`, and uploads the `.lcov` files as the
`coverage` artifact. The report needs no extra permissions, so fork PRs get the same summary.

Run it locally the same way (needs `coverage.py` for your `python3`, same pin as CI):

```bash
pip install 'coverage==7.16.2'
npm run coverage   # or: make coverage
```

For per-suite runs: `npm run coverage:<suite>` with `suite` one of `contracts`, `sdk-ts`,
`sdk-py`, `cli`, `server`, `scripts`, `e2e` (each writes `coverage/<suite>.lcov`), then `npm run
coverage:report`. For changed-line coverage against your
branch point: `git diff -U0 main...HEAD > coverage/base.diff && npm run coverage:report -- --diff
coverage/base.diff`. `coverage/` is gitignored. Each `coverage:*` script runs exactly its `test:*`
twin's files — `test/scripts/package-coverage-sync.test.ts` fails if they drift apart.

## Pull Request Guidelines

1. **Branching**: Create feature branches off `main` referencing the issue ID (e.g., `feat/iss-005-tane-token`).
2. **Traceability**: Reference the governing `REQ-*`, `ADR-*`, and `ISS-*` IDs in your PR description.
3. **Testing**: Include unit, fuzz, and negative/adversarial tests (`docs/security/THREAT_MODEL.md`) for all contract and SDK changes.
4. **Licensing**: By submitting a contribution, you agree that your contribution is licensed under the repository's [MIT License](LICENSE) (`ADR-0013`).

## Versions and releases

- The project uses [Semantic Versioning](https://semver.org/). While the version is `0.x`, any release may contain breaking changes.
- Everything is at `0.1.0`: the root `package.json`, `@16ane/sdk` (`packages/sdk-ts`), `16ane-sdk` (`packages/sdk-py`) and the CLI. No version is tagged, and no package is published to npm or PyPI. Publishing is a separate maintainer decision.
- Record user-visible changes under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) in the same pull request.
- A release bumps every version above together, moves **Unreleased** to a dated version heading, and tags the merge commit `v<version>`.
- Pushing a `v<version>` tag on `main` publishes the Python SDK to PyPI as `16ane-sdk` (`.github/workflows/release-python.yml`). It uses PyPI Trusted Publishing, so no PyPI token is stored in GitHub; the workflow refuses a tag that is not on `main` or does not match `packages/sdk-py`'s version. The publish job then waits for a maintainer's approval in the `pypi` environment, which accepts only `v*` tags. `16ane-sdk 0.0.0` on PyPI is a code-free name placeholder. The TypeScript SDK name `@16ane/sdk` is protected by the `@16ane` npm organization and has no release workflow yet.
- The hosted sandbox API deploys from `sandbox-api-v*` tags, which are deployment markers, not version releases: pushing one on `main` runs `.github/workflows/release-api.yml` (Fly deploy, live smoke test, GitHub release). They need no version bump; see `docs/operations/DEPLOY_API.md`.
