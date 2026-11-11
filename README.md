# Krypt

Krypt bounds what an AI agent may spend. The money sits in a per-user smart
contract vault on NEAR (testnet) that enforces the owner's rules on-chain, and
a web app lets a non-crypto owner set those rules in dollars. Sign-in is an
email code or a passkey through NEAR FastAuth: no wallet, no seed phrase.

A live, read-only view of one testnet vault is hosted at
https://krypt-three-navy.vercel.app/. It is not the app: it reads the vault and
asks the contract what it would do with a given amount, but it cannot sign in
or move money. The full owner flow, including approve and pay, runs locally,
and the video shows it.

The reason is FastAuth. Sign-in works only from `http://localhost:3000`,
because NEAR's FastAuth testnet client allows that one origin. A hosted
deployment cannot offer it.

| | Hosted page | Local app |
| --- | --- | --- |
| Sign in | no | yes, from `http://localhost:3000` only |
| Read rules and receipts | yes, live from the vault | yes |
| Ask the contract about an amount | yes | yes |
| Set rules, approve, pay | no | yes |

## Judge quickstart

- What it is: an on-chain spending account for an AI agent. The owner sets
  limits in dollars; the vault contract enforces them.
- Tracks: `security` (main) and `agents`.
- Live vault on testnet: `vault2.vaults.eqxdemi.testnet`.
- Read-only page, no sign-in: https://krypt-three-navy.vercel.app/
- One-minute check: `cd contract && cargo test` (45 tests).
- Full owner flow: Run locally, then Try it, Level 2 (about 20 minutes).
- Demo video:
  https://x.com/IfeTeddy0108/status/2119493630067151031

## The idea

Handing an AI agent a wallet means trusting the agent. Krypt removes the need
for trust: the vault contract, not the agent, decides what can be paid. Caps,
allowlists, budgets, and approval queues live on-chain, where a compromised or
confused agent cannot argue with them.

One concrete case. An agent reads an email that says an invoice is overdue and
must be paid now, and it believes the sender. With a wallet, that mistake is
final. With Krypt, the request still has to pass the contract: the seller must
be on the list, the amount under the cap, and the budget not yet spent. If any
check fails, no money moves.

## Layers

```
App (React)        five screens: landing, setup, home, rules, receipts
Server (Express)   sponsor treasury: creates vaults, pays gas, relays signatures
Contract (Rust)    the vault itself: holds the money, enforces the rules
```

Each user gets their own vault account and their own agent account, created
and funded by a sponsor. The sponsor pays creation costs and gas; its key is
not an access key on any vault, so it cannot move a user's money.

## How NEAR fits

- Every vault is its own NEAR account, owned by its contract. Rules,
  receipts, and the approval queue are contract state, so enforcement happens
  on-chain. No off-chain component, including this app's own server, can
  bypass a rule.
- Sign-in uses NEAR FastAuth. The MPC network derives the user's signing key
  from the login, so there is no seed phrase and the server never holds a
  user key.
- The agent's key is a FunctionCall access key scoped to one vault, one
  method (`request_spend`), with a fixed gas allowance. A compromised agent
  cannot transfer the vault's balance or touch any other account.
- The sponsor creates each vault and agent as subaccounts and pays their
  storage and gas, so users never handle NEAR to use the product.

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

## See it on chain

These are real testnet transactions from the live vault. Each opens in the
NEAR testnet explorer.

| What happened | Receipt | Transaction |
| --- | --- | --- |
| $0.10 auto-approved and paid | 0 | [request_spend](https://explorer.testnet.near.org/transactions/CsFBaR3UJavmZDQWdWUy19ufeynv2g85u39yvBKLP8oR) |
| $1.00 queued for the owner | 1 | [request_spend](https://explorer.testnet.near.org/transactions/3wsy7msJhVdRW5f6tRTgvD3zPPzpDABPSmx3SkuKcHyn) |
| the owner approved that request | 1 | [approve_spend](https://explorer.testnet.near.org/transactions/8EUtsqMvFNxqXUaiSLLDmMT2DdZ9cdyVhinjZSrXbYyf) |
| $2.50 refused, above the cap | 6 | [request_spend](https://explorer.testnet.near.org/transactions/C9xyvZj9D5qx3SBdN6ywjUBxWwEdqbq9dEdYMk5rVY22) |
| a seller not on the list refused | 4 | [request_spend](https://explorer.testnet.near.org/transactions/BRvZbKBUVpS9a9dV9Y4U2kgV2KjRXhMH6cn6gGEYDTNN) |

The reason for each is in the transaction log, and the same receipts are
readable with `get_receipts` on the vault account.

## Rules the owner sets

- Cap per purchase
- Auto-approve limit (above it, the owner decides)
- Budget per period (day, week, or month)
- Payee allowlist
- The contract also supports rule expiry (`expires_at_ns`)

## How this differs from a plain agent wallet

- The owner sets rules in dollars, not in token amounts, and never has to know
  what a yoctoNEAR is.
- Sign-in is an email code or a passkey through FastAuth: no seed phrase, no
  browser extension, nothing to install.
- An approval re-checks the rules at approval time, so a request queued under
  old rules cannot pass after the owner tightens them.
- A storage reserve guard refuses spends that would leave the vault unable to
  store its own receipts, so a runaway agent cannot fill the vault with spam.

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
| `showcase/` | Static read-only page for a hosted demo URL: live vault reads and `simulate_spend`, no sign-in. |

## Run locally

Prerequisites: Node.js (recent LTS) and npm for the app. Rust for the contract
test suite and for rebuilding the contract, with the `wasm32-unknown-unknown`
target only for the rebuild. A compiled build is bundled at
`app/assets/policy_contract.wasm`, so rebuilding is optional for running the
app.

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

## Try it

Level 1: the contract test suite. No accounts, no network, about one minute.

```sh
cd contract
cargo test
```

You see 45 tests pass. They cover each rule the contract enforces: over-cap
refusals, unapproved payees, exhausted budgets, expired rules, unregistered
agents, the pending-approval queue, rule re-checks at approval time, payout
callbacks, withdrawal destination checks, and storage headroom.

Level 2: the full app on testnet. Needs a sponsor account holding testnet
NEAR (free from a faucet; faucets are rate-limited, so topping up can take a
while) and about 20 minutes.

1. Create a NEAR testnet account and locate its key file, the JSON with a
   `private_key` field that near-cli stores in its credentials directory.
   Keep it outside this repository.
2. Copy `app/env.example` to `app/.env`. Set `SPONSOR_ACCOUNT_ID` and
   `SPONSOR_SUBACCOUNT_SUFFIX` to that account, `SPONSOR_KEY_PATH` to the key
   file, and `INVITE_CODES` to any code you invent.
3. In `app/`: `npm install`, then `npm run dev`.
4. Open exactly `http://localhost:3000`. The FastAuth testnet client allows
   sign-in from this origin only.
5. Sign in with an email code or a passkey, then enter your invite code. You
   see setup create your vault and agent accounts, deploy the contract, fund
   both, and register the agent, each step linking to its explorer
   transaction.
6. Open Rules. A fresh vault starts closed: every purchase is refused until
   you set limits. Set cap $2.00, auto-approve $0.40, budget $2.00 per week,
   add the payee `data.eqxdemi.testnet` (the demo vendor), and save. You see
   the on-chain confirmation with its transaction link.
7. On Home, run "Buy this week's market data" ($0.10). You see it
   auto-approve and pay with no prompt, and a receipt appear with its
   explorer link.
8. Run "Commission the full research report" ($1.00). You see it queue as
   pending because it is above the auto-approve limit. Approve it, and you see
   the payment execute and the receipt update.
9. Run "Upgrade to the live premium feed" ($2.50). You see it refused: above
   the per-purchase cap. No money moves.
10. To see the payee allowlist rule answer, open the hosted read-only page at
    https://krypt-three-navy.vercel.app/ and use its simulator: pick "A seller
    not on the list", enter any amount, and it refuses. The check is a view
    call, so nothing is recorded or paid.
11. Open Receipts. You see every decision above, with status, reason, and
    explorer links, matching what the contract wrote on-chain.

## Demo agent

The bundled agent is deterministic, not an LLM. That is deliberate: it stands
in for any real agent, because Krypt's guarantees come from the contract, not
from the agent's behavior. Under the walkthrough limits, the app exposes three
errands that exercise the spending rules: a small purchase that auto-approves,
a larger one that queues for the owner, and one above the cap that is refused.
The verdicts are computed from your live rules, so changing the limits changes
what each errand does. The payee allowlist has its own demonstration: the
`simulate_spend` view call on the hosted read-only page refuses any seller not
on the list.

## Attack suite

`agent/attack.mjs` is a prompt-injection suite written against the live vault.
Each scenario pairs an injection that an attacker might slip into the agent's
context with the request a compromised agent would make from it.

| Scenario | The injection tries to | What stops it |
| --- | --- | --- |
| S1 exfil | pay `attacker.testnet` | the contract: payee not on the allowlist, receipt written |
| S2 cap smash | claim the owner approved an amount above the cap | the contract: over the cap, receipt written |
| S3 human wall | send a mid-size amount to be forwarded onward | the contract queues it, the owner refuses, the receipt ends refused |
| S4 bypass | transfer directly from the vault | the network: the agent key cannot send a plain transfer, no state change |
| S5 self-approve | approve its own pending spend | the network: the method is outside the key's scope, no state change |

`plan` prints the predicted outcome for each scenario from the live rules and
sends nothing. `attack` runs the suite. `verify` reads the receipts and prints
the scoreboard. The runner predicts every outcome before sending and aborts if
a prediction and its expectation disagree.

## Limitations

- NEAR testnet only. All funds are test money.
- Dollar figures use a fixed demo conversion rate from config, not a market
  price.
- Invite-only with a small user cap. This is a demo deployment, not a hosted
  service.
- Sign-in works only from `http://localhost:3000`: the FastAuth testnet
  client's redirect allowlist contains that one origin. A hosted deployment
  therefore cannot offer sign-in. The read-only page in `showcase/`, deployed
  at https://krypt-three-navy.vercel.app/, is built for that case: it reads
  the live vault and runs `simulate_spend`, but it never signs, broadcasts,
  or writes.
- Upgrading an already-deployed vault needs an owner-signed `DeployContract`;
  the repository includes an operator page for it at
  `app/deploy-upgrade.html`. Vaults provisioned from now on receive the
  current bundled wasm.

## Baseline and prior work

- Every commit in this repository falls inside the NEAR HACKATHON window
  (2026-11-01 to 2026-11-14). The first commit is dated 2026-11-03.
- `agent/`, `counterparty/`, and `worker-contract/` are the CLI-first
  iteration of this project, built in-window from Nov 3 to Nov 5, including
  an attack suite with prompt-injection scenarios that exercises the
  contract's refusals. The web app in `app/` was built on top of it on Nov 5
  and Nov 6.
- The visual design system (`design/soft.css` and the mocks) extends design
  standards the owner maintained before the hackathon, and is disclosed here
  as prior work per Q-005 of the hackathon rules.
- Third-party libraries: near-sdk-rs, near-api-js, @near-js/transactions,
  the @fast-auth-near SDKs, express, jose, react, vite, dotenv. Versions are
  pinned in the package manifests.

## License

MIT. See [LICENSE](LICENSE).
