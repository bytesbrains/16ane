// AneTaskEscrow helpers (#21): the hashes match an independent encoding by Foundry's `cast`, receipts recover
// to their signer, and the calls an agent or seller sends are exactly the contract's ABI. The e2e flow
// (e2e/flows/task-escrow.test.ts) checks the same hashes against the deployed contract.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  AgentSession,
  type AneClient,
  CANCEL_TASK_SIG,
  cancelTaskOnChain,
  computePaymentId,
  computeTaskId,
  computeTaskQuoteId,
  getEscrowTask,
  hashTaskRelease,
  keccak256Utf8,
  OPEN_TASK_SIG,
  openTaskOnChain,
  privateKeyToAddress,
  RECLAIM_TASK_SIG,
  reclaimTaskOnChain,
  recoverAddress,
  RELEASE_TASK_SIG,
  releaseTaskOnChain,
  SecretKey,
  signTaskLock,
  signTaskRelease,
  TASK_RELEASE_TYPEHASH,
  TASK_TERMS_TYPEHASH,
} from "../src/index.ts";

const ESCROW = "0x" + "e5".repeat(20);
const VAULT = "0x" + "77".repeat(20);
const SELLER = "0x" + "5e".repeat(20);
const SPEC = keccak256Utf8("translate 40 pages; task 1");
const AGENT_KEY = new SecretKey(keccak256Utf8("16ane.test.escrow.agent"));
const cast = (...args: string[]) => execFileSync("cast", args, { encoding: "utf8" }).trim();

// Records what would be sent; answers the two reads the helpers make.
function fakeClient(chainId = 84532) {
  const sent: Array<{ to: string; signature: string; args: string[] }> = [];
  const client = {
    chainId,
    getPolicyVersion: async () => 4,
    ethCall: async () =>
      "0x" +
      [VAULT, SELLER].map((a) => a.slice(2).padStart(64, "0")).join("") +
      [100n * 10n ** 18n, 40n * 10n ** 18n, 1_700_259_200n].map((n) => n.toString(16).padStart(64, "0")).join("") +
      SPEC.slice(2) +
      "1".padStart(64, "0"),
    sendContractTx: async (_key: SecretKey, to: string, signature: string, args: string[]) => {
      sent.push({ to, signature, args });
      return { txHash: "0x" + "ab".repeat(32), blockNumber: 3, status: 1 };
    },
  } as unknown as AneClient;
  return { client, sent };
}

test("type hashes are the contract's", () => {
  assert.equal(TASK_TERMS_TYPEHASH, cast("keccak", "TaskTerms(address escrow,address seller,uint64 deadline,bytes32 specHash)"));
  assert.equal(TASK_RELEASE_TYPEHASH, cast("keccak", "Release(bytes32 taskId,uint256 cumulativeAmount,bytes32 deliveryHash)"));
});

test("the task quoteId commits to the escrow, seller, deadline and spec", () => {
  const terms = { seller: SELLER, deadline: 1_700_259_200, specHash: SPEC };
  const encoded = cast("abi-encode", "f(bytes32,address,address,uint64,bytes32)", TASK_TERMS_TYPEHASH, ESCROW, SELLER, "1700259200", SPEC);
  const quoteId = computeTaskQuoteId(ESCROW, terms);
  assert.equal(quoteId, cast("keccak", encoded));
  for (const changed of [
    { ...terms, seller: "0x" + "5f".repeat(20) },
    { ...terms, deadline: terms.deadline + 1 },
    { ...terms, specHash: keccak256Utf8("another job") },
  ]) {
    assert.notEqual(computeTaskQuoteId(ESCROW, changed), quoteId);
  }
  assert.notEqual(computeTaskQuoteId("0x" + "e6".repeat(20), terms), quoteId, "bound to one escrow");
});

test("a delivery receipt is an EIP-712 digest under the escrow's domain and recovers to its signer", () => {
  const release = { taskId: "0x" + "1d".repeat(32), cumulativeAmount: 40n * 10n ** 18n, deliveryHash: keccak256Utf8("chapter 1") };
  const domain = cast(
    "keccak",
    cast(
      "abi-encode",
      "f(bytes32,bytes32,bytes32,uint256,address)",
      cast("keccak", "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
      cast("keccak", "AneTaskEscrow"),
      cast("keccak", "1"),
      "84532",
      ESCROW,
    ),
  );
  const struct = cast(
    "keccak",
    cast("abi-encode", "f(bytes32,bytes32,uint256,bytes32)", TASK_RELEASE_TYPEHASH, release.taskId, release.cumulativeAmount.toString(), release.deliveryHash),
  );
  const digest = hashTaskRelease(84532, ESCROW, release);
  assert.equal(digest, cast("keccak", "0x1901" + domain.slice(2) + struct.slice(2)));
  assert.notEqual(hashTaskRelease(31337, ESCROW, release), digest, "bound to one chain");

  const signature = signTaskRelease(84532, ESCROW, release, AGENT_KEY);
  assert.equal(recoverAddress(digest, signature), privateKeyToAddress(AGENT_KEY));
});

test("signTaskLock signs a SpendIntent to the escrow under the vault's current policy version", async () => {
  const { client } = fakeClient();
  const session = new AgentSession({ client, vaultAddress: VAULT, sessionKey: AGENT_KEY });
  const terms = { seller: SELLER, deadline: 1_700_259_200, specHash: SPEC };
  const lock = await signTaskLock(session, ESCROW, {
    amount: 100n * 10n ** 18n,
    terms,
    serviceIdHash: keccak256Utf8("translation"),
    validBefore: 1_700_003_600,
    nonce: "0x" + "01".repeat(32),
  });
  assert.equal(lock.intent.merchant.toLowerCase(), ESCROW);
  assert.equal(lock.intent.quoteId, computeTaskQuoteId(ESCROW, terms));
  assert.equal(lock.intent.policyVersion, 4, "read from the vault, not the default");
  assert.equal(lock.taskId, computeTaskId(84532, lock.intent.vault, ESCROW, lock.intent.quoteId, lock.intent.nonce));
  assert.equal(lock.taskId, computePaymentId(84532, lock.intent.vault, ESCROW, lock.intent.quoteId, lock.intent.nonce));
});

test("open, release, reclaim and cancel send the contract's exact calls", async () => {
  const { client, sent } = fakeClient();
  const session = new AgentSession({ client, vaultAddress: VAULT, sessionKey: AGENT_KEY });
  const lock = await signTaskLock(session, ESCROW, {
    amount: 100n,
    terms: { seller: SELLER, deadline: 1_700_259_200, specHash: SPEC },
    serviceIdHash: keccak256Utf8("translation"),
    validBefore: 1_700_003_600,
  });
  const submitter = new SecretKey(keccak256Utf8("16ane.test.escrow.relayer"));
  const release = { taskId: lock.taskId, cumulativeAmount: 40n, deliveryHash: keccak256Utf8("d") };

  await openTaskOnChain(client, submitter, ESCROW, lock);
  await releaseTaskOnChain(client, submitter, ESCROW, release, "0x" + "ab".repeat(65));
  await releaseTaskOnChain(client, submitter, ESCROW, release);
  await reclaimTaskOnChain(client, submitter, ESCROW, lock.taskId);
  await cancelTaskOnChain(client, submitter, ESCROW, lock.taskId);

  assert.deepEqual(
    sent.map((s) => [s.to, s.signature]),
    [OPEN_TASK_SIG, RELEASE_TASK_SIG, RELEASE_TASK_SIG, RECLAIM_TASK_SIG, CANCEL_TASK_SIG].map((sig) => [ESCROW, sig]),
  );
  // Each call encodes with cast: the argument shapes match the signatures.
  for (const s of sent) assert.match(cast("calldata", s.signature, ...s.args), /^0x[0-9a-f]{8}/);
  assert.equal(cast("sig", OPEN_TASK_SIG), cast("sig", "openTask((address,address,uint256,bytes32,bytes32,uint256,uint256,bytes32,uint64),bytes,address,uint64,bytes32)"));
  assert.equal(sent[2].args[3], "0x", "no receipt: the sender is the approver");
});

test("getEscrowTask decodes the tasks() getter", async () => {
  const { client } = fakeClient();
  const task = await getEscrowTask(client, ESCROW, "0x" + "1d".repeat(32));
  assert.equal(task.vault.toLowerCase(), VAULT);
  assert.equal(task.seller.toLowerCase(), SELLER);
  assert.equal(task.amount, 100n * 10n ** 18n);
  assert.equal(task.released, 40n * 10n ** 18n);
  assert.equal(task.deadline, 1_700_259_200);
  assert.equal(task.specHash, SPEC);
  assert.equal(task.closed, true);
});
