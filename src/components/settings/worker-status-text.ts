import { formatDate, formatDateTime, formatShortDate, formatTime, timeAgo } from "@/core/time/format";

/** "just now", "10 seconds ago", then timeAgo()'s "5 minutes ago"… */
export function secondsAgoText(d: Date, now: Date): string {
  const sec = Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec} seconds ago`;
  return timeAgo(d, now);
}

export type WorkerStatusText = { running: boolean; text: string; hint: string | null };

/**
 * The background sender's status in plain words (PLAN.md A6 wording: "Background sender", never "worker").
 * Times are in the viewer's own time zone; the date is added when it wasn't today.
 */
export function workerStatusText(
  status: { running: boolean; lastSeen: Date | null },
  now: Date,
  timeZone: string,
): WorkerStatusText {
  if (status.running && status.lastSeen) {
    return { running: true, text: `Running, last check ${secondsAgoText(status.lastSeen, now)}`, hint: null };
  }
  const hint =
    "Double-click start.bat on the office PC. If the background services are installed, restarting the PC also starts it.";
  if (!status.lastSeen) {
    return { running: false, text: "Not running yet — double-click start.bat", hint };
  }
  const sameDay = formatDate(status.lastSeen, timeZone) === formatDate(now, timeZone);
  const when = sameDay ? formatTime(status.lastSeen, timeZone) : formatDateTime(status.lastSeen, timeZone);
  return { running: false, text: `Not running since ${when} — double-click start.bat`, hint };
}

/**
 * The dashboard's "background sender" problem (M6-DESIGN §4.2 item 2, PLAN A6 wording), or null while it runs:
 * "The background sender hasn't checked in since 14:02, so no emails are going out. Restart the PC or double-click
 * start.bat." The time is in the viewer's zone, with the short date in front when it wasn't today ("since 20 Sept,
 * 14:02"). Never seen: "The background sender isn't running, so no emails are going out. Double-click start.bat on
 * the office PC." (Settings › System keeps workerStatusText.)
 */
export function workerDownText(status: { running: boolean; lastSeen: Date | null }, now: Date, timeZone: string): string | null {
  if (status.running) return null;
  if (!status.lastSeen) {
    return "The background sender isn't running, so no emails are going out. Double-click start.bat on the office PC.";
  }
  const time = formatTime(status.lastSeen, timeZone);
  const sameDay = formatDate(status.lastSeen, timeZone) === formatDate(now, timeZone);
  const when = sameDay ? time : `${formatShortDate(status.lastSeen, timeZone, now)}, ${time}`;
  return `The background sender hasn't checked in since ${when}, so no emails are going out. Restart the PC or double-click start.bat.`;
}
