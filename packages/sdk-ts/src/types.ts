export const BUDGET_MODE = {
  FIXED: 0,
  REVOLVING: 1,
} as const;

export type BudgetModeName = "FIXED" | "REVOLVING";

export interface AneContractAddresses {
  registry: string;
  aneTestToken: string;
  aneVaultFactory: string;
  aneFaucet: string;
  aneServiceDirectory: string;
}

export interface VaultAccountingSummary {
  owner: string;
  agentSigner: string;
  tokenBalance: bigint;
  ownerPrincipalDeposited: bigint;
  maxTotalSpend: bigint;
  cumulativeSpent: bigint;
  authorizedRemaining: bigint;
  spendableNow: bigint;
  verifiedRevenue: bigint;
  unallocatedBalance: bigint;
  policyVersion: number;
  expiry: number;
  budgetMode: BudgetModeName;
  revolvingTreasuryCeiling: bigint;
  active: boolean;
}

export interface PaymentRecordView {
  merchant: string;
  amountPaid: bigint;
  amountRefunded: bigint;
  settledAt: number;
}

/**
 * Hooks around every transaction an AneClient sends, e.g. a relayer gas budget (#76). Each runs once per
 * transaction, not per retry: retries follow a node rejecting the send, which costs no fee.
 */
export interface SendHooks {
  /**
   * Before sending; throw to refuse the transaction. `from` is the signer's checksummed address. Whatever it
   * returns (e.g. a budget reservation) is handed to `after` or `failed`.
   */
  before?(from: string): unknown;
  /** After it is mined, with the fee actually paid. Also called for a reverted transaction, which still paid. */
  after?(from: string, feeWei: bigint, txHash: string, ticket: unknown): void;
  /** When sending failed without a receipt, so no fee is known. */
  failed?(from: string, ticket: unknown): void;
}

export interface AneClientOptions {
  rpcUrl: string;
  chainId?: number;
  registryAddress?: string;
  contracts?: Partial<AneContractAddresses>;
  facilitatorUrl?: string;
  sendHooks?: SendHooks;
  /** How long after a confirmed write reads are held to that write's block (#67). Default 60 s; 0 turns it off. */
  readFloorWindowMs?: number;
}
