// Acceptance test for the standalone facilitator and indexer (#18): an independent facilitator
// container verifies and settles ane-vault-v1 and exact payments, and an independent indexer
// container indexes AneServiceDirectory anchors. Run by scripts/docker-smoke-standalone.sh against
// a local Anvil chain (or any testnet deployment):
//   RPC_URL=... REGISTRY_ADDRESS=0x... OWNER_KEY=0x... FACILITATOR_URL=... INDEXER_URL=... \
//     node --experimental-strip-types scripts/smoke-standalone.ts
// Optional: CHAIN_ID (default 84532). Needs Foundry's `cast` on PATH, like the SDK. OWNER_KEY needs
// chain ETH (it also acts as the token admin that mints the test balances); the agent and the exact
// payer hold no ETH — the facilitator's relayer settles for them.
import { pathToFileURL } from "node:url";
import {
  AgentSession,
  AneClient,
  generateKeypair,
  hashTransferWithAuthorization,
  keccak256Utf8,
  OwnerWallet,
  privateKeyToAddress,
  randomBytes32Hex,
  SecretKey,
  signDigest,
} from "../packages/sdk-ts/src/index.ts";
import { waitFor } from "./smoke-sandbox.ts";

const ONE_TANE = 10n ** 18n;
const PAYMENT = 16n * ONE_TANE;

export interface StandaloneSmokeOptions {
  rpcUrl: string;
  registryAddress: string;
  ownerKey: SecretKey;
  facilitatorUrl: string;
  indexerUrl: string;
  chainId?: number;
  log?: (line: string) => void;
}

interface CanonicalRequest {
  x402Version: 2;
  paymentPayload: { x402Version: 2; accepted: Record<string, unknown>; payload: Record<string, unknown> };
  paymentRequirements: Record<string, unknown>;
}

function canonicalRequest(
  scheme: string,
  network: string,
  asset: string,
  amount: string,
  payTo: string,
  payload: Record<string, unknown>,
): CanonicalRequest {
  const requirements = { scheme, network, asset, amount, payTo, maxTimeoutSeconds: 300 };
  return {
    x402Version: 2,
    paymentPayload: { x402Version: 2, accepted: { ...requirements }, payload },
    paymentRequirements: { ...requirements },
  };
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

export async function runStandaloneSmoke(opts: StandaloneSmokeOptions): Promise<void> {
  const log = opts.log ?? (() => {});
  const chainId = opts.chainId ?? 84532;
  const network = `eip155:${chainId}`;
  const client = new AneClient({ rpcUrl: opts.rpcUrl, chainId, registryAddress: opts.registryAddress });
  const contracts = await client.resolveContracts();
  const owner = new OwnerWallet(client, opts.ownerKey);

  // The owner mints its own test balances (token admin on this throwaway chain).
  const deployer = privateKeyToAddress(opts.ownerKey);
  await client.sendContractTx(opts.ownerKey, contracts.aneTestToken, "grantRole(bytes32,address)", [
    keccak256Utf8("MINTER_ROLE"),
    deployer,
  ]);
  await client.sendContractTx(opts.ownerKey, contracts.aneTestToken, "mint(address,uint256)", [
    owner.address,
    (2n * PAYMENT).toString(),
  ]);
  log(`minted ${2n * PAYMENT / ONE_TANE} tANE to the owner`);

  const supported = (await (await fetch(`${opts.facilitatorUrl}/supported`)).json()) as {
    kinds: Array<{ scheme: string; network: string }>;
  };
  const kinds = supported.kinds.map((k) => `${k.scheme}@${k.network}`).sort();
  if (kinds.join(",") !== `ane-vault-v1@${network},exact@${network}`) {
    throw new Error(`unexpected /supported kinds: ${JSON.stringify(supported.kinds)}`);
  }
  log(`/supported lists both schemes on ${network}`);

  // --- ane-vault-v1 through the facilitator -----------------------------------------------
  const { vaultAddress } = await owner.ensureVaultDeployed(0n);
  await owner.fundVault(vaultAddress, PAYMENT);
  const session = new AgentSession({ client, vaultAddress, sessionKey: generateKeypair().secretKey });
  const versionBefore = await client.getPolicyVersion(vaultAddress);
  await owner.delegateSession(vaultAddress, session.sessionAddress, {
    mode: "FIXED",
    allowanceCap: PAYMENT,
    perTxLimit: PAYMENT,
    expiry: Math.floor(Date.now() / 1000) + 3600,
  });
  const policyVersion = await waitFor(
    () => client.getPolicyVersion(vaultAddress),
    (version) => version > versionBefore,
    "the new delegation's policy version",
  );
  const merchant = generateKeypair().address;
  const signed = session.signSpendIntent({
    merchant,
    amount: PAYMENT,
    quoteId: keccak256Utf8(`standalone-vault-${Date.now()}`),
    serviceIdHash: keccak256Utf8("16ane.standalone.v1"),
    validBefore: Math.floor(Date.now() / 1000) + 300,
    policyVersion,
  });
  const vaultRequest = canonicalRequest("ane-vault-v1", network, contracts.aneTestToken, PAYMENT.toString(), merchant, {
    ...signed.intent,
    signature: signed.signature,
  });
  const vaultVerify = await postJson(`${opts.facilitatorUrl}/verify`, vaultRequest);
  if (vaultVerify.status !== 200 || vaultVerify.json.isValid !== true) {
    throw new Error(`vault /verify failed: ${vaultVerify.status} ${JSON.stringify(vaultVerify.json)}`);
  }
  log("vault payment verifies");
  const vaultSettle = await postJson(`${opts.facilitatorUrl}/settle`, vaultRequest);
  if (vaultSettle.status !== 200 || vaultSettle.json.success !== true) {
    throw new Error(`vault /settle failed: ${vaultSettle.status} ${JSON.stringify(vaultSettle.json)}`);
  }
  const vaultCheck = await client.verifySettlementOnChain({
    txHash: vaultSettle.json.transaction,
    expectedAsset: contracts.aneTestToken,
    expectedPayee: merchant,
    expectedAmount: PAYMENT,
    expectedVault: vaultAddress,
    expectedPaymentId: signed.paymentId,
  });
  if (!vaultCheck.verified) throw new Error(`vault settlement did not verify: ${vaultCheck.reason}`);
  if ((await client.getTokenBalance(merchant)) !== PAYMENT) throw new Error("merchant did not receive the vault payment");
  log(`vault payment settled in ${vaultSettle.json.transaction} and verified on-chain`);
  const vaultRetry = await postJson(`${opts.facilitatorUrl}/settle`, vaultRequest);
  if (vaultRetry.json.success !== true || vaultRetry.json.extra?.replayed !== true) {
    throw new Error(`vault /settle retry did not replay the receipt: ${JSON.stringify(vaultRetry.json)}`);
  }
  log("vault /settle retry replays the stored receipt");

  // --- exact (EIP-3009) through the facilitator --------------------------------------------
  const payerKey = generateKeypair().secretKey;
  const payer = privateKeyToAddress(payerKey);
  await client.sendContractTx(opts.ownerKey, contracts.aneTestToken, "mint(address,uint256)", [payer, PAYMENT.toString()]);
  const exactMerchant = generateKeypair().address;
  const auth = {
    from: payer,
    to: exactMerchant,
    value: PAYMENT.toString(),
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 300,
    nonce: randomBytes32Hex(),
  };
  const { digest } = hashTransferWithAuthorization(chainId, contracts.aneTestToken, auth);
  const exactRequest = canonicalRequest("exact", network, contracts.aneTestToken, PAYMENT.toString(), exactMerchant, {
    ...auth,
    signature: signDigest(digest, payerKey).serialized,
  });
  const exactVerify = await postJson(`${opts.facilitatorUrl}/verify`, exactRequest);
  if (exactVerify.status !== 200 || exactVerify.json.isValid !== true) {
    throw new Error(`exact /verify failed: ${exactVerify.status} ${JSON.stringify(exactVerify.json)}`);
  }
  log("exact payment verifies");
  const exactSettle = await postJson(`${opts.facilitatorUrl}/settle`, exactRequest);
  if (exactSettle.status !== 200 || exactSettle.json.success !== true) {
    throw new Error(`exact /settle failed: ${exactSettle.status} ${JSON.stringify(exactSettle.json)}`);
  }
  if ((await client.getTokenBalance(exactMerchant)) !== PAYMENT) {
    throw new Error("merchant did not receive the exact payment");
  }
  log(`exact payment settled in ${exactSettle.json.transaction}; payer held no ETH`);

  // --- the indexer follows the directory ---------------------------------------------------
  // Unique per run, so a rerun against the same chain (restart check) waits for its own anchor
  // instead of matching the previous run's record.
  const serviceId = `16ane.standalone.smoke.v1.${Date.now()}`;
  const serviceIdHash = keccak256Utf8(serviceId);
  const manifestUri = "https://merchant.example/.well-known/16ane-service.json";
  const manifestJson = JSON.stringify({ serviceId, endpoint: "https://merchant.example/api" });
  const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
  await client.sendContractTx(opts.ownerKey, contracts.aneServiceDirectory, "anchorService(bytes32,string,bytes32,uint64,uint8)", [
    serviceIdHash,
    manifestUri,
    keccak256Utf8(manifestJson),
    expiresAt.toString(),
    "1",
  ]);
  const anchored = await waitFor(
    async () => ((await (await fetch(`${opts.indexerUrl}/v1/services`)).json()) as { services: Array<Record<string, unknown>> }).services,
    (services) => services.some((s) => s.serviceIdHash === serviceIdHash),
    "the indexer to list the anchor",
    { attempts: 30, delayMs: 1000 },
  );
  const record = anchored.find((s) => s.serviceIdHash === serviceIdHash)!;
  if (record.status !== "ACTIVE" || record.manifestUri !== manifestUri) {
    throw new Error(`unexpected anchor record: ${JSON.stringify(record)}`);
  }
  log("indexer lists the new anchor");
  await client.sendContractTx(opts.ownerKey, contracts.aneServiceDirectory, "setServiceStatus(bytes32,uint8)", [serviceIdHash, "2"]);
  await waitFor(
    async () =>
      ((await (await fetch(`${opts.indexerUrl}/v1/services/${serviceIdHash}`)).json()) as { status: string }).status,
    (status) => status === "PAUSED",
    "the indexer to follow the status update",
    { attempts: 30, delayMs: 1000 },
  );
  log("indexer follows the PAUSED update");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { RPC_URL, REGISTRY_ADDRESS, OWNER_KEY, FACILITATOR_URL, INDEXER_URL, CHAIN_ID } = process.env;
  if (!RPC_URL || !REGISTRY_ADDRESS || !OWNER_KEY || !FACILITATOR_URL || !INDEXER_URL) {
    console.error("Set RPC_URL, REGISTRY_ADDRESS, OWNER_KEY, FACILITATOR_URL and INDEXER_URL.");
    process.exit(2);
  }
  runStandaloneSmoke({
    rpcUrl: RPC_URL,
    registryAddress: REGISTRY_ADDRESS,
    ownerKey: new SecretKey(OWNER_KEY),
    facilitatorUrl: FACILITATOR_URL,
    indexerUrl: INDEXER_URL,
    chainId: CHAIN_ID ? Number(CHAIN_ID) : undefined,
    log: (line) => console.log(`[smoke] ${line}`),
  }).then(
    () => console.log("[smoke] PASS"),
    (err) => {
      console.error(`[smoke] FAIL: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
