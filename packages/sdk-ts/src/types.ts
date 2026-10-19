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

export interface AneClientOptions {
  rpcUrl: string;
  chainId?: number;
  registryAddress?: string;
  contracts?: Partial<AneContractAddresses>;
  facilitatorUrl?: string;
}
