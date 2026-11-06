// Test dollars are a fixed conversion of NEAR so the numbers read like money.
// Every amount is carried as exact yoctoNEAR in a BigInt; dollars are only
// ever a display layer or a user input that converts straight back to yocto.

const YOCTO = 10n ** 24n;

function rateBasis(rate: number): bigint {
  return BigInt(Math.round(rate * 100));
}

export function toYocto(value: bigint | string): bigint {
  return typeof value === "bigint" ? value : BigInt(value || "0");
}

export function yoctoToCents(yocto: bigint | string, rate: number): bigint {
  const value = toYocto(yocto);
  const basis = rateBasis(rate);
  return (value * basis + YOCTO / 2n) / YOCTO;
}

export function centsToYocto(cents: bigint, rate: number): bigint {
  const basis = rateBasis(rate);
  return (cents * YOCTO) / basis;
}

export function centsToText(cents: bigint): string {
  const negative = cents < 0n;
  const whole = (negative ? -cents : cents) / 100n;
  const fraction = ((negative ? -cents : cents) % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}

export function usd(yocto: bigint | string, rate: number): string {
  return centsToText(yoctoToCents(yocto, rate));
}

export function near(yocto: bigint | string, decimals = 4): string {
  const value = toYocto(yocto);
  const padded = value.toString().padStart(25, "0");
  const whole = padded.slice(0, -24).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(-24).slice(0, decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function parseUsdToCents(text: string): bigint | null {
  const clean = text.replace(/[$,\s]/g, "");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(clean)) return null;
  const [whole, fraction = ""] = clean.split(".");
  return BigInt(whole + fraction.padEnd(2, "0").slice(0, 2));
}

export function centsToUsdInput(cents: bigint): string {
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}

export function yoctoToUsdInput(yocto: bigint | string, rate: number): string {
  return centsToUsdInput(yoctoToCents(yocto, rate));
}

const NS_PER_DAY = 86_400_000_000_000;

export function periodLabel(periodNs: number): string {
  if (!periodNs || periodNs <= 1) return "no period set";
  const days = Math.round(periodNs / NS_PER_DAY);
  if (days <= 1) return "per day";
  if (days < 7) return `per ${days} days`;
  if (days === 7) return "per week";
  if (days < 30) return `per ${days} days`;
  if (days <= 31) return "per month";
  return `per ${days} days`;
}

export function periodWord(periodNs: number): string {
  if (!periodNs || periodNs <= 1) return "right now";
  const days = Math.round(periodNs / NS_PER_DAY);
  if (days <= 1) return "today";
  if (days === 7) return "this week";
  if (days <= 31) return "this month";
  return `in ${days} days`;
}

export function daysToPeriodNs(days: number): number {
  return days * NS_PER_DAY;
}

export function periodNsToDays(periodNs: number): number {
  if (!periodNs) return 7;
  return Math.max(1, Math.round(periodNs / NS_PER_DAY));
}

export function timeOf(timestampNs: number): string {
  const ms = Math.floor(timestampNs / 1_000_000);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 90) return "a minute ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

export function relativeNs(timestampNs: number): string {
  const ms = Math.floor(timestampNs / 1_000_000);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return relativeTime(new Date(ms).toISOString());
}

export function shortId(id: string, size = 6): string {
  if (!id) return "";
  return id.length <= size + 4 ? id : `${id.slice(0, size)}…${id.slice(-4)}`;
}
