import type { ButtonHTMLAttributes, ReactNode } from "react";
import { near, usd } from "../lib/money";
import type { SpendStatus } from "../lib/types";

export function Card(props: {
  title?: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${props.className || ""}`.trim()}>
      {(props.title || props.right) && (
        <header className="section-head">
          <div>
            {props.title && <h2>{props.title}</h2>}
            {props.subtitle && <p>{props.subtitle}</p>}
          </div>
          {props.right}
        </header>
      )}
      {props.children}
    </section>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "quiet" | "leaf";
  busy?: boolean;
};

const BUTTON_CLASS: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary: "b-butter",
  secondary: "b-ghost",
  danger: "b-tomato",
  quiet: "b-link",
  leaf: "b-leaf",
};

export function Button({ variant = "primary", busy, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      className={BUTTON_CLASS[variant]}
      disabled={disabled || busy}
      {...rest}
    >
      {busy ? (
        <>
          <span className="spin" aria-hidden="true" /> {children}
        </>
      ) : (
        children
      )}
    </button>
  );
}

export type Tone = "green" | "amber" | "red" | "blue" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
  green: "c-leaf",
  amber: "c-butter",
  red: "c-tomato",
  blue: "c-pool",
  neutral: "",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`rchip ${TONE_CLASS[tone]}`.trim()}>{children}</span>;
}

const STATUS_META: Record<SpendStatus, { label: string; tone: Tone }> = {
  Settled: { label: "paid on its own", tone: "green" },
  Queued: { label: "waiting for you", tone: "amber" },
  OwnerApproved: { label: "you approved", tone: "blue" },
  OwnerRefused: { label: "you refused", tone: "neutral" },
  Rejected: { label: "refused by rules", tone: "red" },
  TransferFailed: { label: "payment failed", tone: "red" },
};

export function StatusBadge({ status }: { status: SpendStatus }) {
  const meta = STATUS_META[status] || { label: status, tone: "neutral" as Tone };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

function refusalLabel(reason: string): string {
  if (/per-spend cap/i.test(reason)) return "refused: over cap";
  if (/allowlist/i.test(reason)) return "refused: seller";
  if (/budget/i.test(reason)) return "refused: budget";
  if (/expired/i.test(reason)) return "refused: expired";
  if (/spendable NEAR/i.test(reason)) return "refused: balance";
  return "refused by rules";
}

export function ReceiptChip({
  status,
  reason = "",
}: {
  status: SpendStatus;
  reason?: string;
}) {
  if (status === "Rejected") {
    return <span className="rchip c-tomato" title={reason}>{refusalLabel(reason)}</span>;
  }
  if (status === "Queued") {
    return <span className="rchip c-butter" title={reason}>waiting for you</span>;
  }
  if (status === "OwnerApproved") {
    return <span className="rchip c-pool" title={reason}>you approved</span>;
  }
  if (status === "OwnerRefused") {
    return <span className="rchip" title={reason}>you refused</span>;
  }
  if (status === "TransferFailed") {
    return <span className="rchip c-tomato" title={reason}>payment failed</span>;
  }
  return <span className="rchip c-leaf" title={reason}>paid on its own</span>;
}

// Dollars first, exact NEAR underneath. The dollar figure is a fixed test
// conversion; the NEAR figure is the exact amount on the network.
export function Money({
  yocto,
  rate,
  size = "normal",
}: {
  yocto: bigint | string;
  rate: number;
  size?: "normal" | "big" | "inline";
}) {
  if (size === "inline") {
    return (
      <span className="money-inline">
        {usd(yocto, rate)}
        <span className="money-near">{near(yocto, 24)} NEAR</span>
      </span>
    );
  }
  return (
    <span className={`money ${size === "big" ? "big" : ""}`}>
      <span className="money-usd">{usd(yocto, rate)}</span>
      <span className="money-near">{near(yocto, 24)} NEAR</span>
    </span>
  );
}

export function Callout({
  tone = "blue",
  title,
  children,
}: {
  tone?: Tone;
  title?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`callout callout-${tone}`} role={tone === "red" ? "alert" : undefined}>
      {title && <strong>{title}</strong>}
      <div>{children}</div>
    </div>
  );
}

export function TxLink({ hash, label }: { hash: string; label?: string }) {
  if (!hash) return null;
  return (
    <a
      className="txlink"
      href={`https://explorer.testnet.near.org/transactions/${hash}`}
      target="_blank"
      rel="noreferrer"
      title={`Transaction ${hash}`}
    >
      {label || `${hash.slice(0, 6)}...${hash.slice(-4)}`}
    </a>
  );
}

export function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="srow">
      <span>{label}</span>
      <span>{children}</span>
    </div>
  );
}

export function Code({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code className="code" title={title}>
      {children}
    </code>
  );
}

export function BusyLine({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="busy" aria-live="polite">
      <span className="spin" aria-hidden="true" />
      {text}
    </p>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="err" role="alert">
      {message}
    </p>
  );
}
