//! Job board contract: the counterparty the policy agent hires.
//!
//! This is the "seller" side of the demo. It publishes a deterministic
//! price for a task (`quote`), and the vendor fulfils the task by having
//! this contract compute the work itself: the SHA-256 digest of the task
//! text, via the protocol's own hash host function (`fulfil`). The result
//! lives on-chain, so any buyer can independently verify the work by
//! recomputing the digest, before or after paying.
//!
//! Payment never flows through this contract. The buyer pays the plain way,
//! through the policy vault's `request_spend`, and the vault's receipt is
//! the proof of payment. This keeps the vault's payout path untouched: the
//! job board is a record of quotes and delivered work, not an escrow.
//!
//! Design notes that matter:
//! - Only the vendor account (set at init, normally the contract's own
//!   account operated by the vendor's script) may fulfil. Anyone may read
//!   quotes, jobs, and results: the record is public by design.
//! - The pricing formula is constants in this file, so a quote is
//!   reproducible by anyone from the task text alone.
//! - Task text is bounded (same 280-byte ceiling as the vault's purpose
//!   field) so one job cannot bloat state.
//! - Fulfil is idempotent per task: the same task always maps to the same
//!   job id and the same digest, so re-running it cannot forge a second
//!   job or a different answer.

use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

/// 1 NEAR in yoctoNEAR, spelled out so the fee constants below are read
/// as fractions of a NEAR.
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

/// Published pricing: a base fee plus a per-byte component of the task.
/// 0.01 NEAR + 0.0002 NEAR per byte, so a 200-byte task quotes 0.05.
const BASE_FEE_YOCTO: u128 = NEAR / 100;
const PER_BYTE_FEE_YOCTO: u128 = NEAR / 5_000;

/// Hard cap on task bytes, mirroring the vault's purpose cap so the
/// task text can always travel inside a receipt purpose.
const MAX_TASK_BYTES: usize = 280;

/// How many job ids fit in the hex prefix used as the job id.
const JOB_ID_HEX_CHARS: usize = 8;

// Unique byte prefixes for each on-chain collection, so their storage
// keys can never collide.
const PREFIX_JOBS: &[u8] = b"j";
const PREFIX_JOB_IDS: &[u8] = b"i";

/// One delivered job: what was asked, what it cost, what was delivered.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Job {
    /// First 8 hex characters of the task's SHA-256 digest.
    pub id: String,
    pub task: String,
    /// The quoted price at fulfil time, in yoctoNEAR.
    pub price_yocto: U128,
    /// The full SHA-256 hex digest of the task: the verifiable work.
    pub result: String,
    pub fulfilled_at_ns: u64,
}

/// What `quote` returns: the id the job will have, and its price.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct QuoteView {
    pub task_id: String,
    pub price_yocto: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct JobBoard {
    /// The only account allowed to fulfil jobs: the vendor's operator.
    vendor: AccountId,
    jobs: LookupMap<String, Job>,
    /// Insertion order of job ids, so `get_jobs` can list newest first.
    job_ids: Vector<String>,
}

#[near]
impl JobBoard {
    #[init]
    pub fn new(vendor: AccountId) -> Self {
        Self {
            vendor,
            jobs: LookupMap::new(PREFIX_JOBS),
            job_ids: Vector::new(PREFIX_JOB_IDS),
        }
    }

    // ------------------------------------------------------------------
    // Public reads: free view calls, no transaction needed
    // ------------------------------------------------------------------

    /// The published price for a task, and the id its job will have.
    /// Deterministic: anyone can recompute it from the constants above.
    pub fn quote(&self, task: String) -> QuoteView {
        assert_task_shape(&task);
        QuoteView {
            task_id: job_id(&task),
            price_yocto: U128(price_of(&task)),
        }
    }

    pub fn get_job(&self, id: String) -> Option<Job> {
        self.jobs.get(&id).cloned()
    }

    /// Newest first, like the vault's receipt list.
    pub fn get_jobs(&self, limit: Option<u32>) -> Vec<Job> {
        let len = self.job_ids.len();
        let cap = limit.unwrap_or(50).min(200).min(len);
        (0..cap)
            .filter_map(|i| {
                self.job_ids
                    .get(len - 1 - i)
                    .and_then(|id| self.jobs.get(id).cloned())
            })
            .collect()
    }

    pub fn get_vendor(&self) -> AccountId {
        self.vendor.clone()
    }

    // ------------------------------------------------------------------
    // The vendor's one write
    // ------------------------------------------------------------------

    /// Do the work and record it. The contract itself computes the digest,
    /// so the stored result is by construction the SHA-256 of the stored
    /// task: a buyer who recomputes the hash locally can always check it.
    /// Idempotent per task: re-fulfilling refreshes the timestamp but can
    /// never create a second job id or a different answer.
    pub fn fulfil(&mut self, task: String) -> Job {
        require!(
            env::predecessor_account_id() == self.vendor,
            "only the vendor can fulfil a job"
        );
        assert_task_shape(&task);
        let id = job_id(&task);
        let result = digest_hex(&task);
        let price = price_of(&task);
        let job = Job {
            id: id.clone(),
            task,
            price_yocto: U128(price),
            result,
            fulfilled_at_ns: env::block_timestamp(),
        };
        if !self.jobs.contains_key(&id) {
            self.job_ids.push(id.clone());
        }
        self.jobs.insert(id, job.clone());
        env::log_str(&format!(
            "job {} fulfilled for {} yoctoNEAR",
            job.id, job.price_yocto.0
        ));
        job
    }
}

// ======================================================================
// Helpers
// ======================================================================

/// The quoted price for a task: base fee plus the per-byte component.
fn price_of(task: &str) -> u128 {
    let bytes = task.len() as u128;
    BASE_FEE_YOCTO
        .checked_add(
            bytes
                .checked_mul(PER_BYTE_FEE_YOCTO)
                .expect("task price overflowed"),
        )
        .expect("task price overflowed")
}

fn assert_task_shape(task: &str) {
    require!(
        !task.is_empty() && task.len() <= MAX_TASK_BYTES,
        "task must be between 1 and 280 bytes"
    );
}

const HEX: &[u8; 16] = b"0123456789abcdef";

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

/// The full SHA-256 hex digest of a task, computed with the protocol's
/// hash host function.
fn digest_hex(task: &str) -> String {
    hex_encode(&env::sha256(task.as_bytes()))
}

/// The job id: the first 8 hex characters of the task's digest.
fn job_id(task: &str) -> String {
    digest_hex(task)[..JOB_ID_HEX_CHARS].to_string()
}

// ======================================================================
// Tests
// ======================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const T0: u64 = 1_700_000_000_000_000_000;

    fn acct(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn worker() -> AccountId {
        acct("worker.test.near")
    }
    fn vendor() -> AccountId {
        acct("vendor.test.near")
    }
    fn buyer() -> AccountId {
        acct("buyer.test.near")
    }

    fn set_env(predecessor: &AccountId, now: u64) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(worker())
            .predecessor_account_id(predecessor.clone())
            .signer_account_id(predecessor.clone())
            .attached_deposit(near_sdk::NearToken::from_yoctonear(0))
            .block_timestamp(now);
        testing_env!(b.build());
    }

    fn setup() -> JobBoard {
        set_env(&vendor(), T0);
        JobBoard::new(vendor())
    }

    #[test]
    fn quote_follows_the_published_formula() {
        let c = setup();
        set_env(&buyer(), T0);
        // "abc" is 3 bytes: 0.01 + 3 * 0.0002 = 0.0106 NEAR.
        let q = c.quote("abc".to_string());
        assert_eq!(q.price_yocto.0, 10_600_000_000_000_000_000_000u128);
        // The id is the first 8 hex chars of sha256("abc"), the standard
        // FIPS test vector, which also pins the host hash to real SHA-256.
        assert_eq!(q.task_id, "ba7816bf");
    }

    #[test]
    fn fulfil_stores_a_verifiable_digest() {
        let mut c = setup();
        let job = c.fulfil("abc".to_string());
        assert_eq!(job.id, "ba7816bf");
        assert_eq!(
            job.result,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(job.price_yocto.0, 10_600_000_000_000_000_000_000u128);
        assert_eq!(job.fulfilled_at_ns, T0);
        set_env(&buyer(), T0);
        assert_eq!(c.get_job("ba7816bf".to_string()), Some(job));
    }

    #[test]
    #[should_panic(expected = "only the vendor")]
    fn stranger_cannot_fulfil() {
        let mut c = setup();
        set_env(&buyer(), T0);
        c.fulfil("abc".to_string());
    }

    #[test]
    fn refulfilling_a_task_is_idempotent() {
        let mut c = setup();
        c.fulfil("abc".to_string());
        set_env(&vendor(), T0 + 1);
        let again = c.fulfil("abc".to_string());
        assert_eq!(again.id, "ba7816bf");
        assert_eq!(again.fulfilled_at_ns, T0 + 1);
        set_env(&buyer(), T0);
        // One job, not two: the index only grew once.
        assert_eq!(c.get_jobs(None).len(), 1);
    }

    #[test]
    #[should_panic(expected = "task must be")]
    fn empty_task_is_refused() {
        let c = setup();
        set_env(&buyer(), T0);
        c.quote(String::new());
    }

    #[test]
    #[should_panic(expected = "task must be")]
    fn oversized_task_is_refused() {
        let mut c = setup();
        c.fulfil("x".repeat(281));
    }

    #[test]
    fn get_jobs_returns_newest_first() {
        let mut c = setup();
        c.fulfil("first task".to_string());
        set_env(&vendor(), T0 + 1);
        c.fulfil("second task".to_string());
        set_env(&buyer(), T0);
        let jobs = c.get_jobs(None);
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[0].task, "second task");
        assert_eq!(jobs[1].task, "first task");
        // The limit is respected.
        assert_eq!(c.get_jobs(Some(1)).len(), 1);
    }
}
