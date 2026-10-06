import type { RepliesMode } from "@/core/sending/own-mailbox";

/**
 * The Mailgun plan the Owner chose (Setting "mailgun.plan", MAIN-DOMAIN-DESIGN O22–O26) and what the app keeps to:
 * https://www.mailgun.com/pricing/ as read on 2026-09-28. Pure and browser-safe.
 *
 * `planLimits(plan, replies)` is null in app mode with no plan chosen: every reader then behaves exactly as before
 * (§0.2 rule 4). A plan the Owner chooses caps the daily limit and the log retention in every mode (O30).
 */

export type MailgunPlan = "free" | "basic" | "foundation" | "scale";
export const MAILGUN_PLANS: readonly MailgunPlan[] = ["free", "basic", "foundation", "scale"];

export type PlanFacts = { label: string; dailyLimit: number | null; logDays: number; messageDays: number };

export const MAILGUN_PLAN_FACTS: Readonly<Record<MailgunPlan, PlanFacts>> = {
  free: { label: "Free (100 emails a day)", dailyLimit: 100, logDays: 1, messageDays: 1 },
  basic: { label: "Basic", dailyLimit: null, logDays: 1, messageDays: 1 },
  foundation: { label: "Foundation", dailyLimit: null, logDays: 5, messageDays: 1 },
  scale: { label: "Scale or higher", dailyLimit: null, logDays: 30, messageDays: 7 },
};

/** Setting "mailgun.plan" → a plan, or null (not chosen, or unreadable). */
export function planOf(v: unknown): MailgunPlan | null {
  return typeof v === "string" && (MAILGUN_PLANS as readonly string[]).includes(v) ? (v as MailgunPlan) : null;
}

export type PlanLimits = PlanFacts & { plan: MailgunPlan; assumed: boolean };

/** The limits in force (O22): the chosen plan's; none chosen → Free's in own-mailbox mode (assumed), null in app mode. */
export function planLimits(plan: MailgunPlan | null, replies: RepliesMode): PlanLimits | null {
  if (plan) return { ...MAILGUN_PLAN_FACTS[plan], plan, assumed: false };
  if (replies === "own-mailbox") return { ...MAILGUN_PLAN_FACTS.free, plan: "free", assumed: true };
  return null;
}

/** Emails a day kept for "Send me a test" and the reply test on a plan with a daily limit (O23). */
export const PLAN_TEST_RESERVE = 10;

function wholeDays(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= min ? Math.min(max, n) : fallback;
}

/** Days of Mailgun logs the app may count on (O26): the saved number, never more than the plan keeps. */
export function effectiveLogRetentionDays(saved: unknown, limits: PlanLimits | null): number {
  const days = wholeDays(saved, 1, 30, 5);
  return limits ? Math.min(days, limits.logDays) : days;
}

/** The maximum daily limit the warm-up and today's cap use (O23): Setting "sending.maxDailyCap", never above the plan's limit minus the reserve. */
export function effectiveMaxDailyCap(maxDailyCap: unknown, limits: PlanLimits | null): number {
  const max = Math.max(0, Math.floor(Number(maxDailyCap) || 0));
  if (!limits || limits.dailyLimit === null) return max;
  return Math.max(0, Math.min(max, limits.dailyLimit - PLAN_TEST_RESERVE));
}

/** Room left in the rolling 24 hours (O23): for campaign emails (keeping the reserve) and for tests; null = no daily limit. */
export function planRoom(limits: PlanLimits | null, usedLast24h: number): { campaign: number; tests: number } | null {
  if (!limits || limits.dailyLimit === null) return null;
  const used = Math.max(0, Math.floor(usedLast24h));
  return { campaign: Math.max(0, limits.dailyLimit - PLAN_TEST_RESERVE - used), tests: Math.max(0, limits.dailyLimit - used) };
}

export const PLAN_TEXTS = {
  planLabel: "Your Mailgun plan",
  planNotSure: "Not sure",
  planHint: "The app keeps to your plan's daily limit and log retention. Mailgun shows your plan under Account › Plan (it may be called Billing).",
  assumedFree: "Not chosen yet: the app keeps to the Free plan's limits (100 emails a day, 1 day of logs).",
  retentionHint:
    "Mailgun's plans keep event logs for 1 day (Free, Basic), 5 days (Foundation) or 30 days (Scale), and stored replies for 1 day. Choosing your plan fills these in.",
  planSummary: (actorName: string, label: string, logDays: number, messageDays: number): string =>
    `${actorName} set the Mailgun plan to ${label}, with ${logDays} ${logDays === 1 ? "day" : "days"} of event logs and ${messageDays} ${messageDays === 1 ? "day" : "days"} of stored replies`,
  capLine: (cap: number, limit: number): string =>
    `Your Mailgun plan sends at most ${limit.toLocaleString("en-US")} emails a day, so the app plans at most ${cap.toLocaleString("en-US")} campaign emails a day and keeps ${(limit - cap).toLocaleString("en-US")} for test emails.`,
  maxFieldHint: (cap: number): string => `Your Mailgun plan keeps this at ${cap.toLocaleString("en-US")} at most.`,
  testsFull: (limit: number): string =>
    `Your Mailgun plan sends at most ${limit.toLocaleString("en-US")} emails in 24 hours, and that many have gone out. Try again later.`,
  limitRefused:
    "Mailgun refused an email because your plan's sending limit is reached. Sending is paused: click Resume after the limit resets, or upgrade the plan in Mailgun (Account › Plan) and choose it in Settings › Sending & Mailgun › Advanced.",
  limitReason: "Mailgun's sending limit for your plan is reached",
  /** Campaign emails (O25): never suggests authorizing a prospect's address. */
  authorizedOnlyCampaign:
    "Mailgun sends only to authorized recipients on your free account, so it refused this email. In Mailgun, add a payment card (Account › Billing, it may be called Plan), then click Resume. The Free plan stays free.",
  /** "Send me a test" and the reply test (O25): a test mailbox may be authorized. */
  authorizedOnlyTest:
    "Mailgun sends only to authorized recipients on your free account, so it refused this test email. In Mailgun, add a payment card (Account › Billing, it may be called Plan), or add this test mailbox under Authorized recipients, then try again.",
  authorizedReason: "Mailgun sends only to authorized recipients",
  monthlyNotNeeded: (limit: number): string =>
    `Your Mailgun plan stops at ${limit.toLocaleString("en-US")} emails a day, so a monthly safety limit isn't needed.`,
} as const;
