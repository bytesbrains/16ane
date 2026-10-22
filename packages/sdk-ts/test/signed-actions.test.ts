import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  type AneClient,
  BUDGET_MODE,
  createVaultCalldata,
  CREATE_VAULT_SIG,
  encodeCallWithTrailingBytes,
  keccak256Utf8,
  OwnerWallet,
  policyTupleArg,
  relayCreateVault,
  REVOKE_WITH_SIG_SIG,
  revokeCalldata,
  SecretKey,
  SET_POLICY_WITH_SIG_SIG,
  setPolicyCalldata,
  SETTLE_PAYMENT_SIG,
  settlePaymentCalldata,
  toPolicyFields,
  TRANSFER_WITH_AUTHORIZATION_SIG,
  transferCalldata,
} from "../src/index.ts";

const FACTORY = "0x" + "22".repeat(20);
const OWNER_KEY = keccak256Utf8("16ane.test.signed.owner");
const OTHER_KEY = keccak256Utf8("16ane.test.signed.other");

// Enough of an AneClient to sign with and to record what a relayer would send; nothing reaches a chain.
function fakeClient(chainId = 84532) {
  const sent: Array<{ to: string; signature: string; args: string[] }> = [];
  const client = {
    chainId,
    resolveContracts: async () => ({ aneVaultFactory: FACTORY }),
    computeVaultAddress: async () => "0x" + "77".repeat(20),
    sendContractTx: async (_key: SecretKey, to: string, signature: string, args: string[]) => {
      sent.push({ to, signature, args });
      return { txHash: "0x" + "ab".repeat(32), blockNumber: 3, status: 1 };
    },
  } as unknown as AneClient;
  return { client, sent };
}

test("relayCreateVault sends only a creation the owner signed, before its deadline", async () => {
  const { client, sent } = fakeClient();
  const owner = new OwnerWallet(client, OWNER_KEY);
  const relayer = new SecretKey(keccak256Utf8("16ane.test.signed.relayer"));

  const signed = await owner.signVaultCreation(7n);
  const res = await relayCreateVault(client, relayer, signed);
  assert.equal(res.vaultAddress, "0x" + "77".repeat(20));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, FACTORY);
  assert.deepEqual(sent[0].args, [owner.address, signed.salt]);

  const someoneElse = await new OwnerWallet(client, OTHER_KEY).signVaultCreation(7n);
  await assert.rejects(relayCreateVault(client, relayer, { ...someoneElse, owner: owner.address }), /not signed by the owner/);
  await assert.rejects(relayCreateVault(client, relayer, { ...signed, salt: "0x" + "01".repeat(32) }), /not signed by the owner/);
  await assert.rejects(relayCreateVault(client, relayer, signed, signed.deadline), /deadline has passed/);
  await assert.rejects(relayCreateVault(client, relayer, { ...signed, signature: "0x1234" }), /signature is invalid/);
  // Bound to the chain: the same signature presented on another chain recovers someone else.
  await assert.rejects(relayCreateVault(fakeClient(1).client, relayer, signed), /not signed by the owner/);
  assert.equal(sent.length, 1, "no refused creation was sent");
});

test("toPolicyFields keeps delegateSession's defaults and policyTupleArg its tuple format", () => {
  const session = "0x" + "ab".repeat(20);
  const fixed = toPolicyFields(session, { allowanceCap: 320n, perTxLimit: "64", expiry: 1_900_000_000 });
  assert.deepEqual(fixed, {
    agentSigner: "0xABaBaBaBABabABabAbAbABAbABabababaBaBABaB",
    maxTotalSpend: 320n,
    maxPerTx: 64n,
    dailyLimit: 320n, // defaults to the allowance cap
    expiry: 1_900_000_000,
    budgetMode: BUDGET_MODE.FIXED,
    revolvingTreasuryCeiling: 320n, // defaults to the allowance cap
  });
  assert.equal(policyTupleArg(fixed), "(0xABaBaBaBABabABabAbAbABAbABabababaBaBABaB,320,64,320,1900000000,0,320)");

  const revolving = toPolicyFields(session, {
    mode: "REVOLVING",
    allowanceCap: "1000",
    perTxLimit: 10n,
    dailyLimit: "50",
    expiry: 1_900_000_000,
    revolvingTreasuryCeiling: 5_000n,
  });
  assert.equal(revolving.budgetMode, BUDGET_MODE.REVOLVING);
  assert.equal(revolving.dailyLimit, 50n);
  assert.equal(revolving.revolvingTreasuryCeiling, 5_000n);
});

// Each calldata builder must match Foundry's encoder exactly: the relay server simulates with it before paying.
test("calldata builders match cast calldata", () => {
  const cast = (sig: string, ...args: string[]) => execFileSync("cast", ["calldata", sig, ...args], { encoding: "utf8" }).trim();
  const sig65 = "0x" + "ab".repeat(32) + "cd".repeat(32) + "1b";
  const a = "0x" + "11".repeat(20);
  const b = "0x" + "22".repeat(20);
  const nonce = "0x" + "33".repeat(32);

  assert.equal(
    transferCalldata({ from: a, to: b, value: 16n * 10n ** 18n, validAfter: 0, validBefore: 1_900_000_000, nonce, signature: sig65 }),
    cast(TRANSFER_WITH_AUTHORIZATION_SIG, a, b, "16000000000000000000", "0", "1900000000", nonce, sig65),
  );
  const policy = toPolicyFields(b, { mode: "REVOLVING", allowanceCap: 320n, perTxLimit: 64n, dailyLimit: 100n, expiry: 1_900_000_000, revolvingTreasuryCeiling: 999n });
  assert.equal(
    setPolicyCalldata({ vault: a, policy, expectedPolicyVersion: 3, deadline: 1_900_000_100, signature: sig65 }),
    cast(SET_POLICY_WITH_SIG_SIG, policyTupleArg(policy), "3", "1900000100", sig65),
  );
  assert.equal(
    revokeCalldata({ vault: a, expectedPolicyVersion: 4, deadline: 1_900_000_200, signature: sig65 }),
    cast(REVOKE_WITH_SIG_SIG, "4", "1900000200", sig65),
  );
  assert.equal(createVaultCalldata(a, nonce), cast(CREATE_VAULT_SIG, a, nonce));
  const intent = {
    vault: a,
    merchant: b,
    amount: 16n * 10n ** 18n,
    quoteId: nonce,
    serviceIdHash: keccak256Utf8("demo"),
    validAfter: 0,
    validBefore: 1_900_000_000,
    nonce,
    policyVersion: 1,
  };
  assert.equal(
    settlePaymentCalldata(intent, sig65),
    cast(
      SETTLE_PAYMENT_SIG,
      `(${a},${b},16000000000000000000,${nonce},${keccak256Utf8("demo")},0,1900000000,${nonce},1)`,
      sig65,
    ),
  );
});

test("encodeCallWithTrailingBytes rejects a malformed static word", () => {
  assert.throws(
    () => encodeCallWithTrailingBytes(REVOKE_WITH_SIG_SIG, ["not-a-word"], "0xab"),
    /Invalid static ABI word/,
  );
  assert.throws(
    () => encodeCallWithTrailingBytes(REVOKE_WITH_SIG_SIG, ["0x" + "11".repeat(32)], "0xab"),
    /Invalid static ABI word/,
  );
});

