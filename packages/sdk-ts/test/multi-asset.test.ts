// One agent, one vault per asset (#133, ADR-0020): MultiAssetSession picks the asset by the caller's preference and
// per-asset caps, then the vault that holds that asset pays, so the payment, its budget and its receipt check all
// stay in one asset.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentSession, AneClient, MultiAssetSession, functionSelector, parseBaseUnits, toChecksumAddress } from "../src/index.ts";

const TANE = toChecksumAddress("0x" + "a1".repeat(20));
const TSIX = toChecksumAddress("0x" + "b2".repeat(20));
const TANE_VAULT = toChecksumAddress("0x" + "e1".repeat(20));
const TSIX_VAULT = toChecksumAddress("0x" + "e2".repeat(20));
const SELLER = toChecksumAddress("0x" + "c3".repeat(20));
const ONE_TANE = 10n ** 18n;
const ONE_TSIX = 10n ** 6n;
const URL_A = "https://a.example/v1/infer";

const quote = (asset: string, amount: bigint) => ({
  scheme: "ane-vault-v1",
  network: "eip155:84532",
  asset,
  amount: amount.toString(),
  payTo: SELLER,
  maxTimeoutSeconds: 300,
  resource: URL_A,
});
const envelope = (accepts: unknown[]) => Buffer.from(JSON.stringify({ x402Version: 2, accepts }), "utf8").toString("base64");
// The merchant quotes 16 tANE or 2.5 tSIX: raw amounts that differ by twelve orders of magnitude.
const BOTH = [quote(TANE, 16n * ONE_TANE), quote(TSIX, 2_500_000n)];

function client(chainId = 84532, assets: Record<string, string> = { [TANE_VAULT]: TANE, [TSIX_VAULT]: TSIX }): AneClient {
  return {
    chainId,
    getVaultAsset: async (vault: string) => {
      const asset = assets[toChecksumAddress(vault)];
      if (!asset) throw new Error("not a vault");
      return asset;
    },
    getAccountingSummary: async () => ({ active: true, spendableNow: 1000n * ONE_TANE, policyVersion: 1 }),
  } as unknown as AneClient;
}

function agent(c = client()) {
  const key = "0x" + "11".repeat(32);
  return new MultiAssetSession([
    new AgentSession({ client: c, vaultAddress: TANE_VAULT, sessionKey: key }),
    new AgentSession({ client: c, vaultAddress: TSIX_VAULT, sessionKey: key }),
  ]);
}

// Every request gets the same 402 until the payment header arrives; then 200.
function stubFetch(accepts: unknown[]) {
  const calls: RequestInit[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    const headers = init.headers as Record<string, string>;
    if (headers["payment-signature"]) return new Response("{}", { status: 200 });
    return new Response("{}", { status: 402, headers: { "payment-required": envelope(accepts) } });
  }) as typeof fetch;
  const paid = () => {
    const last = calls.at(-1)!.headers as Record<string, string>;
    return JSON.parse(Buffer.from(last["payment-signature"], "base64").toString("utf8"));
  };
  return { calls, paid, restore: () => (globalThis.fetch = realFetch) };
}

test("a vault's asset is its taneToken(), and an address with no code is not a vault", async () => {
  const reads: Array<[string, string]> = [];
  const fake = (answer: string) => ({
    ethCall: async (to: string, data: string) => {
      reads.push([to, data]);
      return answer;
    },
  });
  const word = "0x" + TSIX.slice(2).toLowerCase().padStart(64, "0");
  assert.equal(await AneClient.prototype.getVaultAsset.call(fake(word) as unknown as AneClient, TSIX_VAULT), TSIX);
  assert.deepEqual(reads, [[TSIX_VAULT, functionSelector("taneToken()")]]);
  await assert.rejects(
    AneClient.prototype.getVaultAsset.call(fake("0x") as unknown as AneClient, TSIX_VAULT),
    /is not a 16ane vault/,
  );
});

test("each vault reports its own asset, read from the vault", async () => {
  assert.deepEqual(await agent().vaultAssets(), [
    { asset: TANE, vaultAddress: TANE_VAULT },
    { asset: TSIX, vaultAddress: TSIX_VAULT },
  ]);
});

test("the caller's asset preference picks the vault that pays, and that vault pays in its own asset", async () => {
  for (const [caps, vault, asset, amount] of [
    [[{ asset: TSIX, maxPayment: 3n * ONE_TSIX }, { asset: TANE, maxPayment: 20n * ONE_TANE }], TSIX_VAULT, TSIX, 2_500_000n],
    [[{ asset: TANE, maxPayment: 20n * ONE_TANE }, { asset: TSIX, maxPayment: 3n * ONE_TSIX }], TANE_VAULT, TANE, 16n * ONE_TANE],
  ] as const) {
    const { calls, paid, restore } = stubFetch(BOTH);
    try {
      const res = await agent().purchase(URL_A, { caps: [...caps] });
      assert.equal(res.status, 200);
      assert.equal(calls.length, 3, "probe, quote, paid request");
      const payment = paid();
      assert.equal(payment.payload.vault, vault);
      assert.deepEqual(payment.accepted, { asset, amount: amount.toString(), payTo: SELLER });
      assert.equal((calls[2].headers as Record<string, string>)["x-agent-vault"], vault);
    } finally {
      restore();
    }
  }
});

test("a cap binds only its own asset: a tSIX quote over the tSIX cap falls through to tANE", async () => {
  const { paid, restore } = stubFetch(BOTH);
  try {
    await agent().purchase(URL_A, {
      caps: [
        { asset: TSIX, maxPayment: 2n * ONE_TSIX },
        { asset: TANE, maxPayment: 20n * ONE_TANE },
      ],
    });
    assert.equal(paid().payload.vault, TANE_VAULT);
  } finally {
    restore();
  }
});

test("routing across providers hands each winner to the vault for its asset", async () => {
  const { restore } = stubFetch([quote(TSIX, 2_500_000n)]);
  try {
    const route = await agent().chooseProvider([{ url: URL_A, providerId: "six-only" }], {
      caps: [
        { asset: TANE, maxPayment: 20n * ONE_TANE },
        { asset: TSIX, maxPayment: 3n * ONE_TSIX },
      ],
    });
    assert.equal(route.chosen?.accepted.asset, TSIX);
    assert.equal(route.chosen?.amount, 2_500_000n);
  } finally {
    restore();
  }
});

test("nothing payable within any cap: refused after the probe, before anything is signed", async () => {
  const { calls, restore } = stubFetch(BOTH);
  try {
    await assert.rejects(
      agent().purchase(URL_A, { caps: [{ asset: TSIX, maxPayment: 1n }, { asset: TANE, maxPayment: 1n }] }),
      /ANE-E-3003: No 402 quote is payable from these vaults/,
    );
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test("misconfiguration is refused: unheld or repeated assets, repeated vaults, mixed chains", async () => {
  const key = "0x" + "11".repeat(32);
  await assert.rejects(
    agent().chooseProvider([], { caps: [{ asset: "0x" + "99".repeat(20), maxPayment: 1n }] }),
    /No vault in this session holds/,
  );
  await assert.rejects(
    agent().chooseProvider([], { caps: [{ asset: TSIX, maxPayment: 1n }, { asset: TSIX.toLowerCase(), maxPayment: 2n }] }),
    /has two caps/,
  );
  await assert.rejects(agent().chooseProvider([], { caps: [] }), /At least one asset cap/);

  const sameAsset = client(84532, { [TANE_VAULT]: TANE, [TSIX_VAULT]: TANE });
  await assert.rejects(agent(sameAsset).vaultAssets(), /both hold/);

  assert.throws(() => new MultiAssetSession([]), /at least one vault session/);
  const c = client();
  assert.throws(
    () =>
      new MultiAssetSession([
        new AgentSession({ client: c, vaultAddress: TANE_VAULT, sessionKey: key }),
        new AgentSession({ client: c, vaultAddress: TANE_VAULT.toLowerCase(), sessionKey: key }),
      ]),
    /same vault is listed twice/,
  );
  assert.throws(
    () =>
      new MultiAssetSession([
        new AgentSession({ client: c, vaultAddress: TANE_VAULT, sessionKey: key }),
        new AgentSession({ client: client(1), vaultAddress: TSIX_VAULT, sessionKey: key }),
      ]),
    /same chain/,
  );
});

test("a cap is a canonical base-unit integer, as strict as a quote's amount", async () => {
  for (const maxPayment of ["0x10", "016", "-1", "1e6", "1.5", " 16", ""]) {
    await assert.rejects(agent().chooseProvider([], { caps: [{ asset: TSIX, maxPayment }] }), /Invalid base-unit amount/);
  }
  for (const maxPayment of [-1n, 1n << 256n]) {
    await assert.rejects(agent().chooseProvider([], { caps: [{ asset: TSIX, maxPayment }] }), /outside uint256/);
  }
  assert.equal(parseBaseUnits("2500000"), 2_500_000n);
  assert.equal(parseBaseUnits((1n << 256n) - 1n), (1n << 256n) - 1n);
});

test("a failed vault read is retried, and a stale failure never evicts the retry", async () => {
  let reads = 0;
  let fail = true;
  const c = {
    chainId: 84532,
    getVaultAsset: async (vault: string) => {
      reads++;
      await null;
      if (fail) throw new Error("rpc down");
      return toChecksumAddress(vault) === TANE_VAULT ? TANE : TSIX;
    },
  } as unknown as AneClient;
  const session = new AgentSession({ client: c, vaultAddress: TSIX_VAULT, sessionKey: "0x" + "11".repeat(32) });
  let retry: Promise<string> | undefined;
  // The first caller retries the moment it sees the failure; a second caller was waiting on the same read.
  const first = session.vaultAsset().catch(() => {
    fail = false;
    retry = session.vaultAsset();
  });
  await assert.rejects(session.vaultAsset(), /rpc down/);
  await first;
  assert.equal(await retry, TSIX);
  assert.equal(await session.vaultAsset(), TSIX);
  assert.equal(reads, 2, "one failed read, one retry, and the retry stays cached");

  // MultiAssetSession caches its vault map the same way.
  fail = true;
  const multi = agent({ chainId: 84532, getVaultAsset: c.getVaultAsset } as unknown as AneClient);
  await assert.rejects(multi.vaultAssets(), /rpc down/);
  fail = false;
  assert.deepEqual(await multi.vaultAssets(), [
    { asset: TANE, vaultAddress: TANE_VAULT },
    { asset: TSIX, vaultAddress: TSIX_VAULT },
  ]);
});
