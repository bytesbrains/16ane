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
- **Sandbox contracts deployed to Base Sepolia** (2026-10-20, from `e43ccc8`): registry `0x01d5daB670DE5868305eB862721ebE62772C3Df3`; all addresses in `networks/sandbox-sepolia.json`. All six contracts, including the `AneAgentVault` implementation, are source-verified on Basescan.
- Sandbox server runs on its own and in Docker (ADR-0016, #73, #74): start command configured from `ANE_*` environment variables, configurable listen address, `GET /healthz`, graceful shutdown; a portable multi-arch image (Node 24, checksum-pinned Foundry `cast`, non-root, no secrets) with an end-to-end CI check (`scripts/docker-smoke.sh`); self-hosting guide `docs/operations/SELF_HOSTING.md`.
- Base Sepolia deployment runbook (`docs/operations/DEPLOY_SANDBOX.md`) and an end-to-end smoke test for a deployed sandbox (`scripts/smoke-sandbox.ts`, also run by the E2E suite). `DeploySandbox.s.sol` can sign from an encrypted Foundry keystore (`--account`), so the deployer key need not be in the environment.
- Git hooks: gitleaks and `forge fmt` before commit; gitleaks, committed-file hygiene and `forge test` before push.
- Brand images in use: the README banner (`assets/16ane_social_preview.png`), link previews for 16ane.com (Open Graph and X/Twitter tags with `web/og-image.png`), the logo on the Python SDK's README, and homepage, source and issue links in the Python and TypeScript package metadata.
- Community files: `LICENSE` (MIT), `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), issue and PR templates, `CODEOWNERS`.

### Changed
- Faucet and relayer limits sized for agent-speed use (#61): faucet defaults 16,000 tANE per claim, 1 hour cooldown per recipient, 160 M tANE per day (were 1,600 / 24 h / 1.6 M); ADR-0006, ADR-0008 and ADR-0010 amended so the payment path carries no protocol rate limits or count caps, and operator-paid resources are limited by cost only.
- tANE described as the shared sandbox currency across platforms: providers can price sandbox, demo and introductory/offer-credit tiers in tANE, and agents pay every participating provider from one balance (README, VISION, TOKENOMICS, SANDBOX_AND_CREDITS, 16ane.com). No change to tANE's no-value status.

### Fixed
- SDK transactions no longer fail on public load-balanced RPCs right after a previous transaction confirms: `sendContractTx` retries "nonce too low" and "replacement transaction underpriced", which mean the transaction was rejected and never broadcast. The deployment smoke test waits for its own writes to become visible before reading them.

### Security
- SDK: private keys no longer appear in `cast`'s process arguments (#67). Each `sendContractTx` writes the key as a temporary encrypted V3 keystore (scrypt, aes-128-ctr) with a random password in a private temporary directory, passes it to `cast` as `ETH_KEYSTORE` / `ETH_PASSWORD`, and deletes it afterwards. The CLI, which reads keys from `ANE_*_PRIVATE_KEY`, gets this through the SDK.
- SDK: contract arguments passed to `sendContractTx` can no longer be read by `cast` as options. A value such as `--value=1ether` used to make `cast` send ETH from the signer; `--` now ends the option list before the target and its arguments.
- Sandbox server: request bodies capped at 1 MiB, trial quota keyed on the connection address, and `X-Forwarded-For` trusted only with `trustProxy` (#31).
- Sandbox server: error responses no longer echo internal error text, which could include the RPC URL and the `cast send` command line (#52). Failures that may carry internal detail return a fixed message and an `errorId`; the detail is logged server-side with URLs redacted. A failed faucet claim is now `502` (was `429`), and a malformed JSON body is `400 ANE-E-4000` (was `500`).
