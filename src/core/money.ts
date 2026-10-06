/** Milestone 5 contract (docs/dev/M5-DESIGN.md §0.2 rule 10): money shown to people. Browser-safe, no I/O. */
export function roundUsd(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : 0;
}
/** "$0", "less than $0.01", "$0.48", "$12.30", "$1,240". */
export function formatUsd(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "$0";
  if (v < 0.005) return "less than $0.01";
  if (v >= 1000) return `$${Math.round(v).toLocaleString("en-US")}`;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
/** "about $0.48"; "$0" and "less than $0.01" stay as they are. */
export function aboutUsd(v: number): string {
  const s = formatUsd(v);
  return s === "$0" || s.startsWith("less") ? s : `about ${s}`;
}
/** Per-draft cost on cards: "$0.006" (three decimals below one dollar). */
export function smallUsd(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "$0";
  return v < 1 ? `$${v.toFixed(3)}` : formatUsd(v);
}
