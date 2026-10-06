/**
 * Date formatting in the viewer's own time zone (SPEC: "Show times in each user's own time zone").
 * Pure Intl — safe in the browser and on the server. Pass the user's IANA zone.
 */

export function formatDate(d: Date | string | null | undefined, timeZone: string): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone }).format(date);
}

/** "12 Oct" (adds the year when it isn't the current year). */
export function formatShortDate(d: Date | string | null | undefined, timeZone: string, now = new Date()): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  const sameYear =
    new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone }).format(date) ===
    new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone }).format(now);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone,
  }).format(date);
}

export function formatDateTime(d: Date | string | null | undefined, timeZone: string): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(date);
}

export function formatTime(d: Date | string, timeZone: string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone }).format(date);
}

/** "just now", "5 minutes ago", "12 days ago", "3 months ago". */
export function timeAgo(d: Date | string | null | undefined, now = new Date()): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  const sec = Math.round((now.getTime() - date.getTime()) / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  if (day < 45) return `${day} day${day === 1 ? "" : "s"} ago`;
  const month = Math.round(day / 30);
  if (month < 12) return `${month} month${month === 1 ? "" : "s"} ago`;
  const year = Math.round(month / 12);
  return `${year} year${year === 1 ? "" : "s"} ago`;
}

/** Whole days between two instants (floor). */
export function daysBetween(a: Date, b: Date): number {
  return Math.floor(Math.abs(b.getTime() - a.getTime()) / 86_400_000);
}
