import test from "node:test";
import assert from "node:assert/strict";
import {
  type AneClient,
  BUDGET_MODE,
  keccak256Utf8,
  OwnerWallet,
  policyTupleArg,
  relayCreateVault,
  SecretKey,
  toPolicyFields,
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
