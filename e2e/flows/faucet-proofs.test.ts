import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { keccak256Utf8, privateKeyToAddress, SecretKey } from "../../packages/sdk-ts/src/index.ts";
import { createSandboxServer } from "../../services/sandbox-server/src/server.ts";
import { DEPLOYER_KEY, PROVIDER_KEY, startSandboxStack } from "../harness.ts";

const execFileAsync = promisify(execFile);
const ONE_TANE = 10n ** 18n;

// #79 on a real chain: a claim needs a proof, the recipient's signed claim is relayed gaslessly (also from the
// CLI), and a refused claim (no proof, wrong signer, replayed nonce) costs the relayer nothing.
test("faucet claims need a recipient's proof, and refused claims spend no gas (REQ-002, T3, #79)", async (t) => {
  const { rpcUrl, registryAddress, repoRoot, sandbox, client } = await startSandboxStack(t);
  const relayer = privateKeyToAddress(new SecretKey(DEPLOYER_KEY));
  const relayerTxCount = async () => BigInt(await client.rpcCall<string>("eth_getTransactionCount", [relayer, "latest"]));
  const post = (url: string, body: object) =>
    fetch(`${url}/v1/faucet/claims`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const asBody = (c: Awaited<ReturnType<typeof client.signFaucetClaim>>) => ({
    recipient: c.recipient,
    authorization: { deadline: c.deadline, nonce: c.nonce, signature: c.signature },
  });

  // The CLI signs with ANE_OWNER_PRIVATE_KEY; the new address holds no ETH and pays none.
  const cliKey = keccak256Utf8("16ane.e2e.faucet.cli.v1");
  const cliAddress = privateKeyToAddress(new SecretKey(cliKey));
  const { stdout } = await execFileAsync(
    "node",
    ["--experimental-strip-types", "packages/cli/bin/ane.mjs", "wallet", "fund", "--test", "--api-url", sandbox.url],
    { cwd: repoRoot, env: { ...process.env, ANE_OWNER_PRIVATE_KEY: cliKey } },
  );
  assert.equal((JSON.parse(stdout) as { recipient: string }).recipient, cliAddress);
  assert.equal(await client.getTokenBalance(cliAddress), 16_000n * ONE_TANE);
  assert.equal(await client.rpcCall<string>("eth_getBalance", [cliAddress, "latest"]), "0x0");

  // A signed claim from the SDK, then the same authorization replayed against a server with no memory of it:
  // only the on-chain nonce stands in the way, and the server reads it before sending.
  const key = new SecretKey(keccak256Utf8("16ane.e2e.faucet.sdk.v1"));
  const signed = await client.signFaucetClaim(key);
  assert.equal((await post(sandbox.url, asBody(signed))).status, 201);
  assert.equal(await client.getTokenBalance(signed.recipient), 16_000n * ONE_TANE);

  const fresh = await createSandboxServer({
    rpcUrl,
    chainId: 84532,
    registryAddress,
    relayerPrivateKey: DEPLOYER_KEY,
    providerPrivateKey: PROVIDER_KEY,
  });
  t.after(() => fresh.close());
  const before = await relayerTxCount();
  const replay = await post(fresh.url, asBody(signed));
  assert.equal(replay.status, 403);
  assert.match(((await replay.json()) as { error: { message: string } }).error.message, /nonce was already used/);

  const other = new SecretKey(keccak256Utf8("16ane.e2e.faucet.other.v1"));
  const victim = privateKeyToAddress(new SecretKey(keccak256Utf8("16ane.e2e.faucet.victim.v1")));
  const wrongSigner = await post(fresh.url, asBody({ ...(await client.signFaucetClaim(other)), recipient: victim }));
  assert.equal(wrongSigner.status, 403);
  assert.equal((await post(fresh.url, { recipient: victim })).status, 401);
  assert.equal(await relayerTxCount(), before, "no refused claim sent a transaction");
  assert.equal(await client.getTokenBalance(victim), 0n);
});
