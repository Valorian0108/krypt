import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../lib/api";
import { GAS_OWNER, GAS_WRITE, signOwnerTransaction } from "../lib/chain";
import { usd } from "../lib/money";
import type {
  AgentRunResult,
  AppConfig,
  BroadcastResult,
  Errand,
  RunOutcome,
  User,
  VaultResponse,
} from "../lib/types";
import TopBar, { type Screen } from "../components/TopBar";
import Home from "./Home";
import ReceiptsPage from "./ReceiptsPage";
import RulesPage from "./RulesPage";

type Props = {
  config: AppConfig;
  user: User;
  initial: VaultResponse;
  onSignOut: () => void;
};

const REFRESH_MS = 15_000;

export default function Dashboard({ config, user, initial, onSignOut }: Props) {
  const [screen, setScreen] = useState<Screen>("home");
  const [data, setData] = useState<VaultResponse>(initial);
  const [runningErrand, setRunningErrand] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [stepLine, setStepLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rate = config.nearUsdRate;
  const { vault, activity } = data;
  const vendorName = useCallback(
    (id: string) => config.vendors.find((vendor) => vendor.id === id)?.name || id,
    [config.vendors],
  );

  // Refreshes overlap by design: the 15s poll, post-action refreshes, and a
  // manual refresh can all be in flight at once. Only the newest one may
  // write state, so a slow stale response can never roll the page back.
  const refreshSeq = useRef(0);

  const refresh = useCallback(
    async (quiet = true) => {
      const seq = ++refreshSeq.current;
      try {
        const fresh = await api.vault();
        if (seq !== refreshSeq.current) return;
        setData(fresh);
        setError(null);
      } catch (reason) {
        if (seq !== refreshSeq.current) return;
        if (reason instanceof ApiError && reason.status === 401) {
          onSignOut();
          return;
        }
        if (!quiet) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }
    },
    [onSignOut],
  );

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(true), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  function recordActivity(summary: string, txHash: string, status = "done") {
    void api
      .recordActivity({ kind: "owner", summary, txHash, status })
      .catch(() => undefined);
  }

  async function runErrand(errand: Errand) {
    setRunningErrand(errand.id);
    setOutcome(null);
    setError(null);
    try {
      const result: AgentRunResult = await api.runErrand(errand.id);
      const receipt = result.receipt;
      const tone =
        receipt?.status === "Settled"
          ? "green"
          : receipt?.status === "Queued"
            ? "amber"
            : "red";
      const headline =
        receipt?.status === "Settled"
          ? "Paid on its own"
          : receipt?.status === "Queued"
            ? "Queued for your approval"
            : receipt?.status === "Rejected"
              ? "Refused by your rules"
              : "Finished";
      setOutcome({
        title: errand.title,
        tone,
        headline,
        detail: receipt?.reason || "The network did not return a receipt.",
        status: receipt?.status,
        txHash: result.txHash,
        predicted: result.predicted
          ? `${result.predicted.would_be_status}: ${result.predicted.would_be_reason}`
          : null,
        logs: result.logs,
      });
      await refresh(true);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 422) {
        // A refusal is an outcome, not a malfunction. The rules said no and
        // the network recorded why.
        setOutcome({
          title: errand.title,
          tone: "red",
          headline: "Stopped before it could spend",
          detail: reason.message,
        });
        await refresh(true);
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setRunningErrand(null);
    }
  }

  async function decide(receiptId: number, approve: boolean) {
    const pending = vault.pending.find((entry) => entry.receipt_id === receiptId);
    setDeciding(receiptId);
    setError(null);
    setStepLine(null);
    try {
      const result = await signOwnerTransaction({
        vaultId: user.vaultId,
        publicKey: user.publicKey,
        calls: [
          {
            method: approve ? "approve_spend" : "refuse_spend",
            gas: approve ? GAS_WRITE : GAS_OWNER,
            args: { receipt_id: receiptId },
          },
        ],
        onStep: setStepLine,
      });
      recordActivity(
        approve
          ? `Approved receipt ${receiptId}${pending ? ` (${vendorName(pending.payee)}, ${usd(pending.amount, rate)})` : ""}`
          : `Refused receipt ${receiptId}${pending ? ` (${vendorName(pending.payee)}, ${usd(pending.amount, rate)})` : ""}`,
        result.hash,
      );
      await refresh(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDeciding(null);
      setStepLine(null);
    }
  }

  function onRulesSaved(result: BroadcastResult) {
    recordActivity("Updated the spending rules", result.hash);
    void refresh(true);
  }

  const label = user.name || user.email || user.vaultId;

  return (
    <>
      <TopBar
        label={label}
        active={screen}
        onNav={setScreen}
        onSignOut={onSignOut}
      />

      {screen === "home" && (
        <Home
          config={config}
          user={user}
          vault={vault}
          activity={activity}
          outcome={outcome}
          runningErrand={runningErrand}
          deciding={deciding}
          stepLine={stepLine}
          error={error}
          onRun={(errand) => void runErrand(errand)}
          onDecide={(id, approve) => void decide(id, approve)}
          onNav={setScreen}
        />
      )}

      {screen === "rules" && (
        <RulesPage
          config={config}
          user={user}
          vault={vault}
          onSaved={onRulesSaved}
          onNavHome={() => setScreen("home")}
        />
      )}

      {screen === "receipts" && (
        <ReceiptsPage
          config={config}
          vault={vault}
          activity={activity}
          onNavHome={() => setScreen("home")}
        />
      )}
    </>
  );
}
