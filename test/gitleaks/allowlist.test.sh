#!/usr/bin/env bash
# Guards the EVM-address rule in .gitleaks.toml: public 20-byte addresses must pass, while a
# 32-byte private key in the same position must still be caught. Fixtures are generated at
# runtime so no key-shaped string is ever committed.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

scan() { gitleaks detect --no-git --no-banner --config "${ROOT_DIR}/.gitleaks.toml" --source "$1" >/dev/null 2>&1; }

mkdir -p "${WORK}/address" "${WORK}/key"
printf 'const CONTRACTS = {\n  token: "0x%s",\n};\n' "$(openssl rand -hex 20)" > "${WORK}/address/app.js"
printf 'const cfg = {\n  token: "0x%s",\n};\n' "$(openssl rand -hex 32)" > "${WORK}/key/app.js"

if ! scan "${WORK}/address"; then
    echo "FAIL: a public contract address was flagged as a secret"
    exit 1
fi
if scan "${WORK}/key"; then
    echo "FAIL: a 32-byte private key was NOT flagged (is the address allowlist regex still anchored?)"
    exit 1
fi
echo "PASS: gitleaks allows contract addresses and still catches private keys"
