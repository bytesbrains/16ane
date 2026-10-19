import http from "node:http";
import crypto from "node:crypto";
import {
  AneClient,
  AnePaymentVerifier,
  privateKeyToAddress,
  randomBytes32Hex,
  SANDBOX_DISCLAIMER,
  SecretKey,
  toChecksumAddress,
  TrialQuotaTracker,
  type ServiceManifestPayload,
} from "../../../packages/sdk-ts/src/index.ts";
import { buildDemoManifest, handleDemoRequest, isDemoRoute, type DemoContext } from "./demo.ts";
import { readRequestBody, sendError, sendJson } from "./http.ts";

export interface SandboxServerConfig {
  port?: number;
  rpcUrl: string;
  chainId?: number;
  registryAddress: string;
  relayerPrivateKey: string | SecretKey;
  faucetSignerPrivateKey?: string | SecretKey;
  providerPrivateKey?: string | SecretKey;
  trialFreeCallsPerCaller?: number;
  trialGlobalDailyCap?: number;
}

export interface ClaimStatusRecord {
  claimId: string;
  recipient: string;
  amount: string;
  symbol: "tANE";
  txHash: string;
  blockNumber: number;
  createdAt: string;
  disclaimer: string;
}

const ONE_TANE = 10n ** 18n;
const FAUCET_DRIP_AMOUNT = 1600n * ONE_TANE; // 1,600 tANE (= 100 simulated INR)

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
  const relayerKey =
    config.relayerPrivateKey instanceof SecretKey
      ? config.relayerPrivateKey
      : new SecretKey(config.relayerPrivateKey);
  const faucetSignerKey = config.faucetSignerPrivateKey
    ? config.faucetSignerPrivateKey instanceof SecretKey
      ? config.faucetSignerPrivateKey
      : new SecretKey(config.faucetSignerPrivateKey)
    : relayerKey;
  const providerKey = config.providerPrivateKey
    ? config.providerPrivateKey instanceof SecretKey
      ? config.providerPrivateKey
      : new SecretKey(config.providerPrivateKey)
    : relayerKey;

  const providerAddress = privateKeyToAddress(providerKey);
  const client = new AneClient({
    rpcUrl: config.rpcUrl,
    chainId,
    registryAddress: config.registryAddress,
  });
  const contracts = await client.resolveContracts();
  const verifier = new AnePaymentVerifier({ client, relayerKey });

  const trialTracker = new TrialQuotaTracker({
    enabled: true,
    freeCallsPerCaller: config.trialFreeCallsPerCaller ?? 1,
    globalDailyCap: config.trialGlobalDailyCap ?? 50,
    sponsorDisclosure:
      "Provider-sponsored sandbox trial (0 tANE charged; capped at 1 call/caller and 50 calls/day)",
  });

  const claimsById = new Map<string, ClaimStatusRecord>();
  const ipCooldowns = new Map<string, number>();
  const ipSalt = crypto.randomBytes(16).toString("hex");
  const directoryManifests = new Map<string, ServiceManifestPayload>();

  const demo: DemoContext = {
    client,
    verifier,
    trialTracker,
    providerKey,
    providerAddress,
    contracts,
  };

  const buildSignedManifest = (): ServiceManifestPayload => {
    const signed = client.signServiceManifest(
      buildDemoManifest(demo, chainId),
      providerKey,
      contracts.aneServiceDirectory,
    );
    directoryManifests.set(signed.serviceId, signed);
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
      if (method === "POST" && pathname === "/v1/faucet/claims") {
        const rawBody = await readRequestBody(req);
        const body = rawBody ? (JSON.parse(rawBody) as { recipient?: string; amount?: string }) : {};
        if (!body.recipient) {
          sendError(res, 400, "ANE-E-1001", "Missing recipient address", false);
          return;
        }
        const recipient = toChecksumAddress(body.recipient);
        const amount = body.amount ? BigInt(body.amount) : FAUCET_DRIP_AMOUNT;
        if (amount <= 0n || amount > FAUCET_DRIP_AMOUNT) {
          sendError(
            res,
            400,
            "ANE-E-1002",
            `Requested amount exceeds faucet cap (${FAUCET_DRIP_AMOUNT.toString()} wei = 1600 tANE)`,
            false,
          );
          return;
        }

        const clientIp =
          (req.headers["x-forwarded-for"] as string | undefined) ??
          req.socket.remoteAddress ??
          "local";
        const ipHash = crypto
          .createHash("sha256")
          .update(`${ipSalt}:${clientIp}:${recipient.toLowerCase()}`)
          .digest("hex");
        const lastClaimAt = ipCooldowns.get(ipHash) ?? 0;
        const nowSec = Math.floor(Date.now() / 1000);
        if (nowSec - lastClaimAt < 86400) {
          sendError(
            res,
            429,
            "ANE-E-1003",
            "Faucet cooldown active for this recipient (24h window)",
            true,
          );
          return;
        }

        try {
          const settled = await client.executeFaucetClaimOnChain(relayerKey, recipient);
          ipCooldowns.set(ipHash, nowSec);
          const nonce = randomBytes32Hex();
          const claimId = `claim_${nonce.slice(2, 26)}`;
          const record: ClaimStatusRecord = {
            claimId,
            recipient,
            amount: amount.toString(),
            symbol: "tANE",
            txHash: settled.txHash,
            blockNumber: settled.blockNumber,
            createdAt: new Date().toISOString(),
            disclaimer: SANDBOX_DISCLAIMER,
          };
          claimsById.set(claimId, record);
          sendJson(res, 201, record);
          return;
        } catch (err) {
          sendError(
            res,
            429,
            "ANE-E-1004",
            `On-chain faucet claim rejected: ${err instanceof Error ? err.message : String(err)}`,
            true,
          );
          return;
        }
      }

      if (method === "GET" && pathname.startsWith("/v1/faucet/claims/")) {
        const claimId = pathname.slice("/v1/faucet/claims/".length);
        const record = claimsById.get(claimId);
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
          services: Array.from(directoryManifests.values()),
          disclaimer: SANDBOX_DISCLAIMER,
        });
        return;
      }

      if (method === "POST" && pathname === "/v1/services") {
        const rawBody = await readRequestBody(req);
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
        directoryManifests.set(manifest.serviceId, manifest);
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
          campaigns: [
            {
              campaignId: "sandbox-trial-summarize-v1",
              serviceId: "16ane-sandbox-reference-demo",
              endpoint: "/v1/demo/summarize",
              freeCallsPerCaller: trialTracker.config.freeCallsPerCaller,
              globalDailyCap: trialTracker.config.globalDailyCap,
              sponsorDisclosure: trialTracker.config.sponsorDisclosure,
              disclaimer: SANDBOX_DISCLAIMER,
            },
          ],
          disclaimer: SANDBOX_DISCLAIMER,
        });
        return;
      }

      // 10. Reference Paid Demo Endpoints (/v1/demo/*)
      if (isDemoRoute(method, pathname)) {
        await handleDemoRequest(demo, req, res, method, pathname, fullUrl);
        return;
      }


      sendError(res, 404, "ANE-E-4040", `Route not found: ${method} ${pathname}`, false);
    } catch (err) {
      sendError(res, 500, "ANE-E-5000", err instanceof Error ? err.message : String(err), true);
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(config.port ?? 0, "127.0.0.1", () => resolve());
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
