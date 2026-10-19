import test from "node:test";
import assert from "node:assert/strict";
import util from "node:util";
import {
  AneClient,
  AgentSession,
  OwnerWallet,
  REDACTED_PRIVATE_KEY,
  SecretKey,
  computeRequestHash,
  computeResourceHash,
  hashSpendIntent,
  keccak256Utf8,
  privateKeyToAddress,
  recoverAddress,
  redactSecrets,
  signDigest,
} from "../src/index.ts";

const ANVIL_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_SESSION_KEY = keccak256Utf8("16ane.test.session.key.v1");

test("Keccak-256 and secp256k1 ECDSA recovery match Foundry cast vectors", () => {
  const typeHash = keccak256Utf8(
    "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
  );
  assert.equal(
    typeHash,
    "0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267",
  );
  const addr = privateKeyToAddress(ANVIL_KEY_0);
  assert.equal(addr, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");

  const sig = signDigest(typeHash, ANVIL_KEY_0);
  const recovered = recoverAddress(typeHash, sig.serialized);
  assert.equal(recovered, addr);
});

test("SecretKey and wallet objects never leak raw private keys in logs or JSON (REQ-003)", () => {
  const sk = new SecretKey(ANVIL_KEY_0);
  assert.equal(sk.toString(), REDACTED_PRIVATE_KEY);
  assert.equal(JSON.stringify({ sk }), `{"sk":"${REDACTED_PRIVATE_KEY}"}`);
  assert.ok(!util.inspect(sk).includes("ac0974bec39a"));

  const client = new AneClient({ rpcUrl: "http://127.0.0.1:8545", chainId: 84532 });
  const owner = new OwnerWallet(client, sk);
  const session = new AgentSession({
    client,
    vaultAddress: "0x1111111111111111111111111111111111111111",
    sessionKey: TEST_SESSION_KEY,
  });

  assert.ok(!JSON.stringify(owner).includes("ac0974bec39a"));
  assert.ok(!util.inspect(owner).includes("ac0974bec39a"));
  assert.ok(!JSON.stringify(session).includes(TEST_SESSION_KEY.slice(2, 14)));
  assert.ok(!util.inspect(session).includes(TEST_SESSION_KEY.slice(2, 14)));

  const scrubbed = redactSecrets(`Error with owner_key=${ANVIL_KEY_0}`, [ANVIL_KEY_0]);
  assert.ok(!scrubbed.includes("ac0974bec39a"));
  assert.ok(scrubbed.includes(REDACTED_PRIVATE_KEY));
});

test("ServiceManifest EIP-712 signing and anti-spoofing verification (REQ-007)", () => {
  const client = new AneClient({ rpcUrl: "http://127.0.0.1:8545", chainId: 84532 });
  const providerKey = new SecretKey(ANVIL_KEY_0);
  const providerAddr = privateKeyToAddress(providerKey);

  const signed = client.signServiceManifest(
    {
      schemaVersion: "16ane-manifest-v0",
      serviceId: "demo-summarize",
      name: "Demo Summarize",
      version: "0.1.0",
      network: "eip155:84532",
      chainId: 84532,
      payTo: providerAddr,
      tokenAddress: "0x2222222222222222222222222222222222222222",
      tokenSymbol: "tANE",
      updatedAt: 1760860800,
      endpoints: [
        {
          id: "summarize",
          method: "POST",
          path: "/v1/demo/summarize",
          priceAmount: "16000000000000000000",
          scheme: "ane-vault-v1",
        },
      ],
    },
    providerKey,
  );

  const check = client.verifyServiceManifest(signed);
  assert.equal(check.valid, true);
  assert.equal(check.signer, providerAddr);

  // Tamper with payTo -> signature verification must fail
  const tampered = {
    ...signed,
    payTo: "0x3333333333333333333333333333333333333333",
  };
  const tamperedCheck = client.verifyServiceManifest(tampered);
  assert.equal(tamperedCheck.valid, false);
});

test("AgentSession SpendIntent EIP-712 signature matches session key", () => {
  const client = new AneClient({ rpcUrl: "http://127.0.0.1:8545", chainId: 84532 });
  const session = new AgentSession({
    client,
    vaultAddress: "0x1111111111111111111111111111111111111111",
    sessionKey: TEST_SESSION_KEY,
  });
  const quoteId = computeResourceHash("POST", "http://127.0.0.1:8787/v1/demo/summarize");
  const serviceIdHash = computeRequestHash("16ane-sandbox-reference-demo");
  const signed = session.signSpendIntent({
    merchant: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    amount: 16n * 10n ** 18n,
    quoteId,
    serviceIdHash,
    validBefore: 1900000000,
    policyVersion: 1,
  });
  const { digest } = hashSpendIntent(84532, signed.intent);
  assert.equal(recoverAddress(digest, signed.signature), session.sessionAddress);
});
