import { useState } from "react";
import type { CSSProperties } from "react";
import { login } from "../lib/auth";
import TopBar from "../components/TopBar";
import { Callout, ErrorNote } from "../components/ui";

type Props = {
  notice?: string;
  onLoggedIn: () => void;
};

export default function Landing({ notice, onLoggedIn }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSignIn() {
    setBusy(true);
    setError(null);
    try {
      await login();
      onLoggedIn();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(
        /popup|closed|cancel/i.test(message)
          ? "The sign-in window closed before you finished. Try again when you are ready."
          : message,
      );
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar onSignIn={() => void onSignIn()} signInBusy={busy} />

      <main className="page">
        {notice && (
          <div style={{ paddingTop: 22 }}>
            <Callout tone="amber" title="Signed out">
              <p>{notice}</p>
            </Callout>
          </div>
        )}

        <section className="hero">
          <div className="pop">
            <span className="kicker">a spending account for your agent</span>
            <h1 className="hero-title">
              Your agent can shop. It <span className="hl">cannot</span> drain you.
            </h1>
            <p className="lede">
              Set limits in plain dollars. The agent asks, your rules answer, and every
              purchase leaves a receipt you can open.
            </p>
            <div className="cta">
              <button className="b-butter b-big" onClick={() => void onSignIn()} disabled={busy}>
                {busy ? "Opening the secure window" : "Sign in"}
              </button>
              <a className="demo-link" href="#how">
                See how it works
              </a>
            </div>
            <ErrorNote message={error} />
            <p className="fine">Invite only while we test. One secure popup. No wallet setup.</p>
          </div>

          <div className="visual pop" style={{ "--d": ".12s" } as CSSProperties}>
            <div className="backcard">
              <span className="kicker">your rules</span>
              <div className="chips">
                <span className="chip">cap per purchase $2.00</span>
                <span className="chip">auto-approve $0.40</span>
                <span className="chip">one trusted seller</span>
              </div>
            </div>
            <div className="frontcard lift">
              <div className="mini-head">
                <span className="kicker">last receipts</span>
                <span className="sticker">test money</span>
              </div>
              <div className="mline">
                <span className="mname">Weekly market data</span>
                <span className="mamt">$0.10</span>
                <span className="rchip c-leaf">paid</span>
              </div>
              <div className="mline">
                <span className="mname">Research report</span>
                <span className="mamt">$1.00</span>
                <span className="rchip c-pool">you approved</span>
              </div>
              <div className="mline">
                <span className="mname">Premium feed</span>
                <span className="mamt">$2.50</span>
                <span className="rchip c-tomato">refused</span>
              </div>
              <div className="mini-foot">a sample account on the test network</div>
            </div>
          </div>
        </section>

        <section className="trust">
          <div className="card lift pop" style={{ "--d": ".18s" } as CSSProperties}>
            <span className="kicker">a hard cap</span>
            <h3>Above your limit, the account says no.</h3>
            <p className="note">
              It does not matter what the agent was told. The limit lives in the account
              itself, not in the agent's instructions.
            </p>
          </div>
          <div className="card lift pop" style={{ "--d": ".24s" } as CSSProperties}>
            <span className="kicker">who gets paid</span>
            <h3>Only people you trust get paid.</h3>
            <p className="note">
              Anyone else is refused before a single cent moves, even if the request looks
              harmless.
            </p>
          </div>
          <div className="card lift pop" style={{ "--d": ".30s" } as CSSProperties}>
            <span className="kicker">receipts</span>
            <h3>Every move leaves a receipt.</h3>
            <p className="note">
              Paid, waiting, refused. The record lives on the network, and every row opens
              the real transaction.
            </p>
          </div>
        </section>

        <section className="card how pop" id="how" style={{ "--d": ".36s" } as CSSProperties}>
          <span className="kicker">how it works</span>
          <div className="howgrid">
            <div className="howstep">
              <span className="stepnum s1">1</span>
              <div>
                <b>Set your limits once.</b>
                <span className="howcopy">
                  A cap per purchase, a budget per period, and the sellers you trust.
                </span>
              </div>
            </div>
            <div className="howstep">
              <span className="stepnum s2">2</span>
              <div>
                <b>Let the agent shop.</b>
                <span className="howcopy">
                  Small purchases pay themselves. Everything else waits for you.
                </span>
              </div>
            </div>
            <div className="howstep">
              <span className="stepnum s3">3</span>
              <div>
                <b>Approve only what needs you.</b>
                <span className="howcopy">
                  One press, one signature, and the receipt is written.
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className="ctaband pop" style={{ "--d": ".42s" } as CSSProperties}>
          <div>
            <h2>Give your agent a leash.</h2>
            <p>Test money, real checks. Your rules decide everything.</p>
          </div>
          <button className="b-butter b-big" onClick={() => void onSignIn()} disabled={busy}>
            Sign in
          </button>
        </section>

        <footer className="foot">
          <span>Runs on the NEAR test network. The money is test money.</span>
          <span className="mono">invite only · 2026</span>
        </footer>
      </main>
    </>
  );
}
