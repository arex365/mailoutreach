import { z } from "zod";
import { formatUsd } from "@/core/money";
import { plural } from "@/core/text";
import { formatShortDate } from "@/core/time/format";
import { DEFAULT_VERIFICATION_POLICY } from "@/core/rules/eligibility";
import { CHECK_CONCURRENCY_MAX, type CheckSingleOutcome } from "@/core/verification/types";
import { checkTestResultText, usdAmountText } from "@/core/verification/words";

/**
 * Settings › Deliverability "Address checks" (M5-DESIGN §2.4, §6.6): the values the card edits, their validation with
 * the plain messages of §2.4, and the card's small sentences. Pure and browser-safe: the page, the form and the
 * Server Action share it.
 */

export type SendOrSkip = "send" | "block";

/** The values the "Address checks" card saves (one Setting each; the six policy rows are one Setting). */
export type CheckSettingsValues = {
  deliverableHighRisk: SendOrSkip;
  catchAllLow: SendOrSkip;
  catchAllMedium: SendOrSkip;
  catchAllHigh: SendOrSkip;
  disposable: SendOrSkip;
  unknown: "recheck" | "block";
  pricePerCheck: number;
  includedPerMonth: number;
  maxAgeDays: number;
  monthlyLimitUsd: number;
  concurrency: number;
};

export const CHECK_SETTING_TEXT = {
  sendOrSkip: "Choose Send or Skip.",
  unknown: "Choose Check again after 24 hours or Skip.",
  price: "Enter a price from $0 to $1 per check.",
  included: "Enter a whole number of checks, 0 or more.",
  maxAge: "Choose between 30 and 365 days.",
  limit: "Enter an amount from $1 to $10,000.",
  concurrency: `Choose from 1 to ${CHECK_CONCURRENCY_MAX} checks at the same time.`,
  provider: "Address checks use Mailgun.",
} as const;

/** The largest "checks included in your plan each month" accepted. */
export const INCLUDED_MAX = 1_000_000;

/** A number typed in a field (or sent as a number): trimmed, "0,012" read as 0.012, empty = not a number. */
function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return Number.NaN;
  const s = v.trim().replace(",", ".");
  return s === "" ? Number.NaN : Number(s);
}

/** A number field with one plain message for anything outside `ok`. */
function numberField(message: string, ok: (n: number) => boolean) {
  return z.union([z.number(), z.string()], { error: message }).transform((v, ctx) => {
    const n = toNumber(v);
    if (!Number.isFinite(n) || !ok(n)) {
      ctx.addIssue({ code: "custom", message });
      return z.NEVER;
    }
    return n;
  });
}

const sendOrSkip = z.enum(["send", "block"], { error: CHECK_SETTING_TEXT.sendOrSkip });

/** The card's input (M5-DESIGN §2.4): each policy row Send / Skip, "No answer" Check again / Skip, and the numbers. */
export const checkSettingsSchema = z.object({
  deliverableHighRisk: sendOrSkip,
  catchAllLow: sendOrSkip,
  catchAllMedium: sendOrSkip,
  catchAllHigh: sendOrSkip,
  disposable: sendOrSkip,
  unknown: z.enum(["recheck", "block"], { error: CHECK_SETTING_TEXT.unknown }),
  pricePerCheck: numberField(CHECK_SETTING_TEXT.price, (n) => n >= 0 && n <= 1),
  includedPerMonth: numberField(CHECK_SETTING_TEXT.included, (n) => Number.isInteger(n) && n >= 0 && n <= INCLUDED_MAX),
  maxAgeDays: numberField(CHECK_SETTING_TEXT.maxAge, (n) => Number.isInteger(n) && n >= 30 && n <= 365),
  monthlyLimitUsd: numberField(CHECK_SETTING_TEXT.limit, (n) => n >= 1 && n <= 10_000),
  concurrency: numberField(CHECK_SETTING_TEXT.concurrency, (n) => Number.isInteger(n) && n >= 1 && n <= CHECK_CONCURRENCY_MAX),
  /** Only Mailgun checks addresses in this version (the card shows it as a read-only line). */
  provider: z.literal("mailgun", { error: CHECK_SETTING_TEXT.provider }).optional(),
});

export type CheckSettingsInput = z.input<typeof checkSettingsSchema>;

/** The policy rows in the card's order: label, hint, and the values' words. */
export const POLICY_ROWS: ReadonlyArray<{
  key: "deliverableHighRisk" | "catchAllLow" | "catchAllMedium" | "catchAllHigh" | "disposable";
  label: string;
  hint?: string;
}> = [
  { key: "deliverableHighRisk", label: "Deliverable, high risk (“Risky”)" },
  {
    key: "catchAllLow",
    label: "Can't confirm, low risk",
    hint: "The mail server accepts every address, so nobody can confirm this person exists.",
  },
  { key: "catchAllMedium", label: "Can't confirm, medium risk" },
  { key: "catchAllHigh", label: "Can't confirm, high risk" },
  { key: "disposable", label: "Throwaway addresses" },
];

export const SEND_OR_SKIP_LABELS: Readonly<Record<SendOrSkip, string>> = { send: "Send", block: "Skip" };
export const UNKNOWN_LABELS: Readonly<Record<"recheck" | "block", string>> = { recheck: "Check again after 24 hours", block: "Skip" };

/** "This month: 412 checks, $4.94 of your $100 limit." */
export function checksThisMonthLine(count: number, costUsd: number, limitUsd: number): string {
  return `This month: ${plural(count, "check", "checks")}, ${formatUsd(costUsd)} of your ${usdAmountText(limitUsd)} limit.`;
}

/** The address check key card's status: "Uses your Mailgun key." / "Own key ending …1a2b, saved 3 Oct by Arslan." */
export function checkKeyStatusLine(
  key: { set: false } | { set: true; last4: string; updatedAt: Date | string; byName: string | null },
  timeZone: string,
  now: Date = new Date(),
): string {
  if (!key.set) return "Uses your Mailgun key.";
  return `Own key ending …${key.last4}, saved ${formatShortDate(key.updatedAt, timeZone, now)}${key.byName ? ` by ${key.byName}` : ""}.`;
}

/** The stored Settings the card reads, as getSettings returns them. */
export type StoredCheckSettings = {
  "verification.policy": unknown;
  "verification.pricePerCheck": unknown;
  "verification.includedPerMonth": unknown;
  "verification.maxAgeDays": unknown;
  "verification.monthlyLimitUsd": unknown;
  "verification.concurrency": unknown;
};

/** The Settings keys the card reads (for getSettings). */
export const STORED_CHECK_SETTING_KEYS = [
  "verification.policy",
  "verification.pricePerCheck",
  "verification.includedPerMonth",
  "verification.maxAgeDays",
  "verification.monthlyLimitUsd",
  "verification.concurrency",
] as const;

/**
 * The card's values from the stored Settings: the policy merged over the defaults (a policy saved before the throwaway
 * row existed has none), anything broken read as its default.
 */
export function checkSettingsValuesFrom(s: StoredCheckSettings): CheckSettingsValues {
  const stored = s["verification.policy"];
  const p: Record<string, unknown> = {
    ...DEFAULT_VERIFICATION_POLICY,
    ...(stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {}),
  };
  const sendOrSkip = (v: unknown): SendOrSkip => (v === "send" ? "send" : "block");
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  return {
    deliverableHighRisk: sendOrSkip(p.deliverableHighRisk),
    catchAllLow: sendOrSkip(p.catchAllLow),
    catchAllMedium: sendOrSkip(p.catchAllMedium),
    catchAllHigh: sendOrSkip(p.catchAllHigh),
    disposable: sendOrSkip(p.disposable),
    unknown: p.unknown === "block" ? "block" : "recheck",
    pricePerCheck: num(s["verification.pricePerCheck"], 0.012),
    includedPerMonth: num(s["verification.includedPerMonth"], 0),
    maxAgeDays: num(s["verification.maxAgeDays"], 90),
    monthlyLimitUsd: num(s["verification.monthlyLimitUsd"], 100),
    concurrency: num(s["verification.concurrency"], 2),
  };
}

/** The "Address check key" card's sentences (M5-DESIGN §6.6; the key rules are the Mailgun connection's, M3). */
export const CHECK_KEY_TEXT = {
  paste: "Paste the key from Mailgun › API Security.",
  testKey: "This is a test key. Paste the key from Mailgun › API Security.",
  realKeyInFakeMode: "The test server only takes test keys (key-fake-…).",
  practiceCopy: "The practice copy never talks to Mailgun.",
  saved: "Key saved. It's used for the next check.",
  removed: "Address checks use the Mailgun key again.",
  notSaved: "No separate key is saved: address checks already use the Mailgun key.",
} as const;

/** Which Setting each saved value lives in (the policy rows share "verification.policy"). */
export const CHECK_SETTING_KEYS = {
  pricePerCheck: "verification.pricePerCheck",
  includedPerMonth: "verification.includedPerMonth",
  maxAgeDays: "verification.maxAgeDays",
  monthlyLimitUsd: "verification.monthlyLimitUsd",
  concurrency: "verification.concurrency",
} as const;

/** What the page hands the "Address checks" card. */
export type CheckSettingsView = {
  values: CheckSettingsValues;
  /** "This month: 412 checks, $4.94 of your $100 limit." */
  thisMonth: string;
};

/** What the page hands the "Address check key" card. */
export type CheckKeyView = {
  /** "Uses your Mailgun key." / "Own key ending …1a2b, saved 3 Oct by Arslan." */
  statusLine: string;
  hasOwnKey: boolean;
  practiceCopy: boolean;
};

/** What the page hands the "Test address checks" card. */
export type TestChecksView = {
  /** The Owner's reply inbox (else their login address). */
  defaultEmail: string;
  practiceCopy: boolean;
  /** Setting "verification.pricePerCheck". */
  pricePerCheck: number;
};

/** The "Test address checks" card's text (M5-DESIGN §6.6; the practice copy uses the free test checker). */
export function testChecksIntro(v: { practiceCopy: boolean; pricePerCheck: number }): string {
  if (v.practiceCopy) {
    return "Checks one address with the free test checker, so you can see how checks work. The result isn't saved on any person.";
  }
  const cost = v.pricePerCheck > 0 ? `It costs about ${formatUsd(v.pricePerCheck)}.` : "It's free.";
  return `Checks one address with Mailgun, so you can see that checks work. ${cost} The result isn't saved on any person.`;
}

/**
 * The test's result from the finished run (M5-DESIGN §6.6): "Checked in 1.4 s: can be emailed (deliverable, low
 * risk).", an undeliverable one "… It wasn't added to the do-not-email list.", or the refusal with Mailgun's words
 * for "Details".
 */
export function testCheckResultView(
  run: { status: string; single: CheckSingleOutcome | null; error: string | null },
  opts: { practiceCopy?: boolean } = {},
): { tone: "good" | "info" | "error"; text: string; detail: string | null } {
  if (run.status === "FAILED") return { tone: "error", text: run.error || "The test couldn't finish. Try again in a few minutes.", detail: null };
  if (run.status === "CANCELLED" || !run.single) {
    return { tone: "info", text: "The test didn't run to the end. Try again in a few minutes.", detail: null };
  }
  const text = checkTestResultText(run.single, { practiceCopy: opts.practiceCopy });
  if (run.single.outcome === "refused") return { tone: "error", text, detail: run.single.detail };
  if (run.single.outcome !== "checked") return { tone: "error", text, detail: null };
  return { tone: run.single.decision === "send" ? "good" : "info", text, detail: null };
}

/** The activity sentence for one changed Setting ("Arslan set the monthly limit for address checks to $150"). */
export function checkSettingActivity(actorName: string, key: string, v: CheckSettingsValues): string {
  switch (key) {
    case "verification.policy":
      return `${actorName} changed which address check results are emailed`;
    case "verification.pricePerCheck":
      return `${actorName} set the price per address check to $${v.pricePerCheck}`;
    case "verification.includedPerMonth":
      return `${actorName} set the checks included in the Mailgun plan to ${v.includedPerMonth.toLocaleString("en-US")} a month`;
    case "verification.maxAgeDays":
      return `${actorName} set address check results to count for ${v.maxAgeDays} days`;
    case "verification.monthlyLimitUsd":
      return `${actorName} set the monthly limit for address checks to ${usdAmountText(v.monthlyLimitUsd)}`;
    case "verification.concurrency":
      return `${actorName} set the address checks at the same time to ${v.concurrency}`;
    default:
      return `${actorName} changed the address check settings`;
  }
}
