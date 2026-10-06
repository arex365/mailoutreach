import { formatShortDate, formatTime } from "@/core/time/format";
import { plural } from "@/core/text";

/**
 * Small sentences about a check run in progress (M5-DESIGN §6.1, §6.3), shared by the Verify step, the Contacts
 * dialog and the company panel. Times are written in the viewer's own time zone. Pure and browser-safe.
 */

const num = (v: number): string => Math.max(0, Math.floor(v)).toLocaleString("en-US");

function toDate(at: Date | string): Date {
  return typeof at === "string" ? new Date(at) : at;
}

/** "27 Sept at 14:05" in the viewer's zone (the year only when it isn't this year). */
export function dateAtTimeText(at: Date | string, timeZone: string, now: Date = new Date()): string {
  const d = toDate(at);
  return `${formatShortDate(d, timeZone, now)} at ${formatTime(d, timeZone)}`;
}

/** "14:05" when it is today in the viewer's zone, else "27 Sept at 14:05". */
export function whenText(at: Date | string, timeZone: string, now: Date = new Date()): string {
  const d = toDate(at);
  const sameDay = formatShortDate(d, timeZone, now) === formatShortDate(now, timeZone, now);
  return sameDay ? formatTime(d, timeZone) : dateAtTimeText(d, timeZone, now);
}

/** A deferred run (M5-DESIGN §6.1 "Waiting"): "Waiting: some checks will be tried again at 14:05." */
export function waitingText(waitingUntil: string, timeZone: string, now: Date = new Date()): string {
  return `Waiting: some checks will be tried again at ${whenText(waitingUntil, timeZone, now)}.`;
}

/**
 * What a queued run that waits says: the job's own "Paused: …" summary while checks are paused, otherwise when the
 * checks are tried again.
 */
export function deferredRunText(run: { waitingUntil: string; summary: string | null }, timeZone: string, now: Date = new Date()): string {
  const summary = run.summary?.trim() ?? "";
  if (summary.startsWith("Paused:")) return summary;
  return waitingText(run.waitingUntil, timeZone, now);
}

/** "12 of 40 checked", or "Starting the checks…" before the run has counted its addresses. */
export function runProgressText(done: number, total: number): string {
  return total > 0 ? `${num(Math.min(done, total))} of ${num(total)} checked` : "Starting the checks…";
}

/** The body of the "Stop checking?" dialog: who stays unchecked and what that means at launch. */
export function stopRunText(done: number, total: number): string {
  const left = Math.max(0, Math.floor(total) - Math.floor(done));
  if (total <= 0 || left === 0) {
    return "The addresses not checked yet stay unchecked, and those people are left out when you launch.";
  }
  return left === 1
    ? "The 1 address not checked yet stays unchecked, and that person is left out when you launch."
    : `The ${num(left)} addresses not checked yet stay unchecked, and those people are left out when you launch.`;
}

/** The Contacts dialog while a run goes on: "Checking 40 addresses: 12 done." */
export function dialogRunningText(count: number, done: number): string {
  return `Checking ${plural(count, "address", "addresses")}: ${num(Math.min(done, count))} done.`;
}

/** Where a paused-checks notice sends the Owner. */
export const CHECK_SETTINGS_HREF = "/settings/deliverability#checks";

/** The Member's line under a pause text (M5-DESIGN §6.1). */
export const MEMBER_PAUSE_NOTE = "The Owner can fix this in Settings.";

/** Said while checks are paused but no text was stored with the pause (the check services' own fallback). */
export const PAUSED_FALLBACK_TEXT = "Address checks are paused. Open Settings › Deliverability to see why.";
