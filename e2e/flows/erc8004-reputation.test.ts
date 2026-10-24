import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentSession,
  GIVE_FEEDBACK_SIG,
  REPUTATION_CAVEAT,
  SecretKey,
  buildFeedbackFile,
  getAgentIdentity,
  giveFeedbackOnChain,
  keccak256,
  keccak256Utf8,
  privateKeyToAddress,
  readAgentFeedback,
  registerAgentOnChain,
  setAgentWalletOnChain,
  signAgentWalletSet,
  toJsonDataUri,
  verifyProofOfPayment,
} from "../../packages/sdk-ts/src/index.ts";
import {
  DEPLOYER_KEY,
  ONE_TANE,
  OWNER_KEY,
  PEER_OWNER_KEY,
  SESSION_KEY,
  installErc8004Registries,
  setupFundedSession,
  startSandboxStack,
} from "../harness.ts";

const SELLER_KEY = keccak256Utf8("16ane.e2e.erc8004.seller.v1");
const SELLER_WALLET_KEY = keccak256Utf8("16ane.e2e.erc8004.seller-wallet.v1");

// ERC-8004 identity and payment-backed reputation (REQ-202, ADR-0018, ISS-022), against the registries'
// deployed v2.0.0 bytecode: an agent registers pointing at its agent card and vault, a buyer pays a seller
// and attaches the payment to its feedback, and readers re-verify every proof, flagging the ones that fail.
test("ERC-8004: identity bound to a vault, feedback carrying a verified payment (REQ-202)", async (t) => {
  const stack = await startSandboxStack(t);
  await setupFundedSession(stack);
  const { client, vaultAddress } = stack;
  const { identityRegistry, reputationRegistry } = await installErc8004Registries(client);
  const owner = new SecretKey(OWNER_KEY);
  const peer = new SecretKey(PEER_OWNER_KEY);
  const seller = new SecretKey(SELLER_KEY);
  const sellerAddress = privateKeyToAddress(seller);
  const sellerWallet = privateKeyToAddress(new SecretKey(SELLER_WALLET_KEY));
  await client.rpcCall("anvil_setBalance", [sellerAddress, "0x" + (10n * ONE_TANE).toString(16)]);
  const session = new AgentSession({ client, vaultAddress, sessionKey: new SecretKey(SESSION_KEY) });
  const relayer = new SecretKey(DEPLOYER_KEY);
  const chainNow = async () => Number(BigInt((await client.rpcCall<{ timestamp: string }>("eth_getBlockByNumber", ["latest", false])).timestamp));

  const pay = async (merchant: string) => {
    const { intent, signature } = session.signSpendIntent({
      merchant,
      amount: ONE_TANE,
      quoteId: keccak256Utf8(`erc8004 e2e quote ${Math.random()}`),
      serviceIdHash: keccak256Utf8("translation"),
      validBefore: (await chainNow()) + 300,
      policyVersion: await client.getPolicyVersion(vaultAddress),
    });
    return (await client.settleSpendIntentOnChain(relayer, intent, signature)).txHash;
  };

  await t.test("the owner registers its agent: the file points at the agent card and back at its own id; the vault claim verifies", async () => {
    const reg = await registerAgentOnChain(client, owner, {
      name: "e2e buyer agent",
      description: "Buys translations",
      agentCardUrl: "https://buyer.example/.well-known/agent-card.json",
      vault: vaultAddress,
    });
    const identity = await getAgentIdentity(client, reg.agentId);
    assert.equal(identity.owner, privateKeyToAddress(owner));
    assert.equal(identity.vault?.verified, true);
    assert.equal(identity.vault?.address, vaultAddress);
    assert.equal(identity.registrationBindsBack, true);
    assert.equal(identity.registration?.services[0].endpoint, "https://buyer.example/.well-known/agent-card.json");
    assert.equal(identity.registration?.["16ane"]?.vault, `eip155:84532:${vaultAddress}`);
  });

  await t.test("someone else claiming the owner's vault is recorded by the registry but fails verification", async () => {
    await client.rpcCall("anvil_setBalance", [privateKeyToAddress(peer), "0x" + (10n * ONE_TANE).toString(16)]);
    const reg = await registerAgentOnChain(client, peer, {
      name: "impostor",
      description: "Claims a vault it does not own",
      agentCardUrl: "https://impostor.example/.well-known/agent-card.json",
      vault: vaultAddress,
    });
    const identity = await getAgentIdentity(client, reg.agentId);
    assert.equal(identity.vault?.verified, false);
    assert.equal(identity.vault?.reason, "vault is owned by someone else");
  });

  const sellerReg = await registerAgentOnChain(client, seller, {
    name: "e2e seller agent",
    description: "Translates documents",
    agentCardUrl: "https://seller.example/.well-known/agent-card.json",
    serviceManifestUrl: "https://seller.example/.well-known/16ane-service.json",
  });
  const agentId = sellerReg.agentId;

  await t.test("feedback with a verified payment; a stranger's copy of the proof and a reused proof are flagged", async () => {
    const txHash = await pay(sellerAddress);
    const proof = { fromAddress: vaultAddress, toAddress: sellerAddress, txHash };

    // The SDK refuses to publish a proof the reviewer cannot back: the peer controls neither the vault nor its agent.
    await assert.rejects(
      giveFeedbackOnChain(client, peer, { agentId, value: 100, proofOfPayment: proof }),
      /reviewer controls neither the paying vault nor its agent/,
    );
    // Written straight to the registry, the stranger's entry lands on-chain; readers flag it.
    const forged = buildFeedbackFile(84532, identityRegistry, privateKeyToAddress(peer), {
      agentId,
      value: 100,
      proofOfPayment: proof,
    });
    await client.sendContractTx(peer, reputationRegistry, GIVE_FEEDBACK_SIG, [
      agentId.toString(), "100", "0", "", "", "", toJsonDataUri(forged), keccak256(Buffer.from(JSON.stringify(forged), "utf8")),
    ]);

    const given = await giveFeedbackOnChain(client, owner, { agentId, value: 87, tag1: "quality", proofOfPayment: proof });
    assert.equal(given.feedbackIndex, 1n);
    // The same payment again: accepted on-chain, but it proves only the first entry.
    await giveFeedbackOnChain(client, owner, { agentId, value: 99, proofOfPayment: proof });
    // The agent signer can review too: it controls the paying vault.
    const second = await pay(sellerAddress);
    await giveFeedbackOnChain(client, new SecretKey(SESSION_KEY), {
      agentId, value: 4250, valueDecimals: 2, proofOfPayment: { fromAddress: vaultAddress, toAddress: sellerAddress, txHash: second },
    });

    const feedback = await readAgentFeedback(client, { agentId, fromBlock: sellerReg.blockNumber });
    assert.equal(feedback.caveat, REPUTATION_CAVEAT);
    const summary = feedback.entries.map((e) => [e.clientAddress, e.value, e.payment.verified, e.payment.reason ?? ""]);
    assert.deepEqual(summary, [
      [privateKeyToAddress(peer), 100n, false, "reviewer controls neither the paying vault nor its agent"],
      [privateKeyToAddress(owner), 87n, true, ""],
      [privateKeyToAddress(owner), 99n, false, "payment already proves an earlier entry"],
      [session.sessionAddress, 4250n, true, ""],
    ]);
    assert.equal(feedback.entries[1].tag1, "quality");
    assert.equal(feedback.entries[3].valueDecimals, 2);
  });

  await t.test("the registry refuses self-feedback; a revoked entry reads as revoked", async () => {
    const own = buildFeedbackFile(84532, identityRegistry, sellerAddress, {
      agentId, value: 100, proofOfPayment: { fromAddress: sellerAddress, toAddress: sellerAddress, txHash: "0x" + "11".repeat(32) },
    });
    await assert.rejects(
      client.sendContractTx(seller, reputationRegistry, GIVE_FEEDBACK_SIG, [
        agentId.toString(), "100", "0", "", "", "", toJsonDataUri(own), "0x" + "00".repeat(32),
      ]),
    );
    await client.sendContractTx(owner, reputationRegistry, "revokeFeedback(uint256,uint64)", [agentId.toString(), "1"]);
    const feedback = await readAgentFeedback(client, { agentId, fromBlock: sellerReg.blockNumber });
    assert.deepEqual(feedback.entries.map((e) => e.revoked), [false, true, false, false]);
  });

  await t.test("an EOA wallet that signed for the agent becomes a payee a proof can name", async () => {
    const deadline = (await chainNow()) + 120;
    const signature = signAgentWalletSet(84532, identityRegistry, {
      agentId, newWallet: sellerWallet, owner: sellerAddress, deadline,
    }, new SecretKey(SELLER_WALLET_KEY));
    await setAgentWalletOnChain(client, seller, { agentId, newWallet: sellerWallet, deadline, signature });
    assert.equal((await getAgentIdentity(client, agentId)).agentWallet, sellerWallet);

    const txHash = await pay(sellerWallet);
    const proof = { fromAddress: vaultAddress, toAddress: sellerWallet, chainId: "84532", txHash };
    assert.deepEqual(await verifyProofOfPayment(client, { agentId, clientAddress: privateKeyToAddress(owner), proof }), { verified: true });
    // A payment to someone unrelated proves nothing about this agent.
    const elsewhere = await pay(privateKeyToAddress(peer));
    assert.equal(
      (await verifyProofOfPayment(client, {
        agentId, clientAddress: privateKeyToAddress(owner), proof: { ...proof, toAddress: privateKeyToAddress(peer), txHash: elsewhere },
      })).reason,
      "payee is not the agent's owner, wallet or verified vault",
    );
  });
});
