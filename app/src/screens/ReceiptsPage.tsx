import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { near, periodWord, relativeNs, timeOf, usd } from "../lib/money";
import type { ActivityItem, AppConfig, Receipt, SpendStatus, Vault } from "../lib/types";
import { ReceiptChip } from "../components/ui";

type Filter = "all" | "paid" | "waiting" | "refused";

type Props = {
  config: AppConfig;
  vault: Vault;
  activity: ActivityItem[];
  onNavHome: () => void;
};

const PAGE_SIZE = 10;

function groupOf(status: SpendStatus): Exclude<Filter, "all"> {
  if (status === "Settled" || status === "OwnerApproved") return "paid";
  if (status === "Queued") return "waiting";
  return "refused";
}

function dayLabel(timestampNs: number): string {
  const ms = Math.floor(timestampNs / 1_000_000);
  if (!Number.isFinite(ms) || ms <= 0) return "Earlier";
  const date = new Date(ms);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfThatDay = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const dayMs = 86_400_000;
  if (startOfThatDay === startOfToday) return "Today";
  if (startOfThatDay === startOfToday - dayMs) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function ReceiptsPage({ config, vault, activity, onNavHome }: Props) {
  const rate = config.nearUsdRate;
  const [filter, setFilter] = useState<Filter>("all");
  const [visible, setVisible] = useState(PAGE_SIZE);

  const receipts = vault.receipts;
  const spent = BigInt(vault.status.spent_this_period);
  const budget = BigInt(vault.rules.budget_per_period);
  const spentShare = budget > 0n ? Math.min(100, Number((spent * 1000n) / budget) / 10) : 0;
  const fillClass = spentShare >= 80 ? "m-tomato" : spentShare >= 50 ? "m-butter" : "m-leaf";

  const counts = useMemo(() => {
    const next = { all: receipts.length, paid: 0, waiting: 0, refused: 0 };
    for (const receipt of receipts) next[groupOf(receipt.status)] += 1;
    return next;
  }, [receipts]);

  const txByReceipt = useMemo(() => {
    const map = new Map<number, string>();
    for (const item of activity) {
      if (item.receiptId != null && item.txHash) map.set(item.receiptId, item.txHash);
    }
    return map;
  }, [activity]);

  const vendorName = (id: string) =>
    config.vendors.find((vendor) => vendor.id === id)?.name || id;

  const filtered = receipts.filter(
    (receipt) => filter === "all" || groupOf(receipt.status) === filter,
  );
  const shown = filtered.slice(0, visible);

  const groups = useMemo(() => {
    const map = new Map<string, Receipt[]>();
    for (const receipt of shown) {
      const label = dayLabel(receipt.timestamp_ns);
      const list = map.get(label) || [];
      list.push(receipt);
      map.set(label, list);
    }
    return [...map.entries()];
  }, [shown]);

  function chooseFilter(next: Filter) {
    setFilter(next);
    setVisible(PAGE_SIZE);
  }

  const allTime = vault.status.receipts_count <= receipts.length;
  const noReceipts = receipts.length === 0;

  return (
    <main className="page">
      <div className="pagehead pop">
        <div>
          <span className="kicker">the record</span>
          <h1>Receipts</h1>
          <p className="lede-sm">
            Every request, exactly as the network recorded it. Paid, waiting, refused.
            Nothing hidden.
          </p>
        </div>
      </div>

      <div className="sumgrid">
        <section className="card sumcard pop" style={{ "--d": ".02s" } as CSSProperties}>
          <span className="kicker">
            spent {periodWord(vault.rules.period_ns)} <span className="sticker">test money</span>
          </span>
          <div className="big">{usd(spent, rate)}</div>
          <div className="meter mini">
            <div className={`fill ${fillClass}`} style={{ width: `${spentShare}%` }} />
          </div>
          <div className="sub">
            of {usd(budget, rate)}.
            {vault.status.next_period_reset_ns > 0 && vault.rules.period_ns > 1
              ? ` Resets ${timeOf(vault.status.next_period_reset_ns)}.`
              : " A new period starts when the rules say so."}
          </div>
        </section>

        <section className="card sumcard pop" style={{ "--d": ".06s" } as CSSProperties}>
          <span className="kicker">requests</span>
          <div className="big">
            {allTime ? vault.status.receipts_count : receipts.length}
          </div>
          <div className="sub">
            {allTime ? "since you opened the account" : `the latest ${receipts.length} on record`}
          </div>
        </section>

        <section className="card sumcard pop" style={{ "--d": ".12s" } as CSSProperties}>
          <span className="kicker">refused</span>
          <div className="big">{counts.refused}</div>
          <div className="sub">all by your rules, not by luck</div>
        </section>
      </div>

      <div className="filters pop" style={{ "--d": ".18s" } as CSSProperties}>
        {(
          [
            ["all", "All"],
            ["paid", "Paid"],
            ["waiting", "Waiting"],
            ["refused", "Refused"],
          ] as [Filter, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            className={`fchip ${filter === value ? "on" : ""}`}
            onClick={() => chooseFilter(value)}
            aria-pressed={filter === value}
          >
            {label} <b>{counts[value]}</b>
          </button>
        ))}
      </div>

      {noReceipts ? (
        <section className="card empty pop">
          <span className="kicker">nothing here yet</span>
          <div className="big">No receipts yet.</div>
          <p className="note">
            Run a job from Home and the first request appears here, exactly as the network
            recorded it.
          </p>
          <div className="acts" style={{ justifyContent: "center" }}>
            <button className="b-butter" onClick={onNavHome}>
              Go to Home
            </button>
          </div>
        </section>
      ) : filter !== "all" && counts[filter] === 0 ? (
        <section className="card empty pop">
          <span className="kicker">nothing {filter}</span>
          <div className="big">
            {filter === "waiting" ? "All caught up." : `No ${filter} requests.`}
          </div>
          <p className="note">
            {filter === "waiting"
              ? "No requests are waiting for you. The agent has no open asks."
              : `Every receipt in this account falls outside the ${filter} filter.`}
          </p>
        </section>
      ) : (
        <>
          <div id="list">
            {groups.map(([label, list]) => (
              <div className="rgroup" key={label}>
                <h3 className="ghead">{label}</h3>
                {list.map((receipt) => {
                  const hash = txByReceipt.get(receipt.id) || "";
                  return (
                    <article className="bigrow" key={receipt.id}>
                      <span className="rid">#{receipt.id}</span>
                      <div className="rmain">
                        <b>{receipt.purpose}</b>
                        <span>{vendorName(receipt.payee)}</span>
                      </div>
                      <div className="rnum">
                        <b>{usd(receipt.amount, rate)}</b>
                        <span className="mono">{near(receipt.amount, 24)} NEAR</span>
                      </div>
                      <ReceiptChip status={receipt.status} reason={receipt.reason} />
                      <div className="rmeta">
                        {relativeNs(receipt.timestamp_ns)}
                        {hash && (
                          <a
                            href={`https://explorer.testnet.near.org/transactions/${hash}`}
                            target="_blank"
                            rel="noreferrer"
                            title={`Transaction ${hash}`}
                          >
                            {hash.slice(0, 4)}…{hash.slice(-4)}
                          </a>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            ))}
          </div>

          {filtered.length > visible && (
            <div className="more pop">
              <button className="b-ghost" onClick={() => setVisible((value) => value + PAGE_SIZE)}>
                Show older receipts
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
