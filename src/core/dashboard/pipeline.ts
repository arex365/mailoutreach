/**
 * The dashboard's Companies tile in words (M6-DESIGN §4.3, §10.2 D8): the reply rate and its last-30-days line.
 * Reply rate = companies (not deleted) with `repliedAt` among the companies with `firstContactedAt` (the ones the
 * team emailed); "last 30 days" = the same, for companies first emailed in the last 30 days. Dry runs on real data
 * never set these fields, so they never count; the practice copy counts like live. Pure and browser-safe.
 */

export type ReplyRate = { replied: number; emailed: number; last30: { replied: number; emailed: number } };

const n = (v: number) => v.toLocaleString("en-US");

/**
 * A share as a percentage: a whole number from 10 % ("20%"), one decimal below ("4.5%", a whole value without the
 * ".0": "4%"), "0%" for none, "under 0.1%" for a part too small to show; null when `whole` is 0 (nothing to divide by).
 */
export function percentText(part: number, whole: number): string | null {
  if (!Number.isFinite(whole) || whole <= 0) return null;
  const p = Number.isFinite(part) ? Math.max(0, part) : 0;
  if (p === 0) return "0%";
  const percent = (p / whole) * 100;
  if (percent >= 10) return `${Math.round(percent)}%`;
  const oneDecimal = Math.round(percent * 10) / 10;
  if (oneDecimal >= 10) return "10%";
  if (oneDecimal === 0) return "under 0.1%";
  return `${Number.isInteger(oneDecimal) ? oneDecimal.toFixed(0) : oneDecimal.toFixed(1)}%`;
}

/**
 * "Reply rate: 20% (1 of 5 companies you emailed replied)", "(0 of 1 company you emailed replied)"; before any
 * company was emailed, "No companies emailed yet."
 */
export function replyRateText(r: ReplyRate): string {
  const pct = percentText(r.replied, r.emailed);
  if (pct === null) return "No companies emailed yet.";
  return `Reply rate: ${pct} (${n(r.replied)} of ${n(r.emailed)} ${r.emailed === 1 ? "company" : "companies"} you emailed replied)`;
}

/** "Last 30 days: 8% (5 of 60)", only when a company was first emailed in the last 30 days; else null. */
export function replyRate30Text(r: ReplyRate): string | null {
  const pct = percentText(r.last30.replied, r.last30.emailed);
  if (pct === null) return null;
  return `Last 30 days: ${pct} (${n(r.last30.replied)} of ${n(r.last30.emailed)})`;
}
