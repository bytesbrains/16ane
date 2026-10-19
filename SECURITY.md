# Security Policy

16ane Protocol treats smart contract, agent wallet, and payment protocol security as the highest priority.

## Supported Versions

| Version | Environment | Supported |
| ------- | ----------- | --------- |
| 0.1.x   | Sandbox code targeting Base Sepolia (`eip155:84532`); not yet deployed | Yes |

## Reporting a Vulnerability

If you discover a security vulnerability within 16ane smart contracts, SDKs, facilitator, or infrastructure, please do NOT disclose it publicly on GitHub issues or social media.

Please report vulnerabilities directly via:
- **GitHub private vulnerability reporting**: open the [Security tab](https://github.com/bytesbrains/16ane/security) and click **Report a vulnerability**, or go straight to the [advisory form](https://github.com/bytesbrains/16ane/security/advisories/new).
- **Email**: [security@16ane.com](mailto:security@16ane.com), if you can't use GitHub or the button is not available. Don't put vulnerability details in a public issue.

Please include:
1. Detailed description of the vulnerability and affected component (`tANE`, `AneAgentVault`, `AneFaucet`, SDK, facilitator, or web UI).
2. Steps or proof-of-concept (PoC) Foundry test / script to reproduce the issue.
3. Potential impact and severity assessment against the invariants in `AGENTS.md` and `docs/security/THREAT_MODEL.md`.

## Vulnerability Handling Process

1. **Acknowledgment**: Maintainers aim to acknowledge reports within 3 business days.
2. **Investigation**: Maintainers verify and validate the issue, and keep the reporter updated in the advisory thread.
3. **Mitigation**: A fix is prepared, tested in an isolated environment, and deployed.
4. **Disclosure**: Coordinated public disclosure after mitigations are live.
