// Read-only showcase logic. Every number is fetched from NEAR testnet view
// calls. This page never signs, broadcasts, or writes. The markup it fills
// uses the same classes as the signed-in app, so the hosted page and the
// local app read as one product.

const RPCS = [
  "https://test.rpc.fastnear.com",
  "https://near-testnet.drpc.org",
  "https://archival-rpc.testnet.near.org",
];
const VAULT_ID = "vault2.vaults.eqxdemi.testnet";
const RATE = 5; // fixed demo dollars per NEAR, matching the app config
const YOCTO = 10n ** 24n;
const RATE_BASIS = BigInt(Math.round(RATE * 100));
const NS_PER_DAY = 86_400_000_000_000;
const REFRESH_MS = 30_000;
const PAGE_SIZE = 10;
const OTHER = "__other";

// Same words and tones as the app's ReceiptChip.
const STATUS = {
  Settled: { label: "paid on its own", tone: "c-leaf", mini: "paid" },
  Queued: { label: "waiting for you", tone: "c-butter", mini: "waiting" },
  OwnerApproved: { label: "you approved", tone: "c-pool", mini: "approved" },
  OwnerRefused: { label: "you refused", tone: "", mini: "refused" },
  Rejected: { label: "refused by rules", tone: "c-tomato", mini: "refused" },
  TransferFailed: { label: "payment failed", tone: "c-tomato", mini: "failed" },
};

const $ = (id) => document.getElementById(id);

function setText(id, text) {
  const node = $(id);
  if (node) node.textContent = text;
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function describe(error) {
  if (error instanceof Error) return error.message;
  try {
    return typeof error === "string" ? error : JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// ---------------------------------------------------------------------
// Chain reads
// ---------------------------------------------------------------------

async function rpc(method, params, timeoutMs = 15_000) {
  let lastError = "";
  for (const url of RPCS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) {
        lastError = `${url} returned HTTP ${response.status}`;
        continue;
      }
      const json = await response.json();
      if (json.error) {
        lastError = json.error.message || JSON.stringify(json.error);
        continue;
      }
      if (json.result === undefined) {
        lastError = `${url} returned no result`;
        continue;
      }
      return json.result;
    } catch (error) {
      lastError = `${url}: ${describe(error)}`;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError || "The testnet RPC did not answer.");
}

function argsBase64(args) {
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeResult(result) {
  const bytes = Uint8Array.from(result.result || [], (value) => value);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function callView(methodName, args = {}) {
  return rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: VAULT_ID,
    method_name: methodName,
    args_base64: argsBase64(args),
  }).then(decodeResult);
}

function viewAccount(accountId) {
  return rpc("query", {
    request_type: "view_account",
    finality: "final",
    account_id: accountId,
  });
}

async function storagePerByte() {
  const config = await rpc("EXPERIMENTAL_protocol_config", { finality: "final" });
  const perByte = config?.runtime_config?.storage_amount_per_byte;
  if (perByte === undefined || perByte === null) {
    throw new Error("the storage price was unreadable");
  }
  return BigInt(perByte);
}

async function loadVault() {
  const [account, perByte, status, rules, receipts, pending] = await Promise.all([
    viewAccount(VAULT_ID),
    storagePerByte().catch(() => null),
    callView("get_status"),
    callView("get_rules"),
    callView("get_receipts", { limit: 50 }),
    callView("get_pending"),
  ]);

  const balance = BigInt(account.amount || "0");
  let reserve = null;
  let spendable = null;
  if (perByte !== null) {
    reserve = BigInt(account.storage_usage || 0) * perByte;
    spendable = balance > reserve ? balance - reserve : 0n;
  }

  return {
    account,
    balance,
    reserve,
    spendable,
    status,
    rules,
    receipts: Array.isArray(receipts) ? receipts : [],
    pending: Array.isArray(pending) ? pending : [],
  };
}

// ---------------------------------------------------------------------
// Money and time
// ---------------------------------------------------------------------

function usdText(yocto) {
  const value = BigInt(yocto || "0");
  const cents = (value * RATE_BASIS + YOCTO / 2n) / YOCTO;
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, "0");
  return `$${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}

function yoctoToCents(yocto) {
  return (BigInt(yocto || "0") * RATE_BASIS + YOCTO / 2n) / YOCTO;
}

function centsToYocto(cents) {
  return (cents * YOCTO) / RATE_BASIS;
}

function centsToInput(cents) {
  return `${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function parseUsdToCents(text) {
  const clean = String(text || "").replace(/[$,\s]/g, "");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(clean)) return null;
  const [whole, fraction = ""] = clean.split(".");
  const cents = BigInt(whole + fraction.padEnd(2, "0").slice(0, 2));
  return cents > 0n ? cents : null;
}

function nearText(yocto, decimals = 4) {
  const value = BigInt(yocto || "0");
  const padded = value.toString().padStart(25, "0");
  const whole = padded.slice(0, -24).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(-24).slice(0, decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function periodWord(periodNs) {
  const ns = BigInt(periodNs || 0);
  if (ns <= 1n) return "right now";
  const days = Math.round(Number(ns) / Number(NS_PER_DAY));
  if (days <= 1) return "today";
  if (days === 7) return "this week";
  if (days <= 31) return "this month";
  return `in ${days} days`;
}

function toMs(ns) {
  const value = Number(BigInt(ns || 0));
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value / 1_000_000);
}

function timeOf(ns) {
  const ms = toMs(ns);
  if (ms === null) return "";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function relativeNs(ns) {
  const ms = toMs(ns);
  if (ms === null) return "";
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 90) return "a minute ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// Same day grouping as the app's receipts page.
function dayLabel(timestampNs) {
  const ms = toMs(timestampNs);
  if (ms === null) return "Earlier";
  const date = new Date(ms);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfThatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayMs = 86_400_000;
  if (startOfThatDay === startOfToday) return "Today";
  if (startOfThatDay === startOfToday - dayMs) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function groupOf(status) {
  if (status === "Settled" || status === "OwnerApproved") return "paid";
  if (status === "Queued") return "waiting";
  return "refused";
}

function shortId(id, size = 10) {
  if (!id) return "none";
  return id.length <= size + 4 ? id : `${id.slice(0, size)}…${id.slice(-4)}`;
}

function refusalLabel(reason) {
  const text = reason || "";
  if (/per-spend cap/i.test(text)) return "refused: over cap";
  if (/allowlist/i.test(text)) return "refused: seller";
  if (/budget/i.test(text)) return "refused: budget";
  if (/expired/i.test(text)) return "refused: expired";
  if (/spendable NEAR/i.test(text)) return "refused: balance";
  return "refused by rules";
}

function chipLabel(receipt) {
  if (receipt.status === "Rejected") return refusalLabel(receipt.reason);
  return (STATUS[receipt.status] || { label: receipt.status }).label;
}

function chipTone(receipt) {
  return (STATUS[receipt.status] || { tone: "" }).tone;
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------

let vaultData = null;
let rulesKey = "";
let stampText = "";
let filter = "all";
let visible = PAGE_SIZE;

function render() {
  const data = vaultData;
  if (!data) return;
  const { status, rules, receipts, pending, account } = data;

  setText("stamp", `read at ${stampText}`);
  setText("heroStamp", `live from ${VAULT_ID} · read at ${stampText}`);

  if (data.spendable !== null) {
    setText("available", usdText(data.spendable));
    setText("availableNear", nearText(data.spendable, 24));
    setText(
      "totalNote",
      `The vault holds ${usdText(data.balance)} in total. Another ${usdText(
        data.reserve,
      )} of it is locked by the network as storage for the receipts. Still the owner's money, just not spendable.`,
    );
  } else {
    setText("available", "—");
    setText("availableNear", "—");
    setText("totalNote", "The storage reserve was unreadable, so the spendable share is unknown.");
  }

  const spent = BigInt(status.spent_this_period || "0");
  const budget = BigInt(rules.budget_per_period || "0");
  const remaining = BigInt(status.budget_remaining || "0");
  const share = budget > 0n ? Number((spent * 1000n) / budget) / 10 : 0;
  setText("budgetLabel", `budget left ${periodWord(rules.period_ns)}`);
  setText("budgetLeft", usdText(remaining));
  setText("budgetSub", `Spent ${usdText(spent)} of ${usdText(budget)}.`);
  const fill = $("budgetFill");
  fill.style.width = `${Math.min(100, share)}%`;
  fill.className = `fill ${share >= 80 ? "m-tomato" : share >= 50 ? "m-butter" : "m-leaf"}`;
  $("budgetMeter").setAttribute("aria-label", `${share.toFixed(1)}% of the budget spent`);
  if (status.next_period_reset_ns > 0 && rules.period_ns > 1) {
    setText("budgetSub", `Spent ${usdText(spent)} of ${usdText(budget)}. Resets ${timeOf(status.next_period_reset_ns)}.`);
  }
  $("lowLine").hidden = share < 80;

  const payees = rules.payees || [];
  $("heroChips").replaceChildren(
    make("span", "chip", `cap per purchase ${usdText(rules.cap_per_spend)}`),
    make("span", "chip", `auto-approve ${usdText(rules.auto_limit)}`),
    make(
      "span",
      "chip",
      payees.length ? `${payees.length} trusted seller${payees.length === 1 ? "" : "s"}` : "no sellers yet",
    ),
  );

  $("miniReceipts").replaceChildren(
    ...(receipts.slice(0, 3).length
      ? receipts.slice(0, 3).map((receipt) => {
          const row = make("div", "mline");
          row.append(
            make("span", "mname", receipt.purpose),
            make("span", "mamt", usdText(receipt.amount)),
            make(
              "span",
              `rchip ${chipTone(receipt)}`.trim(),
              receipt.status === "Rejected"
                ? "refused"
                : (STATUS[receipt.status] || { mini: receipt.status }).mini,
            ),
          );
          row.title = `${receipt.payee}: ${chipLabel(receipt)}`;
          return row;
        })
      : [make("div", "mline", "")]),
  );

  // Pending approvals: visible, but only the owner can decide, locally.
  const pendingCard = $("pendingCard");
  pendingCard.hidden = pending.length === 0;
  if (pending.length) {
    setText(
      "pendingTitle",
      `${pending.length} purchase${pending.length === 1 ? "" : "s"} waiting for the owner`,
    );
    $("pendingList").replaceChildren(
      ...pending.map((item) => {
        const wrap = make("div", "pitem");
        const left = make("div");
        const line = make("div", "jobline");
        line.append(
          document.createTextNode(`${item.payee} wants `),
          make("span", "amt", usdText(item.amount)),
          make("span", "mono", ` (${nearText(item.amount, 24)} NEAR)`),
        );
        const note = make("p", "note");
        note.textContent =
          "Money only moves if the owner approves it from the local app. This page can only watch.";
        left.append(line, note);
        wrap.append(left);
        return wrap;
      }),
    );
  }

  renderReceipts(receipts);

  setText("codeHash", account.code_hash || "—");
  setText(
    "storage",
    account.storage_usage !== undefined
      ? `${(Number(account.storage_usage) / 1024).toFixed(1)} KB`
      : "—",
  );
  setText("pending", String(pending.length));
  setText("sumPayees", payees.length ? payees.join(", ") : "nobody yet");
  setText("sumAgent", status.agent ? shortId(status.agent) : "none");

  setText("plAuto", usdText(rules.auto_limit));
  setText("plAuto2", usdText(rules.auto_limit));
  setText("plCap", usdText(rules.cap_per_spend));
  setText("plCap2", usdText(rules.cap_per_spend));
}

function renderReceipts(receipts) {
  const counts = { all: receipts.length, paid: 0, waiting: 0, refused: 0 };
  for (const receipt of receipts) counts[groupOf(receipt.status)] += 1;

  const filtersEl = $("filters");
  const wanted = [
    ["all", "All"],
    ["paid", "Paid"],
    ["waiting", "Waiting"],
    ["refused", "Refused"],
  ];
  filtersEl.replaceChildren(
    ...wanted.map(([value, label]) => {
      const button = make("button", `fchip ${filter === value ? "on" : ""}`);
      button.type = "button";
      button.setAttribute("aria-pressed", String(filter === value));
      button.append(document.createTextNode(`${label} `), make("b", null, String(counts[value])));
      button.addEventListener("click", () => {
        filter = value;
        visible = PAGE_SIZE;
        renderReceipts(vaultData ? vaultData.receipts : []);
      });
      return button;
    }),
  );

  setText(
    "receiptCount",
    receipts.length ? `${counts.all} on record · ${counts.refused} refused by the rules` : "",
  );

  const list = $("receiptList");
  if (receipts.length === 0) {
    list.replaceChildren(
      make("p", "note", "No receipts yet. Every decision the contract makes appears here."),
    );
    $("moreWrap").hidden = true;
    return;
  }

  const filtered = receipts.filter(
    (receipt) => filter === "all" || groupOf(receipt.status) === filter,
  );
  if (filtered.length === 0) {
    list.replaceChildren(
      make(
        "p",
        "note",
        filter === "waiting"
          ? "Nothing is waiting. The agent has no open asks."
          : `No ${filter} receipts in this account.`,
      ),
    );
    $("moreWrap").hidden = true;
    return;
  }

  const shown = filtered.slice(0, visible);
  const groups = new Map();
  for (const receipt of shown) {
    const label = dayLabel(receipt.timestamp_ns);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(receipt);
  }

  const nodes = [];
  for (const [label, list_] of groups) {
    nodes.push(make("h3", "ghead", label));
    for (const receipt of list_) nodes.push(receiptRow(receipt));
  }
  list.replaceChildren(...nodes);

  $("moreWrap").hidden = filtered.length <= visible;
}

function receiptRow(receipt) {
  const row = make("article", "bigrow");
  row.append(make("span", "rid", `#${receipt.id}`));

  const main = make("div", "rmain");
  main.append(make("b", null, receipt.purpose), make("span", null, receipt.payee));
  main.title = `${receipt.payee}: ${receipt.purpose}`;
  row.append(main);

  const num = make("div", "rnum");
  num.append(
    make("b", null, usdText(receipt.amount)),
    make("span", "mono", `${nearText(receipt.amount, 6)} NEAR`),
  );
  row.append(num);

  const chip = make("span", `rchip ${chipTone(receipt)}`.trim(), chipLabel(receipt));
  chip.title = receipt.reason || "";
  row.append(chip);

  const meta = make("div", "rmeta", relativeNs(receipt.timestamp_ns));
  meta.title = timeOf(receipt.timestamp_ns);
  row.append(meta);
  return row;
}

// ---------------------------------------------------------------------
// Simulator controls
// ---------------------------------------------------------------------

const payeeChips = $("payeeChips");
let currentPayee = "";
const otherWrap = $("otherWrap");
const otherPayee = $("otherPayee");
const amountEl = $("amount");
const purposeEl = $("purpose");
const presetsEl = $("presets");
const simForm = $("simForm");
const simBtn = $("simBtn");
const simBusy = $("simBusy");
const simError = $("simError");
const resultEl = $("result");
const verdictEl = $("verdict");
const verdictSub = $("verdictSub");
const verdictNote = $("verdictNote");
const simNote = $("simNote");
const resultMeta = $("resultMeta");

function toggleOther() {
  otherWrap.hidden = currentPayee !== OTHER;
}

// The app has no native dropdowns in its own flows: choices are pill groups.
// The payee picker follows that, as a radio group of fchips.
function syncPayees(rules) {
  const approved = rules.payees || [];
  if (!currentPayee || (!approved.includes(currentPayee) && currentPayee !== OTHER)) {
    currentPayee = approved[0] || OTHER;
  }
  const choices = [...approved, OTHER];
  payeeChips.replaceChildren(
    ...choices.map((value) => {
      const selected = value === currentPayee;
      const button = make(
        "button",
        `fchip ${selected ? "on" : ""}`,
        value === OTHER ? "A seller not on the list" : value,
      );
      button.type = "button";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(selected));
      button.addEventListener("click", () => {
        currentPayee = value;
        toggleOther();
        syncPayees(rules);
      });
      return button;
    }),
  );
  toggleOther();
}

function syncPresets(rules) {
  const autoCents = yoctoToCents(rules.auto_limit);
  const capCents = yoctoToCents(rules.cap_per_spend);
  const presets = [["small", autoCents > 2n ? autoCents / 2n : 10n]];
  if (capCents > autoCents) presets.push(["above auto", autoCents + 50n]);
  if (capCents > 0n) presets.push(["over cap", capCents + 100n]);

  presetsEl.replaceChildren(
    ...presets.map(([label, cents]) => {
      const button = make("button", "chip", `${label}: $${centsToInput(cents)}`);
      button.type = "button";
      button.addEventListener("click", () => {
        amountEl.value = centsToInput(cents);
        amountEl.focus();
      });
      return button;
    }),
  );
}

function maybeSyncRules(rules) {
  const key = JSON.stringify(rules);
  if (key === rulesKey) return;
  rulesKey = key;
  syncPayees(rules);
  syncPresets(rules);
}

function showFormError(message) {
  simError.textContent = message;
  simError.hidden = false;
}

function renderSimulation(sim, payee, yocto) {
  const status = sim.would_be_status;
  const map = {
    Settled: {
      tone: "outcome-green",
      verdict: "It would pay itself.",
      sub: "Inside every rule. The vault would send the money without asking the owner.",
    },
    Queued: {
      tone: "outcome-amber",
      verdict: "It would wait for the owner.",
      sub: "Above the auto-approve limit, below the cap. The owner decides.",
    },
    Rejected: {
      tone: "outcome-red",
      verdict: "It would refuse.",
      sub: "No money would move.",
    },
  };
  const meta = map[status] || { tone: "", verdict: status, sub: "" };

  resultEl.className = `card pop ${meta.tone}`.trim();
  verdictEl.textContent = meta.verdict;
  verdictSub.textContent = meta.sub;
  verdictNote.textContent = sim.would_be_reason || "";
  simNote.textContent = sim.note || "";
  simNote.hidden = !sim.note;
  $("simPayee").textContent = payee;
  $("simAmount").textContent = `${usdText(yocto)} · ${nearText(yocto, 6)} NEAR`;
  resultMeta.hidden = false;
}

simForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  simError.hidden = true;

  const payee = currentPayee === OTHER ? otherPayee.value.trim() : currentPayee;
  const cents = parseUsdToCents(amountEl.value);
  const purpose = purposeEl.value.trim();

  if (!payee || !/^[a-z0-9._-]{2,64}$/.test(payee)) {
    showFormError("Enter a valid NEAR account, such as data.eqxdemi.testnet.");
    return;
  }
  if (cents === null) {
    showFormError("Enter an amount like 0.10, 1, or 25.50.");
    return;
  }
  const purposeBytes = new TextEncoder().encode(purpose).length;
  if (purposeBytes < 1 || purposeBytes > 280) {
    showFormError("Enter a purpose between 1 and 280 characters.");
    return;
  }

  simBtn.disabled = true;
  simBusy.hidden = false;
  resultEl.className = "card pop";
  verdictEl.textContent = "Checking…";
  verdictSub.textContent = "This is a view call. Nothing is sent.";
  verdictNote.textContent = "";
  simNote.hidden = true;
  resultMeta.hidden = true;

  try {
    const yocto = centsToYocto(cents);
    const simulation = await callView("simulate_spend", {
      payee,
      amount: yocto.toString(),
      purpose,
    });
    renderSimulation(simulation, payee, yocto);
  } catch (error) {
    resultEl.className = "card pop outcome outcome-red";
    verdictEl.textContent = "The check did not run.";
    verdictSub.textContent = describe(error);
    verdictNote.textContent =
      "Nothing was sent. The network refused the view call itself, so this is not a policy answer.";
    simNote.hidden = true;
    resultMeta.hidden = true;
  } finally {
    simBtn.disabled = false;
    simBusy.hidden = true;
  }
});

$("moreBtn").addEventListener("click", () => {
  visible += PAGE_SIZE;
  renderReceipts(vaultData ? vaultData.receipts : []);
});

$("refresh").addEventListener("click", () => void refresh(true));

$("copyBtn").addEventListener("click", async () => {
  const button = $("copyBtn");
  const text = $("commands").textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Press Ctrl+C";
  }
  setTimeout(() => {
    button.textContent = "Copy";
  }, 1800);
});

// ---------------------------------------------------------------------
// Load and refresh
// ---------------------------------------------------------------------

async function refresh(manual = false) {
  const button = $("refresh");
  if (manual) button.disabled = true;
  try {
    vaultData = await loadVault();
    stampText = new Date().toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    $("loadError").hidden = true;
    render();
    maybeSyncRules(vaultData.rules);
  } catch (error) {
    const message = describe(error);
    $("loadError").hidden = false;
    setText(
      "loadTitle",
      vaultData ? "Showing the last good read" : "The page could not reach the network",
    );
    setText(
      "loadMsg",
      vaultData
        ? `${message} The numbers below are from the last successful read.`
        : message,
    );
    if (vaultData) setText("stamp", `last read ${stampText} · refresh failed`);
  } finally {
    if (manual) button.disabled = false;
  }
}

void refresh();
setInterval(() => {
  if (!document.hidden) void refresh();
}, REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
});
