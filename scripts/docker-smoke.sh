#!/usr/bin/env bash
# End-to-end check of the sandbox server's Docker image (ADR-0016, #74): deploy the contracts to a local Anvil
# chain, run the image with only environment settings, and check /healthz, a gasless faucet claim landing on
# chain for an address with no ETH, the cooldown (429), the x402 quote (402) and a clean SIGTERM shutdown.
#   scripts/docker-smoke.sh [image]        (default image: 16ane-sandbox:test, built by the caller)
# Needs docker, anvil, forge and cast. On Linux the container reaches Anvil through the host network; on
# Docker Desktop through host.docker.internal.
set -euo pipefail

IMAGE="${1:-16ane-sandbox:test}"
PORT="${ANVIL_PORT:-8591}"
API_PORT="${API_PORT:-18791}"
# Anvil's well-known account 0: a public test key, valid only on this throwaway chain.
KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
USER_ADDR=0x00000000000000000000000000000000000AbC01

if [[ "$(uname -s)" == "Linux" ]]; then
  NET=(--network host); RPC_FROM_CONTAINER="http://127.0.0.1:${PORT}"; API="http://127.0.0.1:8787"
else
  NET=(-p "127.0.0.1:${API_PORT}:8787"); RPC_FROM_CONTAINER="http://host.docker.internal:${PORT}"; API="http://127.0.0.1:${API_PORT}"
fi
RPC="http://127.0.0.1:${PORT}"

fail() { echo "FAIL: $*" >&2; exit 1; }
cleanup() {
  [[ -n "${CID:-}" ]] && docker rm -f "$CID" >/dev/null 2>&1 || true
  [[ -n "${ANVIL_PID:-}" ]] && kill "$ANVIL_PID" 2>/dev/null || true
}
trap cleanup EXIT

anvil --host 0.0.0.0 --port "$PORT" --chain-id 84532 --silent &
ANVIL_PID=$!
for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done

REGISTRY=$(PRIVATE_KEY=$KEY FOUNDRY_DISABLE_NIGHTLY_WARNING=1 forge script script/DeploySandbox.s.sol:DeploySandbox \
  --rpc-url "$RPC" --broadcast 2>&1 | grep -oE 'AneRegistry: *0x[0-9a-fA-F]{40}' | grep -oE '0x[0-9a-fA-F]{40}') \
  || fail "deploy did not print the registry address"

CID=$(docker run -d "${NET[@]}" -e ANE_RPC_URL="$RPC_FROM_CONTAINER" -e ANE_REGISTRY_ADDRESS="$REGISTRY" \
  -e ANE_RELAYER_PRIVATE_KEY="$KEY" "$IMAGE")
for _ in $(seq 1 60); do curl -sf "$API/healthz" >/dev/null && break; sleep 0.5; done
curl -sf "$API/healthz" | grep -q '"status":"ok"' || { docker logs "$CID"; fail "/healthz is not ok"; }

[[ "$(cast balance "$USER_ADDR" --rpc-url "$RPC")" == "0" ]] || fail "test address unexpectedly holds ETH"
claim=$(curl -s -X POST "$API/v1/faucet/claims" -H 'content-type: application/json' -d "{\"recipient\":\"$USER_ADDR\"}")
echo "$claim" | grep -q '"claimId"' || { docker logs "$CID"; fail "gasless claim failed: $claim"; }

TOKEN=$(cast call "$REGISTRY" 'getDeployment()(address,address,address,address,uint64,uint64)' --rpc-url "$RPC" | head -1)
balance=$(cast call "$TOKEN" 'balanceOf(address)(uint256)' "$USER_ADDR" --rpc-url "$RPC" | awk '{print $1}')
[[ "$balance" == "16000000000000000000000" ]] || fail "expected 16,000 tANE on chain, got $balance"
[[ "$(cast balance "$USER_ADDR" --rpc-url "$RPC")" == "0" ]] || fail "the user paid gas"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/v1/faucet/claims" -H 'content-type: application/json' -d "{\"recipient\":\"$USER_ADDR\"}")
[[ "$code" == "429" ]] || fail "expected 429 inside the cooldown, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/v1/demo/summarize" -H 'content-type: application/json' -d '{"text":"hi"}')
[[ "$code" == "402" ]] || fail "expected a 402 x402 quote, got $code"

docker stop -t 10 "$CID" >/dev/null
[[ "$(docker inspect "$CID" --format '{{.State.ExitCode}}')" == "0" ]] || fail "unclean shutdown"
docker logs "$CID" 2>&1 | grep -qE '0x[0-9a-fA-F]{64}' && fail "a 32-byte hex value (key?) appeared in the logs"

echo "PASS: image $IMAGE - healthz, gasless claim (16,000 tANE, user paid no gas), 429 cooldown, 402 quote, clean stop"
