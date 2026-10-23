// ERC-8004 adapter (#22): every selector and event topic the SDK uses is present in the deployed v2.0.0
// registry bytecode (e2e/fixtures), the agentWallet digest matches an independent encoding by Foundry's
// `cast`, and the feedback reader refuses entries whose file is tampered with, misdirected or unreadable.
// The e2e flow (e2e/flows/erc8004-reputation.test.ts) runs the same helpers against that bytecode.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  AGENT_WALLET_SET_TYPEHASH,
  type AneClient,
  ERC8004_BASE_SEPOLIA,
  GIVE_FEEDBACK_SIG,
  REGISTER_AGENT_SIG,
  REPUTATION_CAVEAT,
  SET_AGENT_URI_SIG,
  SET_AGENT_WALLET_SIG,
  SecretKey,
  abiWordUint,
  buildAgentRegistration,
  buildFeedbackFile,
  decodeDataUri,
  decodeNewFeedbackLog,
  functionSelector,
  giveFeedbackOnChain,
  hashAgentWalletSet,
  keccak256,
  keccak256Utf8,
  loadUri,
  MAX_ERC8004_FILE_BYTES,
  parseCaip10,
  privateKeyToAddress,
  readAgentFeedback,
  recoverAddress,
  signAgentWalletSet,
  toJsonDataUri,
  verifyProofOfPayment,
} from "../src/index.ts";

const cast = (...args: string[]) => execFileSync("cast", args, { encoding: "utf8" }).trim();
const fixture = JSON.parse(readFileSync(new URL("../../../e2e/fixtures/erc8004-registries.json", import.meta.url), "utf8"));
const IDENTITY = ERC8004_BASE_SEPOLIA.identityRegistry;
const OWNER = "0x" + "0a".repeat(20);
const WALLET_KEY = new SecretKey(keccak256Utf8("16ane.test.erc8004.wallet"));

test("the fixture bytecode is what its codehash says", () => {
  assert.equal(keccak256(fixture.identityRegistry.code), fixture.identityRegistry.codehash);
  assert.equal(keccak256(fixture.reputationRegistry.code), fixture.reputationRegistry.codehash);
});

// Solc's dispatcher pushes each selector with the shortest PUSHn, so leading zero bytes are dropped.
const pushSelector = (sig: string) => {
  const bytes = functionSelector(sig).slice(2).replace(/^(00)+/, "");
  return (0x5f + bytes.length / 2).toString(16) + bytes;
};

test("every function and event the SDK uses exists in the deployed registries", () => {
  const identityCode: string = fixture.identityRegistry.code.toLowerCase();
  const reputationCode: string = fixture.reputationRegistry.code.toLowerCase();
  for (const sig of [
    REGISTER_AGENT_SIG, SET_AGENT_URI_SIG, SET_AGENT_WALLET_SIG,
    "ownerOf(uint256)", "getAgentWallet(uint256)", "tokenURI(uint256)", "getMetadata(uint256,string)",
  ]) {
    assert.ok(identityCode.includes(pushSelector(sig)), `identity registry lacks ${sig}`);
  }
  for (const sig of [GIVE_FEEDBACK_SIG, "revokeFeedback(uint256,uint64)"]) {
    assert.ok(reputationCode.includes(pushSelector(sig)), `reputation registry lacks ${sig}`);
  }
  for (const event of ["NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)", "FeedbackRevoked(uint256,address,uint64)"]) {
    assert.ok(reputationCode.includes(keccak256Utf8(event).slice(2)), `reputation registry lacks ${event}`);
  }
  assert.ok(identityCode.includes(keccak256Utf8("Registered(uint256,string,address)").slice(2)));
  assert.ok(identityCode.includes(AGENT_WALLET_SET_TYPEHASH.slice(2)));
});

test("the agentWallet digest matches cast's encoding and recovers to the new wallet", () => {
  const params = { agentId: 7, newWallet: privateKeyToAddress(WALLET_KEY), owner: OWNER, deadline: 1_800_000_000 };
  const domain = cast(
    "keccak",
    cast(
      "abi-encode", "f(bytes32,bytes32,bytes32,uint256,address)",
      cast("keccak", "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
      cast("keccak", "ERC8004IdentityRegistry"), cast("keccak", "1"), "84532", IDENTITY,
    ),
  );
  const struct = cast(
    "keccak",
    cast("abi-encode", "f(bytes32,uint256,address,address,uint256)", AGENT_WALLET_SET_TYPEHASH, "7", params.newWallet, OWNER, "1800000000"),
  );
  const digest = hashAgentWalletSet(84532, IDENTITY, params);
  assert.equal(digest, cast("keccak", "0x1901" + domain.slice(2) + struct.slice(2)));
  assert.equal(recoverAddress(digest, signAgentWalletSet(84532, IDENTITY, params, WALLET_KEY)), params.newWallet);
});

test("the registration file names the agent card, the vault, and its own registry entry", () => {
  const vault = "0x" + "77".repeat(20);
  const reg = buildAgentRegistration(84532, IDENTITY, { name: "a", description: "b", agentCardUrl: "https://a.example/.well-known/agent-card.json", vault }, 3n);
  assert.equal(reg.type, "https://eips.ethereum.org/EIPS/eip-8004#registration-v1");
  assert.deepEqual(reg.services, [{ name: "A2A", endpoint: "https://a.example/.well-known/agent-card.json" }]);
  assert.deepEqual(reg.registrations, [{ agentId: 3, agentRegistry: `eip155:84532:${IDENTITY}` }]);
  assert.equal(parseCaip10(reg["16ane"]!.vault!)?.address.toLowerCase(), vault);
  assert.equal(parseCaip10("eip155:84532:not-an-address"), null);
  assert.deepEqual(buildAgentRegistration(84532, IDENTITY, { name: "a", description: "b", agentCardUrl: "x" }).registrations, []);
});

test("data: URIs round-trip; other schemes need a caller-supplied fetcher; large files are refused", async () => {
  const uri = toJsonDataUri({ a: "ünïcode" });
  assert.deepEqual(JSON.parse(Buffer.from(decodeDataUri(uri)!).toString("utf8")), { a: "ünïcode" });
  assert.equal(Buffer.from(decodeDataUri("data:application/json,%7B%7D")!).toString(), "{}");
  await assert.rejects(loadUri("https://evil.example/f.json"), /only data: URIs are read without a fetchUri/);
  await assert.rejects(loadUri(toJsonDataUri({ pad: "x".repeat(MAX_ERC8004_FILE_BYTES) })), /File over/);
  assert.equal(Buffer.from(await loadUri("ipfs://cid", async () => new Uint8Array([1, 2]))).length, 2);
});

test("decodes a NewFeedback event, including a negative value", () => {
  const data = cast(
    "abi-encode", "f(uint64,int128,uint8,string,string,string,string,bytes32)",
    "4", "-250", "1", "quality", "", "https://svc.example/x", "data:,{}", "0x" + "ab".repeat(32),
  );
  const entry = decodeNewFeedbackLog({
    topics: ["0x00", "0x" + abiWordUint(9), "0x" + "0".repeat(24) + "cd".repeat(20)],
    data,
    transactionHash: "0x" + "01".repeat(32),
    blockNumber: "0x10",
  });
  assert.equal(entry.feedbackIndex, 4n);
  assert.equal(entry.value, -250n);
  assert.equal(entry.valueDecimals, 1);
  assert.equal(entry.tag1, "quality");
  assert.equal(entry.endpoint, "https://svc.example/x");
  assert.equal(entry.feedbackURI, "data:,{}");
  assert.equal(entry.clientAddress.toLowerCase(), "0x" + "cd".repeat(20));
  assert.equal(entry.blockNumber, 16);
});

test("feedback values outside the registry's range are refused before anything is sent", async () => {
  const client = {} as AneClient;
  const proofOfPayment = { fromAddress: OWNER, toAddress: OWNER, txHash: "0x" + "00".repeat(32) };
  await assert.rejects(giveFeedbackOnChain(client, WALLET_KEY, { agentId: 1, value: 10n ** 38n + 1n, proofOfPayment }), /out of range/);
  await assert.rejects(giveFeedbackOnChain(client, WALLET_KEY, { agentId: 1, value: 1, valueDecimals: 19, proofOfPayment }), /0-18/);
});

test("a proof for another chain, or with a malformed hash, is not verified", async () => {
  const client = { chainId: 84532 } as AneClient;
  const proof = { fromAddress: OWNER, toAddress: OWNER, chainId: "1", txHash: "0x" + "00".repeat(32) };
  assert.equal((await verifyProofOfPayment(client, { agentId: 1, clientAddress: OWNER, proof })).reason, "proof is for another chain");
  assert.equal(
    (await verifyProofOfPayment(client, { agentId: 1, clientAddress: OWNER, proof: { ...proof, chainId: "84532", txHash: "0x12" } })).reason,
    "malformed txHash",
  );
});

// A chain with one agent (id 5, owned by OWNER, no vault, data: registration file) and the given feedback events.
function chainWith(feedback: Array<{ client: string; uri: string; hash: string }>) {
  const abiString = (s: string) => {
    const hex = Buffer.from(s, "utf8").toString("hex");
    return abiWordUint(32) + abiWordUint(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
  };
  const word = (addr: string) => "0x" + addr.slice(2).padStart(64, "0");
  const tokenURI = toJsonDataUri(buildAgentRegistration(84532, IDENTITY, { name: "s", description: "d", agentCardUrl: "x" }, 5));
  const selector = (sig: string) => functionSelector(sig);
  return {
    chainId: 84532,
    ethCall: async (_to: string, data: string) => {
      if (data.startsWith(selector("ownerOf(uint256)")) || data.startsWith(selector("getAgentWallet(uint256)"))) return word(OWNER);
      if (data.startsWith(selector("tokenURI(uint256)"))) return "0x" + abiString(tokenURI);
      if (data.startsWith(selector("getMetadata(uint256,string)"))) return "0x" + abiWordUint(32) + abiWordUint(0);
      throw new Error(`unexpected call ${data.slice(0, 10)}`);
    },
    rpcCall: async (method: string, params: Array<{ topics: string[] }>) => {
      if (method === "eth_blockNumber") return "0x20";
      if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
      if (params[0].topics[0] !== keccak256Utf8("NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)")) return [];
      return feedback.map((f, i) => ({
        topics: ["0x", "0x" + abiWordUint(5), word(f.client)],
        data: cast("abi-encode", "f(uint64,int128,uint8,string,string,string,string,bytes32)", String(i + 1), "80", "0", "", "", "", f.uri, f.hash),
        transactionHash: "0x" + "02".repeat(32),
        blockNumber: "0x11",
      }));
    },
  } as unknown as AneClient;
}

test("the reader flags a tampered, misdirected or unreadable feedback file and always carries the caveat", async () => {
  const reviewer = "0x" + "cd".repeat(20);
  const proofOfPayment = { fromAddress: reviewer, toAddress: OWNER, txHash: "0x" + "03".repeat(32) };
  const file = buildFeedbackFile(84532, IDENTITY, reviewer, { agentId: 5, value: 80, proofOfPayment });
  const json = JSON.stringify(file);
  const hash = keccak256(new Uint8Array(Buffer.from(json, "utf8")));
  const otherAgent = JSON.stringify({ ...file, agentId: 6 });
  const otherReviewer = JSON.stringify({ ...file, clientAddress: OWNER });
  const client = chainWith([
    { client: reviewer, uri: toJsonDataUri({ ...file, value: "100" }), hash },
    { client: reviewer, uri: toJsonDataUri(JSON.parse(otherAgent)), hash: keccak256(new Uint8Array(Buffer.from(otherAgent))) },
    { client: reviewer, uri: toJsonDataUri(JSON.parse(otherReviewer)), hash: keccak256(new Uint8Array(Buffer.from(otherReviewer))) },
    { client: reviewer, uri: "https://reviewer.example/f.json", hash },
    { client: reviewer, uri: "https://reviewer.example/f.json", hash: "0x" + "00".repeat(32) },
  ]);
  const feedback = await readAgentFeedback(client, { agentId: 5, fromBlock: 0 });
  assert.equal(feedback.caveat, REPUTATION_CAVEAT);
  assert.deepEqual(
    feedback.entries.map((e) => e.payment),
    [
      { verified: false, reason: "file does not match feedbackHash" },
      { verified: false, reason: "file is for another agent" },
      { verified: false, reason: "file names another reviewer" },
      { verified: false, reason: "Cannot read https://reviewer.example/f.json: only data: URIs are read without a fetchUri" },
      { verified: false, reason: "Cannot read https://reviewer.example/f.json: only data: URIs are read without a fetchUri" },
    ],
  );
  // With a fetcher, an off-chain file must still carry a hash.
  const fetched = await readAgentFeedback(client, { agentId: 5, fromBlock: 0 }, { fetchUri: async () => new Uint8Array(Buffer.from(json)) });
  assert.equal(fetched.entries[4].payment.reason, "no feedbackHash for an off-chain file");
});
