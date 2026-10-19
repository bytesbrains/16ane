# Contributing to 16ane Protocol

Thank you for your interest in contributing to **16ane — Open Agent Economy** ([16ane.com](https://16ane.com)).

Before contributing, please read [AGENTS.md](AGENTS.md), [README.md](README.md), and the Architecture Decision Records in [docs/decisions/](docs/decisions/).

## Core Invariants for All Contributions

1. **`tANE` Has Zero Monetary Value (`REQ-012`):** Never describe `tANE` as ₹-backed, redeemable, investable, or convertible to `ANE`. Every user-facing balance, quote, or CLI output must preserve the no-cash-value disclosure.
2. **Contract-Enforced Agent Budgets (`REQ-004`, `ADR-0003`, `ADR-0004`):** Spending limits must be enforced by on-chain contract state (`AneAgentVault`), never by LLM prompts alone. Incoming revenue must never increase spend authority in `FIXED` budget mode.
3. **Zero Secret Leakage (`AGENTS.md`, `ADR-0010`):** Never embed or log private keys in source files, tests, prompts, error stack traces, or MCP outputs.
4. **Permissionless Core Transfers (`REQ-001`):** Never introduce transfer pauses, blacklists, or mandatory hosted dependencies for core `tANE` transfers or verification.

## Development Setup

1. **Clone the repository**:
   ```bash
   git clone --recurse-submodules https://github.com/bytesbrains/16ane-agent-economy.git
   cd 16ane-agent-economy
   ```

2. **Enable git hooks** (`.githooks/`):
   ```bash
   scripts/setup_hooks.sh
   ```
   - `pre-commit`: runs `gitleaks protect --config .gitleaks.toml --staged` and `forge fmt --check`.
   - `pre-push`: runs `scripts/check-committed-files.sh` and `forge test`.

3. **Build and test**:
   ```bash
   make build
   make test
   make lint
   ```

## Pull Request Guidelines

1. **Branching**: Create feature branches off `main` referencing the issue ID (e.g., `feat/iss-005-tane-token`).
2. **Traceability**: Reference the governing `REQ-*`, `ADR-*`, and `ISS-*` IDs in your PR description.
3. **Testing**: Include unit, fuzz, and negative/adversarial tests (`docs/security/THREAT_MODEL.md`) for all contract and SDK changes.
4. **Licensing**: By submitting a contribution, you agree that your contribution is licensed under the repository's [MIT License](LICENSE) (`ADR-0013`).
