import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withTemporaryKeystore } from "./keystore.ts";

const execFileAsync = promisify(execFile);

export interface CastSendResult {
  txHash: string;
  blockNumber: number;
  /** 1 = success. A reverted transaction (0) still paid its fee. */
  status: number;
  /** What the sender paid: gasUsed x effectiveGasPrice, plus the L1 data fee on OP-stack chains like Base. */
  feeWei: bigint;
}

const toBigInt = (value: string | number | undefined): bigint =>
  value === undefined || value === null ? 0n : BigInt(value);

/** Fee actually paid, from a `cast send --json` receipt (#76). */
export function receiptFeeWei(receipt: {
  gasUsed?: string | number;
  effectiveGasPrice?: string | number;
  l1Fee?: string | number;
}): bigint {
  return toBigInt(receipt.gasUsed) * toBigInt(receipt.effectiveGasPrice) + toBigInt(receipt.l1Fee);
}

/**
 * Sends one transaction with Foundry's `cast send` and returns its receipt summary, including a reverted one.
 * The key reaches cast only as a temporary encrypted keystore, never in its arguments (#67).
 */
export async function castSend(
  rpcUrl: string,
  rawKey: string,
  to: string,
  signature: string,
  args: string[],
): Promise<CastSendResult> {
  // "--" ends cast's options: a contract argument such as "--value=1ether" must stay an argument, never
  // become an option that changes the transaction (it would send ETH from the signer).
  const cmdArgs = ["send", "--rpc-url", rpcUrl, "--json", "--", to, signature, ...args];
  const { stdout } = await withTemporaryKeystore(rawKey, (keystoreEnv) => {
    // Signer settings inherited from the caller's shell would override or conflict with the keystore.
    const { ETH_KEYSTORE_ACCOUNT: _account, ETH_FROM: _from, ...inherited } = process.env;
    return execFileAsync("cast", cmdArgs, {
      env: { ...inherited, ...keystoreEnv, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" },
    });
  });
  const parsed = JSON.parse(stdout.trim()) as {
    transactionHash: string;
    blockNumber: string | number;
    status: string | number;
    gasUsed?: string | number;
    effectiveGasPrice?: string | number;
    l1Fee?: string | number;
  };
  return {
    txHash: parsed.transactionHash,
    blockNumber: Number(BigInt(parsed.blockNumber)),
    status: Number(BigInt(parsed.status)),
    feeWei: receiptFeeWei(parsed),
  };
}
