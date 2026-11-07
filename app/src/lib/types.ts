export type Vendor = {
  id: string;
  name: string;
  note: string;
};

export type Errand = {
  id: string;
  title: string;
  vendor: string;
  payee: string;
  amountNear: string;
  amountYocto: string;
  purpose: string;
};

export type AppConfig = {
  network: string;
  nearUsdRate: number;
  auth: {
    domain: string;
    clientId: string;
    fastAuthContractId: string;
    mpcContractId: string;
  };
  vendors: Vendor[];
  defaultRules: {
    capUsd: string;
    autoUsd: string;
    budgetUsd: string;
    periodDays: number;
    payees: string[];
  };
  periodChoices: { days: number; label: string }[];
  errands: Errand[];
  agent: { gasAllowanceNear: string };
};

export type User = {
  subject: string;
  name: string | null;
  email: string | null;
  vaultId: string;
  agentId: string;
  publicKey: string;
  agentPublicKey: string;
  createdAt: string;
  contractCodeHash: string;
};

export type Rules = {
  cap_per_spend: string;
  auto_limit: string;
  budget_per_period: string;
  period_ns: number;
  expires_at_ns: number;
  payees: string[];
};

export type VaultStatus = {
  owner: string;
  agent: string | null;
  spent_this_period: string;
  budget_remaining: string;
  period_start_ns: number;
  next_period_reset_ns: number;
  receipts_count: number;
  pending_count: number;
  vault_balance_yocto: string;
};

export type Receipt = {
  id: number;
  timestamp_ns: number;
  requester: string;
  payee: string;
  amount: string;
  purpose: string;
  status: SpendStatus;
  reason: string;
};

export type SpendStatus =
  | "Settled"
  | "TransferFailed"
  | "Queued"
  | "OwnerApproved"
  | "OwnerRefused"
  | "Rejected";

export type PendingSpend = {
  receipt_id: number;
  payee: string;
  amount: string;
};

export type AccessKeyView = {
  publicKey: string;
  permission:
    | "full"
    | "unknown"
    | { type: "scoped"; receiver: string; methods: string[] };
};

export type Vault = {
  vaultId: string;
  balanceYocto: string;
  storageReserveYocto: string;
  spendableYocto: string;
  storageBytes: number;
  codeHash: string;
  accessKeys: AccessKeyView[];
  status: VaultStatus;
  rules: Rules;
  receipts: Receipt[];
  pending: PendingSpend[];
};

export type ActivityItem = {
  id: string;
  at: string;
  kind: string;
  title: string;
  status?: string;
  reason?: string;
  amountYocto?: string | null;
  receiptId?: number | null;
  txHash?: string;
  errand?: string;
};

export type VaultResponse = {
  vault: Vault;
  activity: ActivityItem[];
  user: User;
};

export type MeResponse =
  | {
      needsSetup: true;
      // True while the server is mid-provisioning for this login: a claim
      // placeholder exists but no vault yet.
      setupInProgress?: boolean;
      identity: { name: string; email: string | null; publicKey: string };
      existingVault: string | null;
    }
  | { needsSetup: false; user: User };

export type AgentRunResult = {
  errand: {
    id: string;
    title: string;
    vendor: string;
    payee: string;
    amountYocto: string;
    purpose: string;
  };
  predicted: {
    simulated: boolean;
    would_be_status: SpendStatus;
    would_be_reason: string;
    note: string;
  } | null;
  receipt: Receipt | null;
  txHash: string;
  explorer: string;
  logs: string[];
};

export type BroadcastResult = {
  hash: string;
  explorer: string;
  status: unknown;
  successValue: string | null;
  logs: string[];
};

export type RunOutcome = {
  title: string;
  tone: "green" | "amber" | "red";
  headline: string;
  detail: string;
  status?: SpendStatus;
  txHash?: string;
  predicted?: string | null;
  logs?: string[];
};
