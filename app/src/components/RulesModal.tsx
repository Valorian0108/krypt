import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { signOwnerTransaction, GAS_OWNER, GAS_WRITE, type OwnerCall } from "../lib/chain";
import {
  centsToYocto,
  daysToPeriodNs,
  parseUsdToCents,
  periodNsToDays,
  yoctoToUsdInput,
} from "../lib/money";
import type { AppConfig, BroadcastResult, Rules, User } from "../lib/types";
import { BusyLine, Button, Callout, ErrorNote } from "./ui";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Props = {
  config: AppConfig;
  user: User;
  rules: Rules;
  onClose: () => void;
  onSaved: (result: BroadcastResult) => void;
};

export default function RulesModal({ config, user, rules, onClose, onSaved }: Props) {
  const rate = config.nearUsdRate;
  const [capUsd, setCapUsd] = useState(yoctoToUsdInput(rules.cap_per_spend, rate));
  const [autoUsd, setAutoUsd] = useState(yoctoToUsdInput(rules.auto_limit, rate));
  const [budgetUsd, setBudgetUsd] = useState(yoctoToUsdInput(rules.budget_per_period, rate));
  const [periodDays, setPeriodDays] = useState(periodNsToDays(rules.period_ns));
  const [payees, setPayees] = useState<string[]>(rules.payees || []);
  const [newPayee, setNewPayee] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  // Modal hygiene: lock the page scroll behind the dialog, move focus in on
  // open, and give it back to the control that opened this dialog on close.
  useEffect(() => {
    const opener = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const first = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialogRef.current)?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  // Keep Tab cycling inside the dialog so keyboard users cannot land on the
  // page behind it.
  function onDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const inside = dialogRef.current.contains(active);
    if (event.shiftKey && (!inside || active === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (!inside || active === last)) {
      event.preventDefault();
      first.focus();
    }
  }

  const originalPayees = useMemo(() => rules.payees || [], [rules.payees]);
  const added = payees.filter((payee) => !originalPayees.includes(payee));
  const removed = originalPayees.filter((payee) => !payees.includes(payee));

  function validate(): string | null {
    const cap = parseUsdToCents(capUsd);
    const auto = parseUsdToCents(autoUsd);
    const budget = parseUsdToCents(budgetUsd);
    if (cap === null || auto === null || budget === null) {
      return "Enter amounts as dollars and cents, like 2.00 or 0.40.";
    }
    if (cap <= 0n) {
      return "A cap of $0.00 keeps every purchase locked. Raise it or close this window.";
    }
    if (auto > cap) {
      return "The auto-approve limit cannot be higher than the single-purchase cap.";
    }
    if (budget < cap) {
      return "The budget should be at least as large as the single-purchase cap.";
    }
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
            cap_per_spend: centsToYocto(parseUsdToCents(capUsd)!, rate).toString(),
            auto_limit: centsToYocto(parseUsdToCents(autoUsd)!, rate).toString(),
            budget_per_period: centsToYocto(parseUsdToCents(budgetUsd)!, rate).toString(),
            period_ns: daysToPeriodNs(periodDays),
            expires_at_ns: 0,
          },
        },
      },
    ];
    for (const payee of added) {
      calls.push({ method: "add_payee", gas: GAS_OWNER, args: { payee } });
    }
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
      setError("That does not look like an account name. It should look like shop.example.testnet.");
      return;
    }
    if (payees.includes(payee)) return;
    setError(null);
    setPayees([...payees, payee]);
  }

  const vendorName = (id: string) =>
    config.vendors.find((vendor) => vendor.id === id)?.name || id;

  return (
    <div className="modal-back" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Change the rules"
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
      >
        <header className="modal-head">
          <h2>Your rules</h2>
          <button className="modal-x" onClick={onClose} disabled={busy} aria-label="Close">
            ×
          </button>
        </header>

        <p className="card-sub">
          The agent can only buy within these limits. Anything above the auto-approve limit
          waits for you, and anything above the cap is refused outright.
        </p>

        <div className="field-grid">
          <label className="field">
            <span className="field-label">Cap per purchase</span>
            <span className="field-input">
              <span className="dollar">$</span>
              <input
                value={capUsd}
                onChange={(event) => setCapUsd(event.target.value)}
                inputMode="decimal"
                autoComplete="off"
                disabled={busy}
              />
            </span>
            <span className="field-hint">No single purchase may cost more than this.</span>
          </label>
          <label className="field">
            <span className="field-label">Auto-approve up to</span>
            <span className="field-input">
              <span className="dollar">$</span>
              <input
                value={autoUsd}
                onChange={(event) => setAutoUsd(event.target.value)}
                inputMode="decimal"
                autoComplete="off"
                disabled={busy}
              />
            </span>
            <span className="field-hint">Purchases at or below this go through on their own.</span>
          </label>
          <label className="field">
            <span className="field-label">Budget</span>
            <span className="field-input">
              <span className="dollar">$</span>
              <input
                value={budgetUsd}
                onChange={(event) => setBudgetUsd(event.target.value)}
                inputMode="decimal"
                autoComplete="off"
                disabled={busy}
              />
            </span>
            <span className="field-hint">
              Total the agent may spend{" "}
              <select
                className="period-select"
                aria-label="Budget period"
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
              .
            </span>
          </label>
        </div>

        <div className="payee-box">
          <span className="field-label">Approved sellers</span>
          <ul className="payee-list">
            {payees.map((payee) => (
              <li key={payee}>
                <span>
                  {vendorName(payee)} <code className="code">{payee}</code>
                </span>
                <button
                  className="payee-x"
                  disabled={busy || payees.length === 1}
                  onClick={() => setPayees(payees.filter((entry) => entry !== payee))}
                  title={payees.length === 1 ? "Keep at least one approved seller" : "Remove"}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <div className="payee-add">
            <input
              value={newPayee}
              onChange={(event) => setNewPayee(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && addPayee()}
              placeholder="account name to approve"
              aria-label="Account name to approve"
              spellCheck={false}
              disabled={busy}
            />
            <Button variant="secondary" onClick={addPayee} disabled={busy || !newPayee.trim()}>
              Add seller
            </Button>
          </div>
        </div>

        {(added.length > 0 || removed.length > 0) && (
          <Callout tone="neutral">
            This approval updates the limits
            {added.length > 0 && ` and adds ${added.map(vendorName).join(", ")}`}
            {removed.length > 0 && ` and removes ${removed.map(vendorName).join(", ")}`}.
          </Callout>
        )}

        <BusyLine text={step} />
        <ErrorNote message={error} />

        <footer className="modal-foot">
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onSave} busy={busy} disabled={busy}>
            {busy ? "Working" : "Approve these rules"}
          </Button>
        </footer>
        {busy && (
          <p className="modal-note">
            A sign-in window will open. Approving it signs one transaction that saves every
            change above.
          </p>
        )}
      </div>
    </div>
  );
}
