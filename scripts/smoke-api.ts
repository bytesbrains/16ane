// End-to-end smoke test for a hosted sandbox API (#78, docs/operations/DEPLOY_API.md step 3). It needs no
// key: it makes a throwaway one in memory, which never leaves this process, and claims for it gaslessly.
//   API_URL=https://16ane-sandbox-api.fly.dev node --experimental-strip-types scripts/smoke-api.ts
// Optional: RPC_URL, to read the claim back from the chain, and EXPECTED_REGISTRY, to check the server's
// deployment; both default to networks/sandbox-sepolia.json.
import { readFileSync } from "node:fs";
import { AneClient, generateKeypair, type ServiceManifestPayload } from "../packages/sdk-ts/src/index.ts";
import { checkApiHealth } from "./api-health.ts";
import { waitFor } from "./smoke-sandbox.ts";

export interface ApiSmokeOptions {
  apiUrl: string;
  rpcUrl: string;
  expectedRegistry?: string;
  log?: (line: string) => void;
}

export async function runApiSmoke(opts: ApiSmokeOptions): Promise<{ claimTxHash: string; recipient: string }> {
  const log = opts.log ?? (() => {});
  const api = (path: string, init?: RequestInit) => fetch(new URL(path, opts.apiUrl), init);
  const expect = (cond: boolean, what: string) => {
    if (!cond) throw new Error(what);
  };
  const claim = (body: object) =>
    api("/v1/faucet/claims", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const problems = await checkApiHealth(opts.apiUrl, opts.expectedRegistry);
  expect(problems.length === 0, `health: ${problems.join("; ")}`);
  log("/healthz ok: RPC reachable, relayer funded, gas budget left");

  const { networks } = (await (await api("/v1/networks")).json()) as {
    networks: Array<{ chainId: number; contracts: Record<string, string> }>;
  };
  const client = new AneClient({ rpcUrl: opts.rpcUrl, chainId: networks[0].chainId, contracts: networks[0].contracts });
  const contracts = await client.resolveContracts();
  log(`network ${networks[0].chainId}: token ${contracts.aneTestToken}, faucet ${contracts.aneFaucet}`);

  const { secretKey, address } = generateKeypair();
  const unproven = await claim({ recipient: address });
  expect(unproven.status === 401, `a claim with no proof must be refused with 401, got ${unproven.status}`);
  log("claim with no proof: 401");

  const signed = await client.signFaucetClaim(secretKey);
  const res = await claim({
    recipient: address,
    authorization: { deadline: signed.deadline, nonce: signed.nonce, signature: signed.signature },
  });
  const record = (await res.json()) as { claimId: string; amount: string; txHash: string; disclaimer?: string };
  expect(res.status === 201, `signed claim: expected 201, got ${res.status} ${JSON.stringify(record)}`);
  expect(Boolean(record.disclaimer?.includes("NO CASH VALUE")), "the claim record must carry the no-cash-value disclaimer");
  log(`signed claim for a fresh address ${address}: tx ${record.txHash}`);

  await waitFor(() => client.getTokenBalance(address), (b) => b === BigInt(record.amount), "the claimed tANE on-chain");
  const eth = BigInt(await client.rpcCall<string>("eth_getBalance", [address, "latest"]));
  expect(eth === 0n, `the recipient must pay no gas, but holds ${eth} wei`);
  log(`on-chain: ${BigInt(record.amount) / 10n ** 18n} tANE received, 0 ETH`);

  const status = await api(`/v1/faucet/claims/${record.claimId}`);
  expect(status.status === 200 && ((await status.json()) as { txHash: string }).txHash === record.txHash, "claim status lookup");
  const again = await client.signFaucetClaim(secretKey);
  const repeat = await claim({
    recipient: address,
    authorization: { deadline: again.deadline, nonce: again.nonce, signature: again.signature },
  });
  expect(repeat.status === 429, `a second claim inside the cooldown must be 429, got ${repeat.status}`);
  log("claim status 200; second claim inside the cooldown: 429");

  const quote = await api("/v1/demo/summarize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Sixteen annas made a rupee." }),
  });
  expect(quote.status === 402, `an unpaid demo call must get a 402 quote, got ${quote.status}`);
  const manifest = (await (await api("/.well-known/16ane-service.json")).json()) as ServiceManifestPayload;
  const verified = client.verifyServiceManifest(manifest, contracts.aneServiceDirectory);
  expect(verified.valid, `service manifest signature: ${verified.reason ?? "invalid"}`);
  log(`demo: 402 quote; manifest signed by ${verified.signer}`);

  return { claimTxHash: record.txHash, recipient: address };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { API_URL, RPC_URL, EXPECTED_REGISTRY } = process.env;
  if (!API_URL) {
    console.error("Set API_URL (see docs/operations/DEPLOY_API.md).");
    process.exit(2);
  }
  const published = JSON.parse(readFileSync(new URL("../networks/sandbox-sepolia.json", import.meta.url), "utf8")) as {
    rpcUrl: string;
    registryAddress: string;
  };
  runApiSmoke({
    apiUrl: API_URL,
    rpcUrl: RPC_URL ?? published.rpcUrl,
    expectedRegistry: EXPECTED_REGISTRY ?? published.registryAddress,
    log: (line) => console.log(`[smoke-api] ${line}`),
  }).then(
    () => console.log("[smoke-api] PASS"),
    (err) => {
      console.error(`[smoke-api] FAIL: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
