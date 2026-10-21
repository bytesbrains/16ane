import http from "node:http";
import {
  AneClient,
  AnePaymentVerifier,
  privateKeyToAddress,
  SANDBOX_DISCLAIMER,
  SecretKey,
  type KeyValueStore,
  MemoryKeyValueStore,
} from "../../../packages/sdk-ts/src/index.ts";
import {
  DEFAULT_RELAYER_GAS_BUDGET_WEI,
  type GasReservation,
  RelayerGasBudget,
  RelayerGasBudgetExceededError,
  sendBudgetExhausted,
} from "../../sandbox-server/src/gas-budget.ts";
import {
  DEFAULT_MAX_BODY_BYTES,
  PayloadTooLargeError,
  sendError,
  sendJson,
  sendLoggedError,
} from "../../sandbox-server/src/http.ts";
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
  const relayerKey =
    config.relayerPrivateKey instanceof SecretKey
      ? config.relayerPrivateKey
      : new SecretKey(config.relayerPrivateKey);
  const relayerAddress = privateKeyToAddress(relayerKey);
  const store = config.store ?? new MemoryKeyValueStore();
  // Every settlement the relayer pays for reserves gas from its daily budget before it is sent,
  // and is counted at its actual fee once mined. The only limit on this path is cost (#61).
  const gasBudget = new RelayerGasBudget(store, config.relayerGasBudgetWei ?? DEFAULT_RELAYER_GAS_BUDGET_WEI);
  const client = new AneClient({
    rpcUrl: config.rpcUrl,
    chainId,
    registryAddress: config.registryAddress,
    sendHooks: {
      before: (from) => (from === relayerAddress ? gasBudget.reserve() : undefined),
      after: (_from, feeWei, _txHash, ticket) => {
        if (ticket) gasBudget.settle(ticket as GasReservation, feeWei);
      },
      failed: (_from, ticket) => {
        if (ticket) gasBudget.release(ticket as GasReservation);
      },
    },
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
          const blockHex = await client.rpcCall<string>("eth_blockNumber", []);
          const balanceWei = BigInt(await client.rpcCall<string>("eth_getBalance", [relayerAddress, "latest"]));
          sendJson(res, 200, {
            status: "ok",
            chainId,
            registry: contracts.registry,
            blockNumber: Number(BigInt(blockHex)),
            relayer: {
              address: relayerAddress,
              balanceWei: balanceWei.toString(),
              dailyGasBudgetWei: gasBudget.dailyBudgetWei.toString(),
              spentTodayWei: gasBudget.spentTodayWei().toString(),
              reservedTodayWei: gasBudget.reservedTodayWei().toString(),
              remainingTodayWei: gasBudget.remainingTodayWei().toString(),
              lowBalance: gasBudget.isLowBalance(balanceWei),
            },
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
      if (err instanceof PayloadTooLargeError) {
        res.setHeader("connection", "close");
        sendError(res, 413, "ANE-E-4130", err.message, false);
        return;
      }
      if (err instanceof RelayerGasBudgetExceededError) {
        sendBudgetExhausted(res, err, "settle the payment yourself with your own gas");
        return;
      }
      // JSON.parse and BigInt throw SyntaxError on malformed client input; their messages only echo that input.
      if (err instanceof SyntaxError) {
        sendError(res, 400, "ANE-E-4000", `Malformed request body: ${err.message}`, false);
        return;
      }
      sendLoggedError(res, 500, "ANE-E-5000", "Internal server error", true, err);
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
