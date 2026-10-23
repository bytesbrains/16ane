// The owner's side of the kit (#20). The owner only signs: the sandbox API's relay submits each step and
// pays its gas, so the same commands work on the local sandbox and on the public Base Sepolia sandbox.
//
//   npm run kit:owner -- setup [--network sandbox]   faucet claim, create vault, fund it, delegate a budget
//   npm run kit:owner -- status                       what the vault holds and the agent may still spend
//   npm run kit:owner -- revoke                       end the agent's authority (gasless)
//   npm run kit:owner -- withdraw                     return the vault's tANE to the owner (needs gas)
//
// The budget is enforced by the AneAgentVault contract, not by the agent's code or its prompt: the agent
// key in .kit/agent.key can never spend more than BUDGET in total or PER_PAYMENT at once.
import { pathToFileURL } from "node:url";
import { OwnerWallet } from "../../packages/sdk-ts/src/index.ts";
import {
  addressOf,
  clientFor,
  fundGasIfLocal,
  loadOrCreateKey,
  ONE_TANE,
  publicSandbox,
  readAgent,
  readNetwork,
  SANDBOX_DISCLAIMER,
  tane,
  writeAgent,
  writeNetwork,
  type KitNetwork,
} from "./kit.ts";

export const FUND = 1_600n * ONE_TANE;
export const BUDGET = 320n * ONE_TANE;
export const PER_PAYMENT = 32n * ONE_TANE;

// Public RPCs are load-balanced: a read right after someone else's write can still see the old state.
async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean, what: string): Promise<T> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function relay(net: KitNetwork, action: string, signed: object): Promise<{ vaultAddress?: string }> {
  const res = await fetch(`${net.apiUrl}/v1/relay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...signed }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  });
  const body = (await res.json()) as { vaultAddress?: string; error?: { code: string; message: string } };
  if (res.status !== 201) throw new Error(`relay ${action} failed (${res.status}): ${body.error?.code} ${body.error?.message}`);
  return body;
}

function context(net: KitNetwork) {
  const client = clientFor(net);
  const owner = new OwnerWallet(client, loadOrCreateKey("owner"));
  return { client, owner };
}

export async function setup(net: KitNetwork, log: (line: string) => void = console.log): Promise<{ vaultAddress: string; sessionAddress: string }> {
  const { client, owner } = context(net);
  // The owner only needs the agent's address; the agent key itself is the agent's (buyer.ts, buyer.py).
  const sessionAddress = addressOf(loadOrCreateKey("agent"));
  log(`owner ${owner.address}`);
  log(`agent ${sessionAddress} (its key stays in .kit/agent.key)`);

  // 1. Free test tokens. The claim is signed by the recipient and relayed, so the owner needs no ETH.
  if ((await client.getTokenBalance(owner.address)) < FUND) {
    const claim = await client.signFaucetClaim(loadOrCreateKey("owner"));
    const res = await fetch(`${net.apiUrl}/v1/faucet/claims`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recipient: claim.recipient,
        authorization: { deadline: claim.deadline, nonce: claim.nonce, signature: claim.signature },
      }),
    });
    const body = (await res.json()) as { amount?: string; error?: { code: string; message: string } };
    if (res.status !== 201) throw new Error(`faucet claim failed (${res.status}): ${body.error?.code} ${body.error?.message}`);
    await waitFor(() => client.getTokenBalance(owner.address), (b) => b >= FUND, "the faucet claim");
    log(`1. faucet: claimed ${tane(body.amount ?? "0")}`);
  } else {
    log(`1. faucet: owner already holds ${tane(await client.getTokenBalance(owner.address))}`);
  }

  // 2. The owner's vault, at an address fixed by the owner and a salt.
  const vaultAddress = await client.computeVaultAddress(owner.address, 0n);
  if (!(await client.isContractDeployed(vaultAddress))) {
    await relay(net, "createVault", await owner.signVaultCreation(0n));
    await waitFor(() => client.isContractDeployed(vaultAddress), Boolean, "the vault to deploy");
  }
  log(`2. vault: ${vaultAddress}`);

  // 3. Funding is a signed EIP-3009 transfer from the owner to the vault.
  const held = await client.getTokenBalance(vaultAddress);
  if (held < FUND) {
    await relay(net, "transfer", await owner.signTransfer(vaultAddress, FUND - held));
    await waitFor(() => client.getTokenBalance(vaultAddress), (b) => b >= FUND, "the vault funding");
  }
  log(`3. funded: the vault holds ${tane(await client.getTokenBalance(vaultAddress))}`);

  // 4. Delegation: a FIXED budget, so money the agent earns never raises what it may spend.
  const before = await client.getAccountingSummary(vaultAddress);
  const policy = await owner.signPolicy(vaultAddress, sessionAddress, {
    mode: "FIXED",
    allowanceCap: BUDGET,
    perTxLimit: PER_PAYMENT,
    expiry: Math.floor(Date.now() / 1000) + 24 * 3600,
  });
  await relay(net, "setPolicy", policy);
  const summary = await waitFor(
    () => client.getAccountingSummary(vaultAddress),
    (s) => s.policyVersion > before.policyVersion,
    "the delegation",
  );
  log(`4. delegated: the agent may spend ${tane(summary.spendableNow)} in total, at most ${tane(PER_PAYMENT)} per payment, for 24 hours`);

  writeAgent({ vaultAddress, sessionAddress });
  return { vaultAddress, sessionAddress };
}

export async function status(net: KitNetwork, log: (line: string) => void = console.log) {
  const { client } = context(net);
  const { vaultAddress } = readAgent();
  const s = await client.getAccountingSummary(vaultAddress);
  log(`vault ${vaultAddress}: holds ${tane(s.tokenBalance)}; agent ${s.active ? "active" : "revoked"}, spent ${tane(s.cumulativeSpent)}, may still spend ${tane(s.spendableNow)}`);
  return s;
}

export async function revoke(net: KitNetwork, log: (line: string) => void = console.log): Promise<void> {
  const { client, owner } = context(net);
  const { vaultAddress } = readAgent();
  await relay(net, "revoke", await owner.signRevoke(vaultAddress));
  await waitFor(() => client.getAccountingSummary(vaultAddress), (s) => !s.active, "the revocation");
  log(`revoked: the agent key can no longer spend from ${vaultAddress}`);
}

export async function withdraw(net: KitNetwork, log: (line: string) => void = console.log): Promise<void> {
  const { client, owner } = context(net);
  const { vaultAddress } = readAgent();
  await fundGasIfLocal(net, owner.address);
  if ((await client.getEthBalance(owner.address)) === 0n) {
    throw new Error(`Withdrawing is an owner transaction and needs a little Base Sepolia ETH for gas at ${owner.address}.`);
  }
  const amount = await client.getTokenBalance(vaultAddress);
  if (amount > 0n) await owner.withdrawPrincipal(vaultAddress, owner.address, amount);
  log(`withdrew ${tane(amount)} back to the owner ${owner.address}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, ...args] = process.argv.slice(2);
  const network = args.includes("--network") ? args[args.indexOf("--network") + 1] : undefined;
  if (network === "sandbox") writeNetwork(publicSandbox());
  else if (network !== undefined && network !== "local") throw new Error("--network must be local or sandbox");
  const net = readNetwork();
  console.log(`[${net.name}] ${SANDBOX_DISCLAIMER}`);
  if (command === "setup") await setup(net);
  else if (command === "status") await status(net);
  else if (command === "revoke") await revoke(net);
  else if (command === "withdraw") await withdraw(net);
  else {
    console.error("usage: npm run kit:owner -- setup [--network sandbox] | status | revoke | withdraw");
    process.exitCode = 2;
  }
}
