import type { SendMode } from "@/generated/prisma/client";
import { GENERAL_INBOX_NAME, parseEmail } from "@/core/email-address";
import { NEVER_EMAIL_STATUSES, type CompanyStatusValue } from "@/core/labels";
import {
  isCheckPendingCode,
  isNeedsCheckCode,
  readRecipientOverrides,
  type PersonFacts,
  type RecipientFacts,
  type RiskValue,
  type VerificationStatusValue,
} from "@/core/rules/eligibility";
import type { CheckPauseState } from "@/core/system-state";
import type { CheckEstimate } from "@/core/verification/estimate";
import { checkNeedOf, liveCheckContext, needsCheck } from "@/core/verification/need";
import { checkBucket } from "@/core/verification/policy";
import { MAX_CHECKS_PER_RUN } from "@/core/verification/types";
import { leftOutWords } from "@/core/verification/words";
import { db } from "@/server/db";
import {
  evaluateCompanies,
  loadEligibilitySettings,
  type EligibilitySettings,
  type PersonEligibility,
} from "@/server/services/eligibility";
import { getSettings } from "@/server/settings";
import { estimateFor, loadCheckPricing } from "./estimate";
import { getChecksPause } from "./pause";
import { campaignCheckRun, CheckRunError, type CampaignCheckRunInfo, type CheckLeftOut } from "./runs";
import { monthlyCheckLimit, type MonthlyCheckLimit } from "./spend";

/**
 * Who a check run would check, and what it would cost (M5-DESIGN §2.8 rule 8, §2.9, §6.1, §6.3).
 *
 * Contacts and list checks count under the live check context (what a live campaign after go-live would need),
 * whatever the sending mode: every live person with an email at the companies, left out without paying when they
 * have no (valid) email, are on the do-not-email list or flagged unsubscribed / bounced / complained, or their company
 * is never emailed (Client, Not interested, Do not contact). Deleted companies and removed people aren't counted.
 *
 * The Verify step counts the campaign's ticked people with the campaign's own context in the launch phase: only
 * those whose every blocking reason is a "needs a check" code (or a due second check) are checked, so nobody pays to
 * check an address that is left out anyway (the 30-day rule, a reservation, the test list…).
 */

/** Companies one Contacts start may cover (the bulk-action limit). */
export const CHECK_COMPANY_LIMIT = 10_000;
const IN_CHUNK = 400;

export const CHECK_LIST_GONE =
  "That list doesn't exist any more: someone may have just deleted it. Refresh the page to see the current lists.";
export const CHECK_CAMPAIGN_GONE = "This campaign doesn't exist any more. Refresh the page to see the latest.";

async function inChunks<T, R>(values: readonly T[], fn: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
  const unique = [...new Set(values)];
  const out: R[] = [];
  for (let i = 0; i < unique.length; i += IN_CHUNK) out.push(...(await fn(unique.slice(i, i + IN_CHUNK))));
  return out;
}

/** Distinct positive integer ids; more than CHECK_COMPANY_LIMIT is refused in plain words. */
export function cleanCompanyIds(input: readonly number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const raw of input) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (out.length > CHECK_COMPANY_LIMIT) {
    throw new CheckRunError(
      `You can check the addresses of up to ${CHECK_COMPANY_LIMIT.toLocaleString("en-US")} companies at a time ` +
        `(you ticked ${out.length.toLocaleString("en-US")}). Tick fewer and try again.`,
      "too-many-companies",
    );
  }
  return out;
}

// ───────────────────────── Contacts and lists ─────────────────────────

export type ContactsCheckInput = { companyIds: number[] } | { listId: number };

export type ContactsCheckView = {
  /** Companies counted (deleted ones aren't). */
  companies: number;
  /** Their people: need + recent + wait + cannot. */
  addresses: number;
  /** "40 need a check" (never checked, only by the test checker, too old, or a due second check). */
  need: number;
  /** "8 were checked in the last 90 days" (a fresh result, or two "no answer"s less than 30 days ago). */
  recent: number;
  /** "2 got no answer less than 24 hours ago; they can be checked again after that." */
  wait: number;
  /** "4 can't be checked: no email address, on the do-not-email list, or never emailed (company status)." */
  cannot: number;
  /** The people "Check N addresses" checks, by person id. */
  targets: number[];
  /** The people "Check these again too" adds (the recent and the waiting ones), by person id. */
  recentTargets: number[];
  /** For `need` addresses. */
  estimate: CheckEstimate;
  notReady: string | null;
  pause: CheckPauseState;
  /** `need` is more than MAX_CHECKS_PER_RUN (5,000): tick fewer companies. */
  tooMany: boolean;
  /** Against `estimate`; recompute with `allEstimate.aboutUsd` when "Check these again too" is ticked. */
  monthly: MonthlyCheckLimit;
  /** The list's name for a list start ("Germany Q4 · 45 companies · 61 addresses"), else null. */
  listName: string | null;
  /** The estimate with "Check these again too" (need + recent + wait addresses). */
  allEstimate: CheckEstimate;
};

type ContactsScan = {
  companies: number;
  listName: string | null;
  need: number[];
  recent: number[];
  wait: number[];
  cannot: number;
};

const PERSON_CHECK_SELECT = {
  id: true,
  companyId: true,
  email: true,
  emailNorm: true,
  verificationStatus: true,
  verificationRisk: true,
  verifiedAt: true,
  verificationProvider: true,
  verificationDisposable: true,
  verificationUnknowns: true,
  unsubscribedAt: true,
  bouncedAt: true,
  complainedAt: true,
} as const;

/** The companies of a Contacts selection or a list (not deleted), and the list's name. */
async function companiesOf(input: ContactsCheckInput): Promise<{ companies: Array<{ id: number; status: string }>; listName: string | null }> {
  let ids: number[];
  let listName: string | null = null;
  if ("listId" in input) {
    const list = await db.list.findUnique({ where: { id: input.listId }, select: { name: true } });
    if (!list) throw new CheckRunError(CHECK_LIST_GONE, "list-gone");
    listName = list.name;
    ids = (await db.companyList.findMany({ where: { listId: input.listId }, select: { companyId: true } })).map((r) => r.companyId);
  } else {
    ids = cleanCompanyIds(input.companyIds);
  }
  const companies = await inChunks(ids, (c) =>
    db.company.findMany({ where: { id: { in: c }, deletedAt: null }, select: { id: true, status: true } }),
  );
  return { companies, listName };
}

/** Sorts every live person at the companies into need / recent / wait / cannot (live check context). */
async function scanContacts(input: ContactsCheckInput, now: Date, settings: EligibilitySettings): Promise<ContactsScan> {
  const { companies, listName } = await companiesOf(input);
  const statusOf = new Map(companies.map((c) => [c.id, c.status as CompanyStatusValue]));
  const people = await inChunks(
    companies.map((c) => c.id),
    (c) => db.person.findMany({ where: { companyId: { in: c }, deletedAt: null }, select: PERSON_CHECK_SELECT }),
  );
  people.sort((a, b) => a.id - b.id);
  const norms = people.map((p) => p.emailNorm).filter((e): e is string => Boolean(e));
  const suppressed = new Set(
    (await inChunks(norms, (c) => db.suppression.findMany({ where: { emailNorm: { in: c } }, select: { emailNorm: true } }))).map(
      (s) => s.emailNorm,
    ),
  );
  const live = liveCheckContext(settings, now);
  const scan: ContactsScan = { companies: companies.length, listName, need: [], recent: [], wait: [], cannot: 0 };
  for (const p of people) {
    const status = statusOf.get(p.companyId);
    if (
      !p.email ||
      !p.emailNorm ||
      !parseEmail(p.email) ||
      suppressed.has(p.emailNorm) ||
      p.unsubscribedAt ||
      p.bouncedAt ||
      p.complainedAt ||
      (status !== undefined && NEVER_EMAIL_STATUSES.has(status))
    ) {
      scan.cannot += 1;
      continue;
    }
    const facts: PersonFacts = {
      id: p.id,
      email: p.email,
      emailNorm: p.emailNorm,
      deleted: false,
      verificationStatus: p.verificationStatus as VerificationStatusValue | null,
      verificationRisk: p.verificationRisk as RiskValue | null,
      verifiedAt: p.verifiedAt,
      verificationProvider: p.verificationProvider,
      verificationDisposable: p.verificationDisposable,
      verificationUnknowns: p.verificationUnknowns,
      unsubscribedAt: null,
      bouncedAt: null,
      complainedAt: null,
      suppression: null,
    };
    const need = checkNeedOf(facts, live);
    if (needsCheck(need)) scan.need.push(p.id);
    else if (need === "wait") scan.wait.push(p.id);
    else scan.recent.push(p.id);
  }
  return scan;
}

/** The people a Contacts or list start would check now (the start re-counts before it enqueues). */
export async function contactsCheckTargets(
  input: ContactsCheckInput,
  opts: { now?: Date; recheckRecent?: boolean } = {},
): Promise<{ personIds: number[]; need: number; listName: string | null }> {
  const scan = await scanContacts(input, opts.now ?? new Date(), await loadEligibilitySettings());
  const personIds = opts.recheckRecent ? [...scan.need, ...scan.recent, ...scan.wait].sort((a, b) => a - b) : scan.need;
  return { personIds, need: scan.need.length, listName: scan.listName };
}

/** The Contacts and list "Check emails" dialog (M5-DESIGN §6.3): counts, cost, the monthly limit and readiness. */
export async function contactsCheckView(input: ContactsCheckInput, now: Date = new Date()): Promise<ContactsCheckView> {
  const settings = await loadEligibilitySettings();
  const [scan, pricing, pause] = await Promise.all([scanContacts(input, now, settings), loadCheckPricing(now), getChecksPause(now)]);
  const estimate = estimateFor(pricing, scan.need.length);
  const recentTargets = [...scan.recent, ...scan.wait].sort((a, b) => a - b);
  const allEstimate = estimateFor(pricing, scan.need.length + recentTargets.length);
  return {
    companies: scan.companies,
    addresses: scan.need.length + scan.recent.length + scan.wait.length + scan.cannot,
    need: scan.need.length,
    recent: scan.recent.length,
    wait: scan.wait.length,
    cannot: scan.cannot,
    targets: scan.need,
    recentTargets,
    estimate,
    notReady: pricing.checker.notReady,
    pause,
    tooMany: scan.need.length > MAX_CHECKS_PER_RUN,
    monthly: await monthlyCheckLimit(estimate.aboutUsd, { now, spentUsd: pricing.spentUsd }),
    listName: scan.listName,
    allEstimate,
  };
}

// ───────────────────────── the Verify step ─────────────────────────

export type CampaignCheckView = {
  mode: "DRY_RUN" | "TEST" | "LIVE";
  goLive: boolean;
  practiceCopy: boolean;
  /** No key / unreadable key / a key that doesn't fit the server. */
  notReady: string | null;
  pause: CheckPauseState;
  need: { total: number; notChecked: number; tooOld: number; testChecker: number; secondCheck: number };
  /** need.total > MAX_CHECKS_PER_RUN: the button checks the first 5,000 (by person id). */
  tooMany: boolean;
  /** First unknowns inside their 24 hours ("2 addresses wait for their second check…"). */
  waiting: number;
  /** Otherwise eligible and no check needed ("112 addresses are already checked."). */
  fine: number;
  /** For min(need.total, MAX_CHECKS_PER_RUN) addresses. */
  estimate: CheckEstimate;
  monthly: MonthlyCheckLimit;
  run: CampaignCheckRunInfo | null;
  leftOutByChecks: CheckLeftOut[];
  /** Dry run: "check them anyway" under the live check context. Null for test and live campaigns. */
  optional: { count: number; estimate: CheckEstimate } | null;
};

type CampaignScan = {
  campaignStatus: string;
  mode: SendMode;
  goLive: boolean;
  practiceCopy: boolean;
  need: CampaignCheckView["need"];
  /** The people to check, by person id (every one of them; a run takes the first 5,000). */
  needIds: number[];
  waiting: number;
  fine: number;
  leftOut: CheckLeftOut[];
  /** Dry runs only: people the live check context would check. */
  optionalIds: number[] | null;
};

/** A person's check facts back from their evaluation (flags and suppressions don't matter for the check need). */
function checkFactsOf(p: PersonEligibility): PersonFacts {
  return {
    id: p.personId,
    email: p.email,
    emailNorm: p.emailNorm,
    deleted: p.deleted,
    verificationStatus: p.verificationStatus,
    verificationRisk: p.verificationRisk,
    verifiedAt: p.verifiedAt,
    verificationProvider: p.verificationProvider,
    verificationDisposable: p.verificationDisposable,
    verificationUnknowns: p.verificationUnknowns,
    unsubscribedAt: null,
    bouncedAt: null,
    complainedAt: null,
    suppression: null,
  };
}

function displayName(p: PersonEligibility): string {
  if (p.isGeneric) return GENERAL_INBOX_NAME;
  return p.name.trim() || p.email || "No name";
}

function sendModeOf(v: unknown): SendMode {
  return v === "TEST" || v === "LIVE" ? v : "DRY_RUN";
}

/** The campaign's mode (a draft: the one it would launch with, Setting "sending.mode"). */
async function campaignOf(campaignId: number): Promise<{ id: number; status: string; mode: SendMode }> {
  const c = await db.campaign.findUnique({ where: { id: campaignId }, select: { id: true, status: true, mode: true } });
  if (!c) throw new CheckRunError(CHECK_CAMPAIGN_GONE, "not-found");
  if (c.status !== "DRAFT") return { id: c.id, status: c.status, mode: c.mode ?? "DRY_RUN" };
  const s = await getSettings(["sending.mode"] as const);
  return { id: c.id, status: c.status, mode: sendModeOf(s["sending.mode"]) };
}

/** The campaign's ticked people, evaluated in `phase` with the campaign's own context. */
async function evaluateTicked(campaignId: number, mode: SendMode, phase: "draft" | "launch", now: Date, settings: EligibilitySettings) {
  const rows = await db.campaignRecipient.findMany({
    where: { campaignId, included: true },
    select: { companyId: true, personId: true, warnings: true },
    orderBy: { id: "asc" },
  });
  const facts = new Map<number, RecipientFacts>(
    rows.map((r) => [r.personId, { excludedByHand: false, overrides: readRecipientOverrides(r.warnings) }]),
  );
  const evaluated = await evaluateCompanies(
    rows.map((r) => r.companyId),
    { mode, campaignId, now, settings, recipients: facts, personIds: rows.map((r) => r.personId), phase },
  );
  const byPerson = new Map<number, { person: PersonEligibility; companyId: number; companyName: string }>();
  for (const company of evaluated.values()) {
    for (const person of company.people) byPerson.set(person.personId, { person, companyId: company.companyId, companyName: company.name });
  }
  const out: Array<{ person: PersonEligibility; companyId: number; companyName: string }> = [];
  for (const r of rows) {
    const hit = byPerson.get(r.personId);
    if (hit) out.push(hit);
  }
  return out;
}

/** The Verify step's counts for a campaign (launch phase, the campaign's own context). */
async function scanCampaign(campaignId: number, now: Date): Promise<CampaignScan> {
  const campaign = await campaignOf(campaignId);
  const settings = await loadEligibilitySettings();
  const ticked = await evaluateTicked(campaignId, campaign.mode, "launch", now, settings);
  const scan: CampaignScan = {
    campaignStatus: campaign.status,
    mode: campaign.mode,
    goLive: settings.goLive,
    practiceCopy: settings.practiceCopy,
    need: { total: 0, notChecked: 0, tooOld: 0, testChecker: 0, secondCheck: 0 },
    needIds: [],
    waiting: 0,
    fine: 0,
    leftOut: [],
    optionalIds: campaign.mode === "DRY_RUN" ? [] : null,
  };
  const live = liveCheckContext(settings, now);
  const seen = new Set<string>();
  for (const { person: p, companyName } of ticked) {
    // Distinct addresses (defensive: an address belongs to one person).
    if (p.emailNorm) {
      if (seen.has(p.emailNorm)) continue;
      seen.add(p.emailNorm);
    }
    const blocking = p.blocking.filter((r) => r.code !== "excluded-by-hand");
    if (scan.optionalIds && blocking.every((r) => r.code === "check-waiting") && needsCheck(checkNeedOf(checkFactsOf(p), live))) {
      scan.optionalIds.push(p.personId);
    }
    if (blocking.length === 0) {
      scan.fine += 1;
      continue;
    }
    if (blocking.every((r) => isCheckPendingCode(r.code)) && p.checkNeed !== "none") {
      if (p.checkNeed === "wait") {
        scan.waiting += 1;
        continue;
      }
      const code = blocking.find((r) => isNeedsCheckCode(r.code))?.code;
      if (code === "not-checked") scan.need.notChecked += 1;
      else if (code === "check-too-old") scan.need.tooOld += 1;
      else if (code === "test-checker") scan.need.testChecker += 1;
      else scan.need.secondCheck += 1;
      scan.need.total += 1;
      scan.needIds.push(p.personId);
      continue;
    }
    // Left out by a check result: its code is the first blocking reason (a dry run's "no answer" included).
    const first = blocking[0]!;
    let reason: string | null = null;
    if (first.code === "check-undeliverable") reason = leftOutWords("invalid");
    else if (first.code === "check-do-not-send") reason = leftOutWords("doNotSend");
    else if (first.code === "check-unknown") reason = leftOutWords("couldnt-check");
    else if (first.code === "check-waiting" && p.checkNeed === "none") reason = leftOutWords("unknown");
    else if (first.code === "policy-blocked" && p.verificationStatus) {
      const b = checkBucket({ status: p.verificationStatus, risk: p.verificationRisk, disposable: p.verificationDisposable }, settings.policy);
      reason = leftOutWords(b.bucket);
    }
    if (reason) scan.leftOut.push({ personId: p.personId, name: displayName(p), email: p.email ?? "", companyName, reason });
  }
  scan.needIds.sort((a, b) => a - b);
  scan.optionalIds?.sort((a, b) => a - b);
  return scan;
}

/**
 * The people a Verify-step start would check now: in a dry run the "check them anyway" people, otherwise the
 * addresses that need a check; at most MAX_CHECKS_PER_RUN, the first ones by person id.
 */
export async function campaignCheckTargets(
  campaignId: number,
  now: Date = new Date(),
): Promise<{ personIds: number[]; mode: SendMode; campaignStatus: string }> {
  const scan = await scanCampaign(campaignId, now);
  const all = scan.optionalIds ?? scan.needIds;
  return { personIds: all.slice(0, MAX_CHECKS_PER_RUN), mode: scan.mode, campaignStatus: scan.campaignStatus };
}

/** The Verify step (M5-DESIGN §6.1): what needs a check, the cost, the monthly limit, the run and who is left out. */
export async function campaignCheckView(campaignId: number, now: Date = new Date()): Promise<CampaignCheckView> {
  const scan = await scanCampaign(campaignId, now);
  const [pricing, pause, run] = await Promise.all([loadCheckPricing(now), getChecksPause(now), campaignCheckRun(campaignId, now)]);
  const estimate = estimateFor(pricing, Math.min(scan.need.total, MAX_CHECKS_PER_RUN));
  return {
    mode: scan.mode,
    goLive: scan.goLive,
    practiceCopy: scan.practiceCopy,
    notReady: pricing.checker.notReady,
    pause,
    need: scan.need,
    tooMany: scan.need.total > MAX_CHECKS_PER_RUN,
    waiting: scan.waiting,
    fine: scan.fine,
    estimate,
    monthly: await monthlyCheckLimit(estimate.aboutUsd, { now, spentUsd: pricing.spentUsd }),
    run,
    leftOutByChecks: scan.leftOut,
    optional: scan.optionalIds
      ? { count: scan.optionalIds.length, estimate: estimateFor(pricing, Math.min(scan.optionalIds.length, MAX_CHECKS_PER_RUN)) }
      : null,
  };
}

/**
 * The Schedule step's note (M5-DESIGN §6.1), counted in the draft phase among the people who will get the email:
 * `unchecked` still need a check (they're left out at launch), `secondCheck` wait for their second check (they become
 * "Waiting for re-check" at launch).
 */
export async function campaignLaunchCheckNote(campaignId: number, now: Date = new Date()): Promise<{ unchecked: number; secondCheck: number }> {
  const { unchecked, secondCheck } = await launchCheckScan(campaignId, now);
  return { unchecked, secondCheck };
}

/** The Schedule step's note plus what launch leaving the unchecked people out does to its companies and time zones. */
export type LaunchCheckAudience = {
  unchecked: number;
  secondCheck: number;
  /** Companies where everyone who'd get the email still needs a check: launch leaves the whole company out. */
  companiesLeftOut: number;
  /** The unchecked people by their company's own time zone (null: the company has none, so the default zone). */
  uncheckedZones: Array<{ timeZone: string | null; people: number }>;
};

/** The draft-phase count behind the note, per company (people who'd get the email / of them unchecked). */
async function launchCheckScan(campaignId: number, now: Date) {
  const campaign = await campaignOf(campaignId);
  const settings = await loadEligibilitySettings();
  const ticked = await evaluateTicked(campaignId, campaign.mode, "draft", now, settings);
  let unchecked = 0;
  let secondCheck = 0;
  const byCompany = new Map<number, { eligible: number; unchecked: number }>();
  for (const { person: p, companyId } of ticked) {
    if (!p.eligible) continue;
    const company = byCompany.get(companyId) ?? { eligible: 0, unchecked: 0 };
    company.eligible += 1;
    byCompany.set(companyId, company);
    if (p.pending.some((r) => isNeedsCheckCode(r.code))) {
      unchecked += 1;
      company.unchecked += 1;
    } else if (p.pending.some((r) => r.code === "check-waiting")) {
      secondCheck += 1;
    }
  }
  return { unchecked, secondCheck, byCompany };
}

/**
 * The Schedule step's data for the launch phase (M5-DESIGN §6.1; M5 review SCREENS-09): the note, how many companies
 * launch leaves out entirely because everyone ticked there still needs a check, and where the unchecked people are,
 * so "They're for N companies" and the recipients' times count only what the launch will really send.
 */
export async function campaignLaunchCheckAudience(campaignId: number, now: Date = new Date()): Promise<LaunchCheckAudience> {
  const scan = await launchCheckScan(campaignId, now);
  const hit = [...scan.byCompany].filter(([, c]) => c.unchecked > 0);
  const zoneRows = await inChunks(
    hit.map(([id]) => id),
    (c) => db.company.findMany({ where: { id: { in: c } }, select: { id: true, timeZone: true } }),
  );
  const zoneOf = new Map(zoneRows.map((r) => [r.id, r.timeZone?.trim() || null]));
  const zones = new Map<string | null, number>();
  for (const [id, c] of hit) {
    const zone = zoneOf.get(id) ?? null;
    zones.set(zone, (zones.get(zone) ?? 0) + c.unchecked);
  }
  return {
    unchecked: scan.unchecked,
    secondCheck: scan.secondCheck,
    companiesLeftOut: hit.filter(([, c]) => c.unchecked >= c.eligible).length,
    uncheckedZones: [...zones].map(([timeZone, people]) => ({ timeZone, people })),
  };
}
