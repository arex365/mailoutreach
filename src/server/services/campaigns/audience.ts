import type { CampaignStatus, Prisma, SendMode } from "@/generated/prisma/client";
import { db, dbTx, type DbOrTx, type Tx } from "@/server/db";
import { logActivity } from "@/server/activity";
import { getSetting } from "@/server/settings";
import { evaluateCompanies, type CompanyEligibility } from "@/server/services/eligibility";
import { buildCompanyWhere } from "@/server/services/companies/filters";
import { COMPANY_STATUS_LABELS, COMPANY_STATUSES, type CompanyStatusValue } from "@/core/labels";
import { GENERAL_INBOX_NAME } from "@/core/email-address";
import { countryName } from "@/core/geo/display";
import { tickedPeopleWarning } from "@/core/rules/default-people";
import {
  readRecipientOverrides,
  withRecipientOverride,
  type EligibilityReason,
  type RecipientFacts,
} from "@/core/rules/eligibility";
import { normalizeText, plural } from "@/core/text";
import { CAMPAIGN_GONE, CampaignError } from "./errors";
import { isLaunching, LAUNCHING_TEXT } from "./launch";

/**
 * The campaign wizard's Audience step (PLAN.md B6.4 step 1, B6.1, B6.2; SPEC §7).
 *
 * The audience is a set of companies. It is stored in Campaign.audience (JSON, see AudienceJson)
 * together with a short history of how companies were added; every company that has a
 * CampaignRecipient row counts as in the audience too, so rows can never be orphaned.
 *
 * Every person with an email address at an audience company gets a CampaignRecipient row when the
 * company is added. `included` is the person's tick. The engine's default pick (pickDefaultPeople,
 * via evaluateCompanies) is ticked, unless the company itself can't be emailed at that moment
 * (Client, Replied, the 30-day rule…): what the Excluded section shows is then never emailed by
 * surprise. Eligibility is never stored: it's evaluated live on every screen, and again by
 * launchCampaign, with the engine's rules (@/server/services/eligibility).
 *
 * A Replied company can be put back by hand: every row at the company gets the engine's override
 * (CampaignRecipient.warnings.overrides = ["company-replied"], withRecipientOverride) and the
 * default people are ticked. Nothing else can be overridden.
 *
 * The audience is judged in the draft phase (M5-DESIGN §2.8 rule 3, §6.2): an address that still needs a check ("Address
 * not checked yet", "Only checked by the test checker", "Last checked more than 90 days ago", a first "no answer"
 * waiting for its re-check) doesn't stop anyone being ticked. It shows as the person's note, the person counts as
 * getting the email and may be the default pick; the Verify step checks them, and the launch leaves out whoever still
 * needs a check then.
 *
 * Drafts only: every change refuses a campaign that is no longer a draft.
 */

export const AUDIENCE_MAX_COMPANIES = 10_000;
export const AUDIENCE_PAGE_SIZE = 50;
const ROW_CHUNK = 500;
const IN_CHUNK = 400;
const MAX_SOURCES = 20;

// ───────────────────────── stored audience ─────────────────────────

export type AudienceSourceKind = "selection" | "list" | "filter";

/** How companies came in, e.g. { kind: "list", label: "List: Germany Q4", added: 45 }. */
export type AudienceSource = { kind: AudienceSourceKind; label: string; added: number; at: string };

/** Campaign.audience. `origin` identifies how the draft was started (used to spot a repeated start). */
export type AudienceJson = { v: 1; companyIds: number[]; sources: AudienceSource[]; origin?: string };

/** Reads Campaign.audience fail-safe: anything unexpected becomes an empty audience. */
export function readAudienceJson(value: unknown): AudienceJson {
  const empty: AudienceJson = { v: 1, companyIds: [], sources: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
  const v = value as { companyIds?: unknown; sources?: unknown; origin?: unknown };
  const ids = Array.isArray(v.companyIds)
    ? [...new Set(v.companyIds.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0))]
    : [];
  const sources: AudienceSource[] = Array.isArray(v.sources)
    ? v.sources
        .filter(
          (s): s is AudienceSource =>
            Boolean(s) &&
            typeof s === "object" &&
            ["selection", "list", "filter"].includes((s as AudienceSource).kind) &&
            typeof (s as AudienceSource).label === "string" &&
            typeof (s as AudienceSource).added === "number",
        )
        .map((s) => ({ kind: s.kind, label: s.label.slice(0, 300), added: s.added, at: typeof s.at === "string" ? s.at : "" }))
        .slice(-MAX_SOURCES)
    : [];
  return { v: 1, companyIds: ids, sources, ...(typeof v.origin === "string" ? { origin: v.origin.slice(0, 200) } : {}) };
}

/** Plain objects written to JSON columns (Campaign.audience, CampaignRecipient.warnings). */
function asJson(value: AudienceJson | Record<string, unknown>): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

// ───────────────────────── draft guard ─────────────────────────

export function notDraftText(status: CampaignStatus): string {
  if (status === "CANCELLED") return "This campaign was cancelled, so it can't be changed. Start a new one instead.";
  return "This campaign has already been launched, so it can't be changed here. Open the campaign page instead.";
}

export type DraftRow = {
  id: number;
  name: string;
  status: CampaignStatus;
  audience: Prisma.JsonValue | null;
  senderId: number | null;
  createdById: number;
};

/**
 * Loads a campaign that must still be a draft, or throws CampaignError in plain words. A draft
 * that is being launched right now can't be changed either (code "launching"): the launch has
 * already checked its sender, message and audience.
 */
export async function loadDraftForChange(client: DbOrTx, campaignId: number): Promise<DraftRow> {
  const c = await client.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, name: true, status: true, audience: true, senderId: true, createdById: true },
  });
  if (!c) throw new CampaignError(CAMPAIGN_GONE, "not-found");
  if (c.status !== "DRAFT") throw new CampaignError(notDraftText(c.status), "not-draft");
  if (isLaunching(campaignId)) throw new CampaignError(LAUNCHING_TEXT, "launching");
  return c;
}

async function assertStillDraft(tx: Tx, campaignId: number): Promise<void> {
  const c = await tx.campaign.findUnique({ where: { id: campaignId }, select: { status: true } });
  if (!c) throw new CampaignError(CAMPAIGN_GONE, "not-found");
  if (c.status !== "DRAFT") throw new CampaignError(notDraftText(c.status), "not-draft");
  if (isLaunching(campaignId)) throw new CampaignError(LAUNCHING_TEXT, "launching");
}

// ───────────────────────── recipient rows ─────────────────────────

export type RecipientRowLite = {
  id: number;
  companyId: number;
  personId: number;
  emailNorm: string;
  included: boolean;
  warnings: Prisma.JsonValue | null;
  hasEdits: boolean;
};

const ROW_SELECT = {
  id: true,
  companyId: true,
  personId: true,
  emailNorm: true,
  included: true,
  warnings: true,
  hasEdits: true,
} as const;

export async function loadRecipientRows(client: DbOrTx, campaignId: number, companyIds?: readonly number[]): Promise<RecipientRowLite[]> {
  if (!companyIds) {
    return client.campaignRecipient.findMany({ where: { campaignId }, select: ROW_SELECT, orderBy: { id: "asc" } });
  }
  const out: RecipientRowLite[] = [];
  const ids = [...new Set(companyIds)];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    out.push(
      ...(await client.campaignRecipient.findMany({
        where: { campaignId, companyId: { in: ids.slice(i, i + IN_CHUNK) } },
        select: ROW_SELECT,
        orderBy: { id: "asc" },
      })),
    );
  }
  return out;
}

/** The audience's company ids: the stored list plus any company that has recipient rows. */
export function audienceIdsOf(json: AudienceJson, rows: readonly RecipientRowLite[]): number[] {
  const out = [...json.companyIds];
  const seen = new Set(out);
  for (const r of rows) {
    if (!seen.has(r.companyId)) {
      seen.add(r.companyId);
      out.push(r.companyId);
    }
  }
  return out;
}

/** The mode a draft would launch with (Setting "sending.mode": dry run, test mode or live). */
export async function draftSendingMode(): Promise<SendMode> {
  const mode = await getSetting("sending.mode");
  return mode === "TEST" || mode === "LIVE" ? mode : "DRY_RUN";
}

// ───────────────────────── views ─────────────────────────

export type AudiencePersonView = {
  personId: number;
  /** Null when the person has no row yet (e.g. added to the company after it joined the campaign). */
  recipientId: number | null;
  /** "Anna Berg", "General inbox", or the address when there's no name. */
  name: string;
  email: string | null;
  isGeneric: boolean;
  verificationStatus: string | null;
  ticked: boolean;
  /** Can be emailed right now (their own address, the company, and any put-back override). */
  eligible: boolean;
  /** Ticked and can be emailed. */
  willGet: boolean;
  /** Can the tick be switched on? (Switching off is always allowed.) */
  canTick: boolean;
  /** Why this person can't be emailed (their own reason; the company's is on the company). */
  reason: string | null;
  /** Notes such as "On test list". */
  notes: string[];
  /** Emails edited for this person in Review. */
  edited: boolean;
  /** Removed from the company since they were added. */
  removed: boolean;
};

export type AudienceCompanyView = {
  companyId: number;
  /** "C-1042". */
  code: string;
  name: string;
  status: CompanyStatusValue;
  country: string | null;
  countryName: string | null;
  deleted: boolean;
  /** "excluded" when nobody at the company can be emailed. */
  section: "included" | "excluded";
  /** The company-level reason nobody here can be emailed (status, 30-day rule, reservation, deleted). */
  blockedReason: string | null;
  /** Replied is the only thing blocking it: it can be put back in by hand. */
  canPutBack: boolean;
  /** Put back in by hand although it replied. */
  putBack: boolean;
  people: AudiencePersonView[];
  ticked: number;
  willGet: number;
  /** "2 people at this company are ticked. Each of them gets the emails." */
  warning: string | null;
  /** Why nobody here can be emailed when it isn't a company-level reason (no email, unsubscribed…). */
  emptyReason: string | null;
};

export type AudienceTotals = {
  /** People who will get the email. */
  people: number;
  /** Companies with at least one of them. */
  companies: number;
  /** Companies in the Excluded section. */
  excludedCompanies: number;
  /** Companies in the "will get the email" section. */
  includedCompanies: number;
  /** Companies in that section where nobody will get the email yet (nobody ticked). */
  nobodyTicked: number;
  /** Every company in the audience. */
  all: number;
};

function isOverridden(reason: EligibilityReason, overrides: ReadonlySet<string>): boolean {
  return reason.overridable && overrides.has(reason.code);
}

function buildView(
  e: CompanyEligibility,
  rows: readonly RecipientRowLite[],
  country: string | null,
): { view: AudienceCompanyView; defaults: number[] } {
  const rowByPerson = new Map(rows.map((r) => [r.personId, r]));
  const putBack = rows.some((r) => readRecipientOverrides(r.warnings).size > 0);
  const companyOverrides: ReadonlySet<string> = putBack ? new Set(["company-replied"]) : new Set();
  const companyBlocking = e.companyReasons.filter((r) => !isOverridden(r, companyOverrides));
  const companyCodes = new Set(e.companyReasons.map((r) => r.code));

  const people: AudiencePersonView[] = [];
  for (const p of e.people) {
    const row = rowByPerson.get(p.personId);
    if (p.deleted && !row) continue;
    const overrides: ReadonlySet<string> = row ? readRecipientOverrides(row.warnings) : companyOverrides;
    // Draft-phase check reasons (pending) never block: they are the person's notes (M5-DESIGN §6.2).
    const blocking = p.reasons.filter((r) => !r.pending && !isOverridden(r, overrides) && r.code !== "excluded-by-hand");
    const own = blocking.filter((r) => !companyCodes.has(r.code));
    const eligible = blocking.length === 0;
    const ticked = row?.included === true;
    people.push({
      personId: p.personId,
      recipientId: row?.id ?? null,
      name: p.isGeneric ? GENERAL_INBOX_NAME : p.name.trim() || p.email || "No name",
      email: p.email,
      isGeneric: p.isGeneric,
      verificationStatus: p.verificationStatus,
      ticked,
      eligible,
      willGet: ticked && eligible && Boolean(row),
      canTick: eligible && Boolean(p.emailNorm),
      reason: own[0]?.text ?? null,
      notes: [...p.notes, ...p.reasons.filter((r) => r.pending).map((r) => r.text)],
      edited: row?.hasEdits === true,
      removed: p.deleted,
    });
  }
  const tickedCount = people.filter((p) => p.ticked).length;
  const willGet = people.filter((p) => p.willGet).length;
  const anyEligible = people.some((p) => p.eligible);
  const withEmail = people.filter((p) => p.email);
  const canPutBack =
    !putBack &&
    e.companyReasons.length > 0 &&
    e.companyReasons.every((r) => r.code === "company-replied") &&
    e.people.some(
      (p) =>
        !p.deleted &&
        Boolean(p.emailNorm) &&
        p.reasons.every((r) => r.pending === true || r.code === "company-replied" || r.code === "excluded-by-hand"),
    );

  let emptyReason: string | null = null;
  if (!anyEligible && companyBlocking.length === 0) {
    if (people.length === 0) emptyReason = "No contacts at this company yet";
    else if (withEmail.length === 0) emptyReason = "Nobody here has an email address";
    else emptyReason = "Nobody here can be emailed";
  }

  return {
    view: {
      companyId: e.companyId,
      code: `C-${e.companyId}`,
      name: e.name,
      status: e.status,
      country,
      countryName: country ? countryName(country) || country : null,
      deleted: e.deleted,
      section: anyEligible ? "included" : "excluded",
      blockedReason: companyBlocking[0]?.text ?? null,
      canPutBack,
      putBack,
      people,
      ticked: tickedCount,
      willGet,
      warning: tickedPeopleWarning(willGet),
      emptyReason,
    },
    // The engine's default pick ignores company-level reasons; used when a company is put back.
    defaults: e.defaultPersonIds,
  };
}

export function totalsOf(views: readonly AudienceCompanyView[]): AudienceTotals {
  let people = 0;
  let companies = 0;
  let excluded = 0;
  let nobody = 0;
  for (const v of views) {
    people += v.willGet;
    if (v.willGet > 0) companies += 1;
    if (v.section === "excluded") excluded += 1;
    else if (v.willGet === 0) nobody += 1;
  }
  return { people, companies, excludedCompanies: excluded, includedCompanies: views.length - excluded, nobodyTicked: nobody, all: views.length };
}

type EvaluatedCompany = { view: AudienceCompanyView; defaults: number[]; eligibility: CompanyEligibility };

/** Evaluates companies of one campaign with the engine's rules and builds their views (in the given order). */
async function evaluateViews(
  campaignId: number,
  companyIds: readonly number[],
  rows: readonly RecipientRowLite[],
  opts: { mode?: SendMode; now?: Date } = {},
): Promise<EvaluatedCompany[]> {
  if (companyIds.length === 0) return [];
  const mode = opts.mode ?? (await draftSendingMode());
  const facts = new Map<number, RecipientFacts>(
    rows.map((r) => [r.personId, { excludedByHand: false, overrides: readRecipientOverrides(r.warnings) }]),
  );
  const evaluated = await evaluateCompanies(companyIds, {
    mode,
    campaignId,
    now: opts.now,
    recipients: facts,
    personIds: rows.map((r) => r.personId),
    // The draft: "needs a check" keeps people tickable (M5-DESIGN §2.8 rule 3).
    phase: "draft",
  });
  const countries = new Map<number, string | null>();
  const ids = [...new Set(companyIds)];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const found = await db.company.findMany({ where: { id: { in: ids.slice(i, i + IN_CHUNK) } }, select: { id: true, country: true } });
    for (const c of found) countries.set(c.id, c.country);
  }
  const rowsByCompany = new Map<number, RecipientRowLite[]>();
  for (const r of rows) {
    const list = rowsByCompany.get(r.companyId);
    if (list) list.push(r);
    else rowsByCompany.set(r.companyId, [r]);
  }
  const out: EvaluatedCompany[] = [];
  for (const id of ids) {
    const e = evaluated.get(id);
    if (!e) continue; // the company row itself is gone (never happens through the app)
    const built = buildView(e, rowsByCompany.get(id) ?? [], countries.get(id) ?? null);
    out.push({ ...built, eligibility: e });
  }
  return out;
}

function byName(a: AudienceCompanyView, b: AudienceCompanyView): number {
  return a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.companyId - b.companyId;
}

export type AudienceSnapshot = {
  campaignId: number;
  mode: SendMode;
  /** Every audience company, by name. */
  companies: AudienceCompanyView[];
  totals: AudienceTotals;
  sources: AudienceSource[];
};

/**
 * The whole audience, evaluated now: every company with its people, ticks, eligibility and
 * reasons, plus the totals. One bulk evaluation (a few indexed queries per 400 companies).
 */
export async function loadAudienceSnapshot(campaignId: number, opts: { now?: Date; mode?: SendMode } = {}): Promise<AudienceSnapshot> {
  const campaign = await db.campaign.findUnique({ where: { id: campaignId }, select: { id: true, audience: true } });
  if (!campaign) throw new CampaignError(CAMPAIGN_GONE, "not-found");
  const json = readAudienceJson(campaign.audience);
  const rows = await loadRecipientRows(db, campaignId);
  const ids = audienceIdsOf(json, rows);
  const mode = opts.mode ?? (await draftSendingMode());
  const evaluated = await evaluateViews(campaignId, ids, rows, { mode, now: opts.now });
  const companies = evaluated.map((e) => e.view).sort(byName);
  return { campaignId, mode, companies, totals: totalsOf(companies), sources: json.sources };
}

export type AudienceSection = "included" | "excluded";

export type AudiencePage = {
  section: AudienceSection;
  q: string;
  page: number;
  pageCount: number;
  /** Companies in this section that match the search. */
  total: number;
  companies: AudienceCompanyView[];
  totals: AudienceTotals;
  sources: AudienceSource[];
  mode: SendMode;
};

function matchesSearch(v: AudienceCompanyView, words: string[]): boolean {
  if (words.length === 0) return true;
  const text = normalizeText([v.name, v.code, ...v.people.flatMap((p) => [p.name, p.email ?? ""])].join(" "));
  return words.every((w) => text.includes(w));
}

/** One page (50 companies) of one section, optionally searched by company, person or address. */
export async function loadAudiencePage(
  campaignId: number,
  opts: { section?: AudienceSection; q?: string; page?: number; now?: Date } = {},
): Promise<AudiencePage> {
  const snap = await loadAudienceSnapshot(campaignId, { now: opts.now });
  const section = opts.section === "excluded" ? "excluded" : "included";
  const q = (opts.q ?? "").trim().slice(0, 200);
  const words = normalizeText(q).split(" ").filter(Boolean).slice(0, 8);
  const inSection = snap.companies.filter((c) => c.section === section && matchesSearch(c, words));
  const pageCount = Math.max(1, Math.ceil(inSection.length / AUDIENCE_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1) || 1), pageCount);
  return {
    section,
    q,
    page,
    pageCount,
    total: inSection.length,
    companies: inSection.slice((page - 1) * AUDIENCE_PAGE_SIZE, page * AUDIENCE_PAGE_SIZE),
    totals: snap.totals,
    sources: snap.sources,
    mode: snap.mode,
  };
}

/** The totals only (for the other steps' summary line). */
export async function audienceTotals(campaignId: number): Promise<AudienceTotals> {
  return (await loadAudienceSnapshot(campaignId)).totals;
}

// ───────────────────────── adding companies ─────────────────────────

export type Actor = { id: number; name: string };

export type AddCompaniesResult = {
  added: number;
  /** Already in the campaign. */
  alreadyIn: number;
  /** Deleted or unknown companies that were skipped. */
  notFound: number;
  /** Left out because the campaign reached AUDIENCE_MAX_COMPANIES. */
  capped: number;
  /** People ticked by default at the added companies. */
  ticked: number;
  /** Companies in the audience afterwards. */
  total: number;
};

async function inChunks<T, R>(values: readonly T[], size: number, fn: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < values.length; i += size) out.push(...(await fn(values.slice(i, i + size))));
  return out;
}

/**
 * Adds companies to a draft's audience (in the order given, up to AUDIENCE_MAX_COMPANIES in all) and
 * creates a recipient row for each of their people with an email address, ticking the engine's
 * default person where the company can be emailed. Deleted companies are skipped.
 * The audience list is saved first, then the rows in chunks of 500 per transaction.
 */
export async function addCompaniesToAudience(
  actor: Actor,
  campaignId: number,
  companyIds: readonly number[],
  source: { kind: AudienceSourceKind; label: string },
  opts: { now?: Date; log?: boolean } = {},
): Promise<AddCompaniesResult> {
  const now = opts.now ?? new Date();
  const draft = await loadDraftForChange(db, campaignId);
  const json = readAudienceJson(draft.audience);
  const rows = await loadRecipientRows(db, campaignId);
  const current = new Set(audienceIdsOf(json, rows));

  const wanted: number[] = [];
  const seen = new Set<number>();
  let alreadyIn = 0;
  for (const id of companyIds) {
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    if (current.has(id)) alreadyIn += 1;
    else wanted.push(id);
  }
  const found = new Set(
    (
      await inChunks(wanted, IN_CHUNK, (chunk) =>
        db.company.findMany({ where: { id: { in: chunk }, deletedAt: null }, select: { id: true } }),
      )
    ).map((c) => c.id),
  );
  const present = wanted.filter((id) => found.has(id));
  const room = Math.max(0, AUDIENCE_MAX_COMPANIES - current.size);
  const toAdd = present.slice(0, room);
  const result: AddCompaniesResult = {
    added: toAdd.length,
    alreadyIn,
    notFound: wanted.length - present.length,
    capped: present.length - toAdd.length,
    ticked: 0,
    total: current.size + toAdd.length,
  };
  if (toAdd.length === 0) return result;

  // 1. The audience list first, so a failure part-way never leaves rows outside it.
  await dbTx(async (tx) => {
    const fresh = await loadDraftForChange(tx, campaignId);
    const a = readAudienceJson(fresh.audience);
    const ids = new Set(a.companyIds);
    for (const id of toAdd) ids.add(id);
    const sources = [
      ...a.sources,
      { kind: source.kind, label: source.label.slice(0, 300), added: toAdd.length, at: now.toISOString() },
    ].slice(-MAX_SOURCES);
    await tx.campaign.update({ where: { id: campaignId }, data: { audience: asJson({ ...a, companyIds: [...ids], sources }) } });
  });

  // 2. Who is at those companies, and who is ticked by default.
  const evaluated = await evaluateCompanies(toAdd, { mode: await draftSendingMode(), campaignId, now, phase: "draft" });
  const havePerson = new Set(rows.map((r) => r.personId));
  const haveEmail = new Set(rows.map((r) => r.emailNorm));
  const create: Prisma.CampaignRecipientCreateManyInput[] = [];
  for (const companyId of toAdd) {
    const e = evaluated.get(companyId);
    if (!e) continue;
    const defaults = new Set(e.companyReasons.length === 0 ? e.defaultPersonIds : []);
    for (const p of e.people) {
      if (p.deleted || !p.emailNorm || havePerson.has(p.personId) || haveEmail.has(p.emailNorm)) continue;
      havePerson.add(p.personId);
      haveEmail.add(p.emailNorm);
      const included = defaults.has(p.personId);
      if (included) result.ticked += 1;
      create.push({ campaignId, companyId, personId: p.personId, emailNorm: p.emailNorm, included });
    }
  }
  for (let i = 0; i < create.length; i += ROW_CHUNK) {
    const chunk = create.slice(i, i + ROW_CHUNK);
    await dbTx(async (tx) => {
      await assertStillDraft(tx, campaignId);
      await tx.campaignRecipient.createMany({ data: chunk });
    });
  }

  if (opts.log !== false) {
    await logActivity({
      actorId: actor.id,
      type: "campaign.audience",
      summary: `${actor.name} added ${plural(toAdd.length, "company", "companies")} to ${draft.name} (${source.label})`,
      campaignId,
      data: { added: toAdd.length, ticked: result.ticked, source: source.kind },
    });
  }
  return result;
}

// ───────────────────────── adding by filter ─────────────────────────

export type AudienceFilter = {
  listId?: number | null;
  tagIds?: number[];
  status?: CompanyStatusValue | null;
  countries?: string[];
  niches?: string[];
};

export function cleanAudienceFilter(f: AudienceFilter): AudienceFilter {
  const ints = (v: unknown[] | undefined) =>
    [...new Set((v ?? []).filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0))].slice(0, 200);
  const texts = (v: unknown[] | undefined) =>
    [...new Set((v ?? []).filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean))].slice(0, 200);
  return {
    listId: typeof f.listId === "number" && Number.isInteger(f.listId) && f.listId > 0 ? f.listId : null,
    tagIds: ints(f.tagIds),
    status: f.status && COMPANY_STATUSES.includes(f.status) ? f.status : null,
    countries: texts(f.countries)
      .map((c) => c.toUpperCase())
      .filter((c) => /^[A-Z]{2}$/.test(c)),
    niches: texts(f.niches).map((n) => n.slice(0, 200)),
  };
}

export function isEmptyAudienceFilter(f: AudienceFilter): boolean {
  return !f.listId && !f.tagIds?.length && !f.status && !f.countries?.length && !f.niches?.length;
}

function filterWhere(f: AudienceFilter): Prisma.CompanyWhereInput {
  // The one definition of "which companies" (Contacts, export and campaigns share it).
  return buildCompanyWhere({
    listId: f.listId ?? undefined,
    tagIds: f.tagIds?.length ? f.tagIds : undefined,
    status: f.status ?? undefined,
    countries: f.countries?.length ? f.countries : undefined,
    niches: f.niches?.length ? f.niches : undefined,
  });
}

/** "List: Germany Q4 · Status: Not contacted · Country: Germany, Norway". */
export async function describeAudienceFilter(f: AudienceFilter): Promise<string> {
  const parts: string[] = [];
  if (f.listId) {
    const list = await db.list.findUnique({ where: { id: f.listId }, select: { name: true } });
    parts.push(`List: ${list?.name ?? "a deleted list"}`);
  }
  if (f.tagIds?.length) {
    const tags = await db.tag.findMany({ where: { id: { in: f.tagIds } }, select: { name: true } });
    const names = tags.map((t) => t.name).sort((a, b) => a.localeCompare(b));
    parts.push(`${names.length === 1 ? "Tag" : "Tags"}: ${names.join(", ") || "deleted tags"}`);
  }
  if (f.status) parts.push(`Status: ${COMPANY_STATUS_LABELS[f.status]}`);
  if (f.countries?.length) {
    parts.push(`${f.countries.length === 1 ? "Country" : "Countries"}: ${f.countries.map((c) => countryName(c) || c).join(", ")}`);
  }
  if (f.niches?.length) parts.push(`${f.niches.length === 1 ? "Niche" : "Niches"}: ${f.niches.join(", ")}`);
  return parts.join(" · ") || "All companies";
}

export type FilterPreview = {
  /** Companies matching the filter. */
  matching: number;
  /** Of those, already in this campaign. */
  alreadyIn: number;
  /** Would be added now (after the size limit). */
  toAdd: number;
  /** Left out by the size limit. */
  capped: number;
};

async function matchingIds(f: AudienceFilter): Promise<number[]> {
  const rows = await db.company.findMany({
    where: filterWhere(f),
    orderBy: [{ nameNorm: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** What "Add companies" would do with this filter (the live count next to the button). */
export async function previewAudienceFilter(campaignId: number, filter: AudienceFilter): Promise<FilterPreview> {
  const f = cleanAudienceFilter(filter);
  if (isEmptyAudienceFilter(f)) return { matching: 0, alreadyIn: 0, toAdd: 0, capped: 0 };
  const campaign = await db.campaign.findUnique({ where: { id: campaignId }, select: { audience: true } });
  if (!campaign) throw new CampaignError(CAMPAIGN_GONE, "not-found");
  const rows = await db.campaignRecipient.findMany({ where: { campaignId }, select: { companyId: true }, distinct: ["companyId"] });
  const current = new Set(readAudienceJson(campaign.audience).companyIds);
  for (const r of rows) current.add(r.companyId);
  const ids = await matchingIds(f);
  const alreadyIn = ids.filter((id) => current.has(id)).length;
  const fresh = ids.length - alreadyIn;
  const room = Math.max(0, AUDIENCE_MAX_COMPANIES - current.size);
  return { matching: ids.length, alreadyIn, toAdd: Math.min(fresh, room), capped: Math.max(0, fresh - room) };
}

/** Adds every company matching a list / tag / status / country / niche filter. */
export async function addAudienceByFilter(
  actor: Actor,
  campaignId: number,
  filter: AudienceFilter,
): Promise<AddCompaniesResult & { label: string }> {
  await loadDraftForChange(db, campaignId);
  const f = cleanAudienceFilter(filter);
  if (isEmptyAudienceFilter(f)) {
    throw new CampaignError("Pick a list, tag, status, country or niche first.", "empty-filter");
  }
  const label = await describeAudienceFilter(f);
  const ids = await matchingIds(f);
  if (ids.length === 0) throw new CampaignError(`No companies match ${label}.`, "no-match");
  const onlyList = Boolean(f.listId) && !f.tagIds?.length && !f.status && !f.countries?.length && !f.niches?.length;
  const result = await addCompaniesToAudience(actor, campaignId, ids, { kind: onlyList ? "list" : "filter", label });
  return { ...result, label };
}

// ───────────────────────── removing companies ─────────────────────────

/** Takes companies (and their people's rows and per-person edits) out of a draft. */
export async function removeCompaniesFromAudience(
  actor: Actor,
  campaignId: number,
  companyIds: readonly number[],
  opts: { now?: Date } = {},
): Promise<{ removed: number }> {
  const now = opts.now ?? new Date();
  const draft = await loadDraftForChange(db, campaignId);
  const ids = [...new Set(companyIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return { removed: 0 };
  const json = readAudienceJson(draft.audience);
  const rows = await loadRecipientRows(db, campaignId, ids);
  const inAudience = new Set(audienceIdsOf(json, rows));
  const removing = ids.filter((id) => inAudience.has(id));
  if (removing.length === 0) return { removed: 0 };

  const rowIds = rows.map((r) => r.id);
  for (let i = 0; i < rowIds.length; i += ROW_CHUNK) {
    const chunk = rowIds.slice(i, i + ROW_CHUNK);
    await dbTx(async (tx) => {
      await assertStillDraft(tx, campaignId);
      // A draft never sends; email rows can only be left over from an interrupted launch.
      const sentish = await tx.outboundEmail.count({
        where: { recipientId: { in: chunk }, status: { in: ["SENDING", "SENT", "UNKNOWN", "UNCONFIRMED"] } },
      });
      if (sentish > 0) throw new CampaignError("Some of these emails may already have gone out, so they can't be removed.", "sent");
      await tx.outboundEmail.deleteMany({ where: { recipientId: { in: chunk } } });
      await tx.campaignRecipient.deleteMany({ where: { id: { in: chunk } } });
    });
  }
  await dbTx(async (tx) => {
    const fresh = await loadDraftForChange(tx, campaignId);
    const a = readAudienceJson(fresh.audience);
    const drop = new Set(removing);
    await tx.campaign.update({
      where: { id: campaignId },
      data: { audience: asJson({ ...a, companyIds: a.companyIds.filter((id) => !drop.has(id)) }) },
    });
    // A draft only holds reservations while it is being launched; never keep one for a removed company.
    await tx.companyReservation.updateMany({
      where: { campaignId, companyId: { in: removing }, releasedAt: null },
      data: { releasedAt: now },
    });
    let summary: string;
    if (removing.length === 1) {
      const c = await tx.company.findUnique({ where: { id: removing[0]! }, select: { name: true } });
      summary = `${actor.name} removed ${c?.name ?? "a company"} from ${fresh.name}`;
    } else {
      summary = `${actor.name} removed ${plural(removing.length, "company", "companies")} from ${fresh.name}`;
    }
    await logActivity(
      {
        actorId: actor.id,
        type: "campaign.audience",
        summary,
        campaignId,
        companyId: removing.length === 1 ? removing[0]! : null,
        data: { removed: removing.length },
      },
      tx,
    );
  });
  return { removed: removing.length };
}

/** Empties the audience ("Start over"). */
export async function clearAudience(actor: Actor, campaignId: number): Promise<{ removed: number }> {
  const draft = await loadDraftForChange(db, campaignId);
  const rows = await loadRecipientRows(db, campaignId);
  const ids = audienceIdsOf(readAudienceJson(draft.audience), rows);
  return removeCompaniesFromAudience(actor, campaignId, ids);
}

// ───────────────────────── ticks and put-back ─────────────────────────

async function companyInAudience(campaignId: number, companyId: number): Promise<{ draft: DraftRow; rows: RecipientRowLite[] }> {
  const draft = await loadDraftForChange(db, campaignId);
  const json = readAudienceJson(draft.audience);
  const rows = await loadRecipientRows(db, campaignId, [companyId]);
  if (!json.companyIds.includes(companyId) && rows.length === 0) {
    throw new CampaignError("This company isn't in the campaign any more. Refresh the page to see the latest.", "not-in-audience");
  }
  return { draft, rows };
}

/** The current view of one audience company. */
export async function loadAudienceCompany(campaignId: number, companyId: number): Promise<AudienceCompanyView> {
  const rows = await loadRecipientRows(db, campaignId, [companyId]);
  const [e] = await evaluateViews(campaignId, [companyId], rows);
  if (!e) throw new CampaignError("This company doesn't exist any more. Refresh the page to see the latest.", "company-gone");
  return e.view;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Ticks or unticks one person (Audience checkboxes; Review's Include/Exclude). Ticking checks the
 * person can be emailed and says why not; unticking always works. A person who has no row yet
 * (added to the company later) gets one.
 */
export async function setPersonTicked(
  actor: Actor,
  campaignId: number,
  personId: number,
  ticked: boolean,
): Promise<{ company: AudienceCompanyView; message: string }> {
  const person = await db.person.findUnique({
    where: { id: personId },
    select: { id: true, companyId: true, name: true, email: true, emailNorm: true, isGeneric: true },
  });
  if (!person) throw new CampaignError("This person doesn't exist any more. Refresh the page to see the latest.", "person-gone");
  const { rows } = await companyInAudience(campaignId, person.companyId);
  const label = person.isGeneric ? GENERAL_INBOX_NAME : person.name.trim() || person.email || "This person";

  if (ticked) {
    const [e] = await evaluateViews(campaignId, [person.companyId], rows);
    const pv = e?.view.people.find((p) => p.personId === personId);
    if (!e || !pv) throw new CampaignError(`${label} isn't at this company any more. Refresh the page to see the latest.`, "person-gone");
    if (!pv.eligible) {
      const why = pv.reason ?? e.view.blockedReason ?? e.view.emptyReason ?? "They can't be emailed right now";
      throw new CampaignError(`${label} can't be emailed: ${lowerFirst(why)}.`, "not-eligible");
    }
  }

  await dbTx(async (tx) => {
    await assertStillDraft(tx, campaignId);
    const existing = await tx.campaignRecipient.findUnique({
      where: { campaignId_personId: { campaignId, personId } },
      select: { id: true },
    });
    if (existing) {
      await tx.campaignRecipient.update({ where: { id: existing.id }, data: { included: ticked } });
      return;
    }
    if (!ticked) return;
    if (!person.emailNorm) throw new CampaignError(`${label} has no email address.`, "no-email");
    const clash = await tx.campaignRecipient.findUnique({
      where: { campaignId_emailNorm: { campaignId, emailNorm: person.emailNorm } },
      select: { id: true },
    });
    if (clash) throw new CampaignError(`Someone else in this campaign already has ${person.email ?? "this address"}.`, "duplicate");
    const putBack = rows.some((r) => readRecipientOverrides(r.warnings).size > 0);
    await tx.campaignRecipient.create({
      data: {
        campaignId,
        companyId: person.companyId,
        personId,
        emailNorm: person.emailNorm,
        included: true,
        ...(putBack ? { warnings: asJson(withRecipientOverride(null, "company-replied", true)) } : {}),
      },
    });
  });
  const company = await loadAudienceCompany(campaignId, person.companyId);
  return { company, message: ticked ? `${label} gets the email.` : `${label} is left out.` };
}

/**
 * Puts a Replied company back in by hand (A5.6), or takes it out again. Only a company whose one
 * company-level reason is "Replied" can be put back; the 30-day rule, reservations and other
 * statuses have no override. Putting back ticks the engine's default person when nobody is ticked.
 */
export async function setCompanyPutBack(
  actor: Actor,
  campaignId: number,
  companyId: number,
  on: boolean,
): Promise<{ company: AudienceCompanyView; message: string }> {
  const { draft, rows } = await companyInAudience(campaignId, companyId);
  const [e] = await evaluateViews(campaignId, [companyId], rows);
  if (!e) throw new CampaignError("This company doesn't exist any more. Refresh the page to see the latest.", "company-gone");
  const view = e.view;
  if (on && view.putBack) return { company: view, message: `${view.name} is already back in.` };
  if (!on && !view.putBack) return { company: view, message: `${view.name} is already left out.` };
  if (on && !view.canPutBack) {
    const other = e.eligibility.companyReasons.find((r) => r.code !== "company-replied");
    if (other) throw new CampaignError(`${view.name} can't be put back: ${lowerFirst(other.text)}.`, "not-overridable");
    if (!e.eligibility.companyReasons.some((r) => r.code === "company-replied")) {
      throw new CampaignError(`${view.name} doesn't need putting back: it hasn't replied.`, "not-replied");
    }
    throw new CampaignError(`Nobody at ${view.name} can be emailed, so there's nothing to put back.`, "nobody");
  }

  await dbTx(async (tx) => {
    await assertStillDraft(tx, campaignId);
    const current = await tx.campaignRecipient.findMany({
      where: { campaignId, companyId },
      select: { id: true, personId: true, included: true, warnings: true },
    });
    for (const r of current) {
      await tx.campaignRecipient.update({
        where: { id: r.id },
        data: {
          warnings: asJson(withRecipientOverride(r.warnings, "company-replied", on)),
          ...(on ? {} : { included: false }),
        },
      });
    }
    if (on) {
      const have = new Set(current.map((r) => r.personId));
      const emails = new Set(
        (await tx.campaignRecipient.findMany({ where: { campaignId }, select: { emailNorm: true } })).map((r) => r.emailNorm),
      );
      for (const p of e.eligibility.people) {
        if (p.deleted || !p.emailNorm || have.has(p.personId) || emails.has(p.emailNorm)) continue;
        await tx.campaignRecipient.create({
          data: {
            campaignId,
            companyId,
            personId: p.personId,
            emailNorm: p.emailNorm,
            included: false,
            warnings: asJson(withRecipientOverride(null, "company-replied", true)),
          },
        });
      }
      const anyTicked = current.some((r) => r.included);
      if (!anyTicked && e.defaults.length > 0) {
        await tx.campaignRecipient.updateMany({ where: { campaignId, companyId, personId: { in: e.defaults } }, data: { included: true } });
      }
    }
    await logActivity(
      {
        actorId: actor.id,
        type: "campaign.putBack",
        summary: on
          ? `${actor.name} put ${view.name} back into ${draft.name} although the company replied`
          : `${actor.name} left ${view.name} out of ${draft.name} again (the company replied)`,
        campaignId,
        companyId,
        data: { on },
      },
      tx,
    );
  });
  const company = await loadAudienceCompany(campaignId, companyId);
  return {
    company,
    message: on ? `${view.name} is back in, although it replied.` : `${view.name} is left out again.`,
  };
}

// ───────────────────────── before launch ─────────────────────────

/** Why an unticked person who could be emailed doesn't get it (Review, and the campaign page after launch). */
export const NOT_TICKED = "Not ticked";

/**
 * Just before launch: every unticked person gets the reason as their exclusionReason, so the
 * campaign page says "Unsubscribed", "Company status is Client" or "Not ticked" (launchCampaign only
 * fills in "Excluded by hand" where it's empty). Ticked people's reasons are cleared (the launch
 * writes its own when they can't be emailed any more). Returns how many rows changed.
 */
export async function syncExclusionReasons(campaignId: number, opts: { now?: Date } = {}): Promise<number> {
  const snap = await loadAudienceSnapshot(campaignId, { now: opts.now });
  const rows = await db.campaignRecipient.findMany({ where: { campaignId }, select: { id: true, exclusionReason: true } });
  const current = new Map(rows.map((r) => [r.id, r.exclusionReason]));
  const byReason = new Map<string | null, number[]>();
  for (const c of snap.companies) {
    for (const p of c.people) {
      if (p.recipientId === null) continue;
      const reason = p.ticked ? null : p.eligible ? NOT_TICKED : (p.reason ?? c.blockedReason ?? c.emptyReason ?? null);
      if ((current.get(p.recipientId) ?? null) === reason) continue;
      const list = byReason.get(reason);
      if (list) list.push(p.recipientId);
      else byReason.set(reason, [p.recipientId]);
    }
  }
  let changed = 0;
  for (const [reason, ids] of byReason) {
    for (let i = 0; i < ids.length; i += ROW_CHUNK) {
      const chunk = ids.slice(i, i + ROW_CHUNK);
      changed += await dbTx(async (tx) => {
        await assertStillDraft(tx, campaignId);
        const res = await tx.campaignRecipient.updateMany({ where: { id: { in: chunk } }, data: { exclusionReason: reason } });
        return res.count;
      });
    }
  }
  return changed;
}
