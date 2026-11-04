// Read-only verifier: dump the vault's live state and the balances of the
// accounts involved, so every on-chain step can be checked against intent.
// Uses no keys at all; safe to run any time.
//
// Usage, from the repository root:
//   node --env-file=.env agent/verify.mjs [extra-account ...]
//
// Reads VAULT_ACCOUNT_ID and AGENT_ACCOUNT_ID from .env when present, and
// always shows the owner/payee account eqxdemi.testnet unless overridden.
import { JsonRpcProvider, yoctoToNear } from "near-api-js";

const url = process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org";
const provider = new JsonRpcProvider({ url });

const vault = process.env.VAULT_ACCOUNT_ID || "vault.eqxdemi.testnet";
const accounts = [
  ...new Set([
    vault,
    process.env.AGENT_ACCOUNT_ID || "agent.eqxdemi.testnet",
    process.env.PAYEE_ACCOUNT_ID || "eqxdemi.testnet",
    ...process.argv.slice(2),
  ]),
];

async function view(contractId, method, args = {}) {
  return provider.callFunction({
    contractId,
    method,
    args,
    blockQuery: { finality: "final" },
  });
}

console.log("=== balances ===");
for (const id of accounts) {
  const a = await provider.viewAccount({ accountId: id, blockQuery: { finality: "final" } });
  console.log(`${id}: ${yoctoToNear(a.amount)} NEAR (exact ${a.amount.toString()} yocto)`);
}

console.log("\n=== vault get_status ===");
console.log(JSON.stringify(await view(vault, "get_status"), null, 2));

console.log("\n=== vault get_rules ===");
console.log(JSON.stringify(await view(vault, "get_rules"), null, 2));

console.log("\n=== vault get_pending ===");
console.log(JSON.stringify(await view(vault, "get_pending"), null, 2));

console.log("\n=== vault get_receipts ===");
console.log(JSON.stringify(await view(vault, "get_receipts", { limit: 50 }), null, 2));
