# Reference sandbox server: gasless faucet, x402 demo API and directory (ADR-0016, #74).
# One portable image for the hosted service (Fly.io) and for self-hosting (#18). It holds no secrets: keys
# come from the environment at run time (see services/sandbox-server/src/main.ts).
#
#   docker build -t 16ane-sandbox .
#   docker run --rm -p 8787:8787 -e ANE_RPC_URL=... -e ANE_REGISTRY_ADDRESS=0x... \
#     -e ANE_RELAYER_PRIVATE_KEY=0x... 16ane-sandbox

# --- Foundry's `cast` (the SDK sends transactions with it), pinned and checksum-verified per architecture.
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

# --- Runtime: Node 24 + cast + the server and SDK source. No npm dependencies (built-in modules only).
FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
# cast's HTTP client needs a CA store, even for plain-http RPC URLs; without it every send fails.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=foundry /opt/foundry/cast /usr/local/bin/cast
WORKDIR /app
COPY --chown=root:root packages/sdk-ts/src packages/sdk-ts/src
COPY --chown=root:root services/sandbox-server/src services/sandbox-server/src
ENV NODE_ENV=production \
    ANE_HOST=0.0.0.0 \
    ANE_PORT=8787 \
    FOUNDRY_DISABLE_NIGHTLY_WARNING=1
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.ANE_PORT}/healthz`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "services/sandbox-server/src/main.ts"]
