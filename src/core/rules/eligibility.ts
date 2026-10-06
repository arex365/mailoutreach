import { COMPANY_STATUS_LABELS, NEVER_EMAIL_STATUSES, type CompanyStatusValue } from "@/core/labels";
import {
  FAILED_CHECK_RETRY_AFTER_DAYS,
  REAL_PROVIDERS,
  UNKNOWN_RECHECK_AFTER_MS,
  type CheckNeed,
} from "@/core/verification/types";
import { DAY_MS, type TeamRuleBlock } from "./team-rule";
import { testListOnly, type SendModeValue } from "./mode";

/**
 * Who can be emailed, and why not (PLAN.md B6.2). Pure: one function used by the wizard, at launch
 * and just before each send (the server gathers the facts in @/server/services/eligibility).
 *
 * Every exclusion has a stable code and a plain sentence. Reasons are listed in the order below;
 * the first one is what the screens show. "company-replied" is the only reason people may override
 * by hand (A5.6: Replied companies are left out by default and can be put back in).
 *
 * Address checks (M5-DESIGN §2.8) are judged per phase: in the campaign draft the "needs a check" codes are pending
 * (the person stays tickable and the Verify step checks them), at launch everything blocks, and at send time the
 * first email measures freshness at the launch while follow-ups rely on the check judged then.
 */

export const ELIGIBILITY_CODES = [
  "no-email",
  "invalid-email",
  "email-changed",
  "not-on-test-list",
  "not-checked",
  "test-checker",
  "check-too-old",
  "check-waiting",
  "check-undeliverable",
  "check-do-not-send",
  "policy-blocked",
  "check-unknown",
  "unsubscribed",
  "bounced",
  "complained",
  "suppressed",
  "company-status",
  "company-replied",
  "team-rule",
  "reserved",
  "duplicate",
  "excluded-by-hand",
  "company-deleted",
  "person-removed",
  "no-reply-route",
] as const;

export type EligibilityCode = (typeof ELIGIBILITY_CODES)[number];

/** Codes that don't block in the draft (M5-DESIGN §2.8 rule 3): the person is tickable and the Verify step checks them. */
export const CHECK_PENDING_CODES = ["not-checked", "test-checker", "check-too-old", "check-waiting"] as const satisfies readonly EligibilityCode[];

/** Reasons people may override by hand. */
export const OVERRIDABLE_CODES = ["company-replied"] as const satisfies readonly EligibilityCode[];
export type OverridableCode = (typeof OVERRIDABLE_CODES)[number];

export function isOverridable(code: EligibilityCode): code is OverridableCode {
  return (OVERRIDABLE_CODES as readonly string[]).includes(code);
}

export type EligibilityReason = {
  code: EligibilityCode;
  /** Plain sentence, e.g. "Unsubscribed" or "Emailed by Ali 12 days ago (Germany Q4, follow-up 1)". */
  text: string;
  /** True when a person may include the recipient anyway (only "company-replied"). */
  overridable: boolean;
  /** The company status behind "company-status" / "company-replied". */
  status?: CompanyStatusValue;
  /** The 30-day rule / reservation details behind "team-rule" / "reserved". */
  teamRule?: TeamRuleBlock;
  /** True for a draft-phase reason that doesn't block (M5-DESIGN §2.8). */
  pending?: boolean;
};

const ORDER = new Map<EligibilityCode, number>(ELIGIBILITY_CODES.map((c, i) => [c, i]));

/** Position of a code in the B6.2 order (lower = shown first). */
export function reasonOrder(code: EligibilityCode): number {
  return ORDER.get(code) ?? ELIGIBILITY_CODES.length;
}

/** Sorts reasons in the B6.2 order and drops repeated codes (the first of each code is kept). */
export function sortReasons(reasons: readonly EligibilityReason[]): EligibilityReason[] {
  const seen = new Set<EligibilityCode>();
  const out: EligibilityReason[] = [];
  for (const r of [...reasons].sort((a, b) => reasonOrder(a.code) - reasonOrder(b.code))) {
    if (seen.has(r.code)) continue;
    seen.add(r.code);
    out.push(r);
  }
  return out;
}

function reason(code: EligibilityCode, text: string, extra: Partial<EligibilityReason> = {}): EligibilityReason {
  return { code, text, overridable: isOverridable(code), ...extra };
}

// ───────────────────────── inputs ─────────────────────────

export type VerificationStatusValue = "VALID" | "INVALID" | "RISKY" | "CATCH_ALL" | "UNKNOWN" | "DO_NOT_SEND";
export type RiskValue = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
export type SuppressionReasonValue = "BOUNCED" | "COMPLAINED" | "UNSUBSCRIBED" | "MANUAL" | "INVALID";

/** Setting "verification.policy": "send" | "block", and for unknown results also "recheck". */
export type VerificationPolicy = {
  deliverableHighRisk: string;
  catchAllLow: string;
  catchAllMedium: string;
  catchAllHigh: string;
  disposable: string;
  unknown: string;
};

export const DEFAULT_VERIFICATION_POLICY: VerificationPolicy = {
  deliverableHighRisk: "block",
  catchAllLow: "send",
  catchAllMedium: "block",
  catchAllHigh: "block",
  disposable: "block",
  unknown: "recheck",
};

export type PersonFacts = {
  id: number;
  email: string | null;
  emailNorm: string | null;
  /** Person.deletedAt is set (removed from the company). */
  deleted: boolean;
  verificationStatus: VerificationStatusValue | null;
  verificationRisk: RiskValue | null;
  verifiedAt: Date | null;
  /** "fake" = the test checker, which counts as "not checked" for real sending. */
  verificationProvider: string | null;
  unsubscribedAt: Date | null;
  bouncedAt: Date | null;
  complainedAt: Date | null;
  /** The address's row on the suppression list, if any. */
  suppression: SuppressionReasonValue | null;
  /** The last check said throwaway (M5). */
  verificationDisposable?: boolean;
  /** Unknown results in a row (M5); missing = 0 (1 when the status is UNKNOWN). */
  verificationUnknowns?: number;
};

export type CompanyFacts = {
  id: number;
  status: CompanyStatusValue;
  deleted: boolean;
};

/** What the campaign knows about this person as a recipient. */
export type RecipientFacts = {
  /** Unticked / excluded by hand (CampaignRecipient.included = false). */
  excludedByHand?: boolean;
  /** Someone else in the same campaign already has this address. */
  duplicate?: boolean;
  /** Reasons a person overrode by hand, e.g. "company-replied". */
  overrides?: ReadonlySet<EligibilityCode>;
  /** Send time: the address the email row was made for; a different current address blocks it. */
  sentToNorm?: string | null;
};

export type EligibilityContext = {
  /** The campaign's mode: address-check rules only apply to TEST and LIVE campaigns. */
  mode: SendModeValue;
  now: Date;
  /** Setting "verification.maxAgeDays". */
  maxCheckAgeDays: number;
  policy: VerificationPolicy;
  /** Setting "sending.testList", normalised. */
  testList: ReadonlySet<string>;
  /**
   * Go-live for this evaluation (M6-DESIGN §2.3): Setting "sending.goLive" in the draft and at launch, the campaign's
   * `launchedGoLive` at send time. TEST always, and LIVE until go-live, only email the test list (`testListOnly`).
   */
  goLive: boolean;
  /** Milestone 3: whether the sender has a working reply route (checked for LIVE only; undefined = not checked). */
  senderHasReplyRoute?: boolean | null;
  senderName?: string | null;
  /** M5-DESIGN §2.8: "draft" makes CHECK_PENDING_CODES non-blocking; default "launch". */
  phase?: "draft" | "launch" | "send";
  /** Freshness is measured at this instant (send time: the campaign's launch). Default `now`. */
  checkAgeAt?: Date;
  /** Send time: the step being sent (≥ 1 ignores freshness and unknown codes). */
  sendStep?: number;
  /** Providers whose results count; default REAL_PROVIDERS. */
  realProviders?: ReadonlySet<string>;
  /**
   * The M3 test-list exception: test-list addresses count as checked. Default: TEST always, LIVE before go-live
   * (M6-DESIGN §2.3). Send time passes `mode === "TEST" || campaign.launchedGoLive !== true` (judged at launch).
   */
  testListCountsAsChecked?: boolean;
};

// ───────────────────────── verification policy ─────────────────────────

export type CheckDecision = "send" | "block" | "recheck" | "undeliverable" | "do-not-send";

function policyValue(v: string | undefined, allowRecheck = false): "send" | "block" | "recheck" {
  if (v === "send") return "send";
  if (allowRecheck && v === "recheck") return "recheck";
  return "block";
}

/**
 * What the verification policy says about one check result (B6.9 table). Unknown settings block. A throwaway
 * (disposable) address that isn't already undeliverable, do-not-send or unknown is blocked unless the policy's
 * `disposable` row says "send" (M5-DESIGN §2.3).
 */
export function checkDecision(
  status: VerificationStatusValue,
  risk: RiskValue | null,
  policy: VerificationPolicy,
  opts: { disposable?: boolean } = {},
): CheckDecision {
  if (opts.disposable && status !== "INVALID" && status !== "DO_NOT_SEND" && status !== "UNKNOWN" && policyValue(policy.disposable) !== "send") {
    return "block";
  }
  switch (status) {
    case "INVALID":
      return "undeliverable";
    case "DO_NOT_SEND":
      return "do-not-send";
    case "VALID":
      return risk === "HIGH" ? policyValue(policy.deliverableHighRisk) : "send";
    case "RISKY":
      return policyValue(policy.deliverableHighRisk);
    case "CATCH_ALL":
      if (risk === "LOW") return policyValue(policy.catchAllLow);
      if (risk === "HIGH") return policyValue(policy.catchAllHigh);
      return policyValue(policy.catchAllMedium);
    case "UNKNOWN":
      return policyValue(policy.unknown, true);
    default:
      return "block";
  }
}

// ───────────────────────── reasons ─────────────────────────

const STATUS_TEXT: Record<CompanyStatusValue, string> = COMPANY_STATUS_LABELS;

/** Reasons that belong to the company (they block every person there). */
export function companyReasons(company: CompanyFacts, teamRule: TeamRuleBlock | null): EligibilityReason[] {
  const out: EligibilityReason[] = [];
  if (NEVER_EMAIL_STATUSES.has(company.status)) {
    out.push(reason("company-status", `Company status is ${STATUS_TEXT[company.status]}`, { status: company.status }));
  } else if (company.status === "REPLIED") {
    out.push(reason("company-replied", "Company status is Replied (you can include it by hand)", { status: "REPLIED" }));
  }
  if (teamRule) out.push(reason(teamRule.kind === "reserved" ? "reserved" : "team-rule", teamRule.text, { teamRule }));
  if (company.deleted) out.push(reason("company-deleted", "The company was deleted"));
  return sortReasons(out);
}

function isRealSendingMode(mode: SendModeValue): boolean {
  return mode === "TEST" || mode === "LIVE";
}

// ───────────────────────── the test list (M6-DESIGN §2.3) ─────────────────────────

/** The sentences of "not-on-test-list": a live campaign before go-live, and Mailgun's test mode (for good, G3). */
export const NOT_ON_TEST_LIST_TEXT = {
  live: "Not on the test list (until you go live, only test-list addresses get real email)",
  test: "Not on the test list (Test mode only emails your test list)",
} as const;

/** The "not-on-test-list" sentence for a campaign in this mode (the eligibility rules and the sending loop's skips). */
export function notOnTestListText(mode: SendModeValue | null | undefined): string {
  return mode === "TEST" ? NOT_ON_TEST_LIST_TEXT.test : NOT_ON_TEST_LIST_TEXT.live;
}

// ───────────────────────── address checks (M5-DESIGN §2.8) ─────────────────────────

/** The sentences of the check codes (M5-DESIGN §2.8 rules 1, 2 and 4). */
export const CHECK_REASON_TEXT = {
  notChecked: "Address not checked yet",
  testChecker: "Only checked by the test checker",
  retryAfterUnknowns: "Couldn't be checked last time; it can be checked again",
  waiting: "Waiting for re-check: the address check got no answer, so it's checked again 24 hours later",
  waitingDryRun: "The address check got no answer. Dry runs don't check addresses again, so this person is left out.",
  unknownTwice: "Couldn't be checked: the address check got no answer twice",
} as const;

/** "Last checked more than 90 days ago" (rule 1). */
export function checkTooOldText(maxCheckAgeDays: number): string {
  return `Last checked more than ${maxCheckAgeDays} days ago`;
}

/** The codes of rule 1: the address needs a (real, fresh) check. */
const NEEDS_CHECK_CODES: ReadonlySet<EligibilityCode> = new Set(["not-checked", "test-checker", "check-too-old"]);
const PENDING_CODES: ReadonlySet<EligibilityCode> = new Set(CHECK_PENDING_CODES);

/** True for the rule-1 codes ("not-checked", "test-checker", "check-too-old"). */
export function isNeedsCheckCode(code: EligibilityCode): boolean {
  return NEEDS_CHECK_CODES.has(code);
}

/** True for a code of CHECK_PENDING_CODES (the rule-1 codes and "check-waiting"). */
export function isCheckPendingCode(code: EligibilityCode): boolean {
  return PENDING_CODES.has(code);
}

/**
 * Whether results of this provider count for TEST/LIVE sending (`ctx.realProviders`, default REAL_PROVIDERS). A
 * result with no provider recorded counts, as it did before M5: the app never writes one (every check records its
 * provider, and an address change clears both), so only hand-made data has it.
 */
function isRealProvider(provider: string | null, ctx: EligibilityContext): boolean {
  if (!provider) return true;
  return ctx.realProviders ? ctx.realProviders.has(provider) : REAL_PROVIDERS.includes(provider);
}

/**
 * Reasons that belong to the person's address.
 *
 * Address checks (M5-DESIGN §2.8), for TEST/LIVE unless the address is a test-list one that counts as checked:
 *  1. needs a check: "not-checked", "test-checker" (any provider not in `realProviders`), "check-too-old" (older than
 *     `maxCheckAgeDays` at `checkAgeAt`; also for two or more unknowns in a row that are 30 days old or more);
 *  2. unknown results (every mode, 1 unknown when the counter is missing): one → "check-waiting" (a DRY_RUN words it
 *     as left out), two or more within 30 days → "check-unknown"; with the policy "block", one → "policy-blocked";
 *  3. the draft phase marks the codes of rules 1 and 2 as pending (not blocking), except a dry run's "check-waiting";
 *  5. follow-ups at send time (`sendStep` ≥ 1) ignore rules 1 and 2 (the check that counted was the one at launch);
 *  7. a throwaway address is "policy-blocked" unless the policy says send.
 * Other results (undeliverable, do not send, the policy rows) apply in every mode and phase, except that a policy block
 * of a result older than the maximum age gives way to its "check-too-old" (it is checked again, M5-DESIGN §2.7);
 * undeliverable and do-not-send stay (they are on the do-not-email list anyway).
 */
export function personReasons(person: PersonFacts, ctx: EligibilityContext): { reasons: EligibilityReason[]; notes: string[] } {
  const out: EligibilityReason[] = [];
  const notes: string[] = [];
  if (person.deleted) out.push(reason("person-removed", "This person was removed from the company"));

  if (!person.email || !person.emailNorm) {
    out.push(reason("no-email", "No email address"));
    return { reasons: sortReasons(out), notes };
  }
  // Stored addresses are validated on the way in; this catches anything older or hand-made.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(person.emailNorm)) {
    out.push(reason("invalid-email", "The email address isn't valid"));
  }

  const phase = ctx.phase ?? "launch";
  const followUp = phase === "send" && (ctx.sendStep ?? 0) >= 1;
  const norm = person.emailNorm;
  const onTestList = ctx.testList.has(norm);
  // TEST/LIVE addresses need a real, fresh check, except test-list addresses while they count as checked.
  let needsRealCheck = false;
  if (isRealSendingMode(ctx.mode)) {
    // Test mode for good, live until go-live: only the test list (M6-DESIGN §2.3, G3).
    if (testListOnly(ctx.mode, ctx.goLive)) {
      if (onTestList) notes.push("On test list");
      else out.push(reason("not-on-test-list", notOnTestListText(ctx.mode)));
    }
    // Test-list addresses count as checked in test mode, and in live campaigns before go-live (Milestone 3 runs test
    // campaigns before address checks exist). Send time judges this at launch instead (`testListCountsAsChecked`,
    // M5-DESIGN §2.8); absent, it is `mode === "TEST" || !goLive`.
    const countsAsChecked = onTestList && (ctx.testListCountsAsChecked ?? (ctx.mode === "TEST" || !ctx.goLive));
    needsRealCheck = !countsAsChecked;
  }

  const status = person.verificationStatus;
  const verifiedAt = person.verifiedAt;
  const checked = Boolean(status && verifiedAt);
  const realResult = checked && isRealProvider(person.verificationProvider, ctx);
  // Whole milliseconds between the check and the instant freshness is judged at (the launch, at send time).
  const ageMs = verifiedAt ? (ctx.checkAgeAt ?? ctx.now).getTime() - verifiedAt.getTime() : 0;

  // Rule 1: the address needs a check.
  let staleVerdict = false;
  if (needsRealCheck && !followUp) {
    if (!checked) {
      out.push(reason("not-checked", CHECK_REASON_TEXT.notChecked));
    } else if (!realResult) {
      out.push(reason("test-checker", CHECK_REASON_TEXT.testChecker));
    } else if (status !== "UNKNOWN" && ageMs > ctx.maxCheckAgeDays * DAY_MS) {
      out.push(reason("check-too-old", checkTooOldText(ctx.maxCheckAgeDays)));
      staleVerdict = true;
    }
  }

  if (status === "UNKNOWN") {
    // Rule 2. A result that doesn't count for real sending (the test checker) is already "test-checker" above.
    const resultCounts = !(needsRealCheck && !realResult);
    if (!followUp && resultCounts) {
      const r = unknownReason(person, ctx, { needsRealCheck, ageMs });
      if (r) out.push(r);
    }
  } else if (status) {
    // A check result is respected in every mode (a dry run shows what live sending would do).
    const disposable = person.verificationDisposable === true;
    const decision = checkDecision(status, person.verificationRisk, ctx.policy, { disposable });
    if (decision === "undeliverable") {
      out.push(reason("check-undeliverable", "The address check said this address doesn't exist"));
    } else if (decision === "do-not-send") {
      out.push(reason("check-do-not-send", "The address check said not to email this address"));
    } else if (decision === "block" && !staleVerdict) {
      // A verdict older than the maximum age no longer decides (as a stale "can be emailed" no longer counts): its
      // "check-too-old" stands for it, so the Verify step checks it again (§2.7) instead of leaving it out for good.
      // Worded as throwaway only when that row is what skips it (a throwaway the policy lets through may be risky).
      const throwaway = disposable && policyValue(ctx.policy.disposable) !== "send";
      out.push(reason("policy-blocked", policyBlockedText(status, person.verificationRisk, { disposable: throwaway })));
    }
  }

  // Rule 3: in the draft the "needs a check" codes don't block (a dry run's "check-waiting" does: no re-checks there).
  if (phase === "draft") {
    for (const r of out) {
      if (PENDING_CODES.has(r.code) && !(r.code === "check-waiting" && ctx.mode === "DRY_RUN")) r.pending = true;
    }
  }

  if (person.unsubscribedAt || person.suppression === "UNSUBSCRIBED") out.push(reason("unsubscribed", "Unsubscribed"));
  if (person.bouncedAt || person.suppression === "BOUNCED") out.push(reason("bounced", "An earlier email to this address bounced"));
  if (person.complainedAt || person.suppression === "COMPLAINED") out.push(reason("complained", "Marked an earlier email as spam"));
  if (person.suppression === "MANUAL") out.push(reason("suppressed", "On the do-not-email list"));
  if (person.suppression === "INVALID") out.push(reason("suppressed", "On the do-not-email list (the address doesn't exist)"));

  if (ctx.mode === "LIVE" && ctx.senderHasReplyRoute === false) {
    const who = ctx.senderName?.trim() || "The sender";
    out.push(reason("no-reply-route", `${who} has no working reply route yet, so replies couldn't reach them`));
  }
  return { reasons: sortReasons(out), notes };
}

/**
 * Rule 2 for an UNKNOWN result (`max(1, verificationUnknowns)` unknowns in a row): null when the policy says send
 * unknown results anyway (not offered on the settings page, but a stored value is honoured).
 */
function unknownReason(
  person: PersonFacts,
  ctx: EligibilityContext,
  facts: { needsRealCheck: boolean; ageMs: number },
): EligibilityReason | null {
  const decision = checkDecision("UNKNOWN", person.verificationRisk, ctx.policy);
  if (decision === "send") return null;
  const unknowns = Math.max(1, Math.floor(person.verificationUnknowns ?? 0));
  if (unknowns >= 2) {
    // Two "no answer"s in a row: nothing automatic for 30 days, then a campaign may check it again (rule 1).
    if (facts.needsRealCheck && facts.ageMs >= FAILED_CHECK_RETRY_AFTER_DAYS * DAY_MS) {
      return reason("check-too-old", CHECK_REASON_TEXT.retryAfterUnknowns);
    }
    return reason("check-unknown", CHECK_REASON_TEXT.unknownTwice);
  }
  if (decision === "block") return reason("policy-blocked", policyBlockedText("UNKNOWN", person.verificationRisk));
  return reason("check-waiting", ctx.mode === "DRY_RUN" ? CHECK_REASON_TEXT.waitingDryRun : CHECK_REASON_TEXT.waiting);
}

/**
 * Where a person stands with checks (M5-DESIGN §2.8 rule 8), from the reasons `personReasons` gave in `ctx`:
 * "check" for a rule-1 code, "second-check" for "check-waiting" whose 24 hours are over, "wait" inside them, and
 * "none" otherwise (a dry run never checks again, and follow-ups never need a check).
 */
export function checkNeedFromReasons(
  reasons: readonly EligibilityReason[],
  person: Pick<PersonFacts, "verifiedAt">,
  ctx: Pick<EligibilityContext, "mode" | "now">,
): CheckNeed {
  if (reasons.some((r) => NEEDS_CHECK_CODES.has(r.code))) return "check";
  if (ctx.mode !== "DRY_RUN" && reasons.some((r) => r.code === "check-waiting")) {
    if (!person.verifiedAt) return "second-check";
    return ctx.now.getTime() - person.verifiedAt.getTime() >= UNKNOWN_RECHECK_AFTER_MS ? "second-check" : "wait";
  }
  return "none";
}

/** The policy sentence (exported for P4's RECHECK settling). */
export function policyBlockedText(status: VerificationStatusValue, risk: RiskValue | null, opts: { disposable?: boolean } = {}): string {
  if (opts.disposable && status !== "UNKNOWN") return "A throwaway address; your check settings skip these";
  if (status === "UNKNOWN") return "The address check got no answer; your check settings skip these";
  const riskWord = risk === "LOW" ? "low" : risk === "HIGH" ? "high" : risk === "MEDIUM" ? "medium" : "unknown";
  if (status === "CATCH_ALL") return `Can't confirm this address (${riskWord} risk); your check settings skip these`;
  return "The address check rated this address high risk; your check settings skip these";
}

/** Reasons that come from the campaign's own recipient list. */
export function recipientReasons(person: PersonFacts, recipient: RecipientFacts | undefined): EligibilityReason[] {
  const out: EligibilityReason[] = [];
  if (!recipient) return out;
  if (recipient.sentToNorm && person.emailNorm && recipient.sentToNorm !== person.emailNorm) {
    out.push(reason("email-changed", "The email address changed after this email was prepared"));
  }
  if (recipient.duplicate) out.push(reason("duplicate", "Same address as another person in this campaign"));
  if (recipient.excludedByHand) out.push(reason("excluded-by-hand", "Excluded by hand"));
  return out;
}

export type EligibilityResult = {
  eligible: boolean;
  /** Every reason, in B6.2 order (overridden and pending ones included). */
  reasons: EligibilityReason[];
  /** The reasons that actually block (not overridden, not pending), in order. */
  blocking: EligibilityReason[];
  /** The first blocking reason (what the screens show), or null when eligible. */
  reason: EligibilityReason | null;
  /** Informational notes such as "On test list". */
  notes: string[];
  /** Draft-phase reasons that don't block (shown as notes). */
  pending: EligibilityReason[];
  /** Where the address stands with checks in this context (M5-DESIGN §2.8 rule 8). */
  checkNeed: CheckNeed;
};

/** Evaluates one person as a recipient of one campaign. */
export function evaluateEligibility(input: {
  company: CompanyFacts;
  person: PersonFacts;
  teamRule: TeamRuleBlock | null;
  recipient?: RecipientFacts;
  ctx: EligibilityContext;
}): EligibilityResult {
  const p = personReasons(input.person, input.ctx);
  const reasons = sortReasons([
    ...p.reasons,
    ...companyReasons(input.company, input.teamRule),
    ...recipientReasons(input.person, input.recipient),
  ]);
  const overrides = input.recipient?.overrides;
  const blocking = reasons.filter((r) => !r.pending && !(r.overridable && overrides?.has(r.code)));
  return {
    eligible: blocking.length === 0,
    reasons,
    blocking,
    reason: blocking[0] ?? null,
    notes: p.notes,
    pending: reasons.filter((r) => r.pending === true),
    checkNeed: checkNeedFromReasons(p.reasons, input.person, input.ctx),
  };
}

// ───────────────────────── stop reasons ─────────────────────────

/**
 * What to store in CampaignRecipient.stopReason when a recipient is stopped because of this reason.
 * Uses the keys the company panel already words nicely ("they unsubscribed", "the company was
 * marked Client" …); other reasons are stored as their sentence.
 */
export function stopReasonFor(r: EligibilityReason): string {
  switch (r.code) {
    case "unsubscribed":
    case "bounced":
    case "complained":
    case "suppressed":
      return r.code;
    case "check-undeliverable":
    case "check-do-not-send":
      return "invalid";
    case "company-status":
    case "company-replied":
      return `status:${r.status ?? "REPLIED"}`;
    case "company-deleted":
      return "company_deleted";
    case "person-removed":
      return "person_removed";
    default:
      return r.text;
  }
}

// ───────────────────────── overrides stored on the recipient ─────────────────────────

/**
 * Overrides live in CampaignRecipient.warnings (a JSON object) under the key "overrides", e.g.
 * { "overrides": ["company-replied"] }. Anything else in that object is left alone. Reading is
 * fail-safe: a missing or malformed value means "no overrides", so the recipient stays excluded.
 */
export function readRecipientOverrides(warnings: unknown): Set<OverridableCode> {
  const out = new Set<OverridableCode>();
  if (!warnings || typeof warnings !== "object" || Array.isArray(warnings)) return out;
  const list = (warnings as { overrides?: unknown }).overrides;
  if (!Array.isArray(list)) return out;
  for (const v of list) if (typeof v === "string" && isOverridable(v as EligibilityCode)) out.add(v as OverridableCode);
  return out;
}

/** Returns a new warnings object with the override switched on or off (other keys kept). */
export function withRecipientOverride(warnings: unknown, code: OverridableCode, on: boolean): Record<string, unknown> {
  const base: Record<string, unknown> =
    warnings && typeof warnings === "object" && !Array.isArray(warnings) ? { ...(warnings as Record<string, unknown>) } : {};
  const set = readRecipientOverrides(base);
  if (on) set.add(code);
  else set.delete(code);
  if (set.size === 0) delete base.overrides;
  else base.overrides = [...set];
  return base;
}
