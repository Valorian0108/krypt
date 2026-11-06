# Krypt

Krypt bounds what an AI agent may spend. The money sits in a per-user smart
contract vault on NEAR (testnet) that enforces the owner's rules on-chain, and
a web app lets a non-crypto owner set those rules in dollars. Sign-in is an
email code or a passkey through NEAR FastAuth: no wallet, no seed phrase.

## The idea

Handing an AI agent a wallet means trusting the agent. Krypt removes the need
for trust: the vault contract, not the agent, decides what can be paid. Caps,
allowlists, budgets, and approval queues live on-chain, where a compromised or
confused agent cannot argue with them.

## Layers

```
App (React)        five screens: landing, setup, home, rules, receipts
Server (Express)   sponsor treasury: creates vaults, pays gas, relays signatures
Contract (Rust)    the vault itself: holds the money, enforces the rules
```

Each user gets their own vault account and their own agent account, created
and funded by a sponsor. The sponsor pays creation costs and gas; its key is
not an access key on any vault, so it cannot move a user's money.

## How a spend works

1. The agent calls `request_spend(payee, amount, purpose)` on the vault,
   signed with its own scoped key.
2. The contract checks the payee allowlist, the per-purchase cap, the
   remaining budget, and that the agent is registered.
3. An amount within the auto-approve limit is paid by the vault directly.
   Anything above it queues as pending and waits for the owner.
4. The owner approves or refuses in the app. Approval re-checks the current
   rules, so a request queued under old rules cannot slip through after a
   change.
5. Every outcome is written as a receipt in contract state, visible in the app
   and on the NEAR explorer.

## Rules the owner sets

- Cap per purchase
- Auto-approve limit (above it, the owner decides)
- Budget per period (day, week, or month)
- Payee allowlist
- The contract also supports rule expiry (`expires_at_ns`)

## Security model

- Owner transactions are relayed only for a fixed method whitelist
  (`set_rules`, `add_payee`, `remove_payee`, `register_agent`, `revoke_agent`,
  `approve_spend`, `refuse_spend`, `withdraw`, `simulate_spend`).
  `DeployContract`, plain transfers, and access-key changes are refused by the
  server even when properly signed.
- Login tokens are verified against the FastAuth JWKS with issuer and
  audience checks; transaction signing uses a separate audience. Owner keys
  are MPC-derived from the login and never touch the server.
- The demo agent's key is role-scoped: it can call `request_spend` on its own
  vault only, with a fixed gas allowance.
- The server binds to 127.0.0.1, rate-limits sensitive endpoints, and gates
  setup behind one-time invite codes with a hard user cap.
- A storage guard refuses agent jobs that would push the vault below its NEAR
  storage reserve, so a runaway agent cannot brick the vault with receipt
  spam.
- The contract is built with `overflow-checks = true`: money arithmetic
  panics instead of wrapping.
- The deployed wasm is pinned by SHA-256 in the server config; the server
  refuses to boot on a mismatch.

## Repository layout

| Path | What it is |
| --- | --- |
| `contract/` | The policy vault contract (Rust, near-sdk 5). The enforcement layer. |
| `app/` | Web app (React 19, TypeScript, Vite) and the sponsor/relay server (Express 5). |
| `agent/` | Off-chain CLI agent for the vault, plus adversarial tests (`attack.mjs`) that attack the vault's rules. |
| `counterparty/` | The other side of the demo economy: job-board vendor, hiring cycle, data seller. |
| `worker-contract/` | Job-board counterparty contract: publishes quotes, fulfils jobs with a verifiable digest. |
| `design/` | Static design mocks and the Soft design system (`soft.css`, logo spec). |

## Run locally

Prerequisites: Node.js (recent LTS) and npm. Rust with the
`wasm32-unknown-unknown` target only if you want to rebuild the contract; a
compiled build is bundled at `app/assets/policy_contract.wasm`.

Contract tests:

```sh
cd contract
cargo test
```

App:

```sh
cd app
npm install
# copy env.example to .env, then fill it in; the file documents every variable
npm run dev
```

The web app runs at `http://localhost:3000` and the API at
`http://127.0.0.1:3001` (localhost only). Setup needs a funded NEAR testnet
sponsor account, its key file stored outside the repository, and invite codes
you choose.

To rebuild the contract: build the release wasm, replace
`app/assets/policy_contract.wasm`, and update `wasmSha256` in
`app/server/config.mjs` to the new hash. The server verifies it at boot.

## Demo agent

The bundled agent is deterministic, not an LLM. That is deliberate: it stands
in for any real agent, because Krypt's guarantees come from the contract, not
from the agent's behavior. The app exposes four errands that exercise each
rule: a small purchase that auto-approves, a larger one that queues for the
owner, one above the cap that is refused, and one to an unapproved payee that
is refused.

## Limitations

- NEAR testnet only. All funds are test money.
- Dollar figures use a fixed demo conversion rate from config, not a market
  price.
- Invite-only with a small user cap. This is a demo deployment, not a hosted
  service.

## License

MIT. See [LICENSE](LICENSE).
