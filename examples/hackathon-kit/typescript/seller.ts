// A seller agent in TypeScript (#20): one paid endpoint, POST /v1/word-count, priced at 16 tANE.
// It speaks x402 v2: a request without payment gets 402 and a quote; a request with a signed
// PAYMENT-SIGNATURE header is checked against this exact request, settled on-chain, then served.
// This seller settles itself, so its key (.kit/seller-ts.key) pays a little gas: free on the local
// sandbox; on Base Sepolia send it some testnet ETH first.
//
//   npm run kit:seller:ts                 # listens on http://127.0.0.1:9101
//   PORT=9200 npm run kit:seller:ts
//
// Make it yours: change SERVICE_ID, PRICE and work(). Keep the disclaimer in every response.
import http from "node:http";
import { pathToFileURL } from "node:url";
import { AnePaymentVerifier, computeRequestHash } from "../../../packages/sdk-ts/src/index.ts";
import { addressOf, clientFor, fundGasIfLocal, loadOrCreateKey, ONE_TANE, readNetwork, SANDBOX_DISCLAIMER, tane } from "../kit.ts";

const SERVICE_ID = "hackathon-word-count";
const PATH = "/v1/word-count";
const PRICE = 16n * ONE_TANE;
const MAX_BODY = 64 * 1024;

// The service itself: deterministic, cheap and free of real compute.
function work(input: { text?: unknown }): { words: number; characters: number } {
  const text = typeof input.text === "string" ? input.text : "";
  return { words: text.split(/\s+/).filter(Boolean).length, characters: [...text].length };
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

// Resolves with the body, or undefined once it passes MAX_BODY (the rest is read and dropped, so the
// client still gets the 413 instead of a reset connection).
async function readBody(req: http.IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size <= MAX_BODY) chunks.push(chunk as Buffer);
  }
  return size > MAX_BODY ? undefined : Buffer.concat(chunks).toString("utf8");
}

// The request body as a JSON object, or undefined. Checked before quoting, so a buyer never pays for a
// request this seller cannot serve.
function parseInput(rawBody: string): { text?: unknown } | undefined {
  try {
    const input: unknown = JSON.parse(rawBody || "{}");
    return input !== null && typeof input === "object" && !Array.isArray(input) ? input : undefined;
  } catch {
    return undefined;
  }
}

export async function startSeller(port = Number(process.env.PORT ?? 9101)): Promise<{ url: string; payTo: string; close: () => Promise<void> }> {
  const net = readNetwork();
  const client = clientFor(net);
  const key = loadOrCreateKey("seller-ts");
  const payTo = addressOf(key);
  await fundGasIfLocal(net, payTo);
  const { aneTestToken } = await client.resolveContracts();
  // The verifier checks each payment and settles it with this seller's key as the relayer.
  const verifier = new AnePaymentVerifier({ client, relayerKey: key });
  const endpoint = { serviceId: SERVICE_ID, priceAmount: PRICE, payTo, assetAddress: aneTestToken, description: "Counts words in a text" };
  // Idempotency keys whose paid request is settling right now. checkIdempotency only sees finished
  // answers, so without this two concurrent retries would both miss the cache and both be charged.
  const inFlight = new Set<string>();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      if (req.method !== "POST" || url.pathname !== PATH) {
        send(res, 404, { error: `try POST ${PATH}`, disclaimer: SANDBOX_DISCLAIMER });
        return;
      }
      const rawBody = await readBody(req);
      if (rawBody === undefined) return send(res, 413, { error: { code: "ANE-E-4001", message: `Body over ${MAX_BODY} bytes` } });
      const input = parseInput(rawBody);
      if (!input) return send(res, 400, { error: { code: "ANE-E-4001", message: "Body must be a JSON object" } });
      const idempotencyKey = req.headers["idempotency-key"] as string | undefined;

      // A retry with the same Idempotency-Key gets the first answer back and is never charged twice.
      const idem = verifier.checkIdempotency(idempotencyKey, computeRequestHash(rawBody));
      if (idem.status === "CONFLICT") return send(res, 409, { error: idem.message });
      if (idem.status === "HIT") return send(res, idem.cached.status, idem.cached.body, idem.cached.headers);

      const payment = req.headers["payment-signature"] as string | undefined;
      if (!payment) {
        const quote = verifier.build402Challenge(endpoint, url.toString());
        return send(res, quote.status, quote.body, quote.headers);
      }
      if (idempotencyKey && inFlight.has(idempotencyKey)) {
        return send(res, 409, { error: { code: "ANE-E-4005", message: "A request with this Idempotency-Key is still settling; retry shortly" } });
      }
      if (idempotencyKey) inFlight.add(idempotencyKey);
      try {
        // Checks the signature, the price, the payee and that it pays for THIS method, URL and body.
        const settled = await verifier.verifyAndSettle({
          paymentSignatureHeader: payment,
          endpoint,
          method: "POST",
          canonicalUrl: url.toString(),
          rawBody,
          idempotencyKey,
        });
        if (!settled.ok) return send(res, settled.status, { error: { code: settled.code, message: settled.message } });

        const body = { serviceId: SERVICE_ID, ...work(input), paid: tane(settled.receipt.amount), txHash: settled.receipt.txHash, disclaimer: SANDBOX_DISCLAIMER };
        const headers = { "payment-response": settled.receiptHeaderB64 };
        verifier.saveIdempotentResponse(idempotencyKey, { requestHash: computeRequestHash(rawBody), status: 200, headers, body, receipt: settled.receipt });
        send(res, 200, body, headers);
      } finally {
        if (idempotencyKey) inFlight.delete(idempotencyKey);
      }
    } catch (err) {
      // The detail goes to this terminal, not to the caller.
      console.error("seller.ts:", err);
      send(res, 500, { error: "internal error", disclaimer: SANDBOX_DISCLAIMER });
    }
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address();
  const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}${PATH}`;
  return { url, payTo, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { url, payTo } = await startSeller();
  console.log(`Seller (TypeScript) on ${url}: ${tane(PRICE)} per call, paid to ${payTo}. ${SANDBOX_DISCLAIMER}`);
}
