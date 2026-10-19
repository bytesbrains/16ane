import http from "node:http";
import crypto from "node:crypto";
import {
  AneClient,
  AnePaymentVerifier,
  computeRequestHash,
  hashClaimAuthorization,
  keccak256Utf8,
  privateKeyToAddress,
  randomBytes32Hex,
  SANDBOX_DISCLAIMER,
  SecretKey,
  signDigest,
  toChecksumAddress,
  TrialQuotaTracker,
  type MerchantEndpointConfig,
  type ServiceManifestPayload,
  type X402Receipt,
} from "../../../packages/sdk-ts/src/index.ts";

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
const PRICE_SUMMARIZE = 16n * ONE_TANE; // 16 tANE (= 1 simulated INR)
const PRICE_CLEAN_DATA = 32n * ONE_TANE; // 32 tANE (= 2 simulated INR)
const PRICE_SIMULATE_FAILURE = 16n * ONE_TANE; // 16 tANE
const FAUCET_DRIP_AMOUNT = 1600n * ONE_TANE; // 1,600 tANE (= 100 simulated INR)

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-16ane-disclaimer": SANDBOX_DISCLAIMER,
    ...extraHeaders,
  });
  res.end(payload);
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

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

  const buildSignedManifest = (baseUrl: string): ServiceManifestPayload => {
    const unsigned: Omit<ServiceManifestPayload, "signer" | "signature"> = {
      schemaVersion: "16ane-manifest-v0",
      serviceId: "16ane-sandbox-reference-demo",
      name: "16ane Deterministic Reference Paid Services (Sandbox)",
      description:
        "Reference x402 v2 paid agent endpoints settling in simulated tANE (TEST TOKENS - NO CASH VALUE)",
      version: "0.1.0",
      network: "eip155:84532",
      chainId,
      payTo: providerAddress,
      tokenAddress: contracts.aneTestToken,
      tokenSymbol: "tANE",
      updatedAt: 1760860800,
      endpoints: [
        {
          id: "summarize",
          method: "POST",
          path: "/v1/demo/summarize",
          priceAmount: PRICE_SUMMARIZE.toString(),
          scheme: "ane-vault-v1",
          description: "Deterministic text summarization (16 tANE per call)",
        },
        {
          id: "clean-data",
          method: "POST",
          path: "/v1/demo/clean-data",
          priceAmount: PRICE_CLEAN_DATA.toString(),
          scheme: "ane-vault-v1",
          description: "Deterministic JSON array deduplication and normalization (32 tANE per call)",
        },
        {
          id: "simulate-failure",
          method: "POST",
          path: "/v1/demo/simulate-failure",
          priceAmount: PRICE_SIMULATE_FAILURE.toString(),
          scheme: "ane-vault-v1",
          description:
            "Settles 16 tANE and simulates downstream failure with automatic on-chain refundPayment",
        },
      ],
      trialQuota: {
        enabled: true,
        freeCallsPerCaller: trialTracker.config.freeCallsPerCaller,
        globalDailyCap: trialTracker.config.globalDailyCap,
        sponsorDisclosure:
          trialTracker.config.sponsorDisclosure ??
          "Provider-sponsored sandbox trial (0 tANE charged)",
      },
    };
    const signed = client.signServiceManifest(
      unsigned,
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
        const manifest = buildSignedManifest(`${protocol}://${host}`);
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
          sendJson(res, 400, {
            error: {
              code: "ANE-E-1001",
              message: "Missing recipient address",
              retryable: false,
              disclaimer: SANDBOX_DISCLAIMER,
            },
          });
          return;
        }
        const recipient = toChecksumAddress(body.recipient);
        const amount = body.amount ? BigInt(body.amount) : FAUCET_DRIP_AMOUNT;
        if (amount <= 0n || amount > FAUCET_DRIP_AMOUNT) {
          sendJson(res, 400, {
            error: {
              code: "ANE-E-1002",
              message: `Requested amount exceeds faucet cap (${FAUCET_DRIP_AMOUNT.toString()} wei = 1600 tANE)`,
              retryable: false,
              disclaimer: SANDBOX_DISCLAIMER,
            },
          });
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
          sendJson(res, 429, {
            error: {
              code: "ANE-E-1003",
              message: "Faucet cooldown active for this recipient (24h window)",
              retryable: true,
              disclaimer: SANDBOX_DISCLAIMER,
            },
          });
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
          sendJson(res, 429, {
            error: {
              code: "ANE-E-1004",
              message: `On-chain faucet claim rejected: ${err instanceof Error ? err.message : String(err)}`,
              retryable: true,
              disclaimer: SANDBOX_DISCLAIMER,
            },
          });
          return;
        }
      }

      if (method === "GET" && pathname.startsWith("/v1/faucet/claims/")) {
        const claimId = pathname.slice("/v1/faucet/claims/".length);
        const record = claimsById.get(claimId);
        if (!record) {
          sendJson(res, 404, {
            error: {
              code: "ANE-E-1005",
              message: `Faucet claim ${claimId} not found`,
              retryable: false,
              disclaimer: SANDBOX_DISCLAIMER,
            },
          });
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
          sendJson(res, 404, {
            error: {
              code: "ANE-E-4012",
              message: `Receipt ${id} not found`,
              retryable: false,
              disclaimer: SANDBOX_DISCLAIMER,
            },
          });
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
        buildSignedManifest(`${protocol}://${host}`);
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
          sendJson(res, 400, {
            error: {
              code: "ANE-E-5002",
              message: check.reason ?? "Invalid service manifest signature",
              retryable: false,
              disclaimer: SANDBOX_DISCLAIMER,
            },
          });
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
      if (
        method === "POST" &&
        (pathname === "/v1/demo/summarize" ||
          pathname === "/v1/demo/clean-data" ||
          pathname === "/v1/demo/simulate-failure")
      ) {
        const rawBody = await readRequestBody(req);
        const requestHash = computeRequestHash(rawBody);
        const idempotencyKey = req.headers["idempotency-key"] as string | undefined;

        // Check Idempotency-Key first (ADR-0009)
        const idem = verifier.checkIdempotency(idempotencyKey, requestHash);
        if (idem.status === "CONFLICT") {
          sendJson(res, 409, {
            error: {
              code: "ANE-E-4004",
              message: idem.message,
              retryable: false,
              disclaimer: SANDBOX_DISCLAIMER,
            },
          });
          return;
        }
        if (idem.status === "HIT") {
          sendJson(res, idem.cached.status, idem.cached.body, {
            ...idem.cached.headers,
            "x-idempotent-replay": "true",
          });
          return;
        }

        const priceMap: Record<string, bigint> = {
          "/v1/demo/summarize": PRICE_SUMMARIZE,
          "/v1/demo/clean-data": PRICE_CLEAN_DATA,
          "/v1/demo/simulate-failure": PRICE_SIMULATE_FAILURE,
        };
        const endpointConfig: MerchantEndpointConfig = {
          serviceId: "16ane-sandbox-reference-demo",
          priceAmount: priceMap[pathname],
          payTo: providerAddress,
          assetAddress: contracts.aneTestToken,
          network: "eip155:84532",
          description: `16ane Sandbox Demo (${pathname})`,
        };

        const paymentSignatureHeader = req.headers["payment-signature"] as string | undefined;
        const trialRequested = req.headers["x-trial-request"] === "true";
        const callerId =
          (req.headers["x-agent-vault"] as string | undefined) ??
          (req.headers["x-agent-session"] as string | undefined) ??
          req.socket.remoteAddress ??
          "anonymous";

        // If no PAYMENT-SIGNATURE header, check if a provider-sponsored trial call was requested
        if (!paymentSignatureHeader) {
          if (pathname === "/v1/demo/summarize" && trialRequested) {
            const trial = trialTracker.checkAndConsume(callerId);
            if (trial.allowed) {
              const parsedInput = rawBody
                ? (JSON.parse(rawBody) as { text?: string })
                : { text: "" };
              const text = parsedInput.text ?? "";
              const words = text.trim() ? text.trim().split(/\s+/) : [];
              const summaryText = words.slice(0, 12).join(" ");
              const trialReceipt: X402Receipt = {
                x402Version: 2,
                success: true,
                scheme: "sponsored-trial",
                network: "eip155:84532",
                txHash: "0x" + "00".repeat(32),
                blockNumber: 0,
                payer: toChecksumAddress(
                  /^0x[0-9a-fA-F]{40}$/.test(callerId)
                    ? callerId
                    : "0x0000000000000000000000000000000000000000",
                ),
                payTo: providerAddress,
                asset: contracts.aneTestToken,
                amount: "0",
                resourceHash: keccak256Utf8(`${method}:${fullUrl.toString()}`),
                requestHash,
                idempotencyKey,
                settledAt: new Date().toISOString(),
                sponsored: true,
                disclaimer: `${SANDBOX_DISCLAIMER} — ${trial.disclosure}`,
              };
              const receiptHeaderB64 = Buffer.from(
                JSON.stringify(trialReceipt),
                "utf8",
              ).toString("base64");
              sendJson(
                res,
                200,
                {
                  serviceId: "16ane-sandbox-reference-demo",
                  endpoint: pathname,
                  summary: summaryText,
                  wordCount: words.length,
                  contentSha256: crypto.createHash("sha256").update(text).digest("hex"),
                  sponsored: true,
                  sponsorDisclosure: trial.disclosure,
                  trialQuotaRemaining: trial.remainingCallerQuota,
                  disclaimer: SANDBOX_DISCLAIMER,
                },
                {
                  "payment-response": receiptHeaderB64,
                  "x-trial-quota-remaining": trial.remainingCallerQuota.toString(),
                },
              );
              return;
            }
          }

          const challenge = verifier.build402Challenge(
            endpointConfig,
            fullUrl.toString(),
            pathname === "/v1/demo/summarize",
          );
          sendJson(res, challenge.status, challenge.body, challenge.headers);
          return;
        }

        // Verify and settle the x402 payment proof
        const settled = await verifier.verifyAndSettle({
          paymentSignatureHeader,
          endpoint: endpointConfig,
          method,
          canonicalUrl: fullUrl.toString(),
          rawBody,
          idempotencyKey,
        });

        if (!settled.ok) {
          sendJson(res, settled.status, {
            error: {
              code: settled.code,
              message: settled.message,
              retryable: settled.status >= 500,
              disclaimer: SANDBOX_DISCLAIMER,
            },
          });
          return;
        }

        const { receipt, receiptHeaderB64 } = settled;

        // Endpoint A: /v1/demo/summarize
        if (pathname === "/v1/demo/summarize") {
          const parsedInput = rawBody
            ? (JSON.parse(rawBody) as { text?: string })
            : { text: "" };
          const text = parsedInput.text ?? "";
          const words = text.trim() ? text.trim().split(/\s+/) : [];
          const summaryText = words.slice(0, 12).join(" ");
          const responseBody = {
            serviceId: "16ane-sandbox-reference-demo",
            endpoint: pathname,
            summary: summaryText,
            wordCount: words.length,
            contentSha256: crypto.createHash("sha256").update(text).digest("hex"),
            paidAmount: receipt.amount,
            assetSymbol: "tANE",
            txHash: receipt.txHash,
            intentId: receipt.intentId,
            sponsored: false,
            disclaimer: SANDBOX_DISCLAIMER,
          };
          const responseHeaders = { "payment-response": receiptHeaderB64 };
          verifier.saveIdempotentResponse(idempotencyKey, {
            requestHash,
            status: 200,
            headers: responseHeaders,
            body: responseBody,
            receipt,
          });
          sendJson(res, 200, responseBody, responseHeaders);
          return;
        }

        // Endpoint B: /v1/demo/clean-data
        if (pathname === "/v1/demo/clean-data") {
          const parsedInput = rawBody
            ? (JSON.parse(rawBody) as { items?: string[] })
            : { items: [] };
          const items = Array.isArray(parsedInput.items) ? parsedInput.items : [];
          const normalized = Array.from(
            new Set(items.map((item) => String(item).trim().toLowerCase()).filter(Boolean)),
          ).sort();
          const responseBody = {
            serviceId: "16ane-sandbox-reference-demo",
            endpoint: pathname,
            inputCount: items.length,
            outputCount: normalized.length,
            items: normalized,
            paidAmount: receipt.amount,
            assetSymbol: "tANE",
            txHash: receipt.txHash,
            intentId: receipt.intentId,
            sponsored: false,
            disclaimer: SANDBOX_DISCLAIMER,
          };
          const responseHeaders = { "payment-response": receiptHeaderB64 };
          verifier.saveIdempotentResponse(idempotencyKey, {
            requestHash,
            status: 200,
            headers: responseHeaders,
            body: responseBody,
            receipt,
          });
          sendJson(res, 200, responseBody, responseHeaders);
          return;
        }

        // Endpoint C: /v1/demo/simulate-failure (settles then triggers on-chain refundPayment - REQ-006, ADR-0009)
        if (pathname === "/v1/demo/simulate-failure") {
          const refundRes = await client.refundPaymentOnChain(
            providerKey,
            receipt.payer,
            receipt.paymentId!,
            receipt.amount,
          );
          const failureBody = {
            status: "REFUNDED",
            error: {
              code: "ANE-E-5004",
              message:
                "Simulated downstream tool failure after payment settlement; full on-chain refund executed via AneAgentVault.refundPayment",
              retryable: true,
            },
            originalTxHash: receipt.txHash,
            refundTxHash: refundRes.txHash,
            refundBlockNumber: refundRes.blockNumber,
            refundedAmount: receipt.amount,
            assetSymbol: "tANE",
            payerVault: receipt.payer,
            intentId: receipt.intentId,
            paymentId: receipt.paymentId,
            disclaimer: SANDBOX_DISCLAIMER,
          };
          const responseHeaders = { "payment-response": receiptHeaderB64 };
          verifier.saveIdempotentResponse(idempotencyKey, {
            requestHash,
            status: 502,
            headers: responseHeaders,
            body: failureBody,
            receipt,
          });
          sendJson(res, 502, failureBody, responseHeaders);
          return;
        }
      }

      sendJson(res, 404, {
        error: {
          code: "ANE-E-4040",
          message: `Route not found: ${method} ${pathname}`,
          retryable: false,
          disclaimer: SANDBOX_DISCLAIMER,
        },
      });
    } catch (err) {
      sendJson(res, 500, {
        error: {
          code: "ANE-E-5000",
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
          disclaimer: SANDBOX_DISCLAIMER,
        },
      });
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
