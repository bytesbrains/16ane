// End-to-end smoke test for a hosted sandbox API (#78, docs/operations/DEPLOY_API.md step 3). It needs no
// key: it makes a throwaway one in memory, which never leaves this process, and claims for it gaslessly.
//   API_URL=https://16ane-sandbox-api.fly.dev node --experimental-strip-types scripts/smoke-api.ts
// Optional: RPC_URL, to read the claim back from the chain, and EXPECTED_REGISTRY, to check the server's
// deployment; both default to networks/sandbox-sepolia.json.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
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
  // Checks the status before parsing, so a proxy's HTML error page reads as its status, not a JSON error.
  const read = async <T>(res: Response, status: number, what: string): Promise<T> => {
    const text = await res.text();
    expect(res.status === status, `${what}: expected ${status}, got ${res.status} ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${what}: answered ${status} without JSON: ${text.slice(0, 300)}`);
    }
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

  const { networks } = await read<{ networks?: Array<{ chainId: number; contracts: Record<string, string> }> }>(
    await api("/v1/networks"),
    200,
    "/v1/networks",
  );
  expect(Array.isArray(networks) && networks.length > 0, "/v1/networks lists no network");
  const served = networks![0];
  // The chain checks below must not take the server's word for which chain and contracts to read: the chain id
  // comes from the RPC, and the contracts from the expected registry on-chain, which the server's must match.
  const chainId = Number(BigInt(await new AneClient({ rpcUrl: opts.rpcUrl }).rpcCall<string>("eth_chainId", [])));
  expect(served.chainId === chainId, `the server says chain ${served.chainId}, the RPC is chain ${chainId}`);
  const client = opts.expectedRegistry
    ? new AneClient({ rpcUrl: opts.rpcUrl, chainId, registryAddress: opts.expectedRegistry })
    : new AneClient({ rpcUrl: opts.rpcUrl, chainId, contracts: served.contracts });
  const contracts = await client.resolveContracts();
  for (const name of ["aneTestToken", "aneVaultFactory", "aneFaucet", "aneServiceDirectory"] as const) {
    expect(
      served.contracts[name]?.toLowerCase() === contracts[name].toLowerCase(),
      `the server's ${name} is ${served.contracts[name]}, the registry's is ${contracts[name]}`,
    );
  }
  log(`network ${chainId}: token ${contracts.aneTestToken}, faucet ${contracts.aneFaucet}`);

  const { secretKey, address } = generateKeypair();
  const unproven = await read<{ error?: { code?: string } }>(await claim({ recipient: address }), 401, "claim with no proof");
  expect(unproven.error?.code === "ANE-E-1007", `claim with no proof: expected ANE-E-1007, got ${unproven.error?.code}`);
  log("claim with no proof: 401");

  const signed = await client.signFaucetClaim(secretKey);
  const record = await read<{ claimId: string; amount: string; txHash: string; disclaimer?: string }>(
    await claim({
      recipient: address,
      authorization: { deadline: signed.deadline, nonce: signed.nonce, signature: signed.signature },
    }),
    201,
    "signed claim",
  );
  expect(Boolean(record.disclaimer?.includes("NO CASH VALUE")), "the claim record must carry the no-cash-value disclaimer");
  log(`signed claim for a fresh address ${address}: tx ${record.txHash}`);

  await waitFor(() => client.getTokenBalance(address), (b) => b === BigInt(record.amount), "the claimed tANE on-chain");
  const eth = BigInt(await client.rpcCall<string>("eth_getBalance", [address, "latest"]));
  expect(eth === 0n, `the recipient must pay no gas, but holds ${eth} wei`);
  log(`on-chain: ${BigInt(record.amount) / 10n ** 18n} tANE received, 0 ETH`);

  const status = await read<{ txHash?: string }>(await api(`/v1/faucet/claims/${record.claimId}`), 200, "claim status");
  expect(status.txHash === record.txHash, `claim status shows tx ${status.txHash}, expected ${record.txHash}`);
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
  const manifest = await read<ServiceManifestPayload>(await api("/.well-known/16ane-service.json"), 200, "service manifest");
  const verified = client.verifyServiceManifest(manifest, contracts.aneServiceDirectory);
  expect(verified.valid, `service manifest signature: ${verified.reason ?? "invalid"}`);
  log(`demo: 402 quote; manifest signed by ${verified.signer}`);

  return { claimTxHash: record.txHash, recipient: address };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
