// Verifies a settlement transaction straight from JSON-RPC, without any hosted facilitator (REQ-005, ADR-0005).
import { abiWordAddress } from "./abi.ts";
import type { AneClient } from "./client.ts";
import { keccak256Utf8 } from "./keccak.ts";
import { RECEIPT_RETRY_DELAYS_MS, sleep } from "./read-floor.ts";

export interface SettlementCheck {
  txHash: string;
  expectedAsset?: string;
  expectedPayee: string;
  expectedAmount: bigint | string;
  expectedVault?: string;
  expectedPaymentId?: string;
}

export interface SettlementVerdict {
  verified: boolean;
  blockNumber: number;
  txHash: string;
  reason?: string;
}

export async function verifySettlementOnChain(
  client: Pick<AneClient, "rpcCall" | "resolveContracts" | "getPaymentRecord">,
  params: SettlementCheck,
): Promise<SettlementVerdict> {
  type Receipt = {
    status: string;
    blockNumber: string;
    logs: Array<{ address: string; topics: string[]; data: string }>;
  };
  // A node behind the one that mined the transaction answers null (#67): ask again briefly before
  // reporting it missing.
  let receipt = await client.rpcCall<Receipt | null>("eth_getTransactionReceipt", [params.txHash]);
  for (const delay of RECEIPT_RETRY_DELAYS_MS) {
    if (receipt) break;
    await sleep(delay);
    receipt = await client.rpcCall<Receipt | null>("eth_getTransactionReceipt", [params.txHash]);
  }

  if (!receipt) {
    return {
      verified: false,
      blockNumber: 0,
      txHash: params.txHash,
      reason: "Transaction receipt not found",
    };
  }
  if (BigInt(receipt.status) !== 1n) {
    return {
      verified: false,
      blockNumber: 0,
      txHash: params.txHash,
      reason: "Transaction reverted on-chain",
    };
  }

  const { aneTestToken } = await client.resolveContracts();
  const assetAddr = (params.expectedAsset ?? aneTestToken).toLowerCase();
  const transferTopic = keccak256Utf8("Transfer(address,address,uint256)").toLowerCase();
  const expectedPayeeTopic = "0x" + abiWordAddress(params.expectedPayee).toLowerCase();
  const expectedAmt = BigInt(params.expectedAmount);

  let matchedTransfer = false;
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() === assetAddr &&
      log.topics[0]?.toLowerCase() === transferTopic &&
      log.topics[2]?.toLowerCase() === expectedPayeeTopic
    ) {
      if (params.expectedVault) {
        const expectedFromTopic = "0x" + abiWordAddress(params.expectedVault).toLowerCase();
        if (log.topics[1]?.toLowerCase() !== expectedFromTopic) {
          continue;
        }
      }
      const value = BigInt(log.data);
      if (value >= expectedAmt) {
        matchedTransfer = true;
        break;
      }
    }
  }

  if (!matchedTransfer) {
    return {
      verified: false,
      blockNumber: Number(BigInt(receipt.blockNumber)),
      txHash: params.txHash,
      reason: "Matching ERC-20 Transfer log to expectedPayee not found in receipt",
    };
  }

  if (params.expectedVault && params.expectedPaymentId) {
    const rec = await client.getPaymentRecord(params.expectedVault, params.expectedPaymentId);
    if (rec.amountPaid < expectedAmt) {
      return {
        verified: false,
        blockNumber: Number(BigInt(receipt.blockNumber)),
        txHash: params.txHash,
        reason: "Payment ID not recorded in AneAgentVault",
      };
    }
  }

  return {
    verified: true,
    blockNumber: Number(BigInt(receipt.blockNumber)),
    txHash: params.txHash,
  };
}
