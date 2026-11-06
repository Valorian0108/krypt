import { transactions, utils } from "near-api-js";
import { config, GAS } from "./config.mjs";
import {
  callView,
  signAndSendWithKey,
  storagePerByte,
  viewAccount,
} from "./rpc.mjs";
import { explainFailure, nearToYocto, outcomeLogs, yoctoToNear } from "./chain.mjs";
import { appendActivity, getAgentRecord } from "./store.mjs";

// The demo agent is a small, deterministic buyer. It quotes, checks the
// rules with a free read-only call, then asks the vault for one spend with
// its own scoped key. Every outcome is a real on-chain receipt.
export const ERRANDS = [
  {
    id: "dataset",
    title: "Buy this week's market data",
    vendor: "Northstar Data",
    payee: "data.eqxdemi.testnet",
    amountNear: "0.02",
    purpose: "Weekly commodity dataset for the research brief",
    blurb: "A routine purchase, small enough to go through on its own.",
  },
  {
    id: "report",
    title: "Commission the full research report",
    vendor: "Northstar Data",
    payee: "data.eqxdemi.testnet",
    amountNear: "0.20",
    purpose: "Full research report with sources",
    blurb: "Bigger than your auto-approve limit, so it should come to you.",
  },
  {
    id: "premium",
    title: "Upgrade to the live premium feed",
    vendor: "Northstar Data",
    payee: "data.eqxdemi.testnet",
    amountNear: "0.50",
    purpose: "Premium real-time feed subscription",
    blurb: "Above the per-purchase cap, so the rules should refuse it.",
  },
  {
    id: "unlisted",
    title: "Pay a vendor you never approved",
    vendor: "Proof Desk",
    payee: "worker.eqxdemi.testnet",
    amountNear: "0.02",
    purpose: "Sample dataset from a vendor that is not on the list",
    blurb: "Not on your approved list, so the rules should refuse it.",
  },
];

export function errandList() {
  return ERRANDS.map((errand) => ({
    id: errand.id,
    title: errand.title,
    vendor: errand.vendor,
    payee: errand.payee,
    amountNear: errand.amountNear,
    amountYocto: nearToYocto(errand.amountNear).toString(),
    purpose: errand.purpose,
    blurb: errand.blurb,
  }));
}

function decodeReceipt(outcome) {
  const value = outcome.status?.SuccessValue;
  if (typeof value !== "string" || value === "") return null;
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

// One job per vault at a time. A double-click or a second tab must never put
// two spends from the same agent in flight at once.
const inFlight = new Set();

export async function runErrand(args) {
  if (inFlight.has(args.vaultId)) {
    const error = new Error("This agent is already running a job. Wait for it to finish.");
    error.status = 409;
    throw error;
  }
  inFlight.add(args.vaultId);
  try {
    return await runErrandInner(args);
  } finally {
    inFlight.delete(args.vaultId);
  }
}

async function runErrandInner({ vaultId, errandId }) {
  const errand = ERRANDS.find((entry) => entry.id === errandId);
  if (!errand) {
    const error = new Error("That job is not on the list.");
    error.status = 400;
    throw error;
  }

  const record = await getAgentRecord(vaultId);
  if (!record || !record.privateKey) {
    const error = new Error("The agent for this account has not been set up yet.");
    error.status = 409;
    throw error;
  }

  const status = await callView(vaultId, "get_status");
  if (!status || status.agent !== record.agentId) {
    const error = new Error(
      "The agent is not turned on for this account yet. Finish setup first.",
    );
    error.status = 409;
    throw error;
  }

  const amountYocto = nearToYocto(errand.amountNear);

  // Storage guard (anti-DoS): every receipt grows on-chain state, and NEAR
  // demands the account balance cover storage_usage * cost-per-byte. If this
  // job would eat into that lock, the network fails the write with
  // LackBalanceForState and can leave the vault unable to act at all. A
  // compromised or runaway agent could otherwise spam jobs until the vault
  // bricks itself, so the server refuses the job while real headroom is
  // missing. The old vaults predate the contract-side check, which makes
  // this server-side guard the active defense for them.
  const vaultAccount = await viewAccount(vaultId);
  const storageLocked = BigInt(vaultAccount.storage_usage) * (await storagePerByte());
  const liquid = BigInt(vaultAccount.amount) - storageLocked;
  const headroom = nearToYocto("0.05");
  if (liquid < amountYocto + headroom) {
    const error = new Error(
      `The vault has only ${yoctoToNear(liquid)} NEAR of spendable money left, and the ` +
        "network needs headroom to store the receipt. Top up the vault before running " +
        "more jobs — no money moved.",
    );
    error.status = 409;
    throw error;
  }

  // Free read-only check first, so the agent knows what the rules would say.
  const predicted = await callView(vaultId, "simulate_spend", {
    payee: errand.payee,
    amount: amountYocto.toString(),
    purpose: errand.purpose,
  }).catch(() => null);

  const keyPair = utils.KeyPair.fromString(record.privateKey);
  const actions = [
    transactions.functionCall(
      "request_spend",
      {
        payee: errand.payee,
        amount: amountYocto.toString(),
        purpose: errand.purpose,
      },
      GAS.requestSpend,
      0n,
    ),
  ];

  let result;
  try {
    result = await signAndSendWithKey({
      signerId: record.agentId,
      keyPair,
      receiverId: vaultId,
      actions,
    });
  } catch (error) {
    const message = String(error.message || error);
    if (message.includes("NotEnoughAllowance") || message.includes("enough allowance")) {
      const wrapped = new Error(
        "The agent has used up its network-fee allowance, so the network refused the job. No money moved.",
      );
      wrapped.status = 409;
      throw wrapped;
    }
    if (message.includes("UNKNOWN_ACCESS_KEY") || message.includes("doesn't exist")) {
      const wrapped = new Error(
        "The agent's key is no longer valid. Its spending allowance may have run out.",
      );
      wrapped.status = 409;
      throw wrapped;
    }
    throw error;
  }

  const failure = explainFailure(result.outcome, "The agent's request");
  if (failure) {
    await appendActivity(vaultId, {
      kind: "agent",
      errand: errand.id,
      title: errand.title,
      amountYocto: amountYocto.toString(),
      status: "failed",
      reason: failure,
      txHash: result.hash,
    });
    const error = new Error(failure);
    error.status = 422;
    error.txHash = result.hash;
    throw error;
  }

  const receipt = decodeReceipt(result.outcome);
  await appendActivity(vaultId, {
    kind: "agent",
    errand: errand.id,
    title: errand.title,
    amountYocto: amountYocto.toString(),
    status: receipt?.status || "unknown",
    reason: receipt?.reason || "",
    receiptId: receipt?.id ?? null,
    txHash: result.hash,
  });

  return {
    errand: {
      id: errand.id,
      title: errand.title,
      vendor: errand.vendor,
      payee: errand.payee,
      amountYocto: amountYocto.toString(),
      purpose: errand.purpose,
    },
    predicted,
    receipt,
    txHash: result.hash,
    explorer: `https://explorer.testnet.near.org/transactions/${result.hash}`,
    logs: outcomeLogs(result.outcome),
  };
}
