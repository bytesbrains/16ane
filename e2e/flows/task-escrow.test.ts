import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentSession,
  SecretKey,
  getEscrowTask,
  keccak256Utf8,
  openTaskOnChain,
  privateKeyToAddress,
  reclaimTaskOnChain,
  releaseTaskOnChain,
  signTaskLock,
  signTaskRelease,
} from "../../packages/sdk-ts/src/index.ts";
import { DEPLOYER_KEY, ONE_TANE, SESSION_KEY, setupFundedSession, startSandboxStack } from "../harness.ts";

const SELLER_KEY = keccak256Utf8("16ane.e2e.escrow.seller.v1");

// An asynchronous task through AneTaskEscrow with the SDK (REQ-201, ADR-0009, ISS-021): the agent locks
// tANE within its vault's policy, pays a milestone by signed receipt, and after the deadline the rest goes
// back to the vault and restores the agent's budget.
test("async task escrow: lock within budget, milestone release, reclaim after deadline (REQ-201)", async (t) => {
  const stack = await startSandboxStack(t);
  await setupFundedSession(stack);
  const { client, vaultAddress, taskEscrowAddress: escrow } = stack;
  const seller = new SecretKey(SELLER_KEY);
  const sellerAddress = privateKeyToAddress(seller);
  // The seller submits the lock and the receipt, so it pays a little gas: free test ETH on Anvil.
  await client.rpcCall("anvil_setBalance", [sellerAddress, "0x" + (10n * ONE_TANE).toString(16)]);
  const session = new AgentSession({ client, vaultAddress, sessionKey: new SecretKey(SESSION_KEY) });

  const chainNow = async () => Number(BigInt((await client.rpcCall<{ timestamp: string }>("eth_getBlockByNumber", ["latest", false])).timestamp));
  const before = await client.getAccountingSummary(vaultAddress);
  const deadline = (await chainNow()) + 600;
  const lock = await signTaskLock(session, escrow, {
    amount: 64n * ONE_TANE,
    terms: { seller: sellerAddress, deadline, specHash: keccak256Utf8("translate 40 pages; e2e task 1") },
    serviceIdHash: keccak256Utf8("translation"),
    validBefore: (await chainNow()) + 300,
  });

  await t.test("the seller opens the task with the agent's signed lock; the vault's budget bounds it", async () => {
    await openTaskOnChain(client, seller, escrow, lock);
    const task = await getEscrowTask(client, escrow, lock.taskId);
    assert.equal(task.vault, vaultAddress);
    assert.equal(task.seller, sellerAddress);
    assert.equal(task.amount, 64n * ONE_TANE);
    assert.equal(task.deadline, deadline);
    assert.equal(task.closed, false);
    const after = await client.getAccountingSummary(vaultAddress);
    assert.equal(after.cumulativeSpent, before.cumulativeSpent + 64n * ONE_TANE);
    assert.equal(await client.getTokenBalance(escrow), 64n * ONE_TANE);

    // Over the vault's 64 tANE per-payment limit: the vault refuses the lock, nothing moves.
    const tooBig = await signTaskLock(session, escrow, {
      amount: 65n * ONE_TANE,
      terms: { seller: sellerAddress, deadline, specHash: keccak256Utf8("e2e task 2") },
      serviceIdHash: keccak256Utf8("translation"),
      validBefore: (await chainNow()) + 300,
    });
    await assert.rejects(openTaskOnChain(client, seller, escrow, tooBig));
    assert.equal(await client.getTokenBalance(escrow), 64n * ONE_TANE);
  });

  await t.test("a milestone receipt from the agent pays the seller 24 tANE; a forged one pays nothing", async () => {
    const release = { taskId: lock.taskId, cumulativeAmount: 24n * ONE_TANE, deliveryHash: keccak256Utf8("chapters 1-15") };
    const forged = signTaskRelease(client.chainId, escrow, release, seller);
    await assert.rejects(releaseTaskOnChain(client, seller, escrow, release, forged));

    const receipt = signTaskRelease(client.chainId, escrow, release, new SecretKey(SESSION_KEY));
    await releaseTaskOnChain(client, seller, escrow, release, receipt);
    assert.equal(await client.getTokenBalance(sellerAddress), 24n * ONE_TANE);
    assert.equal((await getEscrowTask(client, escrow, lock.taskId)).released, 24n * ONE_TANE);
  });

  await t.test("after the deadline anyone returns the other 40 tANE, and the agent's budget comes back", async () => {
    await assert.rejects(reclaimTaskOnChain(client, new SecretKey(DEPLOYER_KEY), escrow, lock.taskId), "not before the deadline");
    await client.rpcCall("evm_increaseTime", [700]);
    await client.rpcCall("evm_mine", []);

    await reclaimTaskOnChain(client, new SecretKey(DEPLOYER_KEY), escrow, lock.taskId);
    const after = await client.getAccountingSummary(vaultAddress);
    assert.equal(after.cumulativeSpent, before.cumulativeSpent + 24n * ONE_TANE, "only the delivered milestone stays spent");
    assert.equal(after.tokenBalance, before.tokenBalance - 24n * ONE_TANE);
    assert.equal(await client.getTokenBalance(escrow), 0n);
    assert.equal((await getEscrowTask(client, escrow, lock.taskId)).closed, true);
    const record = await client.getPaymentRecord(vaultAddress, lock.taskId);
    assert.equal(record.amountRefunded, 40n * ONE_TANE);
  });
});
