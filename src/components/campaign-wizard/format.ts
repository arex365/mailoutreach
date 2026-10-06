import { plural } from "@/core/text";

/**
 * Wording for the campaign wizard (plain, sentence case, from the user's point of view).
 * Pure and browser-safe; unit-tested in tests/unit/campaign-wizard.
 */

export type AudienceTotalsLike = {
  /** People who will get the email (ticked and allowed). */
  people: number;
  /** Companies with at least one of them. */
  companies: number;
  /** Companies in the "Excluded" section (nobody there can be emailed). */
  excludedCompanies: number;
};

/** "148 people at 131 companies will get the email · 17 excluded". */
export function audienceSummary(t: AudienceTotalsLike): string {
  const main =
    t.people === 0
      ? "Nobody will get the email yet"
      : `${plural(t.people, "person", "people")} at ${plural(t.companies, "company", "companies")} will get the email`;
  return t.excludedCompanies > 0 ? `${main} · ${t.excludedCompanies.toLocaleString("en-US")} excluded` : main;
}

export type AddedLike = {
  added: number;
  alreadyIn: number;
  notFound: number;
  capped: number;
  ticked: number;
};

/** "Added 37 companies (41 people ticked). 5 were already in this campaign." */
export function addedMessage(r: AddedLike, max = 10_000): string {
  const parts: string[] = [];
  if (r.added > 0) {
    parts.push(
      `Added ${plural(r.added, "company", "companies")} (${plural(r.ticked, "person", "people")} ticked).`,
    );
  } else {
    parts.push("No companies were added.");
  }
  if (r.alreadyIn > 0) parts.push(`${plural(r.alreadyIn, "company was", "companies were")} already in this campaign.`);
  if (r.notFound > 0) parts.push(`${plural(r.notFound, "company was", "companies were")} skipped because ${r.notFound === 1 ? "it has" : "they have"} been deleted.`);
  if (r.capped > 0) {
    parts.push(
      `${plural(r.capped, "company was", "companies were")} left out: a campaign can have up to ${max.toLocaleString("en-US")} companies.`,
    );
  }
  return parts.join(" ");
}

/** "Anna Berg", or "General inbox" for a role address, or the address when there's no name. */
export function personDisplayName(p: { name: string | null | undefined; isGeneric?: boolean; email?: string | null }): string {
  if (p.isGeneric) return "General inbox";
  const name = (p.name ?? "").trim();
  return name || p.email || "No name";
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export type LocalDateTimeParts = { year: number; month: number; day: number; hour: number; minute: number };

/** Parses the value of an <input type="datetime-local"> ("2026-09-24T10:00"); null when it isn't one. */
export function parseLocalDateTime(value: string | null | undefined): LocalDateTimeParts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,3})?)?$/.exec((value ?? "").trim());
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1, 6).map(Number) as [number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day, hour, minute };
}

/** "Thursday 24 September 2026 at 10:00" (the wall-clock time as typed; no zone maths). */
export function localDateTimeWords(value: string | null | undefined): string | null {
  const p = parseLocalDateTime(value);
  if (!p) return null;
  const weekday = WEEKDAYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()];
  const time = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  return `${weekday} ${p.day} ${MONTHS[p.month - 1]} ${p.year} at ${time}`;
}

/** The value for an <input type="datetime-local"> showing `date` as wall-clock time in `timeZone`. */
export function toLocalInputValue(date: Date | string | null | undefined, timeZone: string): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "";
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(d);
  } catch {
    return "";
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}`;
}

/** "in 5 minutes", "in 3 hours", "in 2 days" (for a start time ahead). */
export function timeUntil(target: Date, now = new Date()): string {
  const min = Math.round((target.getTime() - now.getTime()) / 60_000);
  if (min <= 0) return "now";
  if (min < 60) return `in ${plural(min, "minute", "minutes")}`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `in ${plural(hours, "hour", "hours")}`;
  return `in ${plural(Math.round(hours / 24), "day", "days")}`;
}

/** Problems in one step's text (unknown variables, broken braces), as the server counts them. */
export type StepTextProblemLike = { step: number; unknown: readonly string[]; syntax: boolean };

/** "a", "a and b", "a, b and c". */
function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * One sentence per step with text problems, e.g. "Follow-up 2 uses {{frist_name}}, which isn't a
 * variable we know." or "The first email has { } braces that don't match."
 */
export function textProblemSentence(p: StepTextProblemLike): string {
  const who = p.step <= 0 ? "The first email" : `Follow-up ${p.step}`;
  const names = p.unknown.map((n) => `{{${n}}}`);
  const unknown = names.length === 0 ? "" : `uses ${listWords(names)}, which ${names.length === 1 ? "isn't a variable" : "aren't variables"} we know`;
  const braces = "has { } braces that don't match";
  if (unknown && p.syntax) return `${who} ${unknown}, and ${braces}.`;
  return `${who} ${unknown || braces}.`;
}

/** "3 emails edited for single people have variables we don't know or braces that don't match." (null for none). */
export function editedTextProblemSentence(n: number): string | null {
  if (n <= 0) return null;
  return n === 1
    ? "1 email edited for one person has a variable we don't know or braces that don't match."
    : `${n.toLocaleString("en-US")} emails edited for single people have variables we don't know or braces that don't match.`;
}

export type LaunchSummaryLike = {
  mode: "DRY_RUN" | "TEST" | "LIVE";
  people: number;
  followUps: number;
  missingEmails: number;
  /** Problems in the campaign's text, per step (optional: none when left out). */
  textProblems?: readonly StepTextProblemLike[];
  /** Emails edited for single people whose own text has problems. */
  editedTextProblems?: number;
};

/**
 * What happens to the switched-on follow-ups (M4-DESIGN §9.4): "Its follow-up goes out in the same email thread after
 * its wait, unless someone at the company replies." Null without follow-ups.
 */
export function followUpsSentence(followUps: number): string | null {
  if (followUps <= 0) return null;
  if (followUps === 1) return "Its follow-up goes out in the same email thread after its wait, unless someone at the company replies.";
  return `Its ${followUps} follow-ups go out in the same email thread, each after its wait, unless someone at the company replies.`;
}

/**
 * The dry-run helper "Treat follow-up days as minutes" explained (M4-DESIGN §9.4). It only shortens the waits: with
 * "Ignore sending hours" off, each email still waits for the recipient's sending hours and is spaced out, so the
 * hint names both switches (M4 review SPEC-01).
 */
export const DAYS_AS_MINUTES_HINT =
  "“3 days after” becomes 3 minutes after. Switch on Ignore sending hours too, so you can watch a whole sequence in minutes.";

/** The "Ignore sending hours" switch's explanation, on and off (M3-DESIGN §5.8). */
export function ignoreWindowText(on: boolean): string {
  return on
    ? "Sends as fast as possible, day or night, ignoring sending hours and gaps."
    : "Waits for each recipient's sending hours and takes turns with real emails, so you see when each email would really go out.";
}

/**
 * Today's limit and how much of this campaign fits in it (M3-DESIGN §5.8): "Today's limit is 50;
 * 12 are already used. About 38 of these 120 emails can go out today; the rest follow on the next
 * sending days." Null when no limit applies (dry runs on real data, test mode).
 */
export function limitSentence(s: {
  people: number;
  today: { cap: number; used: number; left: number } | null;
  fits: { today: number; later: number } | null;
}): string | null {
  if (!s.today || !s.fits || s.people <= 0) return null;
  const cap = s.today.cap.toLocaleString("en-US");
  if (s.today.left <= 0) return `Today's limit of ${cap} is used up, so these emails start on the next sending day.`;
  const used =
    s.today.used <= 0 ? "none has been used yet" : s.today.used === 1 ? "1 is already used" : `${s.today.used.toLocaleString("en-US")} are already used`;
  if (s.fits.later <= 0) {
    const all =
      s.people === 1 ? "This email fits" : s.people === 2 ? "Both emails fit" : `All ${s.people.toLocaleString("en-US")} emails fit`;
    return `Today's limit is ${cap}; ${used}. ${all} in today's limit.`;
  }
  return `Today's limit is ${cap}; ${used}. About ${s.fits.today.toLocaleString("en-US")} of these ${s.people.toLocaleString("en-US")} emails can go out today; the rest follow on the next sending days.`;
}

/**
 * What the campaign's mode means, for the Schedule step's summary. Live changes with go-live (M6-DESIGN §2.7): before
 * it only the test list gets real email; after it everyone in the campaign does. Test mode only ever emails the test
 * list (G3), before and after go-live.
 */
export function modeLine(s: { mode: "DRY_RUN" | "TEST" | "LIVE"; practiceCopy: boolean; goLive?: boolean }): string {
  if (s.mode === "TEST") {
    return "It's in Mailgun's test mode: emails to your test list are accepted by Mailgun but never delivered, and company statuses and the 30-day rule don't change.";
  }
  if (s.mode === "LIVE") {
    return s.goLive === true
      ? "It sends real email to everyone in this campaign, inside their working hours and under the daily limit."
      : "It sends real email, but only to the addresses on your test list until you go live. Emails to test mailboxes don't count as emailed, so you can test again at any time.";
  }
  return s.practiceCopy
    ? "This is the practice copy: companies are marked Contacted and the 30-day rule counts these emails, as if they were real."
    : "It's a dry run on your real data: nothing is sent, and company statuses and the 30-day rule don't change.";
}

/**
 * The Schedule step's required tick for a LIVE draft made before go-live (M6-DESIGN G11): "This draft was made before
 * you went live. It now sends real email to 412 people."
 */
export function madeBeforeGoLiveText(people: number): string {
  const n = Math.max(0, Math.floor(people));
  return `This draft was made before you went live. It now sends real email to ${n.toLocaleString("en-US")} ${n === 1 ? "person" : "people"}.`;
}

/** The Schedule step asks for that tick: a LIVE launch of a draft made before go-live. */
export function needsGoLiveTick(s: { mode: "DRY_RUN" | "TEST" | "LIVE"; madeBeforeGoLive?: boolean }): boolean {
  return s.mode === "LIVE" && s.madeBeforeGoLive === true;
}

export type LaunchSentences = {
  main: string;
  missing: string | null;
  /** The campaign's text has unknown variables or broken braces (the Message step fixes it). */
  text: string | null;
  /** Emails edited for single people have their own text problems (Review fixes them). */
  editedText: string | null;
  followUps: string | null;
  /** Anything worth a second look: the button says "Launch anyway". */
  anyWarning: boolean;
};

/** The sentences of the launch confirmation (PLAN.md B6.3, A8 M2). */
export function launchSentences(s: LaunchSummaryLike): LaunchSentences {
  const where = s.mode === "DRY_RUN" ? "go to the dry-run outbox" : "be sent";
  const main = s.people === 1 ? `1 email will ${where}.` : `${s.people.toLocaleString("en-US")} emails will ${where}.`;
  const missing =
    s.missingEmails > 0
      ? `${s.missingEmails === 1 ? "1 email has" : `${s.missingEmails.toLocaleString("en-US")} emails have`} missing details: fix, exclude or send anyway.`
      : null;
  const problems = s.people > 0 ? (s.textProblems ?? []) : [];
  const text = problems.length > 0 ? `${problems.map(textProblemSentence).join(" ")} Check the Message step.` : null;
  const edited = s.people > 0 ? (s.editedTextProblems ?? 0) : 0;
  const editedSentence = editedTextProblemSentence(edited);
  const editedText = editedSentence ? `${editedSentence} ${edited === 1 ? "Check it in Review." : "Check them in Review."}` : null;
  const followUps = followUpsSentence(s.followUps);
  return { main, missing, text, editedText, followUps, anyWarning: Boolean(missing || text || editedText) };
}

// ───────────────────────── recipients' local time ─────────────────────────

/** How many people are in one time zone (companies with no zone count as the default one). */
export type RecipientZoneLike = { timeZone: string; people: number; defaulted: number };

/** "Berlin" for "Europe/Berlin", "New York" for "America/New_York", "UTC" for UTC. */
export function zoneCity(timeZone: string): string {
  if (/^(Etc\/)?(UTC|GMT|Universal|Zulu)$/i.test(timeZone)) return "UTC";
  const last = timeZone.split("/").pop() || timeZone;
  return last.replace(/_/g, " ");
}

/** An instant as wall-clock time in a zone ("07:00", its date and weekday); null for an unknown zone. */
function wallClock(date: Date, timeZone: string): { time: string; day: string; weekday: string } | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
  } catch {
    return null;
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return { time: `${hour}:${get("minute")}`, day: `${get("year")}-${get("month")}-${get("day")}`, weekday: get("weekday") };
}

/**
 * The start in the recipients' own time, for the three zones with the most people: "In the
 * recipients' time: 07:00 in Berlin for 120 people and 06:00 in London for 20 people." A day that
 * differs from the viewer's is named ("23:00 on Wednesday in New York"). Null when nobody gets it.
 */
export function recipientTimesText(start: Date, viewerTimeZone: string, zones: readonly RecipientZoneLike[], max = 3): string | null {
  const viewer = wallClock(start, viewerTimeZone) ?? wallClock(start, "UTC");
  const shown: string[] = [];
  let restPeople = 0;
  let restZones = 0;
  for (const z of zones) {
    if (z.people <= 0) continue;
    const local = shown.length < max ? wallClock(start, z.timeZone) : null;
    if (!local) {
      restPeople += z.people;
      restZones += 1;
      continue;
    }
    const day = viewer && local.day !== viewer.day ? ` on ${local.weekday}` : "";
    shown.push(`${local.time}${day} in ${zoneCity(z.timeZone)} for ${plural(z.people, "person", "people")}`);
  }
  if (shown.length === 0) return null;
  if (restPeople > 0) {
    shown.push(`${plural(restPeople, "more person", "more people")} in ${plural(restZones, "other time zone", "other time zones")}`);
  }
  return `In the recipients' time: ${listWords(shown)}.`;
}

/** Says plainly which zone is used for companies that have none (or null when every company has one). */
export function defaultZoneNote(zones: readonly RecipientZoneLike[], defaultTimeZone: string): string | null {
  const n = zones.reduce((sum, z) => sum + Math.max(0, z.defaulted), 0);
  if (n === 0) return null;
  return `${plural(n, "person is at a company", "people are at companies")} with no country or time zone set, so ${zoneCity(defaultTimeZone)} time (the default time zone) is used for them.`;
}

/** True while the person is typing, so single-key shortcuts (j/k) must not fire. */
export function isTypingTarget(el: EventTarget | null | undefined): boolean {
  if (!el || typeof el !== "object") return false;
  const node = el as { tagName?: unknown; isContentEditable?: unknown; closest?: unknown };
  if (node.isContentEditable === true) return true;
  const tag = typeof node.tagName === "string" ? node.tagName.toUpperCase() : "";
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** The next index for j/k in a list of `length` items (stays inside the list). */
export function moveIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : length - 1;
  return Math.min(length - 1, Math.max(0, current + delta));
}
