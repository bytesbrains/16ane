// Differential tests: the dashboard's dependency-free keccak/ABI ports must agree
// with packages/sdk-ts on every vector. Change both sides together.
import test from "node:test";
import assert from "node:assert/strict";
import {
  abiWordAddress as sdkAddress,
  abiWordBool as sdkBool,
  abiWordBytes32 as sdkBytes32,
  abiWordUint as sdkUint,
  functionSelector as sdkSelector,
} from "../../packages/sdk-ts/src/abi.ts";
import {
  bytesToHex as sdkBytesToHex,
  hexToBytes as sdkHexToBytes,
  keccak256 as sdkKeccak256,
  keccak256Utf8 as sdkKeccakUtf8,
} from "../../packages/sdk-ts/src/keccak.ts";
import { toChecksumAddress as sdkChecksum } from "../../packages/sdk-ts/src/secp256k1.ts";
import {
  abiWordAddress,
  abiWordBool,
  abiWordBytes32,
  abiWordUint,
  formatUnits,
  functionSelector,
  parseUnits,
  splitWords,
  toChecksumAddress,
  wordToAddress,
  wordToBigInt,
  wordToNumber,
} from "../../dashboard/assets/abi.js";
import {
  bytesToHex,
  hexToBytes,
  keccak256,
  keccak256Utf8,
} from "../../dashboard/assets/keccak.js";

const STRINGS = ["", "hello", "Transfer(address,address,uint256)", "16ane campaign control\nprovider: 0xabc"];
const HEXES = ["0x", "0x00", "0xdeadbeef", "0x" + "ab".repeat(64)];
const ADDRS = ["0x0000000000000000000000000000000000000000", "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae"];
const UINTS = [0n, 1n, 16n, 2n ** 256n - 1n];

test("keccak ports match the SDK", () => {
  for (const s of STRINGS) assert.equal(keccak256Utf8(s), sdkKeccakUtf8(s));
  for (const h of HEXES) {
    assert.equal(keccak256(h), sdkKeccak256(h));
    assert.deepEqual([...hexToBytes(h)], [...sdkHexToBytes(h)]);
  }
  for (const bytes of [new Uint8Array([]), new Uint8Array([1, 2, 250]), hexToBytes("0x" + "cd".repeat(100))]) {
    assert.equal(bytesToHex(bytes), sdkBytesToHex(bytes));
    assert.equal(keccak256(bytes), sdkKeccak256(bytes));
  }
  // Cross-check against a known-answer vector (keccak256("")).
  assert.equal(keccak256Utf8(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
});

test("ABI word encoders and selectors match the SDK", () => {
  for (const n of UINTS) assert.equal(abiWordUint(n), sdkUint(n));
  for (const a of ADDRS) assert.equal(abiWordAddress(a), sdkAddress(a));
  assert.equal(abiWordBytes32("0x" + "11".repeat(32)), sdkBytes32("0x" + "11".repeat(32)));
  assert.equal(abiWordBool(true), sdkBool(true));
  assert.equal(abiWordBool(false), sdkBool(false));
  for (const sig of [
    "balanceOf(address)",
    "getAccountingSummary()",
    "payments(bytes32)",
    "createVault(address,bytes32)",
    "setPolicy((address,uint256,uint256,uint256,uint64,uint8,uint256))",
    "revoke()",
    "withdraw(uint256,address)",
    "claim(address)",
    "nextClaimTime(address)",
    "getDeployment()",
    "getVaultsByOwner(address)",
  ]) {
    assert.equal(functionSelector(sig), sdkSelector(sig));
  }
  assert.equal(functionSelector("balanceOf(address)"), "0x70a08231");
  assert.throws(() => abiWordAddress("nope"));
  assert.throws(() => abiWordBytes32("0x1234"));
});

test("decoders and checksum match the SDK", () => {
  for (const a of ADDRS) assert.equal(toChecksumAddress(a), sdkChecksum(a));
  // EIP-55 reference vector.
  assert.equal(toChecksumAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"), "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
  assert.deepEqual(splitWords("0x" + "11".repeat(32) + "22".repeat(32)), ["11".repeat(32), "22".repeat(32)]);
  assert.equal(wordToBigInt("ff"), 255n);
  assert.equal(wordToNumber("ff"), 255);
  assert.equal(wordToAddress("0".repeat(24) + "5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"), "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
});

test("unit formatting round-trips", () => {
  assert.equal(formatUnits(16000000000000000000n, 18), "16");
  assert.equal(formatUnits(1500000000000000000n, 18), "1.5");
  assert.equal(formatUnits(0n, 18), "0");
  assert.equal(parseUnits("16", 18), 16000000000000000000n);
  assert.equal(parseUnits("1.5", 18), 1500000000000000000n);
  assert.equal(parseUnits(" 320 ", 18), 320000000000000000000n);
  assert.throws(() => parseUnits("1.5.6", 18));
  assert.throws(() => parseUnits("-1", 18));
  assert.throws(() => parseUnits("0.0000000000000000001", 18));
});
