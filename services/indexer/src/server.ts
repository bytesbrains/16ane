import http from "node:http";
import {
  AneClient,
  SANDBOX_DISCLAIMER,
  type KeyValueStore,
  MemoryKeyValueStore,
} from "../../../packages/sdk-ts/src/index.ts";
import { sendError, sendJson, sendLoggedError } from "../../sandbox-server/src/http.ts";
import { ServiceDirectoryIndexer, type AnchorStatus } from "./indexer.ts";

export interface IndexerServerConfig {
  port?: number;
  /** Address to listen on; "0.0.0.0" in a container. Defaults to 127.0.0.1. */
  host?: string;
  /** The anchor set and scan cursor (#75). Defaults to memory. */
  store?: KeyValueStore;
  rpcUrl: string;
  chainId?: number;
  registryAddress: string;
  /** First scan starts here on a fresh store: a block number, "latest" (no backfill) or "earliest". */
  fromBlock?: number | "latest" | "earliest";
  /** Milliseconds between scans. Defaults to 5000. */
  pollMs?: number;
  /** Most blocks per eth_getLogs call. Defaults to 2000. */
  maxRange?: number;
  maxBodyBytes?: number;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const STATUSES: AnchorStatus[] = ["ACTIVE", "PAUSED", "DEPRECATED", "NONE"];

export async function createIndexerServer(config: IndexerServerConfig): Promise<{
  server: http.Server;
  url: string;
  port: number;
  client: AneClient;
  indexer: ServiceDirectoryIndexer;
  close: () => Promise<void>;
}> {
  const chainId = config.chainId ?? 84532;
  const store = config.store ?? new MemoryKeyValueStore();
  const client = new AneClient({ rpcUrl: config.rpcUrl, chainId, registryAddress: config.registryAddress });
  const contracts = await client.resolveContracts();
  const indexer = new ServiceDirectoryIndexer(client, contracts.aneServiceDirectory, store, {
    fromBlock: config.fromBlock,
    pollMs: config.pollMs,
    maxRange: config.maxRange,
  });

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? "127.0.0.1";
      const fullUrl = new URL(req.url ?? "/", `http://${host}`);
      const pathname = fullUrl.pathname;
      const method = (req.method ?? "GET").toUpperCase();

      if (method === "GET" && pathname === "/healthz") {
        try {
          const latest = Number(BigInt(await client.rpcCall<string>("eth_blockNumber", [])));
          sendJson(res, 200, {
            status: "ok",
            chainId,
            directory: contracts.aneServiceDirectory,
            latestBlock: latest,
            lastScannedBlock: indexer.lastScannedBlock ?? null,
            services: indexer.listAnchors().length,
            lastScanAt: indexer.lastScanAt ?? null,
            ...(indexer.lastError === undefined ? {} : { lastError: indexer.lastError }),
            disclaimer: SANDBOX_DISCLAIMER,
          });
        } catch {
          sendJson(res, 503, { status: "unavailable", reason: "RPC not reachable", disclaimer: SANDBOX_DISCLAIMER });
        }
        return;
      }

      if (method === "GET" && pathname === "/v1/services") {
        const provider = fullUrl.searchParams.get("provider") ?? undefined;
        const status = fullUrl.searchParams.get("status") ?? undefined;
        if (provider !== undefined && !ADDRESS.test(provider)) {
          sendError(res, 400, "ANE-E-4001", "provider must be an address", false);
          return;
        }
        if (status !== undefined && !(STATUSES as string[]).includes(status)) {
          sendError(res, 400, "ANE-E-4001", `status must be one of ${STATUSES.join(", ")}`, false);
          return;
        }
        sendJson(res, 200, {
          services: indexer.listAnchors({
            ...(provider === undefined ? {} : { provider }),
            ...(status === undefined ? {} : { status: status as AnchorStatus }),
          }),
          disclaimer: SANDBOX_DISCLAIMER,
        });
        return;
      }

      if (method === "GET" && pathname.startsWith("/v1/services/")) {
        const serviceIdHash = pathname.slice("/v1/services/".length);
        if (!BYTES32.test(serviceIdHash)) {
          sendError(res, 400, "ANE-E-4001", "service id hash must be 32 bytes of hex", false);
          return;
        }
        const anchor = indexer.getAnchor(serviceIdHash);
        if (!anchor) {
          sendError(res, 404, "ANE-E-4020", `Service ${serviceIdHash} is not anchored`, false);
          return;
        }
        sendJson(res, 200, { ...anchor, disclaimer: SANDBOX_DISCLAIMER });
        return;
      }

      sendError(res, 404, "ANE-E-4040", `Route not found: ${method} ${pathname}`, false);
    } catch (err) {
      sendLoggedError(res, 500, "ANE-E-5000", "Internal server error", true, err);
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(config.port ?? 0, config.host ?? "127.0.0.1", () => resolve());
  });
  indexer.start();

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : (config.port ?? 8789);
  const url = `http://127.0.0.1:${actualPort}`;

  return {
    server,
    url,
    port: actualPort,
    client,
    indexer,
    close: async () => {
      await indexer.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
