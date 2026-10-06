import type { PauseDetail } from "@/core/system-state";

/**
 * Health auto-pause (PLAN B6.6, M3-DESIGN §4.1.4): sending pauses by itself when too many of the recent counted
 * emails bounced or were marked as spam. The limits use FIXED denominators (the window sizes), so 7 bounces pause
 * even when only 50 emails have gone out so far. Pure; the server side (health-check.ts, P3) loads the counts
 * (loadHealthCounts, P2) and acts on the verdict.
 */

/** Mailgun's own acceptable-use limits, shown next to the Owner's thresholds. */
export const MAILGUN_LIMITS = { bouncePercent: 5, complaintPercent: 0.08 } as const;

/** The recent counted emails and their problems (loadHealthCounts, P2). */
export type HealthCounts = {
  /** Emails among the last `bounceSample` with a permanent failure (never `suppress-*`, never test mode). */
  bounces: number;
  /** How many emails the bounce count looked at (≤ the bounce window). */
  bounceSample: number;
  /** Emails among the last `complaintSample` that drew a spam complaint. */
  complaints: number;
  complaintSample: number;
};

/** The Owner's thresholds (Settings › Deliverability). */
export type HealthSettings = {
  /** Setting "health.bounceWindow" (default 200). */
  bounceWindow: number;
  /** Setting "health.bouncePercent" (default 3). */
  bouncePercent: number;
  /** Setting "health.complaintWindow" (default 1,000). */
  complaintWindow: number;
  /** Setting "health.complaintPercent" (default 0.1). */
  complaintPercent: number;
};

/** What the health check must do now: pause (with the pill reason and fix text), warn, or nothing. */
export type HealthVerdict = {
  /** floor(window × % / 100): sending pauses above this, e.g. 6. */
  bounceLimit: number;
  /** e.g. 1. */
  complaintLimit: number;
  pause: null | { kind: "health-bounce" | "health-complaint"; reason: string; fixText: string; detail: PauseDetail };
  warn: Array<{ rule: "bounce" | "complaint"; title: string; body: string }>;
};

function whole(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/** A percentage in thousandths of a percent, so 0.1 % and 0.08 % compare exactly. */
function milliPercent(p: number): number {
  return Number.isFinite(p) ? Math.max(0, Math.round(p * 1000)) : 0;
}

/** floor(window × percent / 100), in integers. */
function limitFor(window: number, percent: number): number {
  return Math.floor((whole(window) * milliPercent(percent)) / 100_000);
}

/** `count × 100 > window × percent`, in integers: the pause rule. */
function overLimit(count: number, window: number, percent: number): boolean {
  return whole(count) * 100_000 > whole(window) * milliPercent(percent);
}

/** The count at which the Owner gets a warning: half the limit, at least 1. */
function warnAt(limit: number): number {
  return Math.max(1, Math.ceil(limit / 2));
}

function num(n: number): string {
  return n.toLocaleString("en-US");
}

/** "3%", "0.1%", "0.08%". */
function pct(p: number): string {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(p)}%`;
}

/**
 * The emails a count is out of: "the last 200 emails", or "1 email so far" while only one has been counted
 * ("0 of 1 email so far bounced", never "0 of the last 1 emails").
 */
export function emailsCountedText(sample: number): string {
  return sample === 1 ? "1 email so far" : `the last ${num(sample)} emails`;
}

function bouncedText(count: number, sample: number): string {
  return `${num(count)} of ${emailsCountedText(sample)} bounced`;
}

function spamText(count: number, sample: number): string {
  return `${num(count)} of ${emailsCountedText(sample)} ${count === 1 || sample === 1 ? "was" : "were"} marked as spam`;
}

/**
 * Decides whether sending must pause, and which warnings are due. Pause when `count × 100 > window × percent`
 * (bounces are checked first; when both trip, the bounce pause wins). A warning is due when the count reached half
 * the limit (at least 1), nothing pauses, and that rule hasn't warned already (`alreadyWarned`: a warning was sent,
 * the count never dropped below the warning level since, and it is less than 7 days old; the caller decides).
 */
export function evaluateHealth(
  counts: HealthCounts,
  s: HealthSettings,
  alreadyWarned: { bounce: boolean; complaint: boolean },
): HealthVerdict {
  const bounceLimit = limitFor(s.bounceWindow, s.bouncePercent);
  const complaintLimit = limitFor(s.complaintWindow, s.complaintPercent);
  const bounces = whole(counts.bounces);
  const complaints = whole(counts.complaints);
  const bounceSample = whole(counts.bounceSample);
  const complaintSample = whole(counts.complaintSample);
  const verdict: HealthVerdict = { bounceLimit, complaintLimit, pause: null, warn: [] };

  if (overLimit(bounces, s.bounceWindow, s.bouncePercent)) {
    verdict.pause = {
      kind: "health-bounce",
      reason: bouncedText(bounces, bounceSample),
      fixText: `Your limit is ${num(bounceLimit)}. Open the bounced list in Settings › Deliverability (it shows each bounce's campaign and lists), remove or re-check the list they came from, then click Resume.`,
      detail: { count: bounces, sample: bounceSample, window: whole(s.bounceWindow), limit: bounceLimit },
    };
    return verdict;
  }
  if (overLimit(complaints, s.complaintWindow, s.complaintPercent)) {
    verdict.pause = {
      kind: "health-complaint",
      reason: spamText(complaints, complaintSample),
      fixText: `Your limit is ${num(complaintLimit)}. Settings › Deliverability shows which campaign they came from; check it before you resume. Mailgun's own limit is ${pct(MAILGUN_LIMITS.complaintPercent)}.`,
      detail: { count: complaints, sample: complaintSample, window: whole(s.complaintWindow), limit: complaintLimit },
    };
    return verdict;
  }

  if (!alreadyWarned.bounce && bounces >= warnAt(bounceLimit)) {
    verdict.warn.push({
      rule: "bounce",
      title: `Bounces are rising: ${bouncedText(bounces, bounceSample)}`,
      body: `Sending pauses automatically at ${num(bounceLimit + 1)}. Check the bounced addresses in Settings › Deliverability.`,
    });
  }
  if (!alreadyWarned.complaint && complaints >= warnAt(complaintLimit)) {
    verdict.warn.push({
      rule: "complaint",
      title: complaints === 1 ? "An email was marked as spam" : `${num(complaints)} emails were marked as spam`,
      body: `${num(complaints)} of ${emailsCountedText(complaintSample)} drew ${complaints === 1 ? "a complaint" : "complaints"}. Sending pauses automatically at ${num(complaintLimit + 1)}.`,
    });
  }
  return verdict;
}

/**
 * One line for the Deliverability page (§5.5): "3 of the last 200 emails bounced · sending pauses above 6 (3%) ·
 * Mailgun's own limit is 5%." / "0 of the last 1,000 emails were marked as spam · sending pauses above 1 (0.1%) ·
 * Mailgun's own limit is 0.08%."
 */
export function healthLine(rule: "bounce" | "complaint", counts: HealthCounts, s: HealthSettings): string {
  if (rule === "bounce") {
    const sample = whole(counts.bounceSample);
    const head = sample === 0 ? "No emails counted yet" : bouncedText(whole(counts.bounces), sample);
    return `${head} · sending pauses above ${num(limitFor(s.bounceWindow, s.bouncePercent))} (${pct(s.bouncePercent)}) · Mailgun's own limit is ${pct(MAILGUN_LIMITS.bouncePercent)}.`;
  }
  const sample = whole(counts.complaintSample);
  const head = sample === 0 ? "No emails counted yet" : spamText(whole(counts.complaints), sample);
  return `${head} · sending pauses above ${num(limitFor(s.complaintWindow, s.complaintPercent))} (${pct(s.complaintPercent)}) · Mailgun's own limit is ${pct(MAILGUN_LIMITS.complaintPercent)}.`;
}
