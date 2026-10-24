import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  AgentSession,
  AnePaymentVerifier,
  MultiAssetSession,
  SecretKey,
  keccak256Utf8,
  privateKeyToAddress,
  toChecksumAddress,
} from "../../packages/sdk-ts/src/index.ts";
import { DEPLOYER_KEY, ONE_TANE, SESSION_KEY, setupFundedSession, startSandboxStack } from "../harness.ts";

const ONE_TSIX = 10n ** 6n;

// SCENARIOS.md S3 provider routing (#23, REQ-203, REQ-204, ADR-0019): two sellers offer the same capability at
// different prices and quote latencies; the agent probes both without paying, picks the one that meets its
// (max_price, max_latency, asset) constraints, and buys from it pinned to the winning quote. A seller quoting in
// another asset is never chosen, and a seller that raises its price after winning is refused before any payment.
// With a second vault in tSIX (#133, ADR-0020), a tSIX seller wins under a tSIX preference and that vault pays it.
test("S3: the agent routes to the provider that meets its constraints and pays only the winning quote", async (t) => {
  const stack = await startSandboxStack(t);
  await setupFundedSession(stack, { cap: 100n * ONE_TANE, perTx: 64n * ONE_TANE });
  const { client, contracts, vaultAddress, session, owner, secondAsset } = stack;

  // A seller built on the SDK's own verifier. `price` may change per quote; `delayMs` slows only the quote.
  const startSeller = async (name: string, opts: { price: (quoteNo: number) => bigint; delayMs?: number; asset?: string }) => {
    const key = new SecretKey(keccak256Utf8(`16ane.e2e.router.${name}`));
    const payTo = privateKeyToAddress(key);
    await client.rpcCall("anvil_setBalance", [payTo, "0x" + (10n ** 18n).toString(16)]);
    const verifier = new AnePaymentVerifier({ client, relayerKey: key });
    let quotes = 0;
    const endpointFor = (price: bigint) => ({
      serviceId: "demo-inference",
      priceAmount: price,
      payTo,
      assetAddress: opts.asset ?? contracts.aneTestToken,
      network: "eip155:84532" as const,
    });
    let lastPrice = 0n;
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const url = `http://${req.headers.host}${req.url}`;
      const payment = req.headers["payment-signature"] as string | undefined;
      if (!payment) {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        lastPrice = opts.price(++quotes);
        const quote = verifier.build402Challenge(endpointFor(lastPrice), url);
        res.writeHead(quote.status, quote.headers).end(JSON.stringify(quote.body));
        return;
      }
      const settled = await verifier.verifyAndSettle({
        paymentSignatureHeader: payment,
        endpoint: endpointFor(lastPrice),
        method: "POST",
        canonicalUrl: url,
        rawBody,
        idempotencyKey: req.headers["idempotency-key"] as string | undefined,
      });
      if (!settled.ok) {
        res.writeHead(settled.status).end(JSON.stringify({ error: settled.code }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "payment-response": settled.receiptHeaderB64 });
      res.end(JSON.stringify({ seller: name }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}/v1/infer`, payTo };
  };

  const cheapSlow = await startSeller("cheap-slow", { price: () => 8n * ONE_TANE, delayMs: 600 });
  const fast = await startSeller("fast", { price: () => 12n * ONE_TANE });
  // Cheapest of all in raw base units, but in a token this vault cannot hold.
  const otherAsset = await startSeller("other-asset", { price: () => 1n, asset: toChecksumAddress("0x" + "b2".repeat(20)) });
  const candidates = [
    { providerId: "cheap-slow", url: cheapSlow.url, method: "POST" as const, body: "{}" },
    { providerId: "fast", url: fast.url, method: "POST" as const, body: "{}" },
    { providerId: "other-asset", url: otherAsset.url, method: "POST" as const, body: "{}" },
  ];

  await t.test("without a latency bound the cheaper seller wins; the foreign-asset quote is refused", async () => {
    const route = await session.chooseProvider(candidates, { maxPayment: 16n * ONE_TANE });
    assert.equal(route.chosen?.providerId, "cheap-slow");
    assert.deepEqual(route.ranked.map((o) => o.providerId), ["cheap-slow", "fast"]);
    assert.deepEqual(route.rejected.map((r) => [r.providerId, r.reason]), [
      ["other-asset", `asset ${toChecksumAddress("0x" + "b2".repeat(20))} is not accepted`],
    ]);
  });

  await t.test("with max_latency the fast seller wins, and the routed purchase pays it exactly its quote", async () => {
    const route = await session.chooseProvider(candidates, { maxPayment: 16n * ONE_TANE, maxLatencyMs: 300 });
    assert.equal(route.chosen?.providerId, "fast");
    assert.match(route.rejected.find((r) => r.providerId === "cheap-slow")!.reason, /^latency \d+ms exceeds 300ms$/);

    const before = await client.getTokenBalance(fast.payTo);
    const res = await session.purchaseRouted(route.chosen!, { body: "{}", verifyReceiptOnChain: true });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { seller: "fast" });
    assert.equal(res.receipt?.amount, (12n * ONE_TANE).toString());
    assert.equal((await client.getTokenBalance(fast.payTo)) - before, 12n * ONE_TANE);
  });

  await t.test("no seller under max_price: nothing is chosen and nothing is paid", async () => {
    const route = await session.chooseProvider(candidates, { maxPayment: 5n * ONE_TANE });
    assert.equal(route.chosen, undefined);
    assert.equal(route.rejected.length, 3);
  });

  await t.test("a seller that raises its price after winning the route is refused before any payment", async () => {
    const baitAndSwitch = await startSeller("bait", { price: (n) => (n === 1 ? 4n * ONE_TANE : 40n * ONE_TANE) });
    const route = await session.chooseProvider(
      [...candidates, { providerId: "bait", url: baitAndSwitch.url, method: "POST" as const, body: "{}" }],
      { maxPayment: 64n * ONE_TANE },
    );
    assert.equal(route.chosen?.providerId, "bait");
    const spendable = (await client.getAccountingSummary(vaultAddress)).spendableNow;
    await assert.rejects(session.purchaseRouted(route.chosen!, { body: "{}" }), /ANE-E-3002/);
    assert.equal((await client.getAccountingSummary(vaultAddress)).spendableNow, spendable);
    assert.equal(await client.getTokenBalance(baitAndSwitch.payTo), 0n);
  });

  await t.test("with a tSIX vault, a tSIX preference routes to the tSIX seller and that vault pays it, verified on-chain", async () => {
    // The operator mints tSIX on request (no tSIX faucet yet); the owner gets one vault per asset for the same salt.
    await client.sendContractTx(new SecretKey(DEPLOYER_KEY), secondAsset.token, "mint(address,uint256)", [
      owner.address,
      (1000n * ONE_TSIX).toString(),
    ]);
    const { vaultAddress: tsixVault } = await owner.ensureVaultDeployed(0n, { vaultFactory: secondAsset.vaultFactory });
    assert.notEqual(tsixVault, vaultAddress);
    assert.equal(await client.getVaultAsset(tsixVault), toChecksumAddress(secondAsset.token));
    await owner.fundVault(tsixVault, 100n * ONE_TSIX);
    await owner.delegateSession(tsixVault, session.sessionAddress, {
      mode: "FIXED",
      allowanceCap: 10n * ONE_TSIX,
      perTxLimit: 4n * ONE_TSIX,
      expiry: Math.floor(Date.now() / 1000) + 3600,
    });
    const agent = new MultiAssetSession([
      session,
      new AgentSession({ client, vaultAddress: tsixVault, sessionKey: new SecretKey(SESSION_KEY) }),
    ]);

    const six = await startSeller("tsix", { price: () => 2_500_000n, asset: secondAsset.token });
    const withSix = [...candidates.slice(0, 2), { providerId: "tsix", url: six.url, method: "POST" as const, body: "{}" }];
    const tsixCap = { asset: secondAsset.token, maxPayment: 3n * ONE_TSIX };
    const taneCap = { asset: contracts.aneTestToken, maxPayment: 16n * ONE_TANE };

    // tANE preferred: the cheaper tANE seller wins, whatever the far smaller raw tSIX amount.
    assert.equal((await agent.chooseProvider(withSix, { caps: [taneCap, tsixCap] })).chosen?.providerId, "cheap-slow");

    const route = await agent.chooseProvider(withSix, { caps: [tsixCap, taneCap] });
    assert.deepEqual(route.ranked.map((o) => o.providerId), ["tsix", "cheap-slow", "fast"]);
    const taneBefore = await client.getAccountingSummary(vaultAddress);
    const res = await agent.purchaseRouted(route.chosen!, { body: "{}", verifyReceiptOnChain: true });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { seller: "tsix" });
    assert.equal(res.receipt?.amount, "2500000");

    assert.equal(await client.getTokenBalance(six.payTo, secondAsset.token), 2_500_000n);
    assert.equal(await client.getTokenBalance(six.payTo), 0n, "no tANE moved");
    const tsixSummary = await client.getAccountingSummary(tsixVault);
    assert.equal(tsixSummary.cumulativeSpent, 2_500_000n);
    assert.equal(tsixSummary.spendableNow, 10n * ONE_TSIX - 2_500_000n);
    const taneAfter = await client.getAccountingSummary(vaultAddress);
    assert.equal(taneAfter.cumulativeSpent, taneBefore.cumulativeSpent);
    assert.equal(taneAfter.spendableNow, taneBefore.spendableNow);
  });
});
