import http from "node:http";
import {
  AneClient,
  AnePaymentVerifier,
  privateKeyToAddress,
  SANDBOX_DISCLAIMER,
  SecretKey,
  SponsoredQuotaEngine,
  toChecksumAddress,
  type KeyValueStore,
  MemoryKeyValueStore,
  type ServiceManifestPayload,
} from "../../../packages/sdk-ts/src/index.ts";
import {
  buildDefaultCampaignInput,
  campaignHealthView,
  campaignPublicView,
  DEFAULT_TRIAL_COST_BUDGET_MICROS,
  handleCampaignControl,
} from "./campaigns.ts";
import { buildDemoManifest, handleDemoRequest, isDemoRoute, type DemoContext } from "./demo.ts";
import { handleRelay, type RelayContext } from "./relay.ts";
import {
  type ClaimStatusRecord,
  type FaucetContext,
  handleFaucetClaim,
  readFaucetConfig,
  RecipientCooldowns,
  TurnstileVerifier,
} from "./faucet.ts";
import {
  DEFAULT_RELAYER_GAS_BUDGET_WEI,
  type GasReservation,
  RelayerGasBudget,
  RelayerGasBudgetExceededError,
  sendBudgetExhausted,
} from "./gas-budget.ts";
import {
  DEFAULT_MAX_BODY_BYTES,
  PayloadTooLargeError,
  readRequestBody,
  sendError,
  sendJson,
  sendLoggedError,
} from "./http.ts";
import { createSentryReporter, type SentryFetch } from "./sentry.ts";

export interface SandboxServerConfig {
  port?: number;
  /** Address to listen on; "0.0.0.0" in a container. Defaults to 127.0.0.1. */
  host?: string;
  /** State that must survive restarts (#75). Defaults to memory; main.ts passes SQLite. */
  store?: KeyValueStore;
  /** Most the relayer may spend on gas per UTC day (#76). Defaults to 0.05 ETH (ADR-0006). */
  relayerGasBudgetWei?: bigint;
  /** The relayer's maxFeePerGas ceiling (ADR-0006): no sponsored send while the gas price is above it. */
  relayerMaxFeeWei?: bigint;
  rpcUrl: string;
  chainId?: number;
  registryAddress: string;
  relayerPrivateKey: string | SecretKey;
  providerPrivateKey?: string | SecretKey;
  trialFreeCallsPerCaller?: number;
  trialGlobalDailyCap?: number;
  /** Lifetime sponsor compute ceiling for the demo campaign in USD micros (#16). Defaults to $20. */
  trialCostBudgetMicros?: bigint;
  /** Upstream cost pre-reserved per sponsored stub call; 0: the stubs sponsor no real compute. */
  trialEstimatedCostMicrosPerCall?: bigint;
  /** Per-request token ceiling for sponsored calls; 0 disables it. */
  trialMaxTokensPerRequest?: number;
  /** Demo paths where an exhausted trial rejects (429/503) instead of falling back to paid. */
  trialOnlyPaths?: string[];
  /** Honour X-Forwarded-For only when a trusted reverse proxy sets it. */
  trustProxy?: boolean;
  /** Header the platform's proxy sets to the client IP (e.g. "fly-client-ip"); overrides X-Forwarded-For. */
  clientIpHeader?: string;
  /** Accept faucet claims with no proof (#79). Only for local or private servers; off by default. */
  faucetOpenClaims?: boolean;
  /** Cloudflare Turnstile secret for the web faucet; unset turns the Turnstile path off (#79). */
  turnstileSecretKey?: string;
  /** Hostname the Turnstile widget runs on (e.g. "app.16ane.com"); tokens from other sites are refused. */
  turnstileExpectedHostname?: string;
  /** Overrides Cloudflare's siteverify endpoint; for tests. */
  turnstileSiteverifyUrl?: string;
  maxBodyBytes?: number;
  /**
   * Sentry DSN for scrubbed error events from sendLoggedError (#90). Unset means off (self-host
   * default). Posts directly to Sentry's envelope HTTP API — no npm dependency.
   */
  sentryDsn?: string;
  /** Overrides `fetch` for Sentry POSTs; for tests. */
  sentryFetch?: SentryFetch;
}

export type { ClaimStatusRecord } from "./faucet.ts";

export async function createSandboxServer(config: SandboxServerConfig): Promise<{
  server: http.Server;
  url: string;
  port: number;
  client: AneClient;
  verifier: AnePaymentVerifier;
  providerAddress: string;
  close: () => Promise<void>;
}> {
  const chainId = config.chainId ?? 84532;
  const trustProxy = config.trustProxy ?? false;
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const relayerKey =
    config.relayerPrivateKey instanceof SecretKey
      ? config.relayerPrivateKey
      : new SecretKey(config.relayerPrivateKey);
  const providerKey = config.providerPrivateKey
    ? config.providerPrivateKey instanceof SecretKey
      ? config.providerPrivateKey
      : new SecretKey(config.providerPrivateKey)
    : relayerKey;

  const providerAddress = privateKeyToAddress(providerKey);
  const relayerAddress = privateKeyToAddress(relayerKey);
  const store = config.store ?? new MemoryKeyValueStore();
  // Every transaction the relayer pays for (faucet claims, x402 settlements) reserves gas from its daily budget
  // before it is sent, and is counted at its actual fee once mined.
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
  const faucetConfig = await readFaucetConfig(client, contracts.aneFaucet);
  const verifier = new AnePaymentVerifier({ client, relayerKey, store });
  // Optional Sentry sink, created after the fallible chain reads above so a failed startup leaves
  // no state behind. It travels in each handler context (never a module global), so two servers in
  // one process can't cross-report; unset DSN keeps reporting off.
  const sentrySink = createSentryReporter(config.sentryDsn, config.sentryFetch);
  const relay: RelayContext = {
    client,
    relayerKey,
    relayerAddress,
    chainId,
    contracts,
    maxFeeWei: config.relayerMaxFeeWei,
    maxBodyBytes,
    inFlight: new Set(),
    loggedErrorSink: sentrySink,
  };
  const faucet: FaucetContext = {
    client,
    relayerKey,
    store,
    chainId,
    faucetAddress: contracts.aneFaucet,
    faucetConfig,
    cooldowns: new RecipientCooldowns(faucetConfig.cooldownSeconds, store),
    turnstile: config.turnstileSecretKey
      ? new TurnstileVerifier(config.turnstileSecretKey, {
          expectedHostname: config.turnstileExpectedHostname,
          siteverifyUrl: config.turnstileSiteverifyUrl,
        })
      : undefined,
    openClaims: config.faucetOpenClaims ?? false,
    trustProxy,
    clientIpHeader: config.clientIpHeader,
    maxBodyBytes,
    inFlight: new Set(),
    maxFeeWei: config.relayerMaxFeeWei,
    loggedErrorSink: sentrySink,
  };

  // Seeding keeps a stored pause latch: a restart never silently resumes a paused campaign (#16).
  const quotaEngine = new SponsoredQuotaEngine(store);
  quotaEngine.seedCampaign(
    buildDefaultCampaignInput({
      providerAddress,
      freeCallsPerCaller: config.trialFreeCallsPerCaller ?? 1,
      globalDailyCap: config.trialGlobalDailyCap ?? 50,
      costBudgetMicros: config.trialCostBudgetMicros ?? DEFAULT_TRIAL_COST_BUDGET_MICROS,
      estimatedCostMicrosPerCall: config.trialEstimatedCostMicrosPerCall ?? 0n,
      maxTokensPerRequest: config.trialMaxTokensPerRequest ?? 0,
      trialOnlyEndpoints: config.trialOnlyPaths ?? [],
    }),
  );

  const demo: DemoContext = {
    client,
    verifier,
    quotaEngine,
    providerKey,
    providerAddress,
    contracts,
    trustProxy,
    clientIpHeader: config.clientIpHeader,
    maxBodyBytes,
    loggedErrorSink: sentrySink,
  };

  const buildSignedManifest = (): ServiceManifestPayload => {
    const signed = client.signServiceManifest(
      buildDemoManifest(demo, chainId),
      providerKey,
      contracts.aneServiceDirectory,
    );
    store.set("directory.services", signed.serviceId, signed);
    return signed;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? "127.0.0.1";
      const protocol = "http";
      const fullUrl = new URL(req.url ?? "/", `${protocol}://${host}`);
      const pathname = fullUrl.pathname;
      const method = (req.method ?? "GET").toUpperCase();

      // 1. Service Discovery Manifest (/.well-known/16ane-service.json)
      if (method === "GET" && pathname === "/.well-known/16ane-service.json") {
        const manifest = buildSignedManifest();
        sendJson(res, 200, manifest);
        return;
      }

      // 2. Networks Metadata (/v1/networks)
      // Liveness and readiness for the container platform (ADR-0016): reports whether the RPC answers,
      // without exposing configuration beyond the public chain and registry.
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
            sponsored: {
              campaigns: quotaEngine.listCampaigns().map((c) => campaignHealthView(quotaEngine, c)),
            },
            disclaimer: SANDBOX_DISCLAIMER,
          });
        } catch {
          sendJson(res, 503, { status: "unavailable", reason: "RPC not reachable", disclaimer: SANDBOX_DISCLAIMER });
        }
        return;
      }

      if (method === "GET" && pathname === "/v1/networks") {
        sendJson(res, 200, {
          networks: [
            {
              id: "sandbox-sepolia",
              caip2: `eip155:${chainId}`,
              chainId,
              contracts,
              disclaimer: SANDBOX_DISCLAIMER,
            },
          ],
          disclaimer: SANDBOX_DISCLAIMER,
        });
        return;
      }

      // 3. Assets Metadata (/v1/assets)
      if (method === "GET" && pathname === "/v1/assets") {
        sendJson(res, 200, {
          assets: [
            {
              symbol: "tANE",
              name: "16ane Sandbox (NO CASH VALUE)",
              decimals: 18,
              address: contracts.aneTestToken,
              network: `eip155:${chainId}`,
              redeemable: false,
              cashValue: "0",
              historicalNote: "1 INR = 16 Annas (1 Anna = 1/16 Rupee = 6.25 paise)",
              disclaimer: SANDBOX_DISCLAIMER,
            },
          ],
          disclaimer: SANDBOX_DISCLAIMER,
        });
        return;
      }

      // 4. Faucet Claims (POST /v1/faucet/claims & GET /v1/faucet/claims/:id)
      if (method === "POST" && pathname === "/v1/relay") {
        await handleRelay(relay, req, res);
        return;
      }

      if (method === "POST" && pathname === "/v1/faucet/claims") {
        await handleFaucetClaim(faucet, req, res);
        return;
      }

      if (method === "GET" && pathname.startsWith("/v1/faucet/claims/")) {
        const claimId = pathname.slice("/v1/faucet/claims/".length);
        const record = store.get<ClaimStatusRecord>("faucet.claims", claimId);
        if (!record) {
          sendError(res, 404, "ANE-E-1005", `Faucet claim ${claimId} not found`, false);
          return;
        }
        sendJson(res, 200, record);
        return;
      }

      // 5. Wallet Balances (/v1/wallets/:address/balances)
      if (
        method === "GET" &&
        pathname.startsWith("/v1/wallets/") &&
        pathname.endsWith("/balances")
      ) {
        const rawAddr = pathname.slice(
          "/v1/wallets/".length,
          pathname.length - "/balances".length,
        );
        const address = toChecksumAddress(rawAddr);
        const balance = await client.getTokenBalance(address);
        let accounting: Record<string, string | number | boolean> | undefined;
        try {
          const summary = await client.getAccountingSummary(address);
          accounting = {
            owner: summary.owner,
            agentSigner: summary.agentSigner,
            tokenBalance: summary.tokenBalance.toString(),
            ownerPrincipalDeposited: summary.ownerPrincipalDeposited.toString(),
            maxTotalSpend: summary.maxTotalSpend.toString(),
            cumulativeSpent: summary.cumulativeSpent.toString(),
            authorizedRemaining: summary.authorizedRemaining.toString(),
            spendableNow: summary.spendableNow.toString(),
            verifiedRevenue: summary.verifiedRevenue.toString(),
            unallocatedBalance: summary.unallocatedBalance.toString(),
            policyVersion: summary.policyVersion,
            expiry: summary.expiry,
            budgetMode: summary.budgetMode,
            active: summary.active,
          };
        } catch {
          // EOA or non-vault contract
        }
        sendJson(res, 200, {
          address,
          assetSymbol: "tANE",
          assetAddress: contracts.aneTestToken,
          balance: balance.toString(),
          accounting,
          disclaimer: SANDBOX_DISCLAIMER,
        });
        return;
      }

      // 6. Payment Receipt Lookup (/v1/payments/:id)
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

      // 7. Self-hostable x402 Facilitator Endpoints (/v1/x402/*)
      if (method === "GET" && pathname === "/v1/x402/supported") {
        sendJson(res, 200, {
          x402Version: 2,
          kinds: [
            {
              scheme: "ane-vault-v1",
              network: `eip155:${chainId}`,
              asset: contracts.aneTestToken,
              assetSymbol: "tANE",
            },
            {
              scheme: "exact",
              network: `eip155:${chainId}`,
              asset: contracts.aneTestToken,
              assetSymbol: "tANE",
            },
          ],
          disclaimer: SANDBOX_DISCLAIMER,
        });
        return;
      }

      // 8. Service Directory Endpoints (/v1/services)
      if (method === "GET" && pathname === "/v1/services") {
        buildSignedManifest();
        sendJson(res, 200, {
          services: store.values<ServiceManifestPayload>("directory.services"),
          disclaimer: SANDBOX_DISCLAIMER,
        });
        return;
      }

      if (method === "POST" && pathname === "/v1/services") {
        const rawBody = await readRequestBody(req, maxBodyBytes);
        const manifest = JSON.parse(rawBody) as ServiceManifestPayload;
        const check = client.verifyServiceManifest(manifest, contracts.aneServiceDirectory);
        if (!check.valid) {
          sendError(
            res,
            400,
            "ANE-E-5002",
            check.reason ?? "Invalid service manifest signature",
            false,
          );
          return;
        }
        store.set("directory.services", manifest.serviceId, manifest);
        sendJson(res, 201, {
          registered: true,
          serviceId: manifest.serviceId,
          signer: check.signer,
          manifestDigest: check.digest,
          disclaimer: SANDBOX_DISCLAIMER,
        });
        return;
      }

      // 9. Sponsored Trial Campaigns (/v1/campaigns)
      if (method === "GET" && pathname === "/v1/campaigns") {
        sendJson(res, 200, {
          campaigns: quotaEngine.listCampaigns().map((c) => campaignPublicView(quotaEngine, c)),
          disclaimer: SANDBOX_DISCLAIMER,
        });
        return;
      }

      // 10. Provider circuit breaker: pause/resume a campaign with the provider's key (#16)
      if (
        method === "POST" &&
        pathname.startsWith("/v1/campaigns/") &&
        (pathname.endsWith("/pause") || pathname.endsWith("/resume"))
      ) {
        const action = pathname.endsWith("/pause") ? "pause" : "resume";
        const campaignId = pathname.slice("/v1/campaigns/".length, pathname.length - `/${action}`.length);
        await handleCampaignControl(quotaEngine, maxBodyBytes, req, res, campaignId, action);
        return;
      }

      // 11. Reference Paid Demo Endpoints (/v1/demo/*)
      if (isDemoRoute(method, pathname)) {
        await handleDemoRequest(demo, req, res, method, pathname, fullUrl);
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
        sendBudgetExhausted(res, err, "send the transaction yourself with your own gas");
        return;
      }
      // JSON.parse and BigInt throw SyntaxError on malformed client input; their messages only echo that input.
      if (err instanceof SyntaxError) {
        sendError(res, 400, "ANE-E-4000", `Malformed request body: ${err.message}`, false);
        return;
      }
      sendLoggedError(res, 500, "ANE-E-5000", "Internal server error", true, err, sentrySink);
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(config.port ?? 0, config.host ?? "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : (config.port ?? 8787);
  const url = `http://127.0.0.1:${actualPort}`;

  return {
    server,
    url,
    port: actualPort,
    client,
    verifier,
    providerAddress,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
