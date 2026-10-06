import type { CatchUpState } from "@/core/system-state";
import { formatShortDate, formatTime } from "@/core/time/format";

/**
 * The "Check with Mailgun" status in words (M3-DESIGN §5.2, moved here unchanged by M6-DESIGN §7.9, plus the M6 old-
 * domain lines, L10): Settings › Sending & Mailgun and the dashboard say the same thing. Dates in the viewer's zone.
 * Pure and browser-safe.
 */

/** The catch-up's status line, whether it is failing, and Mailgun's error for "Details" (only while failing). */
export type CatchUpStatusLine = { line: string; failing: boolean; detail: string | null };

/**
 * The catch-up is failing: its last run ended with an error, and no run succeeded since (never succeeded, or the last
 * finished run is newer than the last success).
 */
export function catchUpFailing(state: CatchUpState): boolean {
  return (
    state.lastError !== null &&
    (state.lastSuccessAt === null ||
      (state.lastFinishedAt !== null && Date.parse(state.lastFinishedAt) > Date.parse(state.lastSuccessAt)))
  );
}

/**
 * "Last checked with Mailgun at 14:05: 3 updates, 1 new on the do-not-email list." (a time today, else "23 Sep 14:05");
 * while failing, "The app hasn't been able to check Mailgun since …"; before the first check, "Not checked with
 * Mailgun yet since the app started."
 */
export function catchUpStatusLine(state: CatchUpState, zone: string, now: Date): CatchUpStatusLine {
  const at = (d: string) =>
    formatShortDate(d, zone, now) === formatShortDate(now, zone, now)
      ? formatTime(d, zone)
      : `${formatShortDate(d, zone, now)} ${formatTime(d, zone)}`;
  const failing = catchUpFailing(state);
  let line: string;
  if (failing) {
    line = state.lastSuccessAt
      ? `The app hasn't been able to check Mailgun since ${at(state.lastSuccessAt)}. Bounces and unsubscribes may be late.`
      : "The app hasn't been able to check Mailgun yet. Bounces and unsubscribes may be late.";
  } else if (state.lastSuccessAt) {
    const s = state.lastSummary;
    const parts: string[] = [];
    if (s) {
      parts.push(`${s.eventsApplied} update${s.eventsApplied === 1 ? "" : "s"}`);
      if (s.suppressionsAdded) parts.push(`${s.suppressionsAdded} new on the do-not-email list`);
      if (s.inboundStored) parts.push(`${s.inboundStored} repl${s.inboundStored === 1 ? "y" : "ies"} stored`);
    }
    line = `Last checked with Mailgun at ${at(state.lastSuccessAt)}${parts.length ? `: ${parts.join(", ")}` : ""}.`;
  } else {
    line = "Not checked with Mailgun yet since the app started.";
  }
  return { line, failing, detail: failing ? state.lastError : null };
}

/**
 * M6 (L10): one line per older sending domain the catch-up couldn't check (`CatchUpState.oldDomains`), e.g. "Mailgun's
 * logs for the old domain mail.example.com haven't been checked since 25 Sep. Replies and bounces to its last emails
 * may be missed." Empty when there are none.
 */
export function oldDomainLines(state: CatchUpState, zone: string, now: Date): string[] {
  return (state.oldDomains ?? []).map(
    (p) =>
      `Mailgun's logs for the old domain ${p.domain} haven't been checked since ${formatShortDate(p.since, zone, now)}. Replies and bounces to its last emails may be missed.`,
  );
}
