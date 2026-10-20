import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentSession,
  hashVaultCreation,
  keccak256Utf8,
  OwnerWallet,
  recoverAddress,
  relayCreateVault,
  relayRevoke,
  relaySetPolicy,
  relayTransfer,
  SecretKey,
} from "../packages/sdk-ts/src/index.ts";
import { DEPLOYER_KEY, signedClaimBody, startSandboxStack } from "./harness.ts";

const ONE_TANE = 10n ** 18n;

// #77 with the SDK alone, on a real chain: an owner and an agent that never hold ETH. The owner signs; a relayer
// (the deployer key here) submits and pays the gas for every step: vault creation, funding by an EIP-3009
// transfer, delegation (setPolicyWithSig), and revocation (revokeWithSig). The agent's payment is relayed by the
// merchant through x402, as it always has been.
test("an owner and agent with no ETH: claim, create, fund, delegate, pay, revoke", async (t) => {
  const { client, sandbox, contracts } = await startSandboxStack(t);
  const relayer = new SecretKey(DEPLOYER_KEY);
  const ownerKey = keccak256Utf8("16ane.e2e.gasless.owner.v1");
  const owner = new OwnerWallet(client, ownerKey);
  const agent = new SecretKey(keccak256Utf8("16ane.e2e.gasless.agent.v1"));
  const ethOf = (address: string) => client.getEthBalance(address);
  assert.equal(await ethOf(owner.address), 0n);

  // 1. tANE from the faucet, by a signed claim (#79).
  const claim = await fetch(`${sandbox.url}/v1/faucet/claims`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await signedClaimBody(client, ownerKey),
  });
  assert.equal(claim.status, 201);
  assert.equal(await client.getTokenBalance(owner.address), 16_000n * ONE_TANE);

  // 2. Vault creation: the factory needs no signature, but the relay server will check this one.
  const creation = await owner.signVaultCreation(7n);
  assert.equal(
    recoverAddress(hashVaultCreation(client.chainId, contracts.aneVaultFactory, owner.address, creation.salt, creation.deadline), creation.signature),
    owner.address,
  );
  const { vaultAddress } = await relayCreateVault(client, relayer, creation);
  assert.equal(vaultAddress, await client.computeVaultAddress(owner.address, creation.salt));
  assert.ok(await client.isContractDeployed(vaultAddress));

  // 3. Funding: an EIP-3009 transfer into the vault (fundWithPermit can't be relayed).
  await relayTransfer(client, relayer, await owner.signTransfer(vaultAddress, 1_600n * ONE_TANE));
  assert.equal(await client.getTokenBalance(vaultAddress), 1_600n * ONE_TANE);
  assert.equal(await client.getTokenBalance(owner.address), 14_400n * ONE_TANE);

  // 4. Delegation, signed for the vault's current policy version.
  const session = new AgentSession({ client, vaultAddress, sessionKey: agent });
  const policy = await owner.signPolicy(vaultAddress, session.sessionAddress, {
    allowanceCap: 320n * ONE_TANE,
    perTxLimit: 64n * ONE_TANE,
    expiry: Math.floor(Date.now() / 1000) + 3600,
  });
  await relaySetPolicy(client, relayer, policy);
  const summary = await client.getAccountingSummary(vaultAddress);
  assert.equal(summary.agentSigner, session.sessionAddress);
  assert.equal(summary.active, true);
  assert.equal(summary.policyVersion, policy.expectedPolicyVersion + 1);

  // 5. The agent pays through x402; the merchant relays the settlement.
  const idemKey = "idem-gasless-001";
  const paid = await session.purchase(`${sandbox.url}/v1/demo/summarize`, {
    method: "POST",
    body: JSON.stringify({ text: "Sixteen annas made a rupee." }),
    idempotencyKey: idemKey,
    maxPayment: 32n * ONE_TANE,
  });
  assert.equal(paid.status, 200);
  assert.equal((await client.getAccountingSummary(vaultAddress)).cumulativeSpent, 16n * ONE_TANE);

  // 6. Revocation, signed for the policy version the delegation produced.
  await relayRevoke(client, relayer, await owner.signRevoke(vaultAddress));
  assert.equal((await client.getAccountingSummary(vaultAddress)).active, false);

  assert.equal(await ethOf(owner.address), 0n, "the owner never held ETH");
  assert.equal(await ethOf(session.sessionAddress), 0n, "the agent never held ETH");
});
