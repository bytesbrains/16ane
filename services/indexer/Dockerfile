# Standalone service-directory indexer (ADR-0007, #18): polls ServiceAnchored events and serves the
# anchor set at /v1/services. Build from the repo root — the SDK and the shared server modules ride along:
#   docker build -f services/indexer/Dockerfile -t 16ane-indexer .
#   docker run --rm -p 127.0.0.1:8789:8789 -e ANE_RPC_URL=... -e ANE_REGISTRY_ADDRESS=0x... 16ane-indexer
# Read-only: it needs no private keys at all.

# --- Runtime: Node 24 + the indexer, SDK and shared server modules. No npm dependencies, no cast.
FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
WORKDIR /app
COPY --chown=root:root packages/sdk-ts/src packages/sdk-ts/src
COPY --chown=root:root services/sandbox-server/src services/sandbox-server/src
COPY --chown=root:root services/indexer/src services/indexer/src
# State (the anchor set, the scan cursor) lives in SQLite under /data, the mount point for a
# persistent volume. Without a volume it survives restarts but not re-creation.
RUN mkdir -p /data && chown node:node /data
# Cap V8 below small-box RAM (see the root Dockerfile): with a cap V8 collects instead of letting
# the kernel OOM-kill the process. Big-box self-hosters can raise it.
ENV NODE_ENV=production \
    ANE_HOST=0.0.0.0 \
    ANE_PORT=8789 \
    ANE_STATE_PATH=/data/indexer.sqlite \
    NODE_OPTIONS=--max-old-space-size=192
USER node
EXPOSE 8789
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.ANE_PORT}/healthz`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "services/indexer/src/main.ts"]
