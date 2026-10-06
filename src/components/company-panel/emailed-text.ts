import { heldReasonsOf } from "@/core/sequences/hold-reasons";
import { holdStateText, recheckStateText, sequenceSuffix, stopStateText } from "@/core/sequences/wording";
import { formatShortDate, timeAgo } from "@/core/time/format";
import { REAL_PROVIDERS } from "@/core/verification/types";
import { dateAtTimeText } from "@/components/checks/run-text";

/**
 * Pure text builders for "who has been emailed" (SPEC §3, PLAN.md B6.1, M4-DESIGN §2.12, §6), used by the
 * company panel's banner and person cards. Browser-safe, no I/O, unit-tested.
 *
 * Example: "Emailed by Ali 12 days ago · Germany Q4 · follow-up 1 · waiting for follow-up 2 on 12 Oct · replied 2 days ago"
 * A test-list mailbox that only got a live test email before go-live reads "Test email sent 24 Sept (test list,
 * doesn't count as emailed) · Test mailboxes · first email · stopped because they replied", never "Never emailed".
 *
 * The sequence words are the panel column of M4-DESIGN §2.12 (lowercase, they follow "·"); the HELD and M4 stop texts
 * and the " (dry run)" / " (test)" / " (test list)" suffix come from @/core/sequences/wording, which the campaign page
 * and the Contacts "Sequence" column use too.
 */

export type SequenceStateValue =
  | "PENDING"
  | "SCHEDULED"
  | "WAITING"
  | "HELD"
  | "RECHECK"
  | "FINISHED"
  | "STOPPED"
  | "EXCLUDED";

export type SendModeValue = "DRY_RUN" | "TEST" | "LIVE";

/** One CampaignRecipient row, reduced to what the text needs. */
export type SequenceInfo = {
  id: number;
  campaignId: number;
  campaignName?: string | null;
  campaignMode?: SendModeValue | null;
  /**
   * `countsAsEmailed(mode, {practiceCopy, launchedGoLive})` (@/core/rules/mode) with the campaign's own launch flag
   * (M6-DESIGN §2.2): live of a campaign launched after go-live, or a dry run in the practice copy. Picks the suffix
   * (M4-DESIGN §2.12): none when true; otherwise " (dry run)" for a dry run and " (test list)" for a live email of a
   * campaign launched before go-live (also after go-live); " (test)" for Mailgun's test mode always.
   */
  countsAsEmailed: boolean;
  personId?: number | null;
  state: SequenceStateValue;
  /**
   * The step this recipient is on: the next step to send while SCHEDULED/WAITING
   * (0 = first email, 1..3 = follow-ups).
   */
  currentStep: number;
  nextDueAt: Date | string | null;
  stopReason: string | null;
  /** While HELD: why ("outage", "possible-reply" or both, comma-joined); ignored in any other state. */
  holdReason?: string | null;
  /** While RECHECK: when the second address check is due (M5-DESIGN §2.7); ignored in any other state. */
  recheckAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

const ACTIVE_STATES: ReadonlySet<SequenceStateValue> = new Set(["SCHEDULED", "WAITING", "HELD", "RECHECK"]);
const SHOWN_STATES: ReadonlySet<SequenceStateValue> = new Set([...ACTIVE_STATES, "FINISHED", "STOPPED"]);

/** States worth showing in the panel (drafts and exclusions say nothing about emailing). */
export const SHOWN_SEQUENCE_STATES: SequenceStateValue[] = [...SHOWN_STATES];

/** 0 → "first email", n → "follow-up n". */
export function stepLabel(step: number | null | undefined): string {
  if (step === null || step === undefined || !Number.isFinite(step)) return "";
  return step <= 0 ? "first email" : `follow-up ${step}`;
}

function toTime(d: Date | string | null | undefined): number {
  if (!d) return Number.NaN;
  return (typeof d === "string" ? new Date(d) : d).getTime();
}

/**
 * Chooses which recipient row describes "the current sequence" of a company or person:
 * an active one first (real campaigns before dry runs, soonest next step first),
 * otherwise the most recent campaign's row.
 */
export function pickSequence<T extends SequenceInfo>(rows: readonly T[]): T | null {
  const shown = rows.filter((r) => SHOWN_STATES.has(r.state));
  if (shown.length === 0) return null;
  const active = shown.filter((r) => ACTIVE_STATES.has(r.state));
  if (active.length > 0) {
    return [...active].sort((a, b) => {
      const dryA = a.campaignMode === "DRY_RUN" ? 1 : 0;
      const dryB = b.campaignMode === "DRY_RUN" ? 1 : 0;
      if (dryA !== dryB) return dryA - dryB;
      const ta = toTime(a.nextDueAt);
      const tb = toTime(b.nextDueAt);
      const na = Number.isNaN(ta);
      const nb = Number.isNaN(tb);
      if (na !== nb) return na ? 1 : -1;
      if (!na && ta !== tb) return ta - tb;
      return b.id - a.id;
    })[0]!;
  }
  return [...shown].sort((a, b) => {
    if (a.campaignId !== b.campaignId) return b.campaignId - a.campaignId;
    const ua = toTime(a.updatedAt);
    const ub = toTime(b.updatedAt);
    if (!Number.isNaN(ua) && !Number.isNaN(ub) && ua !== ub) return ub - ua;
    return b.id - a.id;
  })[0]!;
}

const STOP_REASONS: Record<string, string> = {
  replied: "they replied",
  reply: "they replied",
  company_replied: "someone at the company replied",
  "company-replied": "someone at the company replied",
  companyreplied: "someone at the company replied",
  unsubscribed: "they unsubscribed",
  unsubscribe: "they unsubscribed",
  bounced: "the email bounced",
  bounce: "the email bounced",
  complained: "they marked it as spam",
  complaint: "they marked it as spam",
  status: "the company's status changed",
  status_changed: "the company's status changed",
  manual: "someone stopped it by hand",
  stopped: "someone stopped it by hand",
  skipped: "someone skipped it",
  deleted: "the company was deleted",
  company_deleted: "the company was deleted",
  person_deleted: "the person was removed",
  person_removed: "the person was removed",
  suppressed: "the address is on the do-not-email list",
  suppression: "the address is on the do-not-email list",
  invalid: "the address check said not to email it",
  verification: "the address check said not to email it",
  campaign_cancelled: "the campaign was cancelled",
  cancelled: "the campaign was cancelled",
  failed: "the email couldn't be sent",
};

const STATUS_WORDS: Record<string, string> = {
  REPLIED: "Replied",
  CLIENT: "Client",
  NOT_INTERESTED: "Not interested",
  DO_NOT_CONTACT: "Do not contact",
};

/** Turns a stored stop reason ("replied", "status:CLIENT", …) into words. */
export function stopReasonText(reason: string | null | undefined): string {
  const raw = (reason ?? "").trim();
  if (!raw) return "";
  const key = raw.toLowerCase().replace(/[.\s]+/g, "_");
  if (STOP_REASONS[key]) return STOP_REASONS[key]!;
  const status = raw.match(/^status[:=_\s-]+([A-Z_]+)$/i);
  if (status) {
    const word = STATUS_WORDS[status[1]!.toUpperCase()];
    if (word) return `the company was marked ${word}`;
  }
  // Already a sentence written by the sender code: use it as it is.
  if (/\s/.test(raw)) return raw.charAt(0).toLowerCase() + raw.slice(1).replace(/\.$/, "");
  return raw.replace(/[_-]+/g, " ").toLowerCase();
}

/** What sequenceStateText reads from a recipient row. */
export type SequenceStateInput = Pick<
  SequenceInfo,
  "state" | "currentStep" | "nextDueAt" | "stopReason" | "campaignMode" | "countsAsEmailed" | "holdReason" | "recheckAt"
>;

/**
 * One recipient's sequence in the panel's words (M4-DESIGN §2.12, dates in the viewer's zone): "scheduled for 3 Oct",
 * "waiting for the first email" (due now), "waiting for follow-up 2 on 12 Oct" / "… since 12 Oct" (overdue),
 * "on hold: a possible reply needs checking", "on hold: replies may have been missed while the PC was off",
 * "waiting for re-check on 27 Sept at 14:05" (M5-DESIGN §2.7), "finished", "stopped because they replied", "stopped
 * because someone at the company replied", "stopped because the company was marked Client", "stopped because the
 * address check said not to email it" … plus the suffix (" (dry run)",
 * " (test)", " (test list)"; left out with `suffix: false`, when the text before it already says so). Null for drafts
 * and exclusions.
 */
export function sequenceStateText(
  seq: SequenceStateInput | null | undefined,
  timeZone: string,
  now: Date = new Date(),
  opts: { suffix?: boolean } = {},
): string | null {
  if (!seq) return null;
  const on = seq.nextDueAt ? formatShortDate(seq.nextDueAt, timeZone, now) : "";
  const due = toTime(seq.nextDueAt);
  const overdue = Number.isFinite(due) && due <= now.getTime();
  let text: string | null;
  switch (seq.state) {
    case "SCHEDULED":
      if (seq.currentStep > 0) text = `${stepLabel(seq.currentStep)} scheduled${on ? ` for ${on}` : ""}`;
      else if (overdue) text = "waiting for the first email";
      else text = `scheduled${on ? ` for ${on}` : ""}`;
      break;
    case "WAITING":
      text =
        seq.currentStep > 0
          ? `waiting for ${stepLabel(seq.currentStep)}${on ? ` ${overdue ? "since" : "on"} ${on}` : ""}`
          : `waiting for the first email${on && !overdue ? ` on ${on}` : ""}`;
      break;
    case "HELD":
      text = holdStateText(heldReasonsOf({ state: seq.state, holdReason: seq.holdReason }), "panel");
      break;
    case "RECHECK":
      text = recheckStateText(seq.recheckAt ? dateAtTimeText(seq.recheckAt, timeZone, now) : null, "panel");
      break;
    case "FINISHED":
      text = "finished";
      break;
    case "STOPPED": {
      const m4 = stopStateText(seq.stopReason, "panel");
      if (m4) {
        text = m4;
        break;
      }
      const why = stopReasonText(seq.stopReason);
      text = why ? `stopped because ${why}` : "stopped";
      break;
    }
    default:
      text = null;
  }
  if (!text) return null;
  if (opts.suffix === false) return text;
  return text + sequenceSuffix({ mode: seq.campaignMode ?? null, countsAsEmailed: seq.countsAsEmailed });
}

/**
 * The newest email the app sent that doesn't count as "emailed" (M3-DESIGN §1.7): a live email before go-live (it
 * could only reach a test-list mailbox) or one sent in Mailgun's test mode (accepted, never delivered).
 * `getCompanyDetail` returns it only for a company or person with no counted email.
 */
export type TestSendInfo = {
  sentAt: Date | string;
  mode: "LIVE" | "TEST";
  /** 0 = first email, 1..3 = follow-ups. */
  step: number | null;
  campaignId: number | null;
  campaignName: string | null;
};

/** "Test email sent 24 Sept (test list, doesn't count as emailed)" / "Sent in test mode 24 Sept (not delivered)". */
export function testSendText(t: Pick<TestSendInfo, "sentAt" | "mode">, timeZone: string, now: Date = new Date()): string {
  const on = formatShortDate(t.sentAt, timeZone, now);
  return t.mode === "TEST"
    ? `Sent in test mode ${on} (not delivered)`
    : `Test email sent ${on} (test list, doesn't count as emailed)`;
}

export type EmailedInput = {
  lastEmailedAt: Date | string | null;
  lastEmailedByName: string | null;
  lastEmailedCampaignName: string | null;
  lastEmailedStep: number | null;
  /** Companies only: the "last contacted" date from the old tool. */
  importedLastContactAt?: Date | string | null;
  sequence?: SequenceInfo | null;
  /** The company's latest reply (M4-DESIGN §6 row 2): adds "replied 2 days ago" after the sequence. */
  repliedAt?: Date | string | null;
  /**
   * The newest test email (test list before go-live, or Mailgun's test mode). Used only when nothing counts as
   * emailed, so a test mailbox that got a live test email and replied doesn't read "Never emailed".
   */
  testSend?: TestSendInfo | null;
};

export type EmailedSummary = {
  /** True when an email went out from the app, or the old tool recorded contact. */
  emailed: boolean;
  /**
   * True when only test emails went out (the test list before go-live, or Mailgun's test mode): the text says so,
   * while `emailed` stays false, as for the filters and the 30-day rule.
   */
  testOnly: boolean;
  parts: string[];
  text: string;
};

/**
 * "Emailed by Ali 12 days ago · Germany Q4 · follow-up 1 · waiting for follow-up 2 on 12 Oct",
 * "Contacted in the old tool 12 days ago", "Test email sent 24 Sept (test list, doesn't count as emailed) ·
 * Test mailboxes · first email · stopped because they replied", or "Never emailed" (only when nothing was sent).
 * When the old tool's date is newer than this app's last email, it comes first (the Contacts column shows the newer
 * one too). With `repliedAt`, "replied 2 days ago" comes last ("Never emailed · replied 2 days ago" for a company that
 * wrote before anyone emailed it); `emailed` still says only whether an email that counts went out.
 */
export function emailedSummary(input: EmailedInput, timeZone: string, now: Date = new Date()): EmailedSummary {
  const parts: string[] = [];
  let emailed = false;
  let testOnly = false;
  const oldToolText = input.importedLastContactAt ? `Contacted in the old tool ${timeAgo(input.importedLastContactAt, now)}` : null;
  if (input.lastEmailedAt) {
    emailed = true;
    const oldIsNewer = Boolean(input.importedLastContactAt) && toTime(input.importedLastContactAt) > toTime(input.lastEmailedAt);
    if (oldIsNewer && oldToolText) parts.push(oldToolText);
    const ago = timeAgo(input.lastEmailedAt, now);
    const emailedText = input.lastEmailedByName ? `Emailed by ${input.lastEmailedByName} ${ago}` : `Emailed ${ago}`;
    parts.push(oldIsNewer ? emailedText.charAt(0).toLowerCase() + emailedText.slice(1) : emailedText);
    if (input.lastEmailedCampaignName) parts.push(input.lastEmailedCampaignName);
    const step = stepLabel(input.lastEmailedStep);
    if (step) parts.push(step);
  } else if (oldToolText) {
    emailed = true;
    parts.push(oldToolText);
  } else if (input.testSend && (input.testSend.mode === "LIVE" || input.testSend.mode === "TEST") && input.testSend.sentAt) {
    testOnly = true;
    parts.push(testSendText(input.testSend, timeZone, now));
    if (input.testSend.campaignName) parts.push(input.testSend.campaignName);
    const step = stepLabel(input.testSend.step);
    if (step) parts.push(step);
  } else {
    parts.push("Never emailed");
  }
  // The test email's own words already say "test list" / "test mode": no second suffix for that same campaign.
  const sameCampaign =
    testOnly && input.testSend?.campaignId != null && input.sequence?.campaignId === input.testSend.campaignId;
  const seq = sequenceStateText(input.sequence ?? null, timeZone, now, { suffix: !sameCampaign });
  if (seq) parts.push(seq);
  if (input.repliedAt) parts.push(`replied ${timeAgo(input.repliedAt, now)}`);
  return { emailed, testOnly, parts, text: parts.join(" · ") };
}

/**
 * The newest test email in `rows` (newest first or not): a delivered test-list email wins over Mailgun's test mode,
 * then the latest. Null when there is none. Used by `getCompanyDetail` for the company and for each person.
 */
export function pickTestSend<T extends Pick<TestSendInfo, "sentAt" | "mode">>(rows: readonly T[]): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (r.mode !== "LIVE" && r.mode !== "TEST") continue;
    const t = toTime(r.sentAt);
    if (!Number.isFinite(t)) continue;
    if (!best) {
      best = r;
      continue;
    }
    const liveR = r.mode === "LIVE" ? 1 : 0;
    const liveB = best.mode === "LIVE" ? 1 : 0;
    if (liveR !== liveB) {
      if (liveR > liveB) best = r;
      continue;
    }
    if (t > toTime(best.sentAt)) best = r;
  }
  return best;
}

/** One flag on a person card: the word, its tone and the tooltip (dates in the viewer's zone). */
export type PersonFlag = { label: string; tone: "neutral" | "danger" | "good"; title: string };

/**
 * The flags of a person card (PLAN.md A6 "people: flags"): Unsubscribed, Bounced, Complained, Replied ("Replied on
 * 3 Oct", M4-DESIGN §6 row 3) and Blocked (on the do-not-email list for another reason).
 */
export function personFlags(
  p: {
    unsubscribedAt: Date | string | null;
    bouncedAt: Date | string | null;
    complainedAt: Date | string | null;
    repliedAt: Date | string | null;
    suppressed: boolean;
  },
  timeZone: string,
  now: Date = new Date(),
): PersonFlag[] {
  const flags: PersonFlag[] = [];
  const on = (d: Date | string) => formatShortDate(d, timeZone, now);
  if (p.unsubscribedAt) flags.push({ label: "Unsubscribed", tone: "danger", title: `Unsubscribed on ${on(p.unsubscribedAt)}` });
  if (p.bouncedAt) flags.push({ label: "Bounced", tone: "danger", title: `An email bounced on ${on(p.bouncedAt)}` });
  if (p.complainedAt) flags.push({ label: "Complained", tone: "danger", title: `Marked an email as spam on ${on(p.complainedAt)}` });
  if (p.repliedAt) flags.push({ label: "Replied", tone: "good", title: `Replied on ${on(p.repliedAt)}` });
  if (p.suppressed && !p.unsubscribedAt && !p.bouncedAt && !p.complainedAt) {
    flags.push({ label: "Blocked", tone: "danger", title: "This address is on the do-not-email list." });
  }
  return flags;
}

/** "Written by Ali on 3 Mar" / "Imported" / "AI, approved by Ali on 3 Mar". */
export function personalLineSourceText(
  source: string | null | undefined,
  byName: string | null | undefined,
  at: Date | string | null | undefined,
  timeZone: string,
  now: Date = new Date(),
): string {
  const on = at ? ` on ${formatShortDate(at, timeZone, now)}` : "";
  const who = byName || "a teammate";
  switch (source) {
    case "manual":
      return `Written by ${who}${on}`;
    case "import":
      return "Imported";
    case "ai":
      return `AI, approved by ${who}${on}`;
    default:
      return "";
  }
}

const DEFAULT_REAL_PROVIDERS: ReadonlySet<string> = new Set(REAL_PROVIDERS);

/**
 * "checked 3 Mar", or "" when never checked. A result from a provider that doesn't count for real sending gets
 * " by the test checker" (M5-DESIGN §6.5): the in-process test checker ("fake"), and the fake Mailgun
 * ("mailgun-fake") unless `realProviders` includes it (fake mode). A result stored without a provider counts as real,
 * as eligibility reads it.
 */
export function checkedText(
  verifiedAt: Date | string | null | undefined,
  provider: string | null | undefined,
  timeZone: string,
  now: Date = new Date(),
  realProviders: ReadonlySet<string> = DEFAULT_REAL_PROVIDERS,
): string {
  if (!verifiedAt) return "";
  const base = `checked ${formatShortDate(verifiedAt, timeZone, now)}`;
  return provider && !realProviders.has(provider) ? `${base} by the test checker` : base;
}

/** Words in a personal line (for the "under 25 words" hint). */
export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

export const PERSONAL_LINE_MAX_CHARS = 300;
export const PERSONAL_LINE_GOOD_WORDS = 25;
