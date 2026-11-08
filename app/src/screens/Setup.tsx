import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "../lib/api";
import { onboardingCalls, signOwnerTransaction } from "../lib/chain";
import {
  centsToYocto,
  daysToPeriodNs,
  near,
  parseUsdToCents,
  periodLabel,
  usd,
} from "../lib/money";
import type { AppConfig, BroadcastResult, MeResponse, User, Vault } from "../lib/types";
import { isOnboarded } from "../lib/vault";
import TopBar from "../components/TopBar";
import { BusyLine, Callout, Code, ErrorNote, TxLink } from "../components/ui";

type Phase = "checking" | "invite" | "build" | "waiting" | "approve" | "done";

type Props = {
  config: AppConfig;
  me: MeResponse;
  onDone: () => void;
  onSignOut: () => void;
};

const BUILD_STEPS = [
  "Checking your invite",
  "Funding your vault",
  "Creating the vault on the test network",
  "Securing the agent key",
];

export default function Setup({ config, me, onDone, onSignOut }: Props) {
  const [phase, setPhase] = useState<Phase>(
    me.needsSetup ? (me.setupInProgress ? "waiting" : "invite") : "checking",
  );
  const [user, setUser] = useState<User | null>(me.needsSetup ? null : me.user);
  const [steps, setSteps] = useState<string[]>([]);
  const [buildStep, setBuildStep] = useState(0);
  const [inviteCode, setInviteCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [stepLine, setStepLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BroadcastResult | null>(null);
  const [funded, setFunded] = useState<Vault | null>(null);
  const [inviteBad, setInviteBad] = useState(false);

  const rate = config.nearUsdRate;
  const defaults = config.defaultRules;
  const identity = me.needsSetup ? me.identity : null;
  const label = me.needsSetup
    ? me.identity.email || me.identity.name
    : me.user.email || me.user.name || me.user.vaultId;

  // A returning user may already be onboarded, or may have closed the popup
  // halfway last time. Check the vault and pick up where they left off.
  const checkOnboarded = useCallback(
    async (current: User) => {
      setPhase("checking");
      setError(null);
      try {
        const { vault } = await api.vault();
        // Zero limits are a valid paused state, not a missing account. The
        // shared rule keeps this in step with the router in App.tsx.
        const onboarded = isOnboarded(vault, current);
        if (onboarded) {
          onDone();
        } else {
          setUser(current);
          setPhase("approve");
        }
      } catch (reason) {
        // A read failure is not proof that setup is missing. Stay on the
        // checking screen with a retry instead of offering to rebuild.
        setError(reason instanceof Error ? reason.message : String(reason));
        setUser(current);
        setPhase("checking");
      }
    },
    [onDone],
  );

  useEffect(() => {
    if (!me.needsSetup) void checkOnboarded(me.user);
    // Run once per mount; the identity is stable while this screen is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The build list is a checklist, not a progress bar. The last item keeps
  // its running dot until the server answers, so this can never claim the
  // account is ready before it is.
  useEffect(() => {
    if (phase !== "build") return;
    const timer = window.setInterval(() => {
      setBuildStep((step) => Math.min(step + 1, BUILD_STEPS.length - 1));
    }, 900);
    return () => window.clearInterval(timer);
  }, [phase]);

  async function onCreate() {
    if (!inviteCode.trim()) {
      setInviteBad(true);
      setError("Enter the invite code you were given. It looks like RING1-XXXX-XXXX.");
      return;
    }
    setInviteBad(false);
    setError(null);
    setBusy(true);
    setBuildStep(0);
    setPhase("build");
    try {
      const created = await api.setup(inviteCode.trim());
      setSteps(created.steps);
      setUser(created.user);
      setBuildStep(BUILD_STEPS.length);
      setPhase("approve");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPhase("invite");
    } finally {
      setBusy(false);
    }
  }

  async function onApprove() {
    if (!user) return;
    const cap = parseUsdToCents(defaults.capUsd);
    const auto = parseUsdToCents(defaults.autoUsd);
    const budget = parseUsdToCents(defaults.budgetUsd);
    if (cap === null || auto === null || budget === null) {
      setError("The starting rules are incomplete on the server. Tell the operator.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const broadcast = await signOwnerTransaction({
        vaultId: user.vaultId,
        publicKey: user.publicKey,
        calls: onboardingCalls(user.agentId, {
          rules: {
            cap_per_spend: centsToYocto(cap, rate).toString(),
            auto_limit: centsToYocto(auto, rate).toString(),
            budget_per_period: centsToYocto(budget, rate).toString(),
            period_ns: daysToPeriodNs(defaults.periodDays),
            expires_at_ns: 0,
          },
        }),
        onStep: setStepLine,
      });
      setResult(broadcast);
      setPhase("done");
      void api
        .recordActivity({
          kind: "setup",
          summary: "Turned on the guardrails: agent registered and rules set",
          txHash: broadcast.hash,
        })
        .catch(() => undefined);
      void api
        .vault()
        .then(({ vault }) => setFunded(vault))
        .catch(() => undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      setStepLine(null);
    }
  }

  async function onCheckAgain() {
    setBusy(true);
    setError(null);
    try {
      const fresh = await api.me();
      if (!fresh.needsSetup) {
        onDone();
        return;
      }
      if (fresh.setupInProgress) {
        setError("Setup is still running. Give it another moment.");
      } else {
        setPhase("invite");
        setError("The earlier attempt stopped before finishing. You can start setup again here.");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  const stepIndex = phase === "invite" ? 1 : phase === "build" || phase === "waiting" ? 2 : 3;
  const stepClass = (index: number) => {
    if (phase === "done") return "step done";
    if (index < stepIndex) return "step done";
    if (index === stepIndex) return "step on";
    return "step";
  };

  const top = <TopBar label={label} onSignOut={onSignOut} />;

  if (phase === "checking") {
    return (
      <>
        {top}
        <main className="page-narrow">
          <section className="card setup-card" style={{ marginTop: 26 }}>
            <span className="kicker">almost there</span>
            <h2>{error ? "Could not read your account" : "Checking your account"}</h2>
            {!error && <BusyLine text="Reading your account from the test network" />}
            <ErrorNote message={error} />
            {error && user && (
              <p>
                <button className="b-butter" onClick={() => void checkOnboarded(user)}>
                  Try again
                </button>
              </p>
            )}
          </section>
        </main>
      </>
    );
  }

  return (
    <>
      {top}
      <main className="page-narrow">
        <div className="setup-head pop">
          <span className="kicker">first run</span>
          <h1>Let's make your spending account.</h1>
          <p className="lede-sm">
            Three small steps. Your rules live in the account itself, and the agent gets a
            key that can only ask.
          </p>
        </div>

        <div className="steps pop" style={{ "--d": ".06s" } as CSSProperties}>
          <span className={stepClass(1)}>
            <b>{phase !== "invite" ? "\u2713" : "1"}</b> invite
          </span>
          <span className={stepClass(2)}>
            <b>{phase === "approve" || phase === "done" ? "\u2713" : "2"}</b> build
          </span>
          <span className={stepClass(3)}>
            <b>{phase === "done" ? "\u2713" : "3"}</b> approve
          </span>
        </div>

        <section className="card setup-card pop" style={{ "--d": ".12s" } as CSSProperties}>
          {phase === "invite" && (
            <div className="state">
              <span className="kicker">step 1 · invite</span>
              <h2>Enter your invite code</h2>
              <p className="note">
                One use per code. Each code covers one account, paid for by the demo sponsor.
                No password after this, you sign in with one secure popup.
              </p>

              {identity && (
                <p className="fine">
                  Signed in as <b>{identity.email || identity.name}</b>.
                </p>
              )}

              {me.needsSetup && me.existingVault && (
                <Callout tone="blue" title="We found an account that belongs to this login">
                  <p>
                    <Code>{me.existingVault}</Code> will be adopted instead of creating a new
                    one.
                  </p>
                </Callout>
              )}

              <label className="field">
                <span className="field-label">Invite code</span>
                <input
                  value={inviteCode}
                  onChange={(event) => {
                    setInviteCode(event.target.value);
                    setInviteBad(false);
                  }}
                  placeholder="RING1-XXXX-XXXX"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  className={inviteBad ? "bad" : ""}
                  onKeyDown={(event) => event.key === "Enter" && void onCreate()}
                />
              </label>
              <ErrorNote message={error} />
              <div className="acts">
                <button className="b-butter b-big" onClick={() => void onCreate()} disabled={busy}>
                  {busy ? "Starting" : "Continue"}
                </button>
              </div>
              <p className="fine">This demo is invite only while we test.</p>
            </div>
          )}

          {(phase === "build" || phase === "waiting") && (
            <div className="state">
              <span className="kicker">step 2 · build</span>
              <h2>{phase === "waiting" ? "Your account is already being built" : "Building your account"}</h2>
              <p className="note">
                {phase === "waiting"
                  ? "Setup for this login started somewhere else and is still running. Keep this tab open, or check again below."
                  : "This takes a few seconds. Keep this tab open, we will tell you when it needs you."}
              </p>
              <ul className="progress">
                {BUILD_STEPS.map((step, index) => {
                  const done = buildStep > index;
                  const running = !done && buildStep === index;
                  return (
                    <li key={step}>
                      <span className={`pstate ${done ? "done" : running ? "running" : ""}`}>
                        {done ? "\u2713" : ""}
                      </span>
                      <span>{step}</span>
                    </li>
                  );
                })}
              </ul>
              {phase === "waiting" && (
                <>
                  <ErrorNote message={error} />
                  <div className="acts">
                    <button className="b-ghost" onClick={() => void onCheckAgain()} disabled={busy}>
                      {busy ? "Checking" : "Check again"}
                    </button>
                  </div>
                </>
              )}
              {phase === "build" && (
                <p className="fine">
                  The demo sponsor pays for the account. It holds no key to what is inside.
                </p>
              )}
            </div>
          )}

          {phase === "approve" && (
            <div className="state">
              <span className="kicker">step 3 · approve</span>
              <h2>One approval and you're in</h2>
              <p className="note">
                We prepared one transaction. It registers your agent and sets your rules.
                Approve it once in the secure window. There is no terminal and no seed phrase.
              </p>

              {steps.length > 0 && (
                <p className="fine">The network just finished: {steps.join(", ")}.</p>
              )}

              <div className="summary">
                <div className="srow">
                  <span>Agent key</span>
                  <b>can ask to spend, nothing else</b>
                </div>
                <div className="srow">
                  <span>Cap per purchase</span>
                  <b>${defaults.capUsd}</b>
                </div>
                <div className="srow">
                  <span>Auto-approve under</span>
                  <b>${defaults.autoUsd}</b>
                </div>
                <div className="srow">
                  <span>Budget {periodLabel(daysToPeriodNs(defaults.periodDays))}</span>
                  <b>${defaults.budgetUsd}</b>
                </div>
                <div className="srow">
                  <span>Who your agent can pay</span>
                  <b>none yet</b>
                </div>
              </div>
              <p className="fine">
                Your agent cannot pay anyone until you add a person or shop on your Rules page.
              </p>
              <BusyLine text={stepLine} />
              <ErrorNote message={error} />
              <div className="acts">
                <button
                  className="b-butter b-big"
                  onClick={() => void onApprove()}
                  disabled={busy || !user}
                >
                  {busy ? "Waiting for you" : "Approve in the secure window"}
                </button>
              </div>
              <p className="fine">
                You can change every rule later. The agent cannot change any of them.
              </p>
            </div>
          )}

          {phase === "done" && (
            <div className="state">
              <div className="done-badge">{"\u2713"}</div>
              <span className="kicker">step 3 · done</span>
              <h2>You're in.</h2>
              <p className="note">
                Your account is live on the test network. Here is what is in it, and your
                rules decide who can touch it.
              </p>
              <div className="balance-box">
                <span className="kicker">
                  in your account <span className="sticker">test money</span>
                </span>
                {funded ? (
                  <>
                    <div className="big" style={{ fontSize: 48, display: "block", width: "max-content" }}>
                      {usd(funded.balanceYocto, rate)}
                    </div>
                    <div className="sub">
                      exactly <span className="mono">{near(funded.balanceYocto, 24)} NEAR</span>,
                      funded by the demo sponsor
                    </div>
                    <p className="fine">
                      Part of that stays locked as network storage so your receipts are kept
                      safe. Your Home page shows what is free to spend.
                    </p>
                  </>
                ) : (
                  <div className="sub">Funded by the demo sponsor and live on the test network.</div>
                )}
              </div>
              {result && (
                <p className="fine">
                  <TxLink hash={result.hash} label="See the setup transaction" />
                </p>
              )}
              <div className="acts">
                <button className="b-butter b-big" onClick={onDone}>
                  Open my home
                </button>
              </div>
              <p className="fine">
                Next: add a person or shop on Rules. Until then, every purchase is refused.
              </p>
              <p className="fine">The agent holds a key that can ask. It can never approve itself.</p>
            </div>
          )}
        </section>

        <p className="fine center pop" style={{ "--d": ".18s" } as CSSProperties}>
          Test network, test money. Nothing here touches real funds.
        </p>
      </main>
    </>
  );
}
