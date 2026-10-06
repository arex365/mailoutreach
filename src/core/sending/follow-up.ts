import { Temporal } from "temporal-polyfill";
import { normalizeMessageId } from "@/core/mailgun/events";
import type { SendModeValue } from "@/core/rules/mode";
import { DEFAULT_COMPANY_ZONE, nextWindowOpen, resolveZone, type SendingWindow } from "./window";

/**
 * Follow-up timing and threading (PLAN A5.4, B6.4; M4-DESIGN §2.1, §2.2; research notifications-and-threading Part B
 * and C). Pure and DST-safe: days are calendar days in the recipient's own zone (Temporal), never 24-hour steps.
 */

/** What `followUpDueAt` needs besides the sent time and the delay; `markSent` loads it inside its transaction. */
export type FollowUpTiming = {
  /** resolveZone(company.timeZone, Setting defaultTimeZone): the recipient's zone, never the cap-day zone. */
  zone: string;
  /** Setting "sending.window" (parseWindow). */
  window: SendingWindow;
  /** gateClass(campaign) !== "ungated": TEST, LIVE, and dry runs with "Ignore sending hours" off. */
  gated: boolean;
  /** Campaign.daysAsMinutes (a dry-run helper). */
  daysAsMinutes: boolean;
  mode: SendModeValue;
};

/** Delays above this are cut to it (the editors allow 1–90 days); keeps Temporal far inside its range. */
const MAX_FOLLOW_UP_DAYS = 3_660;

/** A step's delay as whole days: `max(0, floor(delayDays))`, anything that isn't a finite number → 0. */
export function followUpDays(delayDays: unknown): number {
  const n = typeof delayDays === "number" ? delayDays : Number.NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_FOLLOW_UP_DAYS, Math.max(0, Math.floor(n)));
}

/**
 * When step N+1 is due after step N was accepted at `sentAt` (PLAN A5.4, B6.4; M4-DESIGN §2.1):
 * 1. `days = max(0, floor(delayDays))`, anything invalid → 0;
 * 2. a dry run with "Treat follow-up days as minutes": `sentAt + days minutes`, with no window shift;
 * 3. otherwise the same local clock time `days` calendar days later in the recipient's zone (a DST gap moves it later,
 *    an overlap takes the earlier instant: Temporal's "compatible");
 * 4. gated rows then move to the next open slot of the sending window (a time inside the window stays; outside it, the
 *    next window start), so the stored due time matches when the row can really go;
 * 5. ungated rows keep that time.
 * An invalid zone falls back to Europe/Berlin; an invalid `sentAt` is returned unchanged.
 */
export function followUpDueAt(sentAt: Date, delayDays: number, t: FollowUpTiming): Date {
  const ms = sentAt.getTime();
  if (!Number.isFinite(ms)) return new Date(ms);
  const days = followUpDays(delayDays);
  if (t.daysAsMinutes && t.mode === "DRY_RUN") return new Date(ms + days * 60_000);
  const zone = resolveZone(t.zone, DEFAULT_COMPANY_ZONE);
  const local = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone);
  const due = new Date(local.add({ days }).epochMilliseconds);
  return t.gated ? nextWindowOpen(due, zone, t.window) : due;
}

/** A sent email as threading needs it. */
export type ThreadRow = {
  messageId: string;
  providerId: string | null;
  mode: SendModeValue;
};

/**
 * The ids of one sent email that a reply to it may carry (M4-DESIGN §2.2): ours, then Mailgun's own when it rewrote
 * ours. The provider id counts only for TEST/LIVE rows and only when it contains "@" (a dry run's provider id is
 * "dry-run:<messageId>", never an id). Bare, lowercase, without duplicates.
 */
export function sentIdsOf(row: ThreadRow): string[] {
  const out: string[] = [];
  const ours = normalizeMessageId(row.messageId);
  if (ours) out.push(ours);
  if ((row.mode === "TEST" || row.mode === "LIVE") && row.providerId && row.providerId.includes("@")) {
    const theirs = normalizeMessageId(row.providerId);
    if (theirs && !/\s/.test(theirs) && !out.includes(theirs)) out.push(theirs);
  }
  return out;
}

/** RFC 5322 §2.1.1: a header line is at most 998 characters. */
export const REFERENCES_MAX_LINE = 998;
const REFERENCES_LABEL = "References: ";

/** The length of "References: <id1> <id2> …". */
function referencesLineLength(ids: readonly string[]): number {
  if (ids.length === 0) return REFERENCES_LABEL.length;
  return REFERENCES_LABEL.length + ids.reduce((n, id) => n + id.length + 2, 0) + (ids.length - 1);
}

/**
 * RFC 5537 §3.4.4: when "References: <…> <…>" would pass `maxLineChars` (998) characters, drop ids after the first
 * until it fits, always keeping the first and the last two. Duplicates are dropped too (the first stays).
 */
export function trimReferences(ids: readonly string[], maxLineChars: number = REFERENCES_MAX_LINE): string[] {
  const out: string[] = [];
  for (const id of ids) if (id && !out.includes(id)) out.push(id);
  while (out.length > 3 && referencesLineLength(out) > maxLineChars) out.splice(1, 1);
  return out;
}

/**
 * The threading headers of the next step (RFC 5322 §3.6.4; M4-DESIGN §2.2), stored bare (the Mailgun client adds the
 * angle brackets):
 * - `inReplyTo`: the parent's id as the person received it — Mailgun's id when it rewrote ours on a TEST/LIVE row;
 * - `references`: the parent's References, then the parent's ids (ours, then Mailgun's), oldest first, without
 *   duplicates, space-separated, trimmed by `trimReferences`.
 */
export function threadHeaders(prev: ThreadRow & { references: string | null }): { inReplyTo: string; references: string } {
  const sent = sentIdsOf(prev);
  const inReplyTo = sent[sent.length - 1] ?? prev.messageId;
  const earlier = (prev.references ?? "")
    .split(/[\s,]+/)
    .map((id) => normalizeMessageId(id))
    .filter((id): id is string => Boolean(id));
  const chain = trimReferences([...earlier, ...(sent.length ? sent : [prev.messageId])]);
  return { inReplyTo, references: chain.join(" ") };
}
