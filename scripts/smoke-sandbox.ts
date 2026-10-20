// End-to-end smoke test for a deployed sandbox: Base Sepolia after DeploySandbox, or a local Anvil chain.
// It spends a little testnet gas from one funded owner key (docs/operations/DEPLOY_SANDBOX.md):
//   RPC_URL=... REGISTRY_ADDRESS=0x... SMOKE_OWNER_KEY=0x... \
//     node --experimental-strip-types scripts/smoke-sandbox.ts
// Optional: CHAIN_ID (default 84532). Needs Foundry's `cast` on PATH, like the SDK.
import {
  AgentSession,
  AneClient,
  generateKeypair,
  keccak256Utf8,
  OwnerWallet,
  SecretKey,
} from "../packages/sdk-ts/src/index.ts";
import { readFaucetConfig } from "../services/sandbox-server/src/faucet.ts";

const ONE_TANE = 10n ** 18n;
const PAYMENT = 16n * ONE_TANE;

// Public load-balanced RPCs can answer a read from a node that hasn't seen our latest confirmed transaction
// yet. Poll until the read reflects our own write instead of trusting the first answer.
async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let attempt = 0; attempt < 15; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export interface SmokeOptions {
  rpcUrl: string;
  registryAddress: string;
  ownerKey: SecretKey;
  chainId?: number;
  log?: (line: string) => void;
}

export interface SmokeResult {
  contracts: Awaited<ReturnType<AneClient["resolveContracts"]>>;
  vaultAddress: string;
  merchant: string;
  paymentTxHash: string;
}

export async function runSmoke(opts: SmokeOptions): Promise<SmokeResult> {
  const log = opts.log ?? (() => {});
  const client = new AneClient({ rpcUrl: opts.rpcUrl, chainId: opts.chainId ?? 84532, registryAddress: opts.registryAddress });

  const contracts = await client.resolveContracts();
  log(`registry -> token ${contracts.aneTestToken}, factory ${contracts.aneVaultFactory}, faucet ${contracts.aneFaucet}`);
  const faucet = await readFaucetConfig(client, contracts.aneFaucet);
  log(`faucet: ${faucet.claimAmount / ONE_TANE} tANE per claim, ${faucet.cooldownSeconds}s cooldown per recipient`);

  const owner = new OwnerWallet(client, opts.ownerKey);
  try {
    await client.executeFaucetClaimOnChain(opts.ownerKey, owner.address);
    log(`claimed ${faucet.claimAmount / ONE_TANE} tANE for ${owner.address}`);
  } catch (err) {
    // A rerun inside the cooldown is fine if the owner still holds enough to fund the vault.
    if ((await client.getTokenBalance(owner.address)) < PAYMENT) throw err;
    log("faucet claim skipped (cooldown active); using the owner's existing balance");
  }

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
  log(`vault ${vaultAddress} funded with 16 tANE and delegated to session ${session.sessionAddress}`);

  // The owner key relays the agent's signed intent, so only one funded key is needed.
  const merchant = generateKeypair().address;
  const signed = session.signSpendIntent({
    merchant,
    amount: PAYMENT,
    quoteId: keccak256Utf8(`smoke-${Date.now()}`),
    serviceIdHash: keccak256Utf8("16ane.smoke.v1"),
    validBefore: Math.floor(Date.now() / 1000) + 300,
    policyVersion: await waitFor(
      () => client.getPolicyVersion(vaultAddress),
      (version) => version > versionBefore,
      "the new delegation's policy version",
    ),
  });
  const settled = await client.settleSpendIntentOnChain(opts.ownerKey, signed.intent, signed.signature);
  const check = await waitFor(
    () =>
      client.verifySettlementOnChain({
        txHash: settled.txHash,
        expectedPayee: merchant,
        expectedAmount: PAYMENT,
        expectedVault: vaultAddress,
        expectedPaymentId: signed.paymentId,
      }),
    // Both reasons can be a lagging node that hasn't seen the settlement yet; anything else is a real failure.
    (result) =>
      result.verified ||
      !["Transaction receipt not found", "Payment ID not recorded in AneAgentVault"].includes(result.reason ?? ""),
    "the payment receipt and record",
  );
  if (!check.verified) throw new Error(`payment ${settled.txHash} did not verify: ${check.reason ?? "unknown"}`);
  log(`paid 16 tANE to ${merchant} in ${settled.txHash}; verified on-chain`);

  await owner.revokeSession(vaultAddress);
  log("session revoked");
  return { contracts, vaultAddress, merchant, paymentTxHash: settled.txHash };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { RPC_URL, REGISTRY_ADDRESS, SMOKE_OWNER_KEY, CHAIN_ID } = process.env;
  if (!RPC_URL || !REGISTRY_ADDRESS || !SMOKE_OWNER_KEY) {
    console.error("Set RPC_URL, REGISTRY_ADDRESS and SMOKE_OWNER_KEY (see docs/operations/DEPLOY_SANDBOX.md).");
    process.exit(2);
  }
  runSmoke({
    rpcUrl: RPC_URL,
    registryAddress: REGISTRY_ADDRESS,
    ownerKey: new SecretKey(SMOKE_OWNER_KEY),
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
