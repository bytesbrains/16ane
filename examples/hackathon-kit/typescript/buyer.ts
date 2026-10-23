// A buyer agent in TypeScript (#20). It holds only the agent session key the owner delegated to; the
// vault contract enforces the owner's budget no matter what this code (or a model driving it) decides.
//
//   npm run kit:buyer:ts                                        # buys the sandbox API's demo summary
//   npm run kit:buyer:ts -- http://127.0.0.1:9101/v1/word-count # buys from your TypeScript seller
//   npm run kit:buyer:ts -- http://127.0.0.1:9102/v1/digits     # buys from your Python seller
//
// Make it yours: decide what to buy, what to send, and the most you will pay for it (MAX_PAYMENT).
import { pathToFileURL } from "node:url";
import { AgentSession } from "../../../packages/sdk-ts/src/index.ts";
import { clientFor, loadOrCreateKey, ONE_TANE, readAgent, readNetwork, SANDBOX_DISCLAIMER, tane } from "../kit.ts";

// A client-side guard on top of the contract's limits: refuse any quote above this.
const MAX_PAYMENT = 32n * ONE_TANE;

export async function buy(url: string, body: object): Promise<{ status: number; data: unknown; txHash?: string }> {
  const net = readNetwork();
  const client = clientFor(net);
  const { vaultAddress } = readAgent();
  const session = new AgentSession({ client, vaultAddress, sessionKey: loadOrCreateKey("agent") });

  const res = await session.purchase(url, { method: "POST", body: JSON.stringify(body), maxPayment: MAX_PAYMENT });
  return { status: res.status, data: res.data, txHash: res.receipt?.txHash };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const net = readNetwork();
  const url = process.argv[2] ?? `${net.apiUrl}/v1/demo/summarize`;
  const text = process.argv[3] ?? "Sixteen annas made one rupee. Agents pay each other in test tokens.";
  console.log(`[${net.name}] ${SANDBOX_DISCLAIMER}\nbuying ${url}`);
  const { status, data, txHash } = await buy(url, { text });
  console.log(JSON.stringify({ status, data, txHash }, null, 2));
  const s = await clientFor(net).getAccountingSummary(readAgent().vaultAddress);
  console.log(`spent so far ${tane(s.cumulativeSpent)}; may still spend ${tane(s.spendableNow)}`);
  if (status !== 200) process.exitCode = 1;
}
