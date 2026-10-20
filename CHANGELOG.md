# Changelog

User-visible changes to this repository. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/) (see *Versions and releases* in [CONTRIBUTING.md](CONTRIBUTING.md)).

Nothing has been released yet: no version is tagged, and no package is published to npm or PyPI. Everything below is on `main` at version `0.1.0`. `tANE` is a free testnet token with no monetary value, and nothing here is deployed to a public network.

## [Unreleased]

### Added
- Planning specification: requirements, protocol docs, threat model, ADR-0001 to ADR-0015, traceability, proposed issues and launch-readiness gates.
- Solidity contracts in `src/`: `AneTestToken` (`tANE`), `AneAgentVault`, `AneVaultFactory`, `AneFaucet`, `AneRegistry` and `AneServiceDirectory`, with Foundry unit, fuzz and invariant tests and a Base Sepolia deployment script that CI runs as a dry run.
- TypeScript SDK `@16ane/sdk` (`packages/sdk-ts`, with its own README) and Python SDK `16ane-sdk` (`packages/sdk-py`, import `ane_sdk`).
- `ane` CLI (`packages/cli`).
- Reference sandbox server with an x402 payment flow, faucet and demo endpoints (`services/sandbox-server`). It runs locally and in the E2E suite only.
- E2E scenarios S1 to S6 and threat-model checks T1 to T10 (`e2e/`).
- `16ane.com` overview page served from Cloudflare Workers (`web/`, ADR-0015).
- CI: Foundry, TypeScript type-check, SDK, CLI, server and E2E tests; Python lint and packaging; Slither (medium and above); committed-file hygiene; gitleaks secret scan.
- Git hooks: gitleaks and `forge fmt` before commit; gitleaks, committed-file hygiene and `forge test` before push.
- Brand images in use: the README banner (`assets/16ane_social_preview.png`), link previews for 16ane.com (Open Graph and X/Twitter tags with `web/og-image.png`), the logo on the Python SDK's README, and homepage, source and issue links in the Python and TypeScript package metadata.
- Community files: `LICENSE` (MIT), `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), issue and PR templates, `CODEOWNERS`.

### Security
- Sandbox server: request bodies capped at 1 MiB, trial quota keyed on the connection address, and `X-Forwarded-For` trusted only with `trustProxy` (#31).
- Sandbox server: error responses no longer echo internal error text, which could include the RPC URL and the `cast send` command line (#52). Failures that may carry internal detail return a fixed message and an `errorId`; the detail is logged server-side with URLs redacted. A failed faucet claim is now `502` (was `429`), and a malformed JSON body is `400 ANE-E-4000` (was `500`).
