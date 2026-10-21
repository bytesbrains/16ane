# Standalone x402 facilitator (ADR-0005, #18): /verify, /settle and /supported for the ane-vault-v1
# and exact schemes. Build from the repo root — the SDK and the shared server modules ride along:
#   docker build -f services/facilitator/Dockerfile -t 16ane-facilitator .
#   docker run --rm -p 127.0.0.1:8788:8788 -e ANE_RPC_URL=... -e ANE_REGISTRY_ADDRESS=0x... \
#     -e ANE_RELAYER_PRIVATE_KEY=0x... 16ane-facilitator
# It holds no secrets: the relayer key comes from the environment at run time.
# The server listens on 0.0.0.0 inside the container; who can reach it is decided by how you publish
# the port (docs/operations/SELF_HOSTING.md).

# --- Foundry's `cast` (the SDK sends settlements with it), pinned and checksum-verified per architecture.
FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS foundry
ARG TARGETARCH
ARG FOUNDRY_VERSION=v1.7.1
ARG FOUNDRY_SHA256_amd64=cf7e688ed0c4c48adffca788b496076e31060b67ac5afe1e43dbb5499c20c88b
ARG FOUNDRY_SHA256_arm64=c8fe8fa09ae3aba2c81b510c6f9da3a9d468029b9580e690b245b3f0aea687ae
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) sum="${FOUNDRY_SHA256_amd64}" ;; \
      arm64) sum="${FOUNDRY_SHA256_arm64}" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_linux_${TARGETARCH}.tar.gz"; \
    node -e 'fetch(process.argv[1]).then(async r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); require("fs").writeFileSync("/tmp/foundry.tgz", Buffer.from(await r.arrayBuffer())); })' "$url"; \
    echo "${sum}  /tmp/foundry.tgz" | sha256sum -c -; \
    mkdir -p /opt/foundry; \
    tar -xzf /tmp/foundry.tgz -C /opt/foundry cast; \
    /opt/foundry/cast --version

# --- Runtime: Node 24 + cast + the facilitator, SDK and shared server modules. No npm dependencies.
FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
# cast's HTTP client needs a CA store, even for plain-http RPC URLs; without it every send fails.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=foundry /opt/foundry/cast /usr/local/bin/cast
WORKDIR /app
COPY --chown=root:root packages/sdk-ts/src packages/sdk-ts/src
COPY --chown=root:root services/sandbox-server/src services/sandbox-server/src
COPY --chown=root:root services/facilitator/src services/facilitator/src
# State (consumed payment proofs, receipts, gas spend) lives in SQLite under /data, the mount point
# for a persistent volume. Without a volume it survives restarts but not re-creation.
RUN mkdir -p /data && chown node:node /data
# Cap V8 below small-box RAM (see the root Dockerfile): with a cap V8 collects instead of letting
# the kernel OOM-kill the process. Big-box self-hosters can raise it.
ENV NODE_ENV=production \
    ANE_HOST=0.0.0.0 \
    ANE_PORT=8788 \
    ANE_STATE_PATH=/data/facilitator.sqlite \
    FOUNDRY_DISABLE_NIGHTLY_WARNING=1 \
    NODE_OPTIONS=--max-old-space-size=192
USER node
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.ANE_PORT}/healthz`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "services/facilitator/src/main.ts"]
