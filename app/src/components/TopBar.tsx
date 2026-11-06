import type { CSSProperties } from "react";

export type Screen = "home" | "rules" | "receipts";

export function Wordmark({ size = 25, tone = "cream" }: { size?: number; tone?: "cream" | "ink" }) {
  return (
    <span
      className={`wordmark ${tone === "ink" ? "ink" : ""}`}
      style={{ fontSize: size } as CSSProperties}
    >
      KRYPT
    </span>
  );
}

type Props = {
  label?: string | null;
  active?: Screen;
  onNav?: (screen: Screen) => void;
  onSignOut?: () => void;
  onSignIn?: () => void;
  signInBusy?: boolean;
};

// The top bar shows up in screenshots and demos, so the raw email must never
// render. Keep the first characters of the name part and mask the rest. The
// mask is fixed-width on purpose: it must not leak the address or its length,
// and there is no title attribute so hovering cannot reveal it either.
function maskLabel(raw: string) {
  const value = raw.trim();
  const at = value.indexOf("@");
  if (at < 0) return value;
  return `${value.slice(0, Math.min(4, at))}****`;
}

export default function TopBar({
  label,
  active,
  onNav,
  onSignOut,
  onSignIn,
  signInBusy,
}: Props) {
  const masked = label ? maskLabel(label) : null;
  const initial = (masked?.[0] || "Y").toUpperCase();

  return (
    <header className="top">
      <span style={{ display: "inline-flex", alignItems: "baseline" }}>
        <Wordmark />
        <span className="testnet">testnet</span>
      </span>

      {onNav && (
        <nav className="tabs" aria-label="Main">
          <button
            className={`tab ${active === "home" ? "on" : ""}`}
            onClick={() => onNav("home")}
          >
            Home
          </button>
          <button
            className={`tab ${active === "rules" ? "on" : ""}`}
            onClick={() => onNav("rules")}
          >
            Rules
          </button>
          <button
            className={`tab ${active === "receipts" ? "on" : ""}`}
            onClick={() => onNav("receipts")}
          >
            Receipts
          </button>
        </nav>
      )}

      <span className="spacer" />

      {masked && (
        <span className="ident">
          <span className="avatar" aria-hidden="true">
            {initial}
          </span>
          <span className="email">{masked}</span>
        </span>
      )}

      {label && onSignOut && (
        <button className="signout" onClick={onSignOut}>
          Sign out
        </button>
      )}

      {onSignIn && (
        <button className="signout" onClick={onSignIn} disabled={signInBusy}>
          {signInBusy ? "Opening" : "Sign in"}
        </button>
      )}
    </header>
  );
}
