import type { CSSProperties } from "react";
import { near, periodWord, relativeNs, timeOf, usd } from "../lib/money";
import type { AppConfig, Errand, RunOutcome, User, VaultResponse } from "../lib/types";
import type { Screen } from "../components/TopBar";
import {
  BusyLine,
  Callout,
  ErrorNote,
  ReceiptChip,
  TxLink,
} from "../components/ui";

type Props = {
  config: AppConfig;
  user: User;
  vault: VaultResponse["vault"];
  activity: VaultResponse["activity"];
  outcome: RunOutcome | null;
  runningErrand: string | null;
  deciding: number | null;
  stepLine: string | null;
  error: string | null;
  onRun: (errand: Errand) => void;
  onDecide: (receiptId: number, approve: boolean) => void;
  onNav: (screen: Screen) => void;
};

export default function Home({
  config,
  user,
  vault,
  activity,
  outcome,
  runningErrand,
  deciding,
  stepLine,
  error,
  onRun,
  onDecide,
  onNav,
}: Props) {
  const rate = config.nearUsdRate;
  const { status, rules } = vault;
  const cap = BigInt(rules.cap_per_spend);
  const auto = BigInt(rules.auto_limit);
  const budget = BigInt(rules.budget_per_period);
  const spent = BigInt(status.spent_this_period);
  const remaining = BigInt(status.budget_remaining);
  const spendable = BigInt(vault.spendableYocto);
  const reserve = BigInt(vault.storageReserveYocto);
  const payees = rules.payees || [];
  const rulesClosed = cap === 0n;
  const agentMissing = status.agent !== user.agentId;
  const pending = vault.pending;

  const vendorName = (id: string) =>
    config.vendors.find((vendor) => vendor.id === id)?.name || id;

  const spentShare = budget > 0n ? Number((spent * 1000n) / budget) / 10 : 0;
  const fillClass = spentShare >= 80 ? "m-tomato" : spentShare >= 50 ? "m-butter" : "m-leaf";

  const purposeOf = (receiptId: number) =>
    vault.receipts.find((receipt) => receipt.id === receiptId)?.purpose || "";

  function jobVerdict(errand: Errand): { label: string; tone: string; note: string } {
    const amount = BigInt(errand.amountYocto);
    if (!payees.includes(errand.payee))
      return {
        label: "will be refused: seller",
        tone: "c-tomato",
        note: "This seller is not on your approved list, so the rules refuse it.",
      };
    if (rulesClosed)
      return {
        label: "will be refused: no rules",
        tone: "c-tomato",
        note: "Your spending limits are at zero, so every purchase is refused.",
      };
    if (amount > cap)
      return {
        label: "will be refused: over cap",
        tone: "c-tomato",
        note: "Above your per-purchase cap, so the rules refuse it.",
      };
    if (amount > remaining)
      return {
        label: "will be refused: budget",
        tone: "c-tomato",
        note: "It would exceed your budget for this period, so the rules refuse it.",
      };
    if (amount > spendable)
      return {
        label: "will be refused: balance",
        tone: "c-tomato",
        note: "More than the vault holds, so it cannot pay.",
      };
    if (amount > auto)
      return {
        label: "will ask you",
        tone: "c-butter",
        note: "Bigger than your auto-approve limit, so it comes to you.",
      };
    return {
      label: "will pay itself",
      tone: "c-leaf",
      note: "Inside your auto-approve limit, so it pays itself.",
    };
  }

  const jobs = config.errands.filter((errand) => errand.id !== "unlisted");

  return (
    <main className="page">
      {(rulesClosed || agentMissing) && (
        <Callout tone="red" title="Your guardrails are not fully on">
          {rulesClosed && <p>The spending limits are at zero, so every purchase is refused.</p>}
          {agentMissing && <p>No agent is registered, so no purchase can be requested.</p>}
          <p>
            <button className="b-ghost" onClick={() => onNav("rules")}>
              Set your rules
            </button>
          </p>
        </Callout>
      )}

      {!rulesClosed && !agentMissing && payees.length === 0 && (
        <Callout tone="amber" title="Your agent cannot pay anyone yet">
          <p>
            Add a person or shop on Rules. Until then, every job below is refused before money
            moves.
          </p>
          <p>
            <button className="b-butter" onClick={() => onNav("rules")}>
              Add who my agent can pay
            </button>
          </p>
        </Callout>
      )}

      <div className="row">
        <section className="card hero-card pop" style={{ "--d": ".02s" } as CSSProperties}>
          <span className="kicker">
            available to spend <span className="sticker">test money</span>
          </span>
          <div>
            <span className="big">{usd(vault.spendableYocto, rate)}</span>
          </div>
          <div className="sub">
            exactly <span className="mono">{near(vault.spendableYocto, 24)}</span> NEAR on the
            test network
          </div>
          <div className="chips">
            <span className="chip c-butter">cap per purchase {usd(rules.cap_per_spend, rate)}</span>
            <span className="chip c-leaf">auto-approve up to {usd(rules.auto_limit, rate)}</span>
            <span className={`chip ${payees.length ? "c-pool" : "c-tomato"}`}>
              can pay: {payees.length === 0 ? "nobody yet" : payees.map(vendorName).join(", ")}
            </span>
          </div>
          <p className="note">
            Your vault holds {usd(spendable + reserve, rate)} in total. Another{" "}
            {usd(reserve, rate)} of it is locked by the network as storage for your receipts —
            still yours, just not spendable. This card is real money; the budget card is only a
            limit you set.
          </p>
        </section>

        <section className="card hero-card pop" style={{ "--d": ".08s" } as CSSProperties}>
          <span className="kicker">budget left {periodWord(rules.period_ns)}</span>
          <div>
            <span className="big small">{usd(status.budget_remaining, rate)}</span>
          </div>
          <div className="meter">
            <div
              className={`fill ${fillClass}`}
              style={{ width: `${Math.min(100, spentShare)}%` }}
            />
          </div>
          <div className="sub">
            Spent {usd(status.spent_this_period, rate)} of {usd(rules.budget_per_period, rate)}.
            {status.next_period_reset_ns > 0 && rules.period_ns > 1 && (
              <> Resets {timeOf(status.next_period_reset_ns)}.</>
            )}
          </div>
          {spentShare >= 80 && (
            <div className="lowline">Running low. Raise it in Rules, or wait for the reset.</div>
          )}
          <p className="note">
            The budget is a limit, not a balance. Raising it never adds money — it only lets
            your agent spend more of the vault money on the left.
          </p>
          <div className="acts">
            <button className="b-butter" onClick={() => onNav("rules")}>
              Change my rules
            </button>
          </div>
        </section>
      </div>

      {pending.length > 0 && (
        <section className="card pending pop slide-in" style={{ "--d": ".14s" } as CSSProperties}>
          <div className="pbody">
            <div className="phead">
              <span className="dot" />
              <span className="ptitle">
                {pending.length} purchase{pending.length === 1 ? "" : "s"} waiting for you
              </span>
            </div>
            {pending.map((item) => {
              const purpose = purposeOf(item.receipt_id);
              return (
                <div className="pitem" key={item.receipt_id}>
                  <div>
                    <div className="jobline">
                      {vendorName(item.payee)} wants <span className="amt">{usd(item.amount, rate)}</span>{" "}
                      <span className="mono">({near(item.amount, 24)} NEAR)</span>
                    </div>
                    <p className="note">
                      {purpose || "A purchase above your auto-approve limit."} Money only moves if
                      you press Approve and sign in. Refusing just records your answer.
                    </p>
                  </div>
                  <div className="acts">
                    <button
                      className="b-leaf"
                      onClick={() => onDecide(item.receipt_id, true)}
                      disabled={deciding !== null || runningErrand !== null}
                    >
                      {deciding === item.receipt_id ? "Approving" : "Approve"}
                    </button>
                    <button
                      className="b-tomato"
                      onClick={() => onDecide(item.receipt_id, false)}
                      disabled={deciding !== null || runningErrand !== null}
                    >
                      Refuse
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <div className="jobs">
        {jobs.map((errand, index) => {
          const verdict = jobVerdict(errand);
          return (
            <section
              className="card job pop"
              key={errand.id}
              style={{ "--d": `${0.2 + index * 0.06}s` } as CSSProperties}
            >
              <span className="kicker">job</span>
              <div className="jobline">{errand.title}</div>
              <div className="price">
                {usd(errand.amountYocto, rate)}
                <span className="mono">{near(errand.amountYocto, 24)} NEAR</span>
              </div>
              <p className="note">{verdict.note}</p>
              <div className="chips">
                <span className={`chip ${verdict.tone}`}>{verdict.label}</span>
              </div>
              <button
                className="b-ghost"
                style={{ marginTop: 14, alignSelf: "flex-start" }}
                onClick={() => onRun(errand)}
                disabled={runningErrand !== null || deciding !== null}
              >
                {runningErrand === errand.id ? "Running" : "Run this job"}
              </button>
            </section>
          );
        })}
      </div>

      <BusyLine text={stepLine} />
      <ErrorNote message={error} />

      {outcome && (
        <section className={`card outcome outcome-${outcome.tone} pop`}>
          <div className="section-head" style={{ marginBottom: 4 }}>
            <h2>{outcome.headline}</h2>
            {outcome.status && <ReceiptChip status={outcome.status} reason={outcome.detail} />}
          </div>
          <p className="sub">{outcome.title}</p>
          <p className="note">{outcome.detail}</p>
          {outcome.predicted && (
            <p className="fine">
              Before sending, the agent checked the rules: {outcome.predicted}
            </p>
          )}
          {outcome.txHash && (
            <p className="fine">
              <TxLink hash={outcome.txHash} label="Open the transaction" />
            </p>
          )}
          {outcome.logs && outcome.logs.length > 0 && (
            <details style={{ marginTop: 12 }}>
              <summary>network log lines</summary>
              <pre className="outcome-logs">{outcome.logs.join("\n")}</pre>
            </details>
          )}
        </section>
      )}

      <section className="card pop" style={{ "--d": ".38s" } as CSSProperties}>
        <div className="section-head" style={{ marginBottom: 2 }}>
          <span className="kicker">last 3 receipts</span>
          <span className="spacer" />
          <span className="fine" style={{ margin: 0 }}>
            {activity.length > 0 ? `read from the network` : ""}
          </span>
        </div>
        {vault.receipts.length === 0 ? (
          <p className="note">No receipts yet. Run a job above and the first one appears here.</p>
        ) : (
          <div>
            {vault.receipts.slice(0, 3).map((receipt) => (
              <div className="rrow" key={receipt.id}>
                <span className="rid">#{receipt.id}</span>
                <span className="rseller">{vendorName(receipt.payee)}</span>
                <span className="rpurpose">{receipt.purpose}</span>
                <ReceiptChip status={receipt.status} reason={receipt.reason} />
                <span className="ramt">{usd(receipt.amount, rate)}</span>
                <span className="rtime">{relativeNs(receipt.timestamp_ns)}</span>
              </div>
            ))}
          </div>
        )}
        <button className="see" onClick={() => onNav("receipts")}>
          see all receipts
        </button>
      </section>

      <details className="pop" style={{ "--d": ".44s" } as CSSProperties}>
        <summary>under the hood</summary>
        <p>
          The agent holds a scoped key that can only request spends. Your rules live on chain in
          vault {vault.vaultId}, and they refuse anything over your caps or to anyone you have not
          approved. Every receipt is a record on the test network you can open.
        </p>
        <p className="fine">
          The agent key cannot change rules, move money, or touch another account. The contract
          code hash is <span className="mono">{vault.codeHash}</span>.
        </p>
      </details>
    </main>
  );
}
