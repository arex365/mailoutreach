import type { Prisma, SendMode, SendStatus } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { isFakeMode } from "@/server/mailgun/base-url";
import { getSettings } from "@/server/settings";
import { normalizeEmail } from "@/core/email-address";
import type { CompanyStatusValue } from "@/core/labels";
import { pickDefaultPeople } from "@/core/rules/default-people";
import {
  DEFAULT_VERIFICATION_POLICY,
  companyReasons,
  evaluateEligibility,
  readRecipientOverrides,
  type EligibilityContext,
  type EligibilityReason,
  type PersonFacts,
  type RecipientFacts,
  type RiskValue,
  type SuppressionReasonValue,
  type VerificationPolicy,
  type VerificationStatusValue,
} from "@/core/rules/eligibility";
import { realProviderSet } from "@/core/verification/policy";
import type { CheckNeed } from "@/core/verification/types";
import {
  DAY_MS,
  teamRule,
  usableCompanyDomain,
  type TeamRuleExternalSend,
  type TeamRuleSend,
} from "@/core/rules/team-rule";
import { emailedSendWhere } from "./emailed";
import { findActiveReservations } from "./reservations";

/**
 * Eligibility in bulk (PLAN.md B6.1, B6.2): loads everything the pure rules in @/core/rules need for
 * many companies at once, with a handful of indexed queries (people, suppressions, real-send
 * history by company / domain / address within N days, ExternalSend, active reservations), then
 * evaluates every person. Used by the wizard's audience step, at launch, and (through
 * recheckRecipient) just before each send.
 *
 * Only sends that count as "emailed" are history (`emailedSendWhere`, M6-DESIGN §2.2): live ones of
 * campaigns launched after go-live, plus dry runs in the practice copy. Live sends of a campaign
 * launched before go-live only reach the test list, so they never block those mailboxes for 30 days,
 * also after the switch. Emails that may have gone out (Sending / Not sure it was sent) count too,
 * so an interrupted send can never let a second campaign in.
 *
 * Address checks are judged per phase (M5-DESIGN §2.8): `phase "draft"` (the audience) keeps the "needs a check"
 * codes pending, the default `"launch"` blocks with them, and `recheckRecipient` judges a send with the rules of its
 * step (freshness at the campaign's launch for the first email; follow-ups rely on the check judged at launch).
 */

const IN_CHUNK = 400;
const MAYBE_SENT: SendStatus[] = ["SENDING", "UNKNOWN", "UNCONFIRMED"];

export type EligibilitySettings = {
  /** Setting "teamRule.days". */
  days: number;
  /** Setting "practice.copy". */
  practiceCopy: boolean;
  /** Setting "verification.maxAgeDays". */
  maxCheckAgeDays: number;
  /** Setting "verification.policy" over the defaults (the "disposable" row included). */
  policy: VerificationPolicy;
  /** Setting "sending.testList", normalised. */
  testList: ReadonlySet<string>;
  /**
   * Setting "sending.goLive": the test-list rule in the draft and at launch (M6-DESIGN §0.2 rule 7). At send time
   * `recheckRecipient` replaces it with the campaign's launch flag; "emailed" never reads it (`emailedSendWhere`).
   */
  goLive: boolean;
  /** Setting "sharedDomains.extra". */
  extraShared: ReadonlySet<string>;
  /** Check providers whose results count for real sending: REAL_PROVIDERS, plus "mailgun-fake" in fake mode (D10). */
  realProviders: ReadonlySet<string>;
};

/** The providers whose check results count right now (the fake Mailgun's only while the app talks to it). */
export function realCheckProviders(): ReadonlySet<string> {
  return realProviderSet(isFakeMode());
}

export async function loadEligibilitySettings(): Promise<EligibilitySettings> {
  const s = await getSettings([
    "teamRule.days",
    "practice.copy",
    "verification.maxAgeDays",
    "verification.policy",
    "sending.testList",
    "sending.goLive",
    "sharedDomains.extra",
  ] as const);
  const days = Number(s["teamRule.days"]);
  const maxAge = Number(s["verification.maxAgeDays"]);
  const policy = (s["verification.policy"] ?? {}) as Partial<VerificationPolicy>;
  return {
    days: Number.isFinite(days) ? days : 30,
    practiceCopy: s["practice.copy"] === true,
    maxCheckAgeDays: Number.isFinite(maxAge) && maxAge > 0 ? maxAge : 90,
    policy: { ...DEFAULT_VERIFICATION_POLICY, ...policy },
    testList: new Set(
      (Array.isArray(s["sending.testList"]) ? s["sending.testList"] : [])
        .map((e) => normalizeEmail(String(e)))
        .filter((e): e is string => Boolean(e)),
    ),
    goLive: s["sending.goLive"] === true,
    extraShared: new Set(
      (Array.isArray(s["sharedDomains.extra"]) ? s["sharedDomains.extra"] : [])
        .map((d) => String(d).trim().toLowerCase())
        .filter(Boolean),
    ),
    realProviders: realCheckProviders(),
  };
}

// ───────────────────────── results ─────────────────────────

export type PersonEligibility = {
  personId: number;
  name: string;
  email: string | null;
  emailNorm: string | null;
  isGeneric: boolean;
  verificationStatus: VerificationStatusValue | null;
  verificationRisk: RiskValue | null;
  verifiedAt: Date | null;
  verificationProvider: string | null;
  /** Unknown results in a row (0 after any other result). */
  verificationUnknowns: number;
  /** The last check said throwaway. */
  verificationDisposable: boolean;
  /** Removed from the company (only listed when asked for by id). */
  deleted: boolean;
  eligible: boolean;
  /** Every reason in B6.2 order (overridden and pending ones included). */
  reasons: EligibilityReason[];
  /** The reasons that block (not overridden, not pending), in order. */
  blocking: EligibilityReason[];
  /** Draft-phase check reasons that don't block (shown as notes, M5-DESIGN §2.8 rule 3). */
  pending: EligibilityReason[];
  /** Where the address stands with checks in this evaluation's context (rule 8). */
  checkNeed: CheckNeed;
  /** The first blocking reason (what the screens show), or null. */
  reason: EligibilityReason | null;
  /** Notes such as "On test list". */
  notes: string[];
};

export type CompanyEligibility = {
  companyId: number;
  name: string;
  status: CompanyStatusValue;
  deleted: boolean;
  priorityRank: number;
  /** The company's usable domain (null for shared hosts). */
  domain: string | null;
  /**
   * The first company-level reason (status, Replied, the 30-day rule or a reservation, deleted), or
   * null. "company-replied" is overridable per person.
   */
  blocked: EligibilityReason | null;
  companyReasons: EligibilityReason[];
  /** People in display order (created first → last). */
  people: PersonEligibility[];
  /** Who to tick by default (B6.4): [] when nobody can be emailed. */
  defaultPersonIds: number[];
};

export type EvaluateOptions = {
  /** The campaign's mode (the wizard uses the mode the campaign would launch with). */
  mode: SendMode;
  /** The campaign being checked: its own sends and reservation never block it. */
  campaignId?: number | null;
  now?: Date;
  /** Preloaded settings (e.g. once per sending tick). */
  settings?: EligibilitySettings;
  /** Recipient facts by personId (excluded by hand, overrides, the address an email row was made for). */
  recipients?: ReadonlyMap<number, RecipientFacts>;
  /** Also evaluate these people when they were removed from their company (their result says so). */
  personIds?: readonly number[];
  /**
   * The sender's reply route works (LIVE campaigns, at launch only). Never passed at send time: a
   * broken route there is a wait (the gates hold the email), never a permanent stop (§4.3.2).
   */
  senderHasReplyRoute?: boolean | null;
  senderName?: string | null;
  /** M5-DESIGN §2.8: "draft" keeps the "needs a check" codes pending (tickable); default "launch" (everything blocks). */
  phase?: "draft" | "launch" | "send";
  /** Send time: the step being sent (≥ 1 ignores check age and unknown results). */
  sendStep?: number;
  /** Check freshness is measured at this instant (send time: the campaign's launch); default `now`. */
  checkAgeAt?: Date;
  /**
   * The test-list exception; default: test mode, or live before go-live (send time passes
   * `mode === "TEST" || campaign.launchedGoLive !== true`, M6-DESIGN §2.3).
   */
  testListCountsAsChecked?: boolean;
};

// ───────────────────────── loading ─────────────────────────

async function inChunks<T, R>(values: readonly T[], fn: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
  const unique = [...new Set(values)];
  const out: R[] = [];
  for (let i = 0; i < unique.length; i += IN_CHUNK) out.push(...(await fn(unique.slice(i, i + IN_CHUNK))));
  return out;
}

type HistoryRow = {
  id: number;
  toNorm: string;
  companyId: number | null;
  companyDomain: string | null;
  sentAt: Date | null;
  claimedAt: Date | null;
  dueAt: Date;
  status: SendStatus;
  campaignId: number;
  senderId: number | null;
  step: number;
};

const historySelect = {
  id: true,
  toNorm: true,
  companyId: true,
  companyDomain: true,
  sentAt: true,
  claimedAt: true,
  dueAt: true,
  status: true,
  campaignId: true,
  senderId: true,
  step: true,
} as const;

type ExternalRow = { id: number; toNorm: string; companyId: number | null; companyDomain: string | null; sentAt: Date };

/**
 * "Emailed" sends (and maybe-sent emails) since `since` that match any of the companies, domains or addresses.
 * `emailed` is `emailedSendWhere(practiceCopy)` (M6-DESIGN §2.2), joined in with `AND` so it never collides with the
 * other conditions; ExternalSend rows always count.
 *
 * The sent rows are found by `sentAt` alone and kept when SENT here: only markSent writes `sentAt`, together with SENT,
 * and a `status` condition in the SQL makes SQLite read every SENT email through the (status, dueAt) index instead of
 * the (companyId | companyDomain | toNorm, sentAt) ones (tests/integration/sending/query-plans.test.ts).
 */
async function loadHistory(
  companyIds: number[],
  domains: string[],
  norms: string[],
  since: Date,
  emailed: Prisma.OutboundEmailWhereInput,
  excludeCampaignId: number | null,
): Promise<{ sends: HistoryRow[]; externals: ExternalRow[] }> {
  const notThisCampaign = excludeCampaignId !== null ? { campaignId: { not: excludeCampaignId } } : {};
  const sent = { sentAt: { gte: since }, AND: [emailed], ...notThisCampaign };
  const rows = new Map<number, HistoryRow>();
  const add = (list: HistoryRow[]) => {
    for (const r of list) rows.set(r.id, r);
  };
  const addSent = (list: HistoryRow[]) => add(list.filter((r) => r.status === "SENT"));
  addSent(await inChunks(companyIds, (c) => db.outboundEmail.findMany({ where: { ...sent, companyId: { in: c } }, select: historySelect })));
  addSent(await inChunks(domains, (c) => db.outboundEmail.findMany({ where: { ...sent, companyDomain: { in: c } }, select: historySelect })));
  addSent(await inChunks(norms, (c) => db.outboundEmail.findMany({ where: { ...sent, toNorm: { in: c } }, select: historySelect })));
  // Emails that may have gone out: few rows, matched in memory by the pure rule.
  add(
    await db.outboundEmail.findMany({
      where: { status: { in: MAYBE_SENT }, claimedAt: { gte: since }, AND: [emailed], ...notThisCampaign },
      select: historySelect,
      take: 5_000,
    }),
  );

  const externals = new Map<number, ExternalRow>();
  const ext = { sentAt: { gte: since } };
  const extSelect = { id: true, toNorm: true, companyId: true, companyDomain: true, sentAt: true } as const;
  const addExt = (list: ExternalRow[]) => {
    for (const r of list) externals.set(r.id, r);
  };
  addExt(await inChunks(companyIds, (c) => db.externalSend.findMany({ where: { ...ext, companyId: { in: c } }, select: extSelect })));
  addExt(await inChunks(domains, (c) => db.externalSend.findMany({ where: { ...ext, companyDomain: { in: c } }, select: extSelect })));
  addExt(await inChunks(norms, (c) => db.externalSend.findMany({ where: { ...ext, toNorm: { in: c } }, select: extSelect })));
  return { sends: [...rows.values()], externals: [...externals.values()] };
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Evaluates every person at these companies for one campaign. Companies that don't exist are left
 * out of the result; deleted companies are included (blocked "The company was deleted").
 */
export async function evaluateCompanies(
  companyIds: readonly number[],
  opts: EvaluateOptions,
): Promise<Map<number, CompanyEligibility>> {
  const now = opts.now ?? new Date();
  const settings = opts.settings ?? (await loadEligibilitySettings());
  const campaignId = opts.campaignId ?? null;
  const ids = [...new Set(companyIds)].filter((id) => Number.isInteger(id) && id > 0);
  const result = new Map<number, CompanyEligibility>();
  if (ids.length === 0) return result;

  const companies = await inChunks(ids, (c) =>
    db.company.findMany({
      where: { id: { in: c } },
      select: {
        id: true,
        name: true,
        status: true,
        deletedAt: true,
        domain: true,
        priorityRank: true,
        importedLastContactAt: true,
      },
    }),
  );
  if (companies.length === 0) return result;
  const personSelect = {
    id: true,
    companyId: true,
    name: true,
    email: true,
    emailNorm: true,
    isGeneric: true,
    deletedAt: true,
    createdAt: true,
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
  const people = await inChunks(
    companies.map((c) => c.id),
    (c) => db.person.findMany({ where: { companyId: { in: c }, deletedAt: null }, select: personSelect }),
  );
  // People asked for by id who were removed from their company (their result says so).
  const loaded = new Set(people.map((p) => p.id));
  const missingPeople = (opts.personIds ?? []).filter((id) => !loaded.has(id));
  if (missingPeople.length > 0) {
    const companySet = new Set(companies.map((c) => c.id));
    const extra = await inChunks(missingPeople, (c) => db.person.findMany({ where: { id: { in: c } }, select: personSelect }));
    people.push(...extra.filter((p) => companySet.has(p.companyId)));
  }
  people.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);

  const norms = people.map((p) => p.emailNorm).filter((e): e is string => Boolean(e));
  const domains = companies
    .map((c) => usableCompanyDomain(c.domain, settings.extraShared))
    .filter((d): d is string => Boolean(d));
  const since = new Date(now.getTime() - Math.max(0, settings.days) * DAY_MS);

  const [history, suppressions, reservations] = await Promise.all([
    settings.days > 0
      ? loadHistory(companies.map((c) => c.id), domains, norms, since, emailedSendWhere(settings.practiceCopy), campaignId)
      : Promise.resolve({ sends: [] as HistoryRow[], externals: [] as ExternalRow[] }),
    inChunks(norms, (c) => db.suppression.findMany({ where: { emailNorm: { in: c } }, select: { emailNorm: true, reason: true } })),
    findActiveReservations(db, companies.map((c) => c.id), now, campaignId),
  ]);

  // Names for the reason texts.
  const campaignIds = [...new Set(history.sends.map((s) => s.campaignId))];
  const senderIds = [...new Set(history.sends.map((s) => s.senderId).filter((v): v is number => v !== null))];
  const [campaignRows, userRows] = await Promise.all([
    inChunks(campaignIds, (c) => db.campaign.findMany({ where: { id: { in: c } }, select: { id: true, name: true } })),
    inChunks(senderIds, (c) => db.user.findMany({ where: { id: { in: c } }, select: { id: true, name: true } })),
  ]);
  const campaignName = new Map(campaignRows.map((c) => [c.id, c.name]));
  const userName = new Map(userRows.map((u) => [u.id, u.name]));

  const toSend = (s: HistoryRow): TeamRuleSend => ({
    toNorm: s.toNorm,
    companyId: s.companyId,
    companyDomain: s.companyDomain,
    sentAt: s.sentAt ?? s.claimedAt ?? s.dueAt,
    campaignId: s.campaignId,
    campaignName: campaignName.get(s.campaignId) ?? null,
    senderName: s.senderId !== null ? (userName.get(s.senderId) ?? null) : null,
    step: s.step,
  });

  // Index the history so each company only looks at rows that can match it.
  const sendsByCompany = new Map<number, HistoryRow[]>();
  const sendsByDomain = new Map<string, HistoryRow[]>();
  const sendsByNorm = new Map<string, HistoryRow[]>();
  for (const s of history.sends) {
    if (s.companyId !== null) pushTo(sendsByCompany, s.companyId, s);
    if (s.companyDomain) pushTo(sendsByDomain, s.companyDomain.toLowerCase(), s);
    pushTo(sendsByNorm, s.toNorm.toLowerCase(), s);
  }
  const extByCompany = new Map<number, ExternalRow[]>();
  const extByDomain = new Map<string, ExternalRow[]>();
  const extByNorm = new Map<string, ExternalRow[]>();
  for (const e of history.externals) {
    if (e.companyId !== null) pushTo(extByCompany, e.companyId, e);
    if (e.companyDomain) pushTo(extByDomain, e.companyDomain.toLowerCase(), e);
    pushTo(extByNorm, e.toNorm.toLowerCase(), e);
  }

  const suppressed = new Map(suppressions.map((s) => [s.emailNorm, s.reason as SuppressionReasonValue]));
  const peopleByCompany = new Map<number, typeof people>();
  for (const p of people) pushTo(peopleByCompany, p.companyId, p);

  const ctx: EligibilityContext = {
    mode: opts.mode,
    now,
    maxCheckAgeDays: settings.maxCheckAgeDays,
    policy: settings.policy,
    testList: settings.testList,
    goLive: settings.goLive,
    senderHasReplyRoute: opts.senderHasReplyRoute,
    senderName: opts.senderName,
    phase: opts.phase ?? "launch",
    sendStep: opts.sendStep,
    checkAgeAt: opts.checkAgeAt,
    realProviders: settings.realProviders,
    testListCountsAsChecked: opts.testListCountsAsChecked,
  };

  // Duplicate addresses among the campaign's included recipients (defensive: addresses are unique).
  const seenIncluded = new Set<string>();

  for (const c of companies) {
    const companyPeople = peopleByCompany.get(c.id) ?? [];
    const domain = usableCompanyDomain(c.domain, settings.extraShared);
    const currentNorms = companyPeople
      .filter((p) => !p.deletedAt)
      .map((p) => p.emailNorm)
      .filter((e): e is string => Boolean(e));

    const candidateSends = new Map<number, HistoryRow>();
    for (const s of sendsByCompany.get(c.id) ?? []) candidateSends.set(s.id, s);
    if (domain) for (const s of sendsByDomain.get(domain) ?? []) candidateSends.set(s.id, s);
    for (const n of currentNorms) for (const s of sendsByNorm.get(n) ?? []) candidateSends.set(s.id, s);
    const candidateExternals = new Map<number, ExternalRow>();
    for (const e of extByCompany.get(c.id) ?? []) candidateExternals.set(e.id, e);
    if (domain) for (const e of extByDomain.get(domain) ?? []) candidateExternals.set(e.id, e);
    for (const n of currentNorms) for (const e of extByNorm.get(n) ?? []) candidateExternals.set(e.id, e);

    const holder = reservations.get(c.id);
    const block = teamRule({
      companyId: c.id,
      companyDomain: c.domain,
      emailNorms: currentNorms,
      importedLastContactAt: c.importedLastContactAt,
      sends: [...candidateSends.values()].map(toSend),
      externalSends: [...candidateExternals.values()].map(
        (e): TeamRuleExternalSend => ({ toNorm: e.toNorm, companyId: e.companyId, companyDomain: e.companyDomain, sentAt: e.sentAt }),
      ),
      reservations: holder ? [{ campaignId: holder.campaignId, campaignName: holder.campaignName, ownerName: holder.ownerName }] : [],
      campaignId,
      now,
      days: settings.days,
      extraShared: settings.extraShared,
    });

    const companyFacts = { id: c.id, status: c.status as CompanyStatusValue, deleted: Boolean(c.deletedAt) };
    const cReasons = companyReasons(companyFacts, block);

    const evaluated: PersonEligibility[] = [];
    for (const p of companyPeople) {
      const facts: PersonFacts = {
        id: p.id,
        email: p.email,
        emailNorm: p.emailNorm,
        deleted: Boolean(p.deletedAt),
        verificationStatus: p.verificationStatus as VerificationStatusValue | null,
        verificationRisk: p.verificationRisk as RiskValue | null,
        verifiedAt: p.verifiedAt,
        verificationProvider: p.verificationProvider,
        verificationDisposable: p.verificationDisposable,
        verificationUnknowns: p.verificationUnknowns,
        unsubscribedAt: p.unsubscribedAt,
        bouncedAt: p.bouncedAt,
        complainedAt: p.complainedAt,
        suppression: p.emailNorm ? (suppressed.get(p.emailNorm) ?? null) : null,
      };
      let recipient = opts.recipients?.get(p.id);
      if (recipient && !recipient.excludedByHand && p.emailNorm) {
        if (seenIncluded.has(p.emailNorm)) recipient = { ...recipient, duplicate: true };
        else seenIncluded.add(p.emailNorm);
      }
      const r = evaluateEligibility({ company: companyFacts, person: facts, teamRule: block, recipient, ctx });
      evaluated.push({
        personId: p.id,
        name: p.name,
        email: p.email,
        emailNorm: p.emailNorm,
        isGeneric: p.isGeneric,
        verificationStatus: facts.verificationStatus,
        verificationRisk: facts.verificationRisk,
        verifiedAt: p.verifiedAt,
        verificationProvider: p.verificationProvider,
        verificationUnknowns: p.verificationUnknowns,
        verificationDisposable: p.verificationDisposable,
        deleted: facts.deleted,
        eligible: r.eligible,
        reasons: r.reasons,
        blocking: r.blocking,
        pending: r.pending,
        checkNeed: r.checkNeed,
        reason: r.reason,
        notes: r.notes,
      });
    }

    // Default pick: people whose own address allows it (company-level reasons block everyone equally,
    // and being unticked right now doesn't matter for what would be ticked by default). Pending reasons
    // (a draft's "needs a check") don't disqualify anybody (M5-DESIGN §2.8 rule 9).
    const companyCodes = new Set(cReasons.map((r) => r.code));
    const defaultPersonIds = pickDefaultPeople(
      evaluated
        .filter((e) => !e.deleted)
        .map((e) => ({
          id: e.personId,
          name: e.name,
          isGeneric: e.isGeneric,
          emailNorm: e.emailNorm,
          verificationStatus: e.verificationStatus,
          eligible: e.reasons.every((r) => r.pending === true || companyCodes.has(r.code) || r.code === "excluded-by-hand"),
        })),
    );

    result.set(c.id, {
      companyId: c.id,
      name: c.name,
      status: companyFacts.status,
      deleted: companyFacts.deleted,
      priorityRank: c.priorityRank,
      domain,
      blocked: cReasons[0] ?? null,
      companyReasons: cReasons,
      people: evaluated,
      defaultPersonIds,
    });
  }
  return result;
}

// ───────────────────────── one recipient, at send time ─────────────────────────

export type RecheckResult = {
  eligible: boolean;
  /** The first blocking reason, or null when eligible. */
  reason: EligibilityReason | null;
  reasons: EligibilityReason[];
  notes: string[];
  companyId: number | null;
  personId: number | null;
  /** When the person's address was last checked (for a "check-waiting" first email: recheckAt = max(now, this + 24 h)). */
  verifiedAt: Date | null;
  /** Where the address stands with checks at this step ("wait" / "second-check" for a first "no answer"). */
  checkNeed: CheckNeed;
};

const GONE: EligibilityReason = {
  code: "person-removed",
  text: "This person is no longer in the campaign",
  overridable: false,
};

/**
 * Re-checks one campaign recipient on fresh data (the sending loop calls this after claiming an
 * email, B6.4). `toNorm` is the address the email row was made for: if the person's address has
 * changed since, the email isn't sent. The reply-route rule isn't checked here: a broken route at
 * send time only holds the email (the gates), it never stops the recipient (M3-DESIGN §4.3.9).
 *
 * "Put back by hand" (A5.6) covers only replies from before the launch (M4-DESIGN §2.7, D19): when the company
 * replied after the campaign was launched (`Company.repliedAt > Campaign.launchedAt`), the recipient's
 * "company-replied" override no longer counts and the Replied status stops them again.
 *
 * Address checks are judged for the step being sent (M5-DESIGN §2.8 rules 5–6): the first email (`step` 0, the
 * default) measures freshness at the campaign's launch, follow-ups ignore check age and unknown results, and the
 * test-list exception is the one judged at launch.
 *
 * Test-list only (M6-DESIGN §2.3): a TEST or LIVE campaign is judged in its world at launch, by its own launch flag
 * (`Campaign.launchedGoLive`), never by today's switch. A live campaign launched before go-live keeps its test-list rule
 * after go-live (someone removed from the test list, or added to it later, is left out with "not-on-test-list"), and
 * test mode keeps it for good.
 */
export async function recheckRecipient(
  recipientId: number,
  opts: { now?: Date; toNorm?: string | null; settings?: EligibilitySettings; step?: number } = {},
): Promise<RecheckResult> {
  const rec = await db.campaignRecipient.findUnique({
    where: { id: recipientId },
    select: {
      id: true,
      campaignId: true,
      companyId: true,
      personId: true,
      included: true,
      warnings: true,
      campaign: { select: { mode: true, launchedAt: true, launchedGoLive: true, sender: { select: { name: true } } } },
      company: { select: { repliedAt: true } },
    },
  });
  if (!rec) {
    return { eligible: false, reason: GONE, reasons: [GONE], notes: [], companyId: null, personId: null, verifiedAt: null, checkNeed: "none" };
  }
  const now = opts.now ?? new Date();
  const settings = opts.settings ?? (await loadEligibilitySettings());
  const overrides = readRecipientOverrides(rec.warnings);
  const launchedAt = rec.campaign.launchedAt?.getTime();
  const repliedAt = rec.company.repliedAt?.getTime();
  if (launchedAt !== undefined && repliedAt !== undefined && repliedAt > launchedAt) overrides.delete("company-replied");
  const facts: RecipientFacts = {
    excludedByHand: !rec.included,
    overrides,
    sentToNorm: opts.toNorm ?? null,
  };
  const mode = rec.campaign.mode ?? "DRY_RUN";
  // The campaign's world at launch (M6-DESIGN §2.2, §2.3): its launch flag stands for go-live in the test-list rule.
  const launchedLive = rec.campaign.launchedGoLive === true;
  const evaluated = await evaluateCompanies([rec.companyId], {
    mode,
    campaignId: rec.campaignId,
    now,
    settings: mode === "TEST" || mode === "LIVE" ? { ...settings, goLive: launchedLive } : settings,
    recipients: new Map([[rec.personId, facts]]),
    personIds: [rec.personId],
    senderName: rec.campaign.sender?.name ?? null,
    phase: "send",
    sendStep: Math.max(0, Math.floor(opts.step ?? 0)),
    checkAgeAt: rec.campaign.launchedAt ?? now,
    testListCountsAsChecked: mode === "TEST" || !launchedLive,
  });
  const person = evaluated.get(rec.companyId)?.people.find((p) => p.personId === rec.personId);
  if (!person) {
    return {
      eligible: false,
      reason: GONE,
      reasons: [GONE],
      notes: [],
      companyId: rec.companyId,
      personId: rec.personId,
      verifiedAt: null,
      checkNeed: "none",
    };
  }
  return {
    eligible: person.eligible,
    reason: person.reason,
    reasons: person.reasons,
    notes: person.notes,
    companyId: rec.companyId,
    personId: rec.personId,
    verifiedAt: person.verifiedAt,
    checkNeed: person.checkNeed,
  };
}
