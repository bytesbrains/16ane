import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AneClient, keccak256Utf8, SecretKey } from "../src/index.ts";

// A fake `cast` first on PATH: fails with `failure` for the first `failures` calls, then prints a receipt.
// Every call appends one line to `record`: its arguments, then the keystore and password paths it was given
// and whether those files existed at the time.
interface CastCall {
  args: string;
  keystore: string;
  keystoreExisted: boolean;
  passwordExisted: boolean;
}
function withFakeCast(
  failures: number,
  failure: string,
  run: (calls: () => number, recorded: () => CastCall[]) => Promise<void>,
) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-cast-"));
    const counter = path.join(dir, "calls");
    const record = path.join(dir, "record");
    writeFileSync(counter, "0");
    writeFileSync(record, "");
    writeFileSync(
      path.join(dir, "cast"),
      `#!/bin/sh
n=$(($(cat "${counter}") + 1)); echo $n > "${counter}"
ks=no; [ -f "$ETH_KEYSTORE" ] && ks=yes; pw=no; [ -f "$ETH_PASSWORD" ] && pw=yes
printf '%s\t%s\t%s\t%s\n' "$*" "$ETH_KEYSTORE" "$ks" "$pw" >> "${record}"
if [ $n -le ${failures} ]; then echo "${failure} (args: $*)" >&2; exit 1; fi
echo '{"transactionHash":"0x${"ab".repeat(32)}","blockNumber":"0x5","status":"0x1"}'
`,
    );
    chmodSync(path.join(dir, "cast"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${savedPath}`;
    try {
      await run(
        () => Number(readFileSync(counter, "utf8")),
        () =>
          readFileSync(record, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const [args, keystore, ks, pw] = line.split("\t");
              return { args, keystore, keystoreExisted: ks === "yes", passwordExisted: pw === "yes" };
            }),
      );
    } finally {
      process.env.PATH = savedPath;
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const client = new AneClient({ rpcUrl: "http://127.0.0.1:1", chainId: 84532, contracts: {} });
const key = new SecretKey(keccak256Utf8("16ane.test.send-retry.key.v1"));
const to = "0x" + "11".repeat(20);

test(
  "sendContractTx retries while a public RPC reports a stale nonce",
  withFakeCast(2, "Error: server returned an error response: error code -32000: nonce too low: next nonce 8, tx nonce 7", async (calls) => {
    const res = await client.sendContractTx(key, to, "fund(uint256)", ["1"]);
    assert.equal(res.txHash, "0x" + "ab".repeat(32));
    assert.equal(res.blockNumber, 5);
    assert.equal(calls(), 3);
  }),
);

test(
  "sendContractTx retries when a lagging node still holds the previous transaction as pending",
  withFakeCast(1, "Error: server returned an error response: error code -32000: replacement transaction underpriced", async (calls) => {
    const res = await client.sendContractTx(key, to, "fund(uint256)", ["1"]);
    assert.equal(res.blockNumber, 5);
    assert.equal(calls(), 2);
  }),
);

test(
  "sendContractTx does not retry other errors, and redacts the key",
  withFakeCast(1, "Error: execution reverted", async (calls) => {
    await assert.rejects(client.sendContractTx(key, to, "fund(uint256)", ["1"]), (err: Error) => {
      assert.match(err.message, /execution reverted/);
      assert.ok(!err.message.includes(key.unsafeUnwrap().slice(2)), "the private key is redacted");
      return true;
    });
    assert.equal(calls(), 1);
  }),
);

test(
  "the private key never appears in cast's arguments, even across retries (#67)",
  withFakeCast(2, "Error: server returned an error response: error code -32000: nonce too low", async (_calls, recorded) => {
    await client.sendContractTx(key, to, "fund(uint256)", ["1"]);
    const calls = recorded();
    assert.equal(calls.length, 3);
    const rawKey = key.unsafeUnwrap().slice(2).toLowerCase();
    for (const call of calls) {
      assert.ok(!call.args.toLowerCase().includes(rawKey), `key in argv: ${call.args}`);
      assert.doesNotMatch(call.args, /--private-key/);
      assert.ok(call.keystoreExisted && call.passwordExisted, "cast was given an existing keystore and password file");
      assert.ok(!existsSync(call.keystore), "the temporary keystore is deleted afterwards");
    }
  }),
);
