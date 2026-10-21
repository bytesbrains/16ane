#!/usr/bin/env bash
# End-to-end check of the standalone facilitator and indexer images (#18): deploy the contracts to a
# local Anvil chain, run each image with only environment settings, and prove the acceptance criteria —
# the facilitator verifies and settles ane-vault-v1 and exact payments, the indexer follows
# AneServiceDirectory anchors — then state across a restart and a clean SIGTERM shutdown.
#   scripts/docker-smoke-standalone.sh [facilitator-image] [indexer-image]
# Needs docker, node, anvil, forge and cast. On Linux the containers reach Anvil through the host
# network; on Docker Desktop through host.docker.internal.
set -euo pipefail

FACILITATOR_IMAGE="${1:-16ane-facilitator:test}"
INDEXER_IMAGE="${2:-16ane-indexer:test}"
PORT="${ANVIL_PORT:-8592}"
FACILITATOR_PORT="${FACILITATOR_PORT:-18792}"
INDEXER_PORT="${INDEXER_PORT:-18793}"
# Anvil's well-known account 0: a public test key, valid only on this throwaway chain.
KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

if [[ "$(uname -s)" == "Linux" ]]; then
  FAC_NET=(--network host); INDEX_NET=(--network host)
  RPC_FROM_CONTAINER="http://127.0.0.1:${PORT}"
  FACILITATOR_API="http://127.0.0.1:8788"; INDEXER_API="http://127.0.0.1:8789"
else
  FAC_NET=(-p "127.0.0.1:${FACILITATOR_PORT}:8788"); INDEX_NET=(-p "127.0.0.1:${INDEXER_PORT}:8789")
  RPC_FROM_CONTAINER="http://host.docker.internal:${PORT}"
  FACILITATOR_API="http://127.0.0.1:${FACILITATOR_PORT}"; INDEXER_API="http://127.0.0.1:${INDEXER_PORT}"
fi
RPC="http://127.0.0.1:${PORT}"

fail() { echo "FAIL: $*" >&2; exit 1; }
cleanup() {
  [[ -n "${FAC_CID:-}" ]] && docker rm -f "$FAC_CID" >/dev/null 2>&1 || true
  [[ -n "${IDX_CID:-}" ]] && docker rm -f "$IDX_CID" >/dev/null 2>&1 || true
  [[ -n "${ANVIL_PID:-}" ]] && kill "$ANVIL_PID" 2>/dev/null || true
}
trap cleanup EXIT

anvil --host 0.0.0.0 --port "$PORT" --chain-id 84532 --silent &
ANVIL_PID=$!
for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done

REGISTRY=$(PRIVATE_KEY=$KEY FOUNDRY_DISABLE_NIGHTLY_WARNING=1 forge script script/DeploySandbox.s.sol:DeploySandbox \
  --rpc-url "$RPC" --broadcast 2>&1 | grep -oE 'AneRegistry: *0x[0-9a-fA-F]{40}' | grep -oE '0x[0-9a-fA-F]{40}') \
  || fail "deploy did not print the registry address"

FAC_CID=$(docker run -d "${FAC_NET[@]}" -e ANE_RPC_URL="$RPC_FROM_CONTAINER" -e ANE_REGISTRY_ADDRESS="$REGISTRY" \
  -e ANE_RELAYER_PRIVATE_KEY="$KEY" "$FACILITATOR_IMAGE")
IDX_CID=$(docker run -d "${INDEX_NET[@]}" -e ANE_RPC_URL="$RPC_FROM_CONTAINER" -e ANE_REGISTRY_ADDRESS="$REGISTRY" \
  -e ANE_INDEX_FROM_BLOCK=0 "$INDEXER_IMAGE")
for _ in $(seq 1 60); do curl -sf "$FACILITATOR_API/healthz" >/dev/null && break; sleep 0.5; done
for _ in $(seq 1 60); do curl -sf "$INDEXER_API/healthz" >/dev/null && break; sleep 0.5; done
curl -sf "$FACILITATOR_API/healthz" | grep -q '"status":"ok"' || { docker logs "$FAC_CID"; fail "facilitator /healthz is not ok"; }
curl -sf "$INDEXER_API/healthz" | grep -q '"status":"ok"' || { docker logs "$IDX_CID"; fail "indexer /healthz is not ok"; }

export RPC_URL="$RPC" REGISTRY_ADDRESS="$REGISTRY" OWNER_KEY="$KEY"
export FACILITATOR_URL="$FACILITATOR_API" INDEXER_URL="$INDEXER_API"
node --experimental-strip-types scripts/smoke-standalone.ts || fail "standalone acceptance failed"

# State survives a container restart (#75): the indexer still lists the anchor without rescanning from
# scratch, and both services keep serving (fresh payments, so rerunning the acceptance is safe).
docker restart -t 10 "$FAC_CID" "$IDX_CID" >/dev/null
for _ in $(seq 1 60); do curl -sf "$FACILITATOR_API/healthz" >/dev/null && break; sleep 0.5; done
for _ in $(seq 1 60); do curl -sf "$INDEXER_API/healthz" >/dev/null && break; sleep 0.5; done
curl -sf "$INDEXER_API/v1/services" | grep -q '"status":"PAUSED"' || fail "the anchor was lost on restart"
node --experimental-strip-types scripts/smoke-standalone.ts || fail "standalone acceptance failed after restart"

docker stop -t 10 "$FAC_CID" "$IDX_CID" >/dev/null
[[ "$(docker inspect "$FAC_CID" --format '{{.State.ExitCode}}')" == "0" ]] || fail "facilitator shutdown was unclean"
[[ "$(docker inspect "$IDX_CID" --format '{{.State.ExitCode}}')" == "0" ]] || fail "indexer shutdown was unclean"
docker logs "$FAC_CID" 2>&1 | grep -qE '0x[0-9a-fA-F]{64}' && fail "a 32-byte hex value (key?) appeared in the facilitator logs"
docker logs "$IDX_CID" 2>&1 | grep -qE '0x[0-9a-fA-F]{64}' && fail "a 32-byte hex value (key?) appeared in the indexer logs"

echo "PASS: $FACILITATOR_IMAGE + $INDEXER_IMAGE - verify/settle ane-vault-v1 and exact, anchor indexing, state kept across restart, clean stop"
