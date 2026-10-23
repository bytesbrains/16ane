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

// The service itself: deterministic, cheap and free of real compute.
function work(input: { text?: unknown }): { words: number; characters: number } {
  const text = typeof input.text === "string" ? input.text : "";
  return { words: text.split(/\s+/).filter(Boolean).length, characters: [...text].length };
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
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

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      if (req.method !== "POST" || url.pathname !== PATH) {
        send(res, 404, { error: `try POST ${PATH}`, disclaimer: SANDBOX_DISCLAIMER });
        return;
      }
      const rawBody = await readBody(req);
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

      const body = { serviceId: SERVICE_ID, ...work(JSON.parse(rawBody || "{}")), paid: tane(settled.receipt.amount), txHash: settled.receipt.txHash, disclaimer: SANDBOX_DISCLAIMER };
      const headers = { "payment-response": settled.receiptHeaderB64 };
      verifier.saveIdempotentResponse(idempotencyKey, { requestHash: computeRequestHash(rawBody), status: 200, headers, body, receipt: settled.receipt });
      send(res, 200, body, headers);
    } catch (err) {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
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
