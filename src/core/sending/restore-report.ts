import type { RestoreState } from "@/core/system-state";
import { formatShortDate, formatTime } from "@/core/time/format";

/**
 * The restore report in words (M3-DESIGN §4.3.7, moved here unchanged by M6-DESIGN §7.9): what the pause card on
 * Settings › Sending & Mailgun says about a restore, and what Settings › Backups' "Last restore" card reuses. Dates in
 * the viewer's zone. Pure and browser-safe.
 */

/** The restore report's lines: the main sentence, whether sending after it is a risk, whether the check still runs. */
export type RestoreReportLines = {
  /** The main sentence; null when there is nothing to say (no restore, or no report yet). */
  text: string | null;
  /** The check failed, or finished without checking Mailgun: emails sent after the backup may go out a second time. */
  risk: boolean;
  /** The check with Mailgun is still running (pending or scanning). */
  running: boolean;
  /** Extra lines for "Details" (why the check failed; the backup is older than Mailgun's logs). */
  details: string[];
};

/** "23 Sep 14:05" (the year added when it isn't this year) in `zone`; "" for no date. */
export function shortDateTime(d: string | Date | null | undefined, zone: string, now: Date): string {
  if (!d) return "";
  return `${formatShortDate(d, zone, now)} ${formatTime(d, zone)}`;
}

/** What the restore check found (or is doing), from `STATE_KEYS.restore`. */
export function restoreReportLines(restore: RestoreState, zone: string, now: Date): RestoreReportLines {
  const running = restore.status === "pending" || restore.status === "scanning";
  const risk = restore.status === "failed" || (restore.status === "done" && restore.report?.mailgunChecked === false);
  if (running) {
    return {
      text: "Checking Mailgun for emails sent after the backup. This finishes about 35 minutes after the restore.",
      risk,
      running,
      details: [],
    };
  }
  const r = restore.report;
  const why = r?.error ? [`Why: ${r.error}`] : [];
  const older = r?.olderThanRetention ? ["The backup is older than Mailgun keeps its logs, so some sends couldn't be checked."] : [];
  const counts = (report: NonNullable<typeof r>) => {
    const confirmed = report.matchedByMessageId + report.matchedBySendId + report.matchedByRecipient;
    const found = report.rowsCreated + report.externalSends;
    return `${confirmed} confirmed as sent, ${found} found that the backup didn't know about, ${report.madeUnconfirmed} marked 'Not sure it was sent'`;
  };
  const span = (report: NonNullable<typeof r>) =>
    `${report.windowFrom ? shortDateTime(report.windowFrom, zone, now) : "the backup"} → ${report.windowTo ? shortDateTime(report.windowTo, zone, now) : "now"}`;
  if (risk) {
    // The walk ran but couldn't cover every sending domain (the replaced database's couldn't be read, review
    // BACKUPS-7): say what it found, and that it isn't complete.
    if (restore.status === "done" && r?.windowFrom) {
      return {
        text: `Checked Mailgun for sends after the backup (${span(r)}), but not through every sending domain: ${counts(r)}.`,
        risk,
        running,
        details: [...why, ...older],
      };
    }
    return { text: "The app couldn't check Mailgun for emails sent after the backup.", risk, running, details: why };
  }
  if (restore.status === "done" && r) {
    return {
      text: `Checked Mailgun for sends after the backup (${span(r)}): ${counts(r)}.`,
      risk,
      running,
      details: older,
    };
  }
  return { text: null, risk, running, details: [] };
}
