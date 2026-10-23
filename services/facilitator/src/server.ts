import http from "node:http";
import {
  type AneClient,
  AnePaymentVerifier,
  SANDBOX_DISCLAIMER,
  type KeyValueStore,
  MemoryKeyValueStore,
  type SecretKey,
} from "../../../packages/sdk-ts/src/index.ts";
import { DEFAULT_MAX_BODY_BYTES, sendError, sendJson } from "../../sandbox-server/src/http.ts";
import {
  createRelayerClient,
  fetchRelayerHealth,
  sendServerError,
} from "../../sandbox-server/src/service-shared.ts";
import { handleSettle, handleVerify, supportedBody, type FacilitatorContext } from "./facilitator.ts";

export interface FacilitatorServerConfig {
  port?: number;
  /** Address to listen on; "0.0.0.0" in a container. Defaults to 127.0.0.1. */
  host?: string;
  /** State that must survive restarts (#75): consumed proofs, receipts, gas spend. Defaults to memory. */
  store?: KeyValueStore;
  /** Most the relayer may spend on gas per UTC day (#76). Defaults to 0.05 ETH (ADR-0006). */
  relayerGasBudgetWei?: bigint;
  /** The relayer's maxFeePerGas ceiling (ADR-0006): no settle while the gas price is above it. */
  relayerMaxFeeWei?: bigint;
  rpcUrl: string;
  chainId?: number;
  registryAddress: string;
  relayerPrivateKey: string | SecretKey;
  maxBodyBytes?: number;
}

export async function createFacilitatorServer(config: FacilitatorServerConfig): Promise<{
  server: http.Server;
  url: string;
  port: number;
  client: AneClient;
  verifier: AnePaymentVerifier;
  relayerAddress: string;
  close: () => Promise<void>;
}> {
  const chainId = config.chainId ?? 84532;
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const store = config.store ?? new MemoryKeyValueStore();
  const { client, gasBudget, relayerKey, relayerAddress } = createRelayerClient({
    rpcUrl: config.rpcUrl,
    chainId,
    registryAddress: config.registryAddress,
    relayerPrivateKey: config.relayerPrivateKey,
    store,
    relayerGasBudgetWei: config.relayerGasBudgetWei,
  });
  const contracts = await client.resolveContracts();
  const verifier = new AnePaymentVerifier({ client, relayerKey, store });
  const ctx: FacilitatorContext = {
    client,
    verifier,
    contracts,
    relayerAddress,
    gasBudget,
    maxFeeWei: config.relayerMaxFeeWei,
    maxBodyBytes,
  };

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? "127.0.0.1";
      const fullUrl = new URL(req.url ?? "/", `http://${host}`);
      const pathname = fullUrl.pathname;
      const method = (req.method ?? "GET").toUpperCase();

      if (method === "GET" && pathname === "/healthz") {
        try {
          const health = await fetchRelayerHealth(client, gasBudget, relayerAddress);
          sendJson(res, 200, {
            status: "ok",
            chainId,
            registry: contracts.registry,
            ...health,
            disclaimer: SANDBOX_DISCLAIMER,
          });
        } catch {
          sendJson(res, 503, { status: "unavailable", reason: "RPC not reachable", disclaimer: SANDBOX_DISCLAIMER });
        }
        return;
      }

      if (method === "GET" && pathname === "/supported") {
        sendJson(res, 200, supportedBody(ctx));
        return;
      }

      if (method === "POST" && pathname === "/verify") {
        await handleVerify(ctx, req, res);
        return;
      }

      if (method === "POST" && pathname === "/settle") {
        await handleSettle(ctx, req, res);
        return;
      }

      if (method === "GET" && pathname.startsWith("/v1/payments/")) {
        const id = pathname.slice("/v1/payments/".length);
        const receipt = verifier.getReceipt(id);
        if (!receipt) {
          sendError(res, 404, "ANE-E-4012", `Receipt ${id} not found`, false);
          return;
        }
        sendJson(res, 200, receipt);
        return;
      }

      sendError(res, 404, "ANE-E-4040", `Route not found: ${method} ${pathname}`, false);
    } catch (err) {
      sendServerError(res, err, "settle the payment yourself with your own gas");
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(config.port ?? 0, config.host ?? "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : (config.port ?? 8788);
  const url = `http://127.0.0.1:${actualPort}`;

  return {
    server,
    url,
    port: actualPort,
    client,
    verifier,
    relayerAddress,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
