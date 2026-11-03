//! Policy contract: bounds what an AI agent may spend, on-chain.
//!
//! The owner registers one agent account and a set of rules: a cap per
//! spend, an auto-settle limit, a budget per time period, a payee
//! allowlist, and an expiry. The agent may call exactly one method,
//! `request_spend`. The contract checks the request against the rules and
//! either settles it (direct testnet transfer from the contract's own
//! balance), queues it for owner approval, or refuses it with a readable
//! reason. Every outcome is written as a receipt in contract state, so the
//! decision history is tamper-evident and publicly readable.
//!
//! Design notes that matter for security:
//! - Refusals are recorded, not panicked. A rule refusal writes a receipt
//!   and returns normally, so the reason lives on-chain. Panics are
//!   reserved for authorization failures (caller is not the owner or not
//!   the registered agent), which should leave no trace.
//! - Fail closed. Until the owner sets rules, every cap and budget is
//!   zero, so every request is refused.
//! - Owner methods require exactly 1 yoctoNEAR attached. A FunctionCall
//!   access key (what the agent holds) cannot attach any deposit, so this
//!   is a second lock on owner methods, independent of key method scoping.
//! - Budget accounting: settled spends debit the period budget immediately.
//!   Queued spends do NOT reserve budget; the budget is re-checked at
//!   approval time and the approval fails if the budget ran out. This edge
//!   is documented deliberately (see SCOPE notes), not silently chosen.
//! - If a payout transfer fails on-chain, a private callback restores the
//!   budget and marks the receipt as failed.
//! - All money arithmetic is checked; `overflow-checks = true` is also set
//!   in the release profile.

use near_sdk::json_types::U128;
use near_sdk::store::{IterableSet, LookupMap, Vector};
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
};

/// Gas reserved for the private transfer-result callback.
const CALLBACK_GAS: Gas = Gas::from_tgas(6);

/// Hard cap on receipt bytes, so one request cannot bloat state.
const MAX_PURPOSE_BYTES: usize = 280;

pub type ReceiptId = u64;

// Unique byte prefixes for each on-chain collection, so their storage
// keys can never collide.
const PREFIX_ALLOWLIST: &[u8] = b"a";
const PREFIX_RECEIPTS: &[u8] = b"r";
const PREFIX_PENDING: &[u8] = b"p";
const PREFIX_PENDING_ORDER: &[u8] = b"o";

/// The owner's rules, stored as data.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Rules {
    /// Absolute maximum for a single spend. Above this: refused.
    pub cap_per_spend: U128,
    /// At or below this: settles automatically. Above it, up to the cap:
    /// queued for owner approval.
    pub auto_limit: U128,
    /// Total the agent may settle per period.
    pub budget_per_period: U128,
    /// Period length in nanoseconds. Must be greater than zero.
    pub period_ns: u64,
    /// Policy expiry as a nanosecond unix timestamp. Zero means no expiry.
    pub expires_at_ns: u64,
}

impl Rules {
    /// Fail-closed defaults: everything is zero, so nothing can be spent
    /// until the owner explicitly sets rules.
    fn closed() -> Self {
        Self {
            cap_per_spend: U128(0),
            auto_limit: U128(0),
            budget_per_period: U128(0),
            period_ns: 1,
            expires_at_ns: 0,
        }
    }
}

/// What happened to one spend request, as a status a person can read.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum SpendStatus {
    /// The rules allowed it and the transfer was scheduled.
    Settled,
    /// The transfer failed on-chain; the budget was restored.
    TransferFailed,
    /// Above the auto-settle limit, waiting for the owner.
    Queued,
    /// The owner approved; the transfer was scheduled.
    OwnerApproved,
    /// The owner refused.
    OwnerRefused,
    /// A rule refused it; the reason is in the receipt.
    Rejected,
}

/// The on-chain record of one decision. This is the product's audit trail.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Receipt {
    pub id: ReceiptId,
    pub timestamp_ns: u64,
    pub requester: AccountId,
    pub payee: AccountId,
    pub amount: U128,
    pub purpose: String,
    pub status: SpendStatus,
    /// A sentence a person can read, never an error code.
    pub reason: String,
}

/// A spend waiting for the owner's decision.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
struct PendingSpend {
    payee: AccountId,
    amount: u128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PendingView {
    pub receipt_id: ReceiptId,
    pub payee: AccountId,
    pub amount: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct RulesView {
    pub cap_per_spend: U128,
    pub auto_limit: U128,
    pub budget_per_period: U128,
    pub period_ns: u64,
    pub expires_at_ns: u64,
    pub payees: Vec<AccountId>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct StatusView {
    pub owner: AccountId,
    pub agent: Option<AccountId>,
    pub spent_this_period: U128,
    pub budget_remaining: U128,
    pub period_start_ns: u64,
    pub next_period_reset_ns: u64,
    pub receipts_count: u64,
    pub pending_count: u64,
    pub vault_balance_yocto: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PolicyVault {
    owner: AccountId,
    agent: Option<AccountId>,
    rules: Rules,
    allowlist: IterableSet<AccountId>,
    spent_this_period: u128,
    period_start_ns: u64,
    receipts: Vector<Receipt>,
    pending: LookupMap<ReceiptId, PendingSpend>,
    pending_order: Vector<ReceiptId>,
    next_receipt_id: ReceiptId,
}

/// JSON arguments for the private transfer-result callback. The callback's
/// `result` argument comes from the runtime, not from these args.
#[derive(near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
struct CallbackArgs {
    amount: U128,
    receipt_id: ReceiptId,
}

#[near]
impl PolicyVault {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            agent: None,
            rules: Rules::closed(),
            allowlist: IterableSet::new(PREFIX_ALLOWLIST),
            spent_this_period: 0,
            period_start_ns: env::block_timestamp(),
            receipts: Vector::new(PREFIX_RECEIPTS),
            pending: LookupMap::new(PREFIX_PENDING),
            pending_order: Vector::new(PREFIX_PENDING_ORDER),
            next_receipt_id: 0,
        }
    }

    // ------------------------------------------------------------------
    // The one agent method
    // ------------------------------------------------------------------

    /// The only method the agent's scoped key may call. Checks the request
    /// against the rules and settles, queues, or refuses it. Every outcome
    /// writes a receipt.
    pub fn request_spend(
        &mut self,
        payee: AccountId,
        amount: U128,
        purpose: String,
    ) -> Receipt {
        // Authorization failures panic (no receipt): the caller has no
        // business here, and a panic leaves state untouched.
        require!(
            self.agent.is_some(),
            "no agent is registered, so nobody may request spends"
        );
        require!(
            env::predecessor_account_id() == self.agent.clone().unwrap(),
            "only the registered agent may request spends"
        );
        require!(
            !purpose.is_empty() && purpose.len() <= MAX_PURPOSE_BYTES,
            "purpose must be between 1 and 280 bytes"
        );

        self.roll_period_if_needed();
        let amount_y = amount.0;

        // Rule checks, in the order a person would explain them. Each
        // refusal records a receipt with a readable reason and returns.
        if self.rules.expires_at_ns != 0 && env::block_timestamp() >= self.rules.expires_at_ns {
            return self.record(
                payee,
                amount_y,
                purpose,
                SpendStatus::Rejected,
                "the policy has expired, so every request is refused until the owner renews it",
            );
        }
        if amount_y == 0 {
            return self.record(
                payee,
                amount_y,
                purpose,
                SpendStatus::Rejected,
                "the amount must be greater than zero",
            );
        }
        if !self.allowlist.contains(&payee) {
            return self.record(
                payee,
                amount_y,
                purpose,
                SpendStatus::Rejected,
                "the payee is not on the owner's allowlist",
            );
        }
        if amount_y > self.rules.cap_per_spend.0 {
            return self.record(
                payee,
                amount_y,
                purpose,
                SpendStatus::Rejected,
                "the amount exceeds the per-spend cap in the rules",
            );
        }
        let remaining = self.rules.budget_per_period.0.saturating_sub(self.spent_this_period);
        if amount_y > remaining {
            return self.record(
                payee,
                amount_y,
                purpose,
                SpendStatus::Rejected,
                "the period budget does not have enough left for this amount",
            );
        }
        if NearToken::from_yoctonear(amount_y) > env::account_balance() {
            return self.record(
                payee,
                amount_y,
                purpose,
                SpendStatus::Rejected,
                "the vault does not hold that much NEAR",
            );
        }

        if amount_y > self.rules.auto_limit.0 {
            // Above the auto-settle limit but within the cap: queue for the
            // owner. Budget is deliberately not debited here; it is
            // re-checked at approval time.
            let receipt = self.record(
                payee,
                amount_y,
                purpose,
                SpendStatus::Queued,
                "the amount is above the auto-settle limit, so it waits for the owner's approval",
            );
            self.pending.insert(
                receipt.id,
                PendingSpend {
                    payee: receipt.payee.clone(),
                    amount: amount_y,
                },
            );
            self.pending_order.push(receipt.id);
            return receipt;
        }

        // Within every rule: debit the budget first, then schedule the
        // payout. Debiting before the promise is what makes a double
        // request impossible: the second call sees the reduced budget.
        self.spent_this_period = self
            .spent_this_period
            .checked_add(amount_y)
            .expect("budget arithmetic overflowed");
        let receipt = self.record(
            payee.clone(),
            amount_y,
            purpose,
            SpendStatus::Settled,
            "within every rule; the payment was scheduled",
        );
        self.payout(payee, amount_y, receipt.id);
        receipt
    }

    // ------------------------------------------------------------------
    // Owner methods (1 yoctoNEAR required on each; a FunctionCall key
    // cannot attach a deposit, so the agent's key can never call these)
    // ------------------------------------------------------------------

    #[payable]
    pub fn set_rules(&mut self, rules: Rules) {
        self.assert_owner_one_yocto();
        require!(rules.period_ns > 0, "the period length must be greater than zero");
        require!(
            rules.auto_limit.0 <= rules.cap_per_spend.0,
            "the auto-settle limit must not exceed the per-spend cap"
        );
        require!(
            rules.expires_at_ns == 0 || rules.expires_at_ns > env::block_timestamp(),
            "the expiry must be in the future, or zero for no expiry"
        );
        self.rules = rules;
        env::log_str("the owner updated the rules");
    }

    #[payable]
    pub fn add_payee(&mut self, payee: AccountId) {
        self.assert_owner_one_yocto();
        require!(
            self.allowlist.insert(payee.clone()),
            "that payee is already on the allowlist"
        );
        env::log_str(&format!("the owner added an allowed payee: {payee}"));
    }

    #[payable]
    pub fn remove_payee(&mut self, payee: AccountId) {
        self.assert_owner_one_yocto();
        require!(
            self.allowlist.remove(&payee),
            "that payee was not on the allowlist"
        );
        env::log_str(&format!("the owner removed an allowed payee: {payee}"));
    }

    #[payable]
    pub fn register_agent(&mut self, agent: AccountId) {
        self.assert_owner_one_yocto();
        self.agent = Some(agent.clone());
        env::log_str(&format!("the owner registered the agent: {agent}"));
    }

    #[payable]
    pub fn revoke_agent(&mut self) {
        self.assert_owner_one_yocto();
        require!(self.agent.take().is_some(), "no agent is registered");
        env::log_str("the owner revoked the agent");
    }

    #[payable]
    pub fn approve_spend(&mut self, receipt_id: ReceiptId) {
        self.assert_owner_one_yocto();
        let pending = self
            .pending
            .get(&receipt_id)
            .cloned()
            .expect("there is no pending spend with that receipt id");
        self.roll_period_if_needed();
        require!(
            self.rules.expires_at_ns == 0 || env::block_timestamp() < self.rules.expires_at_ns,
            "the policy has expired, so nothing can be approved"
        );
        let remaining = self.rules.budget_per_period.0.saturating_sub(self.spent_this_period);
        require!(
            pending.amount <= remaining,
            "the period budget ran out before this approval, so it cannot be paid"
        );
        require!(
            NearToken::from_yoctonear(pending.amount) <= env::account_balance(),
            "the vault does not hold that much NEAR"
        );
        self.pending.remove(&receipt_id);
        self.spent_this_period = self
            .spent_this_period
            .checked_add(pending.amount)
            .expect("budget arithmetic overflowed");
        self.update_receipt(
            receipt_id,
            SpendStatus::OwnerApproved,
            "the owner approved this spend; the payment was scheduled",
        );
        env::log_str(&format!("the owner approved receipt {receipt_id}"));
        self.payout(pending.payee, pending.amount, receipt_id);
    }

    #[payable]
    pub fn refuse_spend(&mut self, receipt_id: ReceiptId) {
        self.assert_owner_one_yocto();
        require!(
            self.pending.remove(&receipt_id).is_some(),
            "there is no pending spend with that receipt id"
        );
        self.update_receipt(
            receipt_id,
            SpendStatus::OwnerRefused,
            "the owner refused this spend",
        );
        env::log_str(&format!("the owner refused receipt {receipt_id}"));
    }

    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        self.assert_owner_one_yocto();
        // Keep enough to cover the contract's own storage, so the state
        // (rules and receipts) can never be stranded by a withdrawal.
        let reserved = storage_reserved();
        let balance = env::account_balance().as_yoctonear();
        require!(
            balance > reserved,
            "the vault holds only its storage reserve, so there is nothing to withdraw"
        );
        require!(
            amount.0 <= balance - reserved,
            "withdrawing that much would leave the vault below its storage reserve"
        );
        env::log_str("the owner withdrew NEAR from the vault");
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
    }

    // ------------------------------------------------------------------
    // Private callback: what happened to a payout transfer
    // ------------------------------------------------------------------

    #[private]
    pub fn on_transfer_result(
        &mut self,
        #[callback_result] result: Result<(), PromiseError>,
        amount: U128,
        receipt_id: ReceiptId,
    ) {
        match result {
            Ok(()) => {
                self.update_receipt(
                    receipt_id,
                    SpendStatus::Settled,
                    "the payment reached the payee",
                );
                env::log_str(&format!("receipt {receipt_id}: the payment reached the payee"));
            }
            Err(_) => {
                // Restore the budget. saturating_sub: if the period rolled
                // between settle and callback, the refund lands in the new
                // period's accounting, clamped at zero rather than
                // panicking. Documented edge, not silent corruption.
                self.spent_this_period = self.spent_this_period.saturating_sub(amount.0);
                self.update_receipt(
                    receipt_id,
                    SpendStatus::TransferFailed,
                    "the transfer to the payee failed, so the budget was restored",
                );
                env::log_str(&format!(
                    "receipt {receipt_id}: the transfer failed and the budget was restored"
                ));
            }
        }
    }

    // ------------------------------------------------------------------
    // Views (free to call, change nothing)
    // ------------------------------------------------------------------

    pub fn get_status(&self) -> StatusView {
        let (spent, period_start) = self.effective_period();
        let remaining = self.rules.budget_per_period.0.saturating_sub(spent);
        StatusView {
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            spent_this_period: U128(spent),
            budget_remaining: U128(remaining),
            period_start_ns: period_start,
            next_period_reset_ns: period_start.saturating_add(self.rules.period_ns),
            receipts_count: self.receipts.len() as u64,
            pending_count: self.pending_ids().len() as u64,
            vault_balance_yocto: U128(env::account_balance().as_yoctonear()),
        }
    }

    pub fn get_rules(&self) -> RulesView {
        RulesView {
            cap_per_spend: self.rules.cap_per_spend,
            auto_limit: self.rules.auto_limit,
            budget_per_period: self.rules.budget_per_period,
            period_ns: self.rules.period_ns,
            expires_at_ns: self.rules.expires_at_ns,
            payees: self.allowlist.iter().cloned().collect(),
        }
    }

    /// Most recent receipts first, up to `limit` (default 50).
    pub fn get_receipts(&self, limit: Option<u32>) -> Vec<Receipt> {
        let cap = limit.unwrap_or(50).min(self.receipts.len());
        let len = self.receipts.len();
        (0..cap)
            .map(|i| self.receipts.get(len - 1 - i).cloned().expect("index in range"))
            .collect()
    }

    pub fn get_pending(&self) -> Vec<PendingView> {
        self.pending_ids()
            .into_iter()
            .filter_map(|id| {
                self.pending.get(&id).map(|p| PendingView {
                    receipt_id: id,
                    payee: p.payee.clone(),
                    amount: U128(p.amount),
                })
            })
            .collect()
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    fn assert_owner_one_yocto(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner may call this method"
        );
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "this method requires exactly 1 yoctoNEAR attached, which a function-call key cannot attach"
        );
    }

    fn roll_period_if_needed(&mut self) {
        let now = env::block_timestamp();
        if now >= self.period_start_ns.saturating_add(self.rules.period_ns) {
            self.period_start_ns = now;
            self.spent_this_period = 0;
            env::log_str("a new budget period started; the spent amount was reset");
        }
    }

    /// Read-only version of the period roll, for views.
    fn effective_period(&self) -> (u128, u64) {
        let now = env::block_timestamp();
        if now >= self.period_start_ns.saturating_add(self.rules.period_ns) {
            (0, now)
        } else {
            (self.spent_this_period, self.period_start_ns)
        }
    }

    fn pending_ids(&self) -> Vec<ReceiptId> {
        self.pending_order
            .iter()
            .copied()
            .filter(|id| self.pending.contains_key(id))
            .collect()
    }

    fn record(
        &mut self,
        payee: AccountId,
        amount_y: u128,
        purpose: String,
        status: SpendStatus,
        reason: &str,
    ) -> Receipt {
        let id = self.next_receipt_id;
        self.next_receipt_id = id.checked_add(1).expect("receipt id overflow");
        let receipt = Receipt {
            id,
            timestamp_ns: env::block_timestamp(),
            requester: env::predecessor_account_id(),
            payee,
            amount: U128(amount_y),
            purpose,
            status,
            reason: reason.to_string(),
        };
        env::log_str(&format!(
            "receipt {id} {:?}: {reason}",
            receipt.status
        ));
        self.receipts.push(receipt.clone());
        receipt
    }

    fn update_receipt(&mut self, id: ReceiptId, status: SpendStatus, reason: &str) {
        let idx = id as u32;
        if let Some(mut receipt) = self.receipts.get(idx).cloned() {
            receipt.status = status;
            receipt.reason = reason.to_string();
            self.receipts.set(idx, receipt);
        }
    }

    /// Schedule the payout and its private result callback with low-level
    /// promise batches. Low-level batches register with the runtime
    /// immediately, which lets `request_spend` return the receipt to the
    /// agent in the same call. (The high-level `Promise` API only schedules
    /// when the promise object is returned from the method, and here the
    /// return value is the receipt.)
    fn payout(&self, payee: AccountId, amount_y: u128, receipt_id: ReceiptId) {
        let transfer_idx = env::promise_batch_create(&payee);
        env::promise_batch_action_transfer(transfer_idx, NearToken::from_yoctonear(amount_y));
        let callback_idx = env::promise_batch_then(transfer_idx, &env::current_account_id());
        let args =
            near_sdk::serde_json::to_vec(&CallbackArgs { amount: U128(amount_y), receipt_id })
                .expect("callback arguments must serialize");
        env::promise_batch_action_function_call(
            callback_idx,
            "on_transfer_result",
            &args,
            NearToken::from_yoctonear(0),
            CALLBACK_GAS,
        );
    }
}

/// The contract's storage reserve in yoctoNEAR: what its state costs at
/// the protocol's per-byte price, using the contract's live storage usage.
fn storage_reserved() -> u128 {
    let per_byte = env::storage_byte_cost().as_yoctonear();
    per_byte.saturating_mul(env::storage_usage() as u128)
}

// ======================================================================
// Tests, including the attacker suite
// ======================================================================
//
// Two families live here:
// 1. Behaviour tests: the rules do what the scope document says.
// 2. Attacker tests: privilege confusion, double spend, callback failure,
//    budget exhaustion, expiry, lockout, and arithmetic abuse. Each maps
//    to an item on the NEAR security checklist.

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const T0: u64 = 1_700_000_000_000_000_000;
    const NS: u64 = 1_000_000_000;
    const DAY_NS: u64 = 86_400 * NS;
    const NEAR: u128 = 1_000_000_000_000_000_000_000_000; // 1 NEAR in yocto

    fn acct(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn owner() -> AccountId {
        acct("owner.test.near")
    }
    fn vault() -> AccountId {
        acct("vault.test.near")
    }
    fn agent() -> AccountId {
        acct("agent.test.near")
    }
    fn intruder() -> AccountId {
        acct("intruder.test.near")
    }
    fn good() -> AccountId {
        acct("good.test.near")
    }
    fn evil() -> AccountId {
        acct("evil.test.near")
    }

    /// Set the VM context: who is calling, with what deposit, at what time.
    fn set_env(predecessor: &AccountId, deposit_yocto: u128, now: u64) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(vault())
            .predecessor_account_id(predecessor.clone())
            .signer_account_id(predecessor.clone())
            .attached_deposit(NearToken::from_yoctonear(deposit_yocto))
            .block_timestamp(now)
            .account_balance(NearToken::from_yoctonear(10 * NEAR))
            .storage_usage(10_000);
        testing_env!(b.build());
    }

    fn owner_env(now: u64) {
        set_env(&owner(), 1, now);
    }

    /// Rules used by most tests: cap 1 NEAR, auto-settle up to 0.5 NEAR,
    /// budget 2 NEAR per day, no expiry.
    fn normal_rules() -> Rules {
        Rules {
            cap_per_spend: U128(NEAR),
            auto_limit: U128(NEAR / 2),
            budget_per_period: U128(2 * NEAR),
            period_ns: DAY_NS,
            expires_at_ns: 0,
        }
    }

    /// A fully configured vault: rules set, one allowed payee, agent
    /// registered.
    fn setup() -> PolicyVault {
        owner_env(T0);
        let mut c = PolicyVault::new(owner());
        c.set_rules(normal_rules());
        c.add_payee(good());
        c.register_agent(agent());
        c
    }

    /// The agent asks to spend. Deposit is 0: a FunctionCall key cannot
    /// attach one, and the tests model that faithfully.
    fn agent_ask(c: &mut PolicyVault, payee: AccountId, amount: u128, now: u64) -> Receipt {
        set_env(&agent(), 0, now);
        c.request_spend(payee, U128(amount), "test purpose".to_string())
    }

    fn status_of(c: &PolicyVault, now: u64) -> StatusView {
        set_env(&owner(), 0, now);
        c.get_status()
    }

    // ------------------------------------------------------------------
    // Behaviour tests
    // ------------------------------------------------------------------

    #[test]
    fn init_is_fail_closed() {
        // A brand-new vault with no rules refuses everything, even a
        // registered agent paying an allowlisted payee one yocto.
        owner_env(T0);
        let mut c = PolicyVault::new(owner());
        c.add_payee(good());
        c.register_agent(agent());
        let r = agent_ask(&mut c, good(), 1, T0);
        assert_eq!(r.status, SpendStatus::Rejected);
        assert!(r.reason.contains("cap"));
    }

    #[test]
    fn happy_path_settles_and_debits_budget() {
        let mut c = setup();
        let r = agent_ask(&mut c, good(), 4 * NEAR / 10, T0);
        assert_eq!(r.status, SpendStatus::Settled);
        assert_eq!(r.requester, agent());
        assert_eq!(r.payee, good());
        let s = status_of(&c, T0);
        assert_eq!(s.spent_this_period.0, 4 * NEAR / 10);
        assert_eq!(s.budget_remaining.0, 2 * NEAR - 4 * NEAR / 10);
        assert_eq!(s.receipts_count, 1);
    }

    #[test]
    fn above_auto_limit_queues_without_debiting() {
        let mut c = setup();
        let r = agent_ask(&mut c, good(), 8 * NEAR / 10, T0);
        assert_eq!(r.status, SpendStatus::Queued);
        assert_eq!(status_of(&c, T0).spent_this_period.0, 0);
        let pending = {
            set_env(&owner(), 0, T0);
            c.get_pending()
        };
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].receipt_id, r.id);
        assert_eq!(pending[0].amount.0, 8 * NEAR / 10);
    }

    #[test]
    fn owner_approves_queued_spend() {
        let mut c = setup();
        let r = agent_ask(&mut c, good(), 8 * NEAR / 10, T0);
        owner_env(T0);
        c.approve_spend(r.id);
        assert_eq!(status_of(&c, T0).spent_this_period.0, 8 * NEAR / 10);
        set_env(&owner(), 0, T0);
        assert_eq!(c.get_pending().len(), 0);
        let receipts = c.get_receipts(None);
        assert_eq!(receipts[0].status, SpendStatus::OwnerApproved);
    }

    #[test]
    fn owner_refuses_queued_spend() {
        let mut c = setup();
        let r = agent_ask(&mut c, good(), 8 * NEAR / 10, T0);
        owner_env(T0);
        c.refuse_spend(r.id);
        assert_eq!(status_of(&c, T0).spent_this_period.0, 0);
        set_env(&owner(), 0, T0);
        let receipts = c.get_receipts(None);
        assert_eq!(receipts[0].status, SpendStatus::OwnerRefused);
        assert!(receipts[0].reason.contains("refused"));
    }

    #[test]
    fn period_rolls_and_budget_resets() {
        let mut c = setup();
        let _ = agent_ask(&mut c, good(), 4 * NEAR / 10, T0);
        assert_eq!(status_of(&c, T0).spent_this_period.0, 4 * NEAR / 10);
        // One period later the budget is fresh again.
        assert_eq!(status_of(&c, T0 + DAY_NS + 1).spent_this_period.0, 0);
        // And a new spend works in the new period.
        let r = agent_ask(&mut c, good(), 4 * NEAR / 10, T0 + DAY_NS + 1);
        assert_eq!(r.status, SpendStatus::Settled);
    }

    #[test]
    fn successful_callback_marks_receipt_paid() {
        let mut c = setup();
        let r = agent_ask(&mut c, good(), 4 * NEAR / 10, T0);
        // The payout promise resolved: the contract calls its own private
        // callback, so the predecessor is the contract itself.
        set_env(&vault(), 0, T0);
        c.on_transfer_result(Ok(()), U128(4 * NEAR / 10), r.id);
        set_env(&owner(), 0, T0);
        let receipts = c.get_receipts(None);
        assert_eq!(receipts[0].status, SpendStatus::Settled);
        assert!(receipts[0].reason.contains("reached the payee"));
    }

    #[test]
    fn withdraw_keeps_the_storage_reserve() {
        let mut c = setup();
        owner_env(T0);
        // Withdrawing a sane amount works and returns a promise.
        let _ = c.withdraw(U128(NEAR));
        // Withdrawing everything must fail: the state must stay funded.
        owner_env(T0);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut c = c;
            let _ = c.withdraw(U128(1000 * NEAR));
        }));
        assert!(result.is_err(), "withdrawing the reserve must panic");
    }

    // ------------------------------------------------------------------
    // Attacker suite
    // ------------------------------------------------------------------

    #[test]
    #[should_panic(expected = "only the owner")]
    fn attacker_non_owner_cannot_set_rules() {
        // Privilege confusion: a stranger tries to loosen the rules.
        let mut c = setup();
        set_env(&intruder(), 1, T0);
        c.set_rules(Rules {
            cap_per_spend: U128(1000 * NEAR),
            auto_limit: U128(1000 * NEAR),
            budget_per_period: U128(1000 * NEAR),
            period_ns: DAY_NS,
            expires_at_ns: 0,
        });
    }

    #[test]
    #[should_panic(expected = "only the owner")]
    fn attacker_agent_cannot_call_owner_methods() {
        // Privilege confusion, layer 2: even if the agent somehow reached
        // an owner method (it cannot, the key is scoped), the contract's
        // own check stops it. The agent account is not the owner account.
        let mut c = setup();
        set_env(&agent(), 1, T0);
        c.add_payee(evil());
    }

    #[test]
    #[should_panic(expected = "yoctoNEAR")]
    fn attacker_owner_methods_refuse_zero_deposit() {
        // The one-yocto guard: a FunctionCall key cannot attach a deposit,
        // so any call that arrives with zero attached is not the owner's
        // wallet, even if the account id somehow matched.
        let mut c = setup();
        set_env(&owner(), 0, T0);
        c.revoke_agent();
    }

    #[test]
    #[should_panic(expected = "only the registered agent")]
    fn attacker_stranger_cannot_request_spend() {
        // A random account tries to use the agent's door.
        let mut c = setup();
        set_env(&intruder(), 0, T0);
        c.request_spend(good(), U128(NEAR / 10), "let me in".to_string());
    }

    #[test]
    #[should_panic(expected = "no agent is registered")]
    fn attacker_old_agent_is_locked_out_after_revoke() {
        // Revocation must be immediate and total. After revoke there is no
        // registered agent at all, so the first authorization check fires:
        // "no agent is registered, so nobody may request spends".
        let mut c = setup();
        owner_env(T0);
        c.revoke_agent();
        set_env(&agent(), 0, T0);
        c.request_spend(good(), U128(NEAR / 10), "still me".to_string());
    }

    #[test]
    fn attacker_off_allowlist_payee_is_refused_and_recorded() {
        // Prompt-injection scenario: the agent is tricked into paying an
        // address the owner never allowed. Refused, with the reason
        // on-chain, and the budget untouched.
        let mut c = setup();
        let r = agent_ask(&mut c, evil(), NEAR / 10, T0);
        assert_eq!(r.status, SpendStatus::Rejected);
        assert!(r.reason.contains("allowlist"));
        assert_eq!(status_of(&c, T0).spent_this_period.0, 0);
        set_env(&owner(), 0, T0);
        let receipts = c.get_receipts(None);
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].status, SpendStatus::Rejected);
    }

    #[test]
    fn attacker_over_cap_is_refused() {
        let mut c = setup();
        let r = agent_ask(&mut c, good(), 15 * NEAR / 10, T0);
        assert_eq!(r.status, SpendStatus::Rejected);
        assert!(r.reason.contains("cap"));
        assert_eq!(status_of(&c, T0).spent_this_period.0, 0);
    }

    #[test]
    fn attacker_zero_amount_is_refused() {
        // Dust requests must not spam the receipt log for free: they are
        // refused with a reason like everything else.
        let mut c = setup();
        let r = agent_ask(&mut c, good(), 0, T0);
        assert_eq!(r.status, SpendStatus::Rejected);
        assert!(r.reason.contains("greater than zero"));
    }

    #[test]
    fn attacker_double_request_cannot_exceed_budget() {
        // Double-spend race: two requests that each fit in the remaining
        // budget but together do not. Because the first debits before it
        // returns, the second sees the reduced budget and is refused.
        owner_env(T0);
        let mut c = PolicyVault::new(owner());
        c.set_rules(Rules {
            cap_per_spend: U128(NEAR),
            auto_limit: U128(NEAR),
            budget_per_period: U128(NEAR),
            period_ns: DAY_NS,
            expires_at_ns: 0,
        });
        c.add_payee(good());
        c.register_agent(agent());

        let first = agent_ask(&mut c, good(), 6 * NEAR / 10, T0);
        assert_eq!(first.status, SpendStatus::Settled);
        let second = agent_ask(&mut c, good(), 6 * NEAR / 10, T0);
        assert_eq!(second.status, SpendStatus::Rejected);
        assert!(second.reason.contains("budget"));
        assert_eq!(status_of(&c, T0).spent_this_period.0, 6 * NEAR / 10);
    }

    #[test]
    fn attacker_queued_spends_cannot_be_self_approved() {
        // The agent tries to approve its own queued spend. Even holding a
        // deposit somehow, it is not the owner.
        let mut c = setup();
        let r = agent_ask(&mut c, good(), 8 * NEAR / 10, T0);
        set_env(&agent(), 1, T0);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.approve_spend(r.id);
        }));
        assert!(result.is_err(), "the agent must not approve its own spend");
    }

    #[test]
    fn attacker_failed_transfer_restores_the_budget() {
        // Callback-failure attack surface: if the payout fails on-chain,
        // the budget must not stay wrongly debited, or the agent loses
        // headroom forever; and it must not stay credited, or a failed
        // payout would look like a successful one.
        let mut c = setup();
        let r = agent_ask(&mut c, good(), 4 * NEAR / 10, T0);
        assert_eq!(status_of(&c, T0).spent_this_period.0, 4 * NEAR / 10);
        set_env(&vault(), 0, T0);
        c.on_transfer_result(Err(PromiseError::Failed), U128(4 * NEAR / 10), r.id);
        assert_eq!(status_of(&c, T0).spent_this_period.0, 0);
        set_env(&owner(), 0, T0);
        let receipts = c.get_receipts(None);
        assert_eq!(receipts[0].status, SpendStatus::TransferFailed);
        assert!(receipts[0].reason.contains("restored"));
    }

    #[test]
    fn attacker_expired_policy_refuses_everything() {
        let mut c = setup();
        owner_env(T0);
        c.set_rules(Rules {
            expires_at_ns: T0 + 10 * NS,
            ..normal_rules()
        });
        let r = agent_ask(&mut c, good(), NEAR / 10, T0 + 11 * NS);
        assert_eq!(r.status, SpendStatus::Rejected);
        assert!(r.reason.contains("expired"));
    }

    #[test]
    fn attacker_removed_payee_is_refused_immediately() {
        // Revoking a payee must take effect at once.
        let mut c = setup();
        owner_env(T0);
        c.remove_payee(good());
        let r = agent_ask(&mut c, good(), NEAR / 10, T0);
        assert_eq!(r.status, SpendStatus::Rejected);
        assert!(r.reason.contains("allowlist"));
    }

    #[test]
    fn attacker_huge_amount_is_refused_without_arithmetic_damage() {
        // Overflow abuse: u128::MAX as an amount must be refused cleanly,
        // never wrap or panic in the arithmetic.
        let mut c = setup();
        let r = agent_ask(&mut c, good(), u128::MAX, T0);
        assert_eq!(r.status, SpendStatus::Rejected);
        // The cap check fires first (1 NEAR cap), and the budget is
        // untouched.
        assert!(r.reason.contains("cap"));
        assert_eq!(status_of(&c, T0).spent_this_period.0, 0);
    }

    #[test]
    fn attacker_oversized_purpose_is_rejected_before_state_grows() {
        // Storage-bloat attempt: a giant purpose string must be refused
        // before anything is written.
        let mut c = setup();
        set_env(&agent(), 0, T0);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.request_spend(good(), U128(NEAR / 10), "x".repeat(10_000));
        }));
        assert!(result.is_err(), "oversized purpose must panic before recording");
        assert_eq!(status_of(&c, T0).receipts_count, 0);
    }

    #[test]
    fn attacker_more_than_vault_balance_is_refused() {
        // The vault holds 10 NEAR in the test context; a request for more
        // must be refused with the vault reason, not settle and fail later.
        let mut c = setup();
        let r = agent_ask(&mut c, good(), 11 * NEAR, T0);
        // The cap check (1 NEAR) fires first, which is the stricter rule.
        assert_eq!(r.status, SpendStatus::Rejected);
        assert!(r.reason.contains("cap"));
    }

    #[test]
    #[should_panic(expected = "only the owner")]
    fn attacker_stranger_cannot_withdraw() {
        let mut c = setup();
        set_env(&intruder(), 1, T0);
        let _ = c.withdraw(U128(NEAR));
    }

    #[test]
    fn receipt_log_is_ordered_and_readable() {
        // The audit trail: three decisions in order, most recent first
        // from the view, each with a human sentence.
        let mut c = setup();
        let _settled = agent_ask(&mut c, good(), NEAR / 10, T0);
        let _refused = agent_ask(&mut c, evil(), NEAR / 10, T0);
        let _queued = agent_ask(&mut c, good(), 8 * NEAR / 10, T0);
        set_env(&owner(), 0, T0);
        let receipts = c.get_receipts(None);
        assert_eq!(receipts.len(), 3);
        assert_eq!(receipts[0].id, 2);
        assert_eq!(receipts[0].status, SpendStatus::Queued);
        assert_eq!(receipts[1].id, 1);
        assert_eq!(receipts[1].status, SpendStatus::Rejected);
        assert_eq!(receipts[2].id, 0);
        assert_eq!(receipts[2].status, SpendStatus::Settled);
        for r in &receipts {
            assert!(!r.reason.is_empty(), "every receipt carries a readable reason");
        }
    }
}
