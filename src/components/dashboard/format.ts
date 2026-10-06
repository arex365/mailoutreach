import type { CompanyStatusValue } from "@/core/labels";
import { capDayOfWeek, type CapDay } from "@/core/sending/capday";
import { isHealthyForWarmup } from "@/core/sending/warmup";
import { isWeekdaysOnly, type WarmupToday } from "@/core/sending/warmup-line";
import { parseWindow } from "@/core/sending/window";
import { formatDate, formatShortDate, formatTime } from "@/core/time/format";
import { companyFiltersToParams } from "@/server/services/companies/filters";
import type { HealthView } from "@/server/services/mail-events/deliverability";
import { contactsHref } from "@/components/contacts/url";
import { DASHBOARD_TEXTS } from "./texts";
import type { HealthTileView, TodayView } from "./types";

/**
 * The dashboard's tiles in words (M6-DESIGN §4.3): pure builders the page loader uses, and the few helpers the screen
 * needs. Nothing here reads the database. Pure and browser-safe.
 */

/** What the Today tile needs from `getTodayCap(now)` (M3-DESIGN §4.2.5). */
export type TodayCapFacts = {
  used: number;
  cap: number;
  left: number;
  testSends: number;
  /** An override for today's cap day is in force (TodayCap.override). */
  override: unknown;
  aboveSchedule: boolean;
};

/**
 * The Today tile (§4.3): the big number against today's limit and its lines, in this order, each only when it
 * applies: test emails ("Send me a test" and the reply test, review DASHBOARD-9) · a hand-set limit (and whether it is above the warm-up schedule) · the limit is
 * reached · the warm-up. The warm-up line (`warmupLine(step, table, loadWarmupToday(now))`) shows after go-live and in
 * the practice copy; before go-live with Mailgun set up it says the ramp starts at go-live; real data without Mailgun
 * gets "Nothing goes through Mailgun yet" instead.
 */
export function todayView(input: {
  cap: TodayCapFacts;
  warmupLine: string | null;
  practiceCopy: boolean;
  live: boolean;
  configured: boolean;
}): TodayView {
  const t = DASHBOARD_TEXTS.today;
  const { cap } = input;
  const used = Math.max(0, Math.floor(cap.used) || 0);
  const limit = Math.max(0, Math.floor(cap.cap) || 0);
  const lines: string[] = [];
  if (cap.testSends > 0) lines.push(t.testSends(cap.testSends));
  if (cap.override) lines.push(cap.aboveSchedule ? `${t.override}${t.aboveSchedule}` : t.override);
  if (cap.left <= 0) lines.push(t.reached);
  if (input.practiceCopy || input.live) {
    if (input.warmupLine) lines.push(input.warmupLine);
  } else if (input.configured) {
    lines.push(t.warmupBeforeGoLive, t.warmupBeforeGoLiveNote);
  }
  return {
    used,
    cap: limit,
    percent: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : used > 0 ? 100 : 0,
    lines,
    notConfigured: !input.practiceCopy && !input.configured ? t.notConfigured : null,
  };
}

/**
 * Today's warm-up facts for `warmupLine` (M6-DESIGN §2.6), from what the dashboard already read: the same values P2's
 * `loadWarmupToday(now)` gives — today's counted sends (getTodayCap's `used`) against the step's scheduled limit
 * (`warmupCap`), whether today's cap day is a sending day (Setting "sending.window"), and whether the health counts
 * (loadHealthView's, counted since go-live like the warm-up's own) are healthy by the warm-up's percentages. Built
 * here so the dashboard counts the health sample once: it is the costliest read at post-go-live volumes. The
 * dashboard's integration test checks it against `loadWarmupProgress`.
 */
export function warmupTodayFrom(input: {
  used: number;
  warmupCap: number;
  capDay: CapDay;
  /** Setting "sending.window" (parsed here, the default window when unreadable). */
  window: unknown;
  /** Setting "warmup.minUsePercent". */
  minUsePercent: number;
  counts: { bounces: number; complaints: number };
  thresholds: { bounceWindow: number; complaintWindow: number; healthyBouncePercent: number; healthyComplaintPercent: number };
}): WarmupToday {
  const days = parseWindow(input.window).days;
  return {
    sendingDay: days.includes(capDayOfWeek(input.capDay)),
    used: input.used,
    cap: input.warmupCap,
    minUsePercent: input.minUsePercent,
    weekdaysOnly: isWeekdaysOnly(days),
    healthy: isHealthyForWarmup({
      bounces: input.counts.bounces,
      bounceWindow: input.thresholds.bounceWindow,
      healthyBouncePercent: input.thresholds.healthyBouncePercent,
      complaints: input.counts.complaints,
      complaintWindow: input.thresholds.complaintWindow,
      healthyComplaintPercent: input.thresholds.healthyComplaintPercent,
    }),
  };
}

/**
 * "you resumed on 27 Sept" from Domain health's "Counting since you resumed on 27 Sept." (`HealthView.sinceNote`, also
 * "Counting since you went live on …"); null without a note or for one worded otherwise.
 */
export function countingSinceWords(sinceNote: string | null): string | null {
  const m = /^Counting since (.*?)\.?$/.exec((sinceNote ?? "").trim());
  return m ? m[1]!.trim() || null : null;
}

/**
 * The Domain health tile (§4.3) from `loadHealthView` (which counts from go-live, G12): the two meters with the lines
 * that already name "your limit" and Mailgun's, the small-sample notes and "Counting since …". The ids of the emails
 * behind the counts stay on the server; no "See which emails count" link here. Nothing to measure yet: a sentence
 * instead — "No emails sent … yet" only when the counts start at the beginning; after a resume or go-live, "Nothing
 * sent since you resumed on 27 Sept, …" (review DASHBOARD-6: emails did go out before that, they just don't count).
 */
export function healthTileView(
  h: Pick<HealthView, "practiceCopy" | "counts" | "bounceLine" | "complaintLine" | "bounceLimit" | "complaintLimit" | "bounceNote" | "complaintNote" | "sinceNote">,
): HealthTileView {
  const t = DASHBOARD_TEXTS.health;
  const nothingSent = h.counts.bounceSample <= 0 && h.counts.complaintSample <= 0;
  const since = countingSinceWords(h.sinceNote);
  return {
    empty: nothingSent ? (since ? t.emptySince(since) : h.practiceCopy ? t.emptyPractice : t.emptyReal) : null,
    bounce: { label: t.bounceLabel, line: h.bounceLine, count: h.counts.bounces, limit: h.bounceLimit, note: h.bounceNote },
    complaint: {
      label: t.complaintLabel,
      line: h.complaintLine,
      count: h.counts.complaints,
      limit: h.complaintLimit,
      note: h.complaintNote,
    },
    sinceNote: h.sinceNote,
  };
}

/** The Contacts link of one status row: "/contacts?status=REPLIED" (built like every other Contacts link). */
export function statusHref(status: CompanyStatusValue): string {
  return contactsHref(companyFiltersToParams({ status }));
}

/** "Ali · Live": the sender and the launch mode of an active campaign. */
export function campaignMetaLine(c: { senderName: string | null; modeLabel: string | null }): string {
  return [c.senderName, c.modeLabel].filter((p): p is string => Boolean(p)).join(" · ");
}

/**
 * Where Active campaigns' "+ 3 more" leads (review DASHBOARD-7): the Running tab when every campaign left out is
 * running, the Scheduled tab when every one is scheduled, else the Campaigns page.
 */
export function campaignsMoreHref(moreRunning: number, moreScheduled: number): string {
  if (moreRunning > 0 && moreScheduled <= 0) return "/campaigns?tab=running";
  if (moreScheduled > 0 && moreRunning <= 0) return "/campaigns?tab=scheduled";
  return "/campaigns";
}

/** A collapsed run of identical activity rows: "12 companies", "3 times", "at least 200 companies". */
export function activityGroupText(g: { count: number; companies: boolean; atLeast: boolean }): string {
  const t = DASHBOARD_TEXTS.activity;
  return g.companies ? t.companies(g.count, g.atLeast) : t.times(g.count, g.atLeast);
}

/** The replies list's footer: "All replies", or "All replies (3 more)" when more are waiting than shown. */
export function repliesFooterLabel(total: number, shown: number): string {
  const more = total - shown;
  return more > 0 ? DASHBOARD_TEXTS.replies.allLinkMore(more) : DASHBOARD_TEXTS.replies.allLink;
}

/** "14:02" today, "25 Sept, 14:02" on another day (the viewer's zone), for "since …" in the attention list. */
export function sinceText(at: Date | string, timeZone: string, now: Date): string {
  const time = formatTime(at, timeZone);
  return formatDate(at, timeZone) === formatDate(now, timeZone) ? time : `${formatShortDate(at, timeZone, now)}, ${time}`;
}
