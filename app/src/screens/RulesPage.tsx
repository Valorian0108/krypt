import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { GAS_OWNER, GAS_WRITE, signOwnerTransaction, type OwnerCall } from "../lib/chain";
import {
  centsToYocto,
  daysToPeriodNs,
  near,
  periodNsToDays,
  usd,
  yoctoToCents,
  yoctoToUsdInput,
} from "../lib/money";
import type { AppConfig, BroadcastResult, User, Vault } from "../lib/types";
import { BusyLine, ErrorNote, TxLink } from "../components/ui";

type Props = {
  config: AppConfig;
  user: User;
  vault: Vault;
  onSaved: (result: BroadcastResult) => void;
  onNavHome: () => void;
};

const EXAMPLE_AMOUNTS = [10n, 100n, 250n];

export default function RulesPage({ config, user, vault, onSaved, onNavHome }: Props) {
  const rate = config.nearUsdRate;
  const rules = vault.rules;

  const [cap, setCap] = useState(() => Number(yoctoToUsdInput(rules.cap_per_spend, rate)));
  const [auto, setAuto] = useState(() => Number(yoctoToUsdInput(rules.auto_limit, rate)));
  const [budget, setBudget] = useState(() => Number(yoctoToUsdInput(rules.budget_per_period, rate)));
  const [periodDays, setPeriodDays] = useState(() => periodNsToDays(rules.period_ns));
  const [payees, setPayees] = useState<string[]>(() => rules.payees || []);
  const [newPayee, setNewPayee] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedHash, setSavedHash] = useState<string | null>(null);

  const originalPayees = useMemo(() => rules.payees || [], [rules.payees]);
  const added = payees.filter((payee) => !originalPayees.includes(payee));
  const removed = originalPayees.filter((payee) => !payees.includes(payee));

  const vendorName = (id: string) =>
    config.vendors.find((vendor) => vendor.id === id)?.name || id;
  const vendorNote = (id: string) =>
    config.vendors.find((vendor) => vendor.id === id)?.note || "added by you";

  const capCents = Math.round(cap * 100);
  const autoCents = Math.round(auto * 100);
  const budgetCents = Math.round(budget * 100);
  const spentCents = Number(yoctoToCents(vault.status.spent_this_period, rate));
  const spentShare =
    budgetCents > 0 ? Math.min(100, (spentCents / budgetCents) * 100) : 0;
  const fillClass = spentShare >= 80 ? "m-tomato" : spentShare >= 50 ? "m-butter" : "m-leaf";

  function validate(): string | null {
    if (!Number.isFinite(cap) || !Number.isFinite(auto) || !Number.isFinite(budget)) {
      return "Enter amounts in dollars and cents, like 2.00 or 0.40.";
    }
    if (cap < 0 || auto < 0 || budget < 0) return "Amounts cannot be negative.";
    if (auto > cap) return "Auto-approve cannot be higher than the per purchase cap.";
    if (budget < cap) return "The budget should be at least as large as the per purchase cap.";
    if (added.length + removed.length + 1 > 6) {
      return "That is too many changes for one approval. Save some now and the rest after.";
    }
    return null;
  }

  async function onSave() {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setBusy(true);
    const calls: OwnerCall[] = [
      {
        method: "set_rules",
        gas: GAS_WRITE,
        args: {
          rules: {
            cap_per_spend: centsToYocto(BigInt(capCents), rate).toString(),
            auto_limit: centsToYocto(BigInt(autoCents), rate).toString(),
            budget_per_period: centsToYocto(BigInt(budgetCents), rate).toString(),
            period_ns: daysToPeriodNs(periodDays),
            expires_at_ns: 0,
          },
        },
      },
    ];
    for (const payee of added) calls.push({ method: "add_payee", gas: GAS_OWNER, args: { payee } });
    for (const payee of removed) {
      calls.push({ method: "remove_payee", gas: GAS_OWNER, args: { payee } });
    }

    try {
      const result = await signOwnerTransaction({
        vaultId: user.vaultId,
        publicKey: user.publicKey,
        calls,
        onStep: setStep,
      });
      setSavedHash(result.hash);
      onSaved(result);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
      setBusy(false);
      setStep(null);
    }
  }

  function addPayee() {
    const payee = newPayee.trim().toLowerCase();
    setNewPayee("");
    if (!payee) return;
    if (!/^[a-z0-9._-]{2,64}$/.test(payee) || !payee.includes(".")) {
      setError("That does not look like an account name. It should look like shop.testnet.");
      return;
    }
    if (payees.includes(payee)) {
      setError("That account is already on your list.");
      return;
    }
    setError(null);
    setPayees([...payees, payee]);
  }

  function bump(field: "cap" | "auto" | "budget", delta: number) {
    if (field === "cap") setCap((value) => Math.max(0, Math.round((value + delta) * 10) / 10));
    if (field === "auto") setAuto((value) => Math.max(0, Math.round((value + delta) * 10) / 10));
    if (field === "budget") setBudget((value) => Math.max(0, Math.round((value + delta) * 10) / 10));
  }

  function verdict(amountCents: bigint): { label: string; tone: string } {
    const capBig = BigInt(capCents);
    const autoBig = BigInt(autoCents);
    if (amountCents > capBig) return { label: "refused", tone: "c-tomato" };
    if (amountCents > autoBig) return { label: "waits for you", tone: "c-butter" };
    return { label: "pays itself", tone: "c-leaf" };
  }

  return (
    <main className="page">
      <div className="pagehead pop">
        <div>
          <span className="kicker">your limits</span>
          <h1>Rules</h1>
          <p className="lede-sm">
            Plain limits, checked by the network. The agent cannot change them. Only you can.
          </p>
        </div>
        <button className="b-ghost" onClick={onNavHome}>
          Back to home
        </button>
      </div>

      <div className="rules-grid">
        <div className="stack">
          <section className="card rule-card pop" style={{ "--d": ".04s" } as CSSProperties}>
            <div className="rule-head">
              <span className="kicker">cap per purchase</span>
              <span className="ruleval">{usd(centsToYocto(BigInt(capCents), rate), rate)}</span>
            </div>
            <p className="note">Anything above this is refused, every time.</p>
            <div className="stepper">
              <button className="stepbtn" onClick={() => bump("cap", -0.5)} aria-label="Lower the per purchase cap">
                {"\u2212"}
              </button>
              <input
                type="range"
                min={0}
                max={20}
                step={0.5}
                value={cap}
                aria-label="Cap per purchase in dollars"
                onChange={(event) => setCap(Number(event.target.value))}
                style={rangeStyle(cap, 0, 20)}
                disabled={busy}
              />
              <button className="stepbtn" onClick={() => bump("cap", 0.5)} aria-label="Raise the per purchase cap">
                +
              </button>
            </div>
            <div className="exact">
              exactly <span className="mono">{near(centsToYocto(BigInt(capCents), rate), 4)}</span>{" "}
              NEAR at ${rate.toFixed(2)} per NEAR
            </div>
          </section>

          <section className="card rule-card pop" style={{ "--d": ".1s" } as CSSProperties}>
            <div className="rule-head">
              <span className="kicker">auto-approve under</span>
              <span className="ruleval">{usd(centsToYocto(BigInt(autoCents), rate), rate)}</span>
            </div>
            <p className="note">Under this, the agent pays on its own. Above it, purchases wait for your OK.</p>
            <div className="stepper">
              <button className="stepbtn" onClick={() => bump("auto", -0.1)} aria-label="Lower the auto-approve limit">
                {"\u2212"}
              </button>
              <input
                type="range"
                min={0}
                max={10}
                step={0.1}
                value={auto}
                aria-label="Auto approve limit in dollars"
                onChange={(event) => setAuto(Number(event.target.value))}
                style={rangeStyle(auto, 0, 10)}
                disabled={busy}
              />
              <button className="stepbtn" onClick={() => bump("auto", 0.1)} aria-label="Raise the auto-approve limit">
                +
              </button>
            </div>
            <div className="exact">
              exactly <span className="mono">{near(centsToYocto(BigInt(autoCents), rate), 4)}</span>{" "}
              NEAR at ${rate.toFixed(2)} per NEAR
            </div>
          </section>

          <section className="card rule-card pop" style={{ "--d": ".16s" } as CSSProperties}>
            <div className="rule-head">
              <span className="kicker">budget</span>
              <span className="ruleval">{usd(centsToYocto(BigInt(budgetCents), rate), rate)}</span>
            </div>
            <p className="note">The most the agent can spend in one period. It resets on its own.</p>
            <div className="stepper">
              <button className="stepbtn" onClick={() => bump("budget", -0.5)} aria-label="Lower the budget">
                {"\u2212"}
              </button>
              <input
                type="range"
                min={0}
                max={50}
                step={0.5}
                value={budget}
                aria-label="Budget in dollars"
                onChange={(event) => setBudget(Number(event.target.value))}
                style={rangeStyle(budget, 0, 50)}
                disabled={busy}
              />
              <button className="stepbtn" onClick={() => bump("budget", 0.5)} aria-label="Raise the budget">
                +
              </button>
            </div>
            <div className="exact">
              exactly <span className="mono">{near(centsToYocto(BigInt(budgetCents), rate), 4)}</span>{" "}
              NEAR at ${rate.toFixed(2)} per NEAR
            </div>
            <label className="field">
              <span className="field-label">Resets</span>
              <select
                value={periodDays}
                onChange={(event) => setPeriodDays(Number(event.target.value))}
                disabled={busy}
              >
                {config.periodChoices.map((choice) => (
                  <option key={choice.days} value={choice.days}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section className="card rule-card pop" style={{ "--d": ".22s" } as CSSProperties}>
            <div className="rule-head">
              <span className="kicker">who your agent can pay</span>
              <span className={`chip ${payees.length ? "c-pool" : "c-tomato"}`}>
                {payees.length} {payees.length === 1 ? "seller" : "sellers"}
              </span>
            </div>
            <p className="note">Only the people and shops on this list can be paid. Anyone else is refused.</p>
            <div className="seller-list">
              {payees.length === 0 ? (
                <p className="seller-empty">
                  No one yet. Every purchase will be refused until you add someone.
                </p>
              ) : (
                payees.map((payee) => (
                  <div className="seller" key={payee}>
                    <span className="sdot" />
                    <div>
                      <b>{vendorName(payee)}</b>
                      <span className="mono">{payee}</span>
                      <span className="swhat">{vendorNote(payee)}</span>
                    </div>
                    <button
                      className="b-link"
                      onClick={() => setPayees(payees.filter((entry) => entry !== payee))}
                      disabled={busy}
                    >
                      remove
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="addrow">
              <input
                value={newPayee}
                onChange={(event) => setNewPayee(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && addPayee()}
                placeholder="shop.testnet"
                aria-label="Account name to approve"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
              <button onClick={addPayee} disabled={busy || !newPayee.trim()}>
                Add
              </button>
            </div>
            <p className="fine">Adding someone takes effect after you save. You can also remove everyone to pause payments.</p>
          </section>
        </div>

        <aside className="stack sticky">
          <section className="card pop" style={{ "--d": ".08s" } as CSSProperties}>
            <span className="kicker">what this will do</span>
            <div className="pline">
              <span className="dotc d-leaf" />
              <span>
                Under <b>{usd(centsToYocto(BigInt(autoCents), rate), rate)}</b>: pays itself.
              </span>
            </div>
            <div className="pline">
              <span className="dotc d-butter" />
              <span>
                From <b>{usd(centsToYocto(BigInt(autoCents), rate), rate)}</b> to{" "}
                <b>{usd(centsToYocto(BigInt(capCents), rate), rate)}</b>: waits for your OK.
              </span>
            </div>
            <div className="pline">
              <span className="dotc d-tomato" />
              <span>
                Over <b>{usd(centsToYocto(BigInt(capCents), rate), rate)}</b>: refused.
              </span>
            </div>
            <div className="pline">
              <span className="dotc d-tomato" />
              <span>Anyone not on your list: refused.</span>
            </div>
            {autoCents > capCents && (
              <p className="warn">
                Auto-approve cannot be above your per purchase cap. Lower it before saving.
              </p>
            )}
          </section>

          <section className="card pop" style={{ "--d": ".14s" } as CSSProperties}>
            <span className="kicker">try it</span>
            <p className="note" style={{ marginTop: 8 }}>
              Three example purchases, checked against the rules on this page.
            </p>
            {EXAMPLE_AMOUNTS.map((amount) => {
              const state = verdict(amount);
              return (
                <div className="exrow" key={amount.toString()}>
                  <span>{usd(centsToYocto(amount, rate), rate)} purchase</span>
                  <span className={`rchip ${state.tone}`}>{state.label}</span>
                </div>
              );
            })}
          </section>

          <section className="card pop" style={{ "--d": ".2s" } as CSSProperties}>
            <div className="weekrow">
              <span className="kicker">spent this period</span>
              <span className="mono">
                {usd(vault.status.spent_this_period, rate)} of {usd(rules.budget_per_period, rate)}
              </span>
            </div>
            <div className="meter">
              <div className={`fill ${fillClass}`} style={{ width: `${spentShare}%` }} />
            </div>
            <p className="note">
              {BigInt(vault.status.budget_remaining) > 0n
                ? `Leaves ${usd(vault.status.budget_remaining, rate)} before the reset.`
                : "The budget is used up. New purchases are refused until it resets."}
            </p>
            <button className="b-butter b-big" style={{ width: "100%", marginTop: 18 }} onClick={onSave} disabled={busy}>
              {busy ? "Waiting for you" : "Save my rules"}
            </button>
            <p className="fine">You sign once. Changes land on the network.</p>
            <BusyLine text={step} />
            <ErrorNote message={error} />
            {savedHash && (
              <div className="callout callout-green" style={{ marginTop: 12 }}>
                <strong>Your rules are live</strong>
                <p>
                  The network is enforcing them now. <TxLink hash={savedHash} label="See the change" />
                </p>
              </div>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
}

function rangeStyle(value: number, min: number, max: number): CSSProperties {
  const share = max > min ? ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100 : 0;
  return {
    background: `linear-gradient(to right, var(--butter) 0 ${share}%, var(--cream) ${share}% 100%)`,
  };
}
