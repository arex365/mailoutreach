import { aboutUsd, formatUsd } from "@/core/money";
import type { CheckPauseKind } from "@/core/system-state";
import { plural } from "@/core/text";
import type { CheckEstimate } from "./estimate";
import type { CheckBucket } from "./policy";
import {
  MAX_CHECKS_PER_RUN,
  type CheckDecision,
  type CheckRunCounts,
  type CheckSingleOutcome,
  type RiskValue,
  type VerificationStatusValue,
} from "./types";

/**
 * Every sentence about address checks (M5-DESIGN §2.3, §2.9–§2.12, §6.1, §6.3, §6.5, §6.6), in one place so the
 * notification, the job summary, the Verify step, the Contacts dialog, the panel and the Activity page say the same.
 * Pure and browser-safe. Plain words, sentence case, and what to do next.
 */

const num = (v: number): string => Math.max(0, Math.floor(v)).toLocaleString("en-US");

/** An amount for a limit: "$100" for whole dollars, else like formatUsd ("$12.50"). */
export function usdAmountText(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "$0";
  return Number.isInteger(v) ? `$${v.toLocaleString("en-US")}` : formatUsd(v);
}

/** A price per check with its real precision: "$0.012", "$0.01", "$1". */
export function pricePerCheckText(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return "$0";
  return `$${p.toLocaleString("en-US", { minimumFractionDigits: p < 1 ? 2 : 0, maximumFractionDigits: 4 })}`;
}

// ───────────────────────── reasons and results ─────────────────────────

const REASON_WORDS: Readonly<Record<string, string>> = {
  mailbox_does_not_exist: "This mailbox doesn't exist.",
  no_mx: "This domain can't receive email.",
  "No MX host found": "This domain can't receive email.",
  malformed_address: "This isn't a valid email address.",
  invalid_tld: "The domain ending isn't real.",
  catch_all: "Their mail server accepts every address, so nobody can confirm this person exists.",
  accept_all: "Their mail server accepts every address, so nobody can confirm this person exists.",
  mailbox_is_role_address: "A shared inbox.",
  mailbox_is_disposable_address: "A throwaway address.",
  long_term_disposable: "A throwaway address.",
  high_risk_domain: "The domain looks risky.",
  subdomain_mailer: "The domain looks risky.",
  immature_domain: "The domain is very new.",
  tld_risk: "The domain ending is often used for spam.",
  unknown_provider: "Unknown mail provider.",
  smtp_error: "Their mail server didn't answer the check.",
  smtp_timeout: "Their mail server didn't answer the check.",
  mailbox_quota_exceeded: "The mailbox is full.",
  "failed custom grammar check": "The address breaks the provider's rules.",
  no_data: "No data.",
  "app:unreadable_response": "Mailgun's answer couldn't be read.",
};

/** A provider reason code in words (research §2.4); any other code is shown as received. */
export function reasonWords(code: string): string {
  return Object.hasOwn(REASON_WORDS, code) ? REASON_WORDS[code]! : code;
}

function riskWord(risk: RiskValue | null): string {
  if (risk === "LOW") return "low";
  if (risk === "MEDIUM") return "medium";
  if (risk === "HIGH") return "high";
  return "unknown";
}

/** Whether a result is skipped because it is a throwaway address (not because of its risk). */
function isThrowawaySkip(r: { status: VerificationStatusValue; disposable: boolean; decision: CheckDecision | null }): boolean {
  return r.disposable && r.decision === "block" && r.status !== "UNKNOWN" && r.status !== "INVALID" && r.status !== "DO_NOT_SEND";
}

/**
 * A checked result in a few words, for "Checked in 1.4 s: …" and "Ali checked anna@firma.de: …": "can be emailed",
 * "doesn't exist", "shouldn't be emailed", "got no answer", or what the check settings skip.
 */
export function checkResultWords(r: {
  status: VerificationStatusValue;
  risk: RiskValue | null;
  disposable: boolean;
  decision: CheckDecision;
}): string {
  if (r.status === "INVALID") return "doesn't exist";
  if (r.status === "DO_NOT_SEND") return "shouldn't be emailed";
  if (r.status === "UNKNOWN") return r.decision === "block" ? "got no answer, skipped by your check settings" : "got no answer";
  if (r.decision === "send") {
    if (r.status !== "CATCH_ALL") return "can be emailed";
    return r.risk === "LOW"
      ? "can't be confirmed, but it's low risk, so it can be emailed"
      : `can't be confirmed (${riskWord(r.risk)} risk), but your check settings allow it`;
  }
  if (isThrowawaySkip(r)) return "a throwaway address, skipped by your check settings";
  if (r.status === "CATCH_ALL") return `can't be confirmed (${riskWord(r.risk)} risk), skipped by your check settings`;
  return "rated high risk, skipped by your check settings";
}

/** Mailgun's own verdict in plain words, for the Settings test: "deliverable, low risk". */
export function checkVerdictDetail(status: VerificationStatusValue, risk: RiskValue | null): string {
  const word: Record<VerificationStatusValue, string> = {
    VALID: "deliverable",
    RISKY: "deliverable",
    CATCH_ALL: "catch-all",
    INVALID: "undeliverable",
    DO_NOT_SEND: "do not send",
    UNKNOWN: "unknown",
  };
  if (status === "UNKNOWN") return word.UNKNOWN;
  return risk && risk !== "UNKNOWN" ? `${word[status]}, ${riskWord(risk)} risk` : `${word[status]}, risk unknown`;
}

/** The short reason on a "Who is left out" row: "doesn't exist", "rated high risk", … */
export function leftOutWords(bucket: CheckBucket | "couldnt-check"): string {
  switch (bucket) {
    case "invalid":
      return "doesn't exist";
    case "doNotSend":
      return "shouldn't be emailed";
    case "risky":
      return "rated high risk";
    case "catchAllBlocked":
      return "can't be confirmed";
    case "disposable":
      return "a throwaway address";
    case "unknown":
      return "got no answer";
    case "couldnt-check":
      return "couldn't be checked";
    default:
      return "can be emailed";
  }
}

// ───────────────────────── one address (panel and Settings test) ─────────────────────────

/**
 * The panel's toast for a finished one-address run (M5-DESIGN §6.5). In the practice copy the test checker, not
 * Mailgun, is named in the refusal and time-out sentences.
 */
export function checkOutcomeToast(email: string, single: CheckSingleOutcome, opts: { practiceCopy?: boolean } = {}): string {
  const checker = opts.practiceCopy ? "The test checker" : "Mailgun";
  switch (single.outcome) {
    case "skipped":
      if (single.skipReason === "suppressed") return `${email} is on the do-not-email list, so it wasn't checked.`;
      if (single.skipReason === "no-email") return "No email address to check.";
      if (single.skipReason === "never-emailed") {
        return `${email} wasn't checked: its company is never emailed (Client, Not interested or Do not contact).`;
      }
      return `${email} wasn't checked.`;
    case "refused":
      return `${checker} couldn't check ${email}.`;
    case "not-reached":
      return `${checker} didn't answer in time. Try again in a few minutes.`;
    default:
      break;
  }
  const status = single.status;
  if (!status) return `${email} was checked.`;
  if (status === "INVALID") return `${email} doesn't exist. It's on the do-not-email list now.`;
  if (status === "DO_NOT_SEND") return `The check says not to email ${email}. It's on the do-not-email list now.`;
  if (status === "UNKNOWN") {
    return single.decision === "block"
      ? `The check got no answer for ${email}. Your check settings skip these.`
      : `The check got no answer for ${email}. It's tried again after 24 hours when this person is in a campaign.`;
  }
  if (single.decision === "send") {
    if (status !== "CATCH_ALL") return `${email} can be emailed.`;
    return single.risk === "LOW"
      ? `${email} can't be confirmed, but it's low risk, so it can be emailed.`
      : `${email} can't be confirmed (${riskWord(single.risk)} risk), but your check settings allow it, so it can be emailed.`;
  }
  if (isThrowawaySkip({ status, disposable: single.disposable, decision: single.decision })) {
    return `${email} is a throwaway address. Your check settings skip it.`;
  }
  if (status === "CATCH_ALL") return `${email} can't be confirmed (${riskWord(single.risk)} risk). Your check settings skip it.`;
  return `The check rated ${email} high risk. Your check settings skip it.`;
}

/** "1.4 s" (at least 0.1 s). */
function secondsText(ms: number): string {
  return `${(Math.max(ms, 100) / 1000).toFixed(1)} s`;
}

/**
 * Settings › Deliverability "Test address checks" (M5-DESIGN §6.6): "Checked in 1.4 s: can be emailed (deliverable,
 * low risk)." An undeliverable or "don't email" result says it wasn't put on the do-not-email list (a test never is).
 */
export function checkTestResultText(single: CheckSingleOutcome, opts: { practiceCopy?: boolean } = {}): string {
  const checker = opts.practiceCopy ? "The test checker" : "Mailgun";
  if (single.outcome === "refused") return `${checker} couldn't check this address.`;
  if (single.outcome === "not-reached") return `${checker} didn't answer in time. Try again in a few minutes.`;
  if (single.outcome === "skipped" || !single.status) return "This address wasn't checked.";
  const when = single.ms !== null ? `Checked in ${secondsText(single.ms)}` : "Checked";
  const words = checkResultWords({
    status: single.status,
    risk: single.risk,
    disposable: single.disposable,
    decision: single.decision ?? "block",
  });
  if (single.status === "INVALID" || single.status === "DO_NOT_SEND") {
    return `${when}: ${words}. It wasn't added to the do-not-email list.`;
  }
  return `${when}: ${words} (${checkVerdictDetail(single.status, single.risk)}).`;
}

// ───────────────────────── a run ─────────────────────────

/** The non-zero parts of a run, in the §2.11 order: "33 can be emailed", "2 don't exist", … */
function summaryParts(c: CheckRunCounts): string[] {
  const parts: string[] = [];
  if (c.canEmail > 0) parts.push(`${num(c.canEmail)} can be emailed`);
  if (c.invalid > 0) parts.push(c.invalid === 1 ? "1 doesn't exist" : `${num(c.invalid)} don't exist`);
  if (c.doNotSend > 0) parts.push(`${num(c.doNotSend)} shouldn't be emailed`);
  if (c.risky > 0) parts.push(c.risky === 1 ? "1 is rated high risk" : `${num(c.risky)} are rated high risk`);
  if (c.catchAllBlocked > 0) parts.push(`${num(c.catchAllBlocked)} can't be confirmed`);
  if (c.disposable > 0) parts.push(c.disposable === 1 ? "1 is a throwaway address" : `${num(c.disposable)} are throwaway addresses`);
  if (c.unknown > 0) parts.push(`${num(c.unknown)} got no answer`);
  return parts;
}

/**
 * The one sentence about a run (M5-DESIGN §2.11), used by the notification, the job summary and the Contacts
 * dialog: "40 addresses checked: 33 can be emailed, 2 don't exist, 1 is rated high risk. 2 couldn't be checked right
 * now. Cost $0.48."
 */
export function checkRunSummary(c: CheckRunCounts): string {
  const parts = summaryParts(c);
  let s =
    c.checked > 0
      ? `${plural(c.checked, "address", "addresses")} checked${parts.length > 0 ? `: ${parts.join(", ")}` : ""}.`
      : "No addresses were checked.";
  const notChecked = c.refused + c.notReached;
  if (notChecked > 0) {
    s += ` ${num(notChecked)} couldn't be checked right now.`;
    if (c.mayBeCharged > 0) s += notChecked === 1 ? " It may have been charged." : " Some of them may have been charged.";
  }
  return `${s} Cost ${formatUsd(c.costUsd)}.`;
}

/**
 * The `verify.run` activity: "Ali checked 40 addresses for Germany Q4: 33 can be emailed, 2 don't exist, 1 is rated
 * high risk." (the first three parts of the summary, no dates).
 */
export function checkRunActivity(actorName: string, c: CheckRunCounts, campaignName: string | null): string {
  const where = campaignName ? ` for ${campaignName}` : "";
  if (c.checked === 0) return `${actorName} checked no addresses${where}.`;
  const parts = summaryParts(c).slice(0, 3);
  return `${actorName} checked ${plural(c.checked, "address", "addresses")}${where}${parts.length > 0 ? `: ${parts.join(", ")}` : ""}.`;
}

/**
 * The "Checks finished" lines of the Verify step and the Contacts dialog (M5-DESIGN §6.1, §6.3).
 *
 * `inCampaign` (default true) is for the Verify step: its run belongs to a campaign, whose launch re-checks a first "no
 * answer" 24 hours later and emails the person if it passes, and leaves out who wasn't checked. A Contacts or list run
 * (`inCampaign: false`) belongs to no campaign: nothing re-checks or emails anyone by itself, so its lines say what
 * happened and what's possible, like the panel's toast.
 */
export function checkRunDoneLines(c: CheckRunCounts, opts: { inCampaign?: boolean } = {}): string[] {
  const inCampaign = opts.inCampaign !== false;
  const lines: string[] = [];
  if (c.checked === 0) lines.push("No addresses were checked.");
  if (c.canEmail > 0) {
    let line = `${num(c.canEmail)} can be emailed`;
    const low = c.lowRiskCatchAll;
    if (low > 0) {
      line +=
        c.canEmail === 1
          ? " (it can't be confirmed but is low risk)"
          : ` (${num(low)} of them can't be confirmed but ${low === 1 ? "is" : "are"} low risk)`;
    }
    lines.push(`${line}.`);
  }
  const leftOutAnd = inCampaign ? "left out and " : "";
  if (c.invalid > 0) {
    lines.push(
      c.invalid === 1
        ? `1 doesn't exist. It's ${leftOutAnd}on the do-not-email list now.`
        : `${num(c.invalid)} don't exist. They're ${leftOutAnd}on the do-not-email list now.`,
    );
  }
  if (c.doNotSend > 0) {
    lines.push(
      `${num(c.doNotSend)} shouldn't be emailed: the check says not to. ${c.doNotSend === 1 ? "It's" : "They're"} ${leftOutAnd}on the do-not-email list now.`,
    );
  }
  if (c.risky > 0) {
    lines.push(`${c.risky === 1 ? "1 is" : `${num(c.risky)} are`} rated high risk. Your check settings skip these.`);
  }
  if (c.catchAllBlocked > 0) lines.push(`${num(c.catchAllBlocked)} can't be confirmed. Your check settings skip these.`);
  if (c.disposable > 0) {
    lines.push(
      c.disposable === 1
        ? "1 is a throwaway address. Your check settings skip these."
        : `${num(c.disposable)} are throwaway addresses. Your check settings skip these.`,
    );
  }
  if (c.unknown > 0) {
    if (inCampaign) {
      lines.push(
        c.unknown === 1
          ? "1 got no answer. It's checked again 24 hours after the first try, and emailed if it passes."
          : `${num(c.unknown)} got no answer. They're checked again 24 hours after the first try, and emailed if they pass.`,
      );
    } else {
      lines.push(
        c.unknown === 1
          ? "1 got no answer. It's tried again after 24 hours when this person is in a campaign."
          : `${num(c.unknown)} got no answer. They're tried again after 24 hours when these people are in a campaign.`,
      );
    }
  }
  if (c.refused > 0) {
    const one = c.refused === 1;
    let line = one ? "1 couldn't be checked: Mailgun refused it." : `${num(c.refused)} couldn't be checked: Mailgun refused them.`;
    if (inCampaign) line += one ? " That person is left out." : " Those people are left out.";
    lines.push(line);
  }
  if (c.notReached > 0) {
    const one = c.notReached === 1;
    let line = inCampaign
      ? one
        ? "1 couldn't be checked right now. It's left out at launch unless you check it again."
        : `${num(c.notReached)} couldn't be checked right now. They're left out at launch unless you check them again.`
      : one
        ? "1 couldn't be checked right now. You can check it again later."
        : `${num(c.notReached)} couldn't be checked right now. You can check them again later.`;
    if (c.mayBeCharged > 0) line += one ? " Mailgun may have charged for it." : " Mailgun may have charged for some of them.";
    lines.push(line);
  }
  lines.push(`Cost ${formatUsd(c.costUsd)}.`);
  return lines;
}

/** The title of `verify.finished`: "Address checks finished" (wizard runs: "… for Germany Q4"). */
export function checkFinishedTitle(campaignName: string | null): string {
  return campaignName ? `Address checks finished for ${campaignName}` : "Address checks finished";
}

/**
 * The recheck run's notice to a campaign's sender (M5-DESIGN §2.11): "1 person in Germany Q4 was left out: their
 * address couldn't be checked. 2 others passed and get their first email."
 */
export function recheckLeftOutNotice(campaignName: string, leftOut: number, released: number): { title: string; body: string } {
  let body =
    leftOut === 1
      ? `1 person in ${campaignName} was left out: their address couldn't be checked.`
      : `${num(leftOut)} people in ${campaignName} were left out: their addresses couldn't be checked.`;
  if (released > 0) {
    body += released === 1 ? " 1 other passed and gets their first email." : ` ${num(released)} others passed and get their first email.`;
  }
  return { title: "Left out after a second address check", body };
}

/** "Checking 40 addresses. You'll get a notification when it's done." (the toast after a start). */
export function checkStartToast(count: number): string {
  return `Checking ${plural(count, "address", "addresses")}. You'll get a notification when it's done.`;
}

// ───────────────────────── cost ─────────────────────────

/**
 * The cost line (M5-DESIGN §2.10): "Cost: about $0.48 (40 checks × $0.012).", partly or fully included in the plan,
 * or free with the test checker; then " Up to $0.02 more if some need a second check tomorrow." when that can cost.
 */
export function checkCostLine(e: CheckEstimate): string {
  let s: string;
  if (e.provider === "fake") {
    s = "Cost: free (the test checker is used here).";
  } else if (e.count === 0) {
    s = "Cost: $0 (nothing to check).";
  } else if (e.paidCount === 0) {
    const left = Math.max(0, e.freeLeft - e.count);
    s = `Cost: free (${num(e.count)} of the ${num(e.includedPerMonth)} checks your Mailgun plan includes this month; ${num(left)} left).`;
  } else if (e.paidCount < e.count) {
    const included = e.count - e.paidCount;
    s = `Cost: ${aboutUsd(e.aboutUsd)} (${plural(e.paidCount, "check", "checks")} × ${pricePerCheckText(e.pricePerCheck)}; ${num(included)} ${included === 1 ? "is" : "are"} included in your plan).`;
  } else {
    s = `Cost: ${aboutUsd(e.aboutUsd)} (${plural(e.count, "check", "checks")} × ${pricePerCheckText(e.pricePerCheck)}).`;
  }
  if (e.recheckExtraUsd > 0) {
    s += ` Up to ${formatUsd(Math.max(0.01, e.recheckExtraUsd))} more if some need a second check tomorrow.`;
  }
  return s;
}

// ───────────────────────── refusals and pauses ─────────────────────────

/** getVerifier's "no key" sentence (M5-DESIGN §2.2); the other not-ready texts are Mailgun's NOT_CONNECTED_TEXT. */
export const NO_CHECK_KEY_TEXT = "Address checks need a Mailgun key. The Owner can connect Mailgun in Settings › Sending & Mailgun.";

/** Contacts and list starts whose count changed since the dialog opened (§6.3, §6.11). */
export const COUNT_CHANGED_TEXT = "The number of addresses changed. Open the dialog again to see the new count and cost.";

/** The Verify step's start when its count changed since the page was loaded. */
export const CAMPAIGN_COUNT_CHANGED_TEXT =
  "The number of addresses changed. Check the new count and cost on this page, then start the checks again.";

/** "That's 7,210 addresses. Check at most 5,000 at a time: tick fewer companies." */
export function tooManyChecksText(count: number): string {
  return `That's ${num(count)} addresses. Check at most ${num(MAX_CHECKS_PER_RUN)} at a time: tick fewer companies.`;
}

/** The panel's 24-hour rule: "anna@firma.de was checked today already." */
export function checkedTodayText(email: string): string {
  return `${email} was checked today already.`;
}

/**
 * A start that would pass this office month's check limit (M5-DESIGN §2.9): "That would pass this month's check limit
 * of $100 ($91.20 used so far). Raise the limit in Settings › Deliverability, or check fewer addresses." A Member is
 * asked to ask the Owner.
 */
export function monthlyLimitRefusal(opts: { limitUsd: number; spentUsd: number; isOwner: boolean }): string {
  const start = `That would pass this month's check limit of ${usdAmountText(opts.limitUsd)} (${formatUsd(opts.spentUsd)} used so far).`;
  return opts.isOwner
    ? `${start} Raise the limit in Settings › Deliverability, or check fewer addresses.`
    : `${start} Ask the Owner to raise the limit in Settings › Deliverability, or check fewer addresses.`;
}

/** The pause sentences (M5-DESIGN §2.12). The monthly limit's needs the limit and the next month's first day. */
export function checkPauseText(kind: CheckPauseKind, opts: { limitUsd?: number; resetLabel?: string } = {}): string {
  switch (kind) {
    case "monthly_limit":
      return (
        `Address checks stopped: this month's check limit of ${usdAmountText(opts.limitUsd ?? 0)} is reached. ` +
        `Raise it in Settings › Deliverability or wait until ${opts.resetLabel ?? "the 1st of next month"}.`
      );
    case "unreadable":
      return "Address checks paused: Mailgun's answers couldn't be read. Run update.bat, then click Resume checks.";
    case "auth":
      return (
        "Address checks paused: Mailgun didn't accept the key. In Mailgun, open API Security, create a key with the " +
        "Developer role and paste it in Settings › Sending & Mailgun (or as the address check key in Settings › " +
        "Deliverability), then click Resume checks."
      );
    case "payment":
      return "Address checks paused: Mailgun refused address checks for a billing or plan reason. Check Billing in Mailgun, then click Resume checks.";
    case "not-allowed":
      return "Address checks paused: Mailgun won't run address checks on this account right now. Check the banner in Mailgun, then click Resume checks.";
    case "business-verification":
      return (
        "Address checks paused: Mailgun is holding your account until business verification is finished. Complete the " +
        "form in the banner at the top of Mailgun, then click Resume checks."
      );
    case "not-found":
      return "Address checks paused: Mailgun didn't recognise the check request. Run update.bat, then click Resume checks.";
    default:
      return "Address checks paused. Open Settings › Deliverability to see why.";
  }
}

/** The title of the `verify.paused` notice: "Address checks paused" ("… stopped" for the monthly limit). */
export function checkPauseTitle(kind: CheckPauseKind): string {
  return kind === "monthly_limit" ? "Address checks stopped" : "Address checks paused";
}
