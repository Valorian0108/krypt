// The data seller: a plain account (no contract) that delivers a small
// dataset once the vault's receipts show its order was paid. The vault
// receipt is the proof of payment; delivery is the file written below and
// printed to the console. This is the second counterparty type on the
// allowlist: not every vendor runs a contract.
//
// Usage, from the repository root:
//   node --env-file=.env counterparty/seller.mjs deliver [receipt-id]
//
// Required .env entries: VAULT_ACCOUNT_ID, SELLER_ACCOUNT_ID.
// Optional: NEAR_RPC_URL. Uses no keys at all; everything here is reads.
import { writeFileSync, mkdirSync } from "node:fs";
import { JsonRpcProvider } from "near-api-js";

const [mode, receiptIdArg] = process.argv.slice(2);
if (mode !== "deliver") {
  console.error("usage: node --env-file=.env counterparty/seller.mjs deliver [receipt-id]");
  process.exit(2);
}
const vault = process.env.VAULT_ACCOUNT_ID;
const seller = process.env.SELLER_ACCOUNT_ID;
if (!vault || !seller) {
  console.error("missing VAULT_ACCOUNT_ID or SELLER_ACCOUNT_ID in the environment");
  process.exit(2);
}
const url = process.env.NEAR_RPC_URL || "https://test.rpc.fastnear.com";
const provider = new JsonRpcProvider({ url });

// The synthetic dataset this seller trades in. Deterministic and clearly
// labelled as sample data: the point of the demo is the payment discipline
// around it, not the numbers.
const DATASET = {
  note: "synthetic sample data for the policy-agent demo",
  feed: "example-commodity-prices",
  rows: [
    { asset: "WHEAT", unit: "bushel", price_usd: "5.41" },
    { asset: "COPPER", unit: "pound", price_usd: "4.12" },
    { asset: "OIL_BRENT", unit: "barrel", price_usd: "79.63" },
    { asset: "GOLD", unit: "ounce", price_usd: "2648.90" },
    { asset: "NATGAS", unit: "mmbtu", price_usd: "2.87" },
  ],
};

const receipts = await provider.callFunction({
  contractId: vault,
  method: "get_receipts",
  args: { limit: 100 },
  blockQuery: { finality: "final" },
});

const paidToSeller = receipts.filter(
  (r) => r.payee === seller && ["Settled", "OwnerApproved"].includes(r.status)
);
if (paidToSeller.length === 0) {
  console.log(`no paid orders for ${seller} in the vault's receipts; nothing to deliver`);
  process.exit(2);
}
let receipt = paidToSeller[0]; // get_receipts is newest first
if (receiptIdArg !== undefined) {
  receipt = paidToSeller.find((r) => String(r.id) === String(receiptIdArg));
  if (!receipt) {
    console.error(`no paid receipt ${receiptIdArg} for ${seller}`);
    process.exit(2);
  }
}

const delivery = {
  delivered_for: {
    vault_receipt_id: receipt.id,
    amount_yocto: receipt.amount,
    purpose: receipt.purpose,
    vault_status: receipt.status,
  },
  dataset: DATASET,
};
mkdirSync("deliveries", { recursive: true });
const path = `deliveries/delivery-${receipt.id}.json`;
writeFileSync(path, JSON.stringify(delivery, null, 2) + "\n");

console.log(`paid order found: vault receipt ${receipt.id}, ${receipt.amount} yocto, status ${receipt.status}`);
console.log(`purpose: ${receipt.purpose}`);
console.log(`delivery written to ${path}:`);
console.log(JSON.stringify(delivery, null, 2));
process.exit(0);
