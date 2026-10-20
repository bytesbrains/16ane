import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AneClient, SecretKey } from "../src/index.ts";
import { settleExactAuthorizationOnChain } from "../src/transactions.ts";

// The Solidity signatures `name(type,…)` declared in a contract source, so an SDK call can be checked against
// the contract it targets without compiling or deploying anything.
function declaredSignatures(contractPath: string, name: string): string[] {
  const source = readFileSync(new URL(`../../../${contractPath}`, import.meta.url), "utf8");
  return [...source.matchAll(new RegExp(`function ${name}\\(([^)]*)\\)`, "g"))].map(
    ([, params]) => `${name}(${params.split(",").map((p) => p.trim().split(/\s+/)[0]).join(",")})`,
  );
}

// The x402 "exact" scheme's settlement (EIP-3009) is the one relayed transaction no e2e scenario sends yet, so
// its method signature and argument order are pinned here.
test("settleExactAuthorizationOnChain calls the token's bytes-signature transferWithAuthorization in order", async () => {
  const sent: Array<{ to: string; signature: string; args: string[] }> = [];
  const client = {
    resolveContracts: async () => ({ aneTestToken: "0x" + "11".repeat(20) }),
    sendContractTx: async (_key: SecretKey, to: string, signature: string, args: string[]) => {
      sent.push({ to, signature, args });
      return { txHash: "0x" + "ab".repeat(32), blockNumber: 7, status: 1 };
    },
  } as unknown as AneClient;
  const auth = {
    from: "0x" + "aa".repeat(20),
    to: "0x" + "bb".repeat(20),
    value: 16n * 10n ** 18n,
    validAfter: 0,
    validBefore: 1_900_000_000,
    nonce: "0x" + "cd".repeat(32),
  };
  const result = await settleExactAuthorizationOnChain(client, {} as SecretKey, auth, "0xsig");

  assert.deepEqual(result, { txHash: "0x" + "ab".repeat(32), blockNumber: 7 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "0x" + "11".repeat(20), "sent to the tANE token");
  assert.ok(
    declaredSignatures("src/AneTestToken.sol", "transferWithAuthorization").includes(sent[0].signature),
    `${sent[0].signature} is one of AneTestToken's declared overloads`,
  );
  assert.deepEqual(sent[0].args, [auth.from, auth.to, "16000000000000000000", "0", "1900000000", auth.nonce, "0xsig"]);
});
