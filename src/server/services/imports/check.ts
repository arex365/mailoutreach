import type { Prisma } from "@/generated/prisma/client";
import { COMPANY_STATUS_LABELS, NEVER_EMAIL_STATUSES, type CompanyStatusValue } from "@/core/labels";
import { mergeGroupDrafts, prepareImport, type GroupPerson, type ImportGroupDraft, type PreparedImport } from "@/core/import/grouping";
import { isRoundTripMapping, type ColumnMapping } from "@/core/import/column-matching";
import type {
  CheckGroupView,
  CheckRowIssueView,
  CheckSummary,
  CheckView,
  CompanyRef,
  GroupDecision,
  GroupOutcome,
  ImportFlag,
  ImportOptions,
  RowIssueTone,
} from "@/core/import/types";
import { normalizeText } from "@/core/text";
import { timeAgo } from "@/core/time/format";
import { db } from "@/server/db";
import { getSetting } from "@/server/settings";
import { analyzeRoundTrip } from "./round-trip";
import { companyCode, loadImportRows } from "./sessions";

/**
 * Import step 4 (PLAN.md B6.13): normalise + group the stored rows (core/import/grouping),
 * then match every group to existing companies — including soft-deleted ones — and work out
 * what the commit will do. The commit job re-runs exactly this before writing.
 *
 * A mapping with a Company ID column is the missing-emails round trip (M5-DESIGN §4.2): its
 * planner (`analyzeRoundTrip`, round-trip.ts) groups the rows by company code instead and only
 * plans people; the check screen and the commit take its plans like any other.
 *
 * Matching an existing company:
 *  - a usable domain, profile link or Instagram handle → match;
 *  - the same name and country → match;
 *  - rows that only name a person, whose email already belongs to a company → that company;
 *  - the same name in another country (or with no country on one side) → "possible duplicate: choose";
 *  - a soft-deleted match → "Restore C-1042 (emailed by Ali 12 days ago)?" (default: restore);
 *  - an email that already belongs to a different company → a row problem, never an error.
 */

const IN_CHUNK = 400;
const VIEW_LIMIT = 100;

export const companySelect = {
  id: true,
  name: true,
  nameNorm: true,
  website: true,
  domain: true,
  profileKey: true,
  instagram: true,
  country: true,
  timeZone: true,
  niche: true,
  priority: true,
  status: true,
  notes: true,
  personalLine: true,
  customFields: true,
  deletedAt: true,
  lastEmailedAt: true,
  lastEmailedById: true,
  importedLastContactAt: true,
  repliedAt: true,
} satisfies Prisma.CompanySelect;

export type ExistingCompany = Prisma.CompanyGetPayload<{ select: typeof companySelect }>;

export const personSelect = {
  id: true,
  companyId: true,
  name: true,
  role: true,
  email: true,
  emailNorm: true,
  deletedAt: true,
  lastEmailedAt: true,
  lastEmailedById: true,
  unsubscribedAt: true,
  bouncedAt: true,
  complainedAt: true,
  repliedAt: true,
  notes: true,
} satisfies Prisma.PersonSelect;

export type ExistingPerson = Prisma.PersonGetPayload<{ select: typeof personSelect }>;

export type PersonAction = "create" | "update" | "restore" | "fill" | "none";

export type PlannedPerson = GroupPerson & {
  action: PersonAction;
  /** The existing person this updates/restores/fills. */
  existingId: number | null;
  existingName: string | null;
  existingRole: string | null;
  /** Round trip: `Person.notes` from the row's "Notes about the person" (source URL · Claude's note). */
  notes?: string | null;
};

export type RowStatusValue = "CREATED" | "UPDATED" | "SKIPPED" | "INVALID" | "EMPTY" | "PROBLEM";

export type GroupPlan = {
  group: ImportGroupDraft;
  outcome: GroupOutcome;
  /** The existing company this group updates or skips (null = a new company). */
  target: ExistingCompany | null;
  restore: boolean;
  decision: GroupDecision;
  people: PlannedPerson[];
  flags: ImportFlag[];
  /** Someone at this company (or one of its addresses) was emailed before. */
  emailed: boolean;
  /** The row whose status the group uses (where a "kept the status" note goes). */
  statusRowNumber: number | null;
  /** The note planned when the target's status is protected and the file says another one. */
  keptStatusNote: string | null;
};

export type RowPlan = {
  status: RowStatusValue;
  /** What the check screen says about the row. */
  messages: string[];
  groupKey: string | null;
  /**
   * What the commit stores with the row (`ImportRow.message`, which feeds the problem-rows download);
   * default `messages`. A round trip keeps rows that need nothing done (no email found, the address is
   * already there) out of the download.
   */
  stored?: string[];
  /** Round trip: Claude found no email for this row. */
  noEmail?: boolean;
};

export type ImportAnalysis = {
  prepared: PreparedImport;
  plans: GroupPlan[];
  rowPlans: Map<number, RowPlan>;
  summary: CheckSummary;
  /** The missing-emails round trip (a Company ID column): plans only add people; companies never change. */
  roundTrip: boolean;
};

type MatchResult =
  | { kind: "none" }
  | { kind: "exact"; company: ExistingCompany }
  | { kind: "possible"; candidates: ExistingCompany[] };

type Matched = { group: ImportGroupDraft; match: MatchResult };

type MatchContext = {
  companies: Map<number, ExistingCompany>;
  personByEmail: Map<string, ExistingPerson>;
  peopleByCompany: Map<number, ExistingPerson[]>;
  suppressed: Map<string, string>;
  userNames: Map<number, string>;
};

type Stage = { prepared: PreparedImport; matched: Matched[]; ctx: MatchContext };

// ───────────────────────── helpers ─────────────────────────

/** Capital first letter and a full stop — but an email address at the start stays as it is. */
export function sentence(s: string): string {
  const t = s.trim();
  if (!t) return t;
  const startsWithAddress = /^\S+@\S+/.test(t);
  const cap = startsWithAddress ? t : t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(cap) ? cap : `${cap}.`;
}

async function inChunks<T, R>(values: T[], fn: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) out.push(...(await fn(values.slice(i, i + IN_CHUNK))));
  return out;
}

function pickBest(list: ExistingCompany[]): ExistingCompany | null {
  if (list.length === 0) return null;
  return [...list].sort((a, b) => {
    const da = a.deletedAt ? 1 : 0;
    const dbb = b.deletedAt ? 1 : 0;
    return da - dbb || a.id - b.id;
  })[0]!;
}

/** How the check screen names an existing company ("C-1042", name, country, deleted). */
export function companyRef(c: ExistingCompany): CompanyRef {
  return { id: c.id, code: companyCode(c.id), name: c.name, country: c.country, deleted: Boolean(c.deletedAt) };
}
const ref = companyRef;

function emailedText(at: Date, byId: number | null, ctx: MatchContext, now: Date): string {
  const who = byId ? ctx.userNames.get(byId) : null;
  return who ? `emailed by ${who} ${timeAgo(at, now)}` : `emailed ${timeAgo(at, now)}`;
}

/**
 * "Who has replied" on the check screen (M4-DESIGN §6 row 9), neutral in tone: "anna@firma.de replied 3 days ago" for
 * each address in the file whose person replied, otherwise "Replied 3 days ago" when the matched company replied
 * (someone not in the file, or a reply linked to the company only).
 */
function repliedFlags(emails: readonly string[], company: ExistingCompany | null, ctx: MatchContext, now: Date): ImportFlag[] {
  const people: ImportFlag[] = [];
  for (const e of emails) {
    const p = ctx.personByEmail.get(e);
    if (p?.repliedAt) people.push({ tone: "neutral", text: `${p.email ?? e} replied ${timeAgo(p.repliedAt, now)}` });
  }
  if (people.length > 0) return people;
  return company?.repliedAt ? [{ tone: "neutral", text: `Replied ${timeAgo(company.repliedAt, now)}` }] : [];
}

/**
 * Client, Not interested and Do not contact are never changed by an import (SPEC §2: they are
 * never emailed; an old file saying "Not contacted" must not put them back in campaigns).
 * Returns the row note when the file asks for a different status, else null.
 */
export function keptStatusNote(current: CompanyStatusValue, fromFile: CompanyStatusValue | null): string | null {
  if (!fromFile || fromFile === current || !NEVER_EMAIL_STATUSES.has(current)) return null;
  return sentence(
    `kept the status ${COMPANY_STATUS_LABELS[current]} (the file says ${COMPANY_STATUS_LABELS[fromFile]}): an import never changes Client, Not interested or Do not contact`,
  );
}

async function extraSharedDomains(): Promise<ReadonlySet<string>> {
  try {
    const extra = await getSetting("sharedDomains.extra");
    return new Set((extra ?? []).map((d) => String(d).trim().toLowerCase()).filter(Boolean));
  } catch {
    return new Set();
  }
}

// ───────────────────────── stage 1+2: prepare and match (cached for the check screen) ─────────────────────────

async function loadMatchContext(groups: ImportGroupDraft[], exclude: ReadonlySet<number>): Promise<{
  ctx: MatchContext;
  byDomain: Map<string, ExistingCompany[]>;
  byProfile: Map<string, ExistingCompany[]>;
  byInstagram: Map<string, ExistingCompany[]>;
  byName: Map<string, ExistingCompany[]>;
}> {
  const domains = [...new Set(groups.flatMap((g) => g.domains))];
  const profiles = [...new Set(groups.flatMap((g) => g.profileKeys))];
  const handles = [...new Set(groups.flatMap((g) => g.instagrams))];
  const names = [...new Set(groups.map((g) => g.nameNorm).filter(Boolean))];
  const emails = [...new Set(groups.flatMap((g) => g.emails))];

  const found = [
    ...(await inChunks(domains, (c) => db.company.findMany({ where: { domain: { in: c } }, select: companySelect }))),
    ...(await inChunks(profiles, (c) => db.company.findMany({ where: { profileKey: { in: c } }, select: companySelect }))),
    ...(await inChunks(handles, (c) => db.company.findMany({ where: { instagram: { in: c } }, select: companySelect }))),
    ...(await inChunks(names, (c) => db.company.findMany({ where: { nameNorm: { in: c } }, select: companySelect }))),
  ];
  const persons = await inChunks(emails, (c) => db.person.findMany({ where: { emailNorm: { in: c } }, select: personSelect }));
  const suppressions = await inChunks(emails, (c) =>
    db.suppression.findMany({ where: { emailNorm: { in: c } }, select: { emailNorm: true, reason: true } }),
  );

  const companies = new Map<number, ExistingCompany>();
  for (const c of found) if (!exclude.has(c.id)) companies.set(c.id, c);
  // Companies of people found by email (for "already belongs to C-1042 Acme").
  const missing = [...new Set(persons.map((p) => p.companyId))].filter((id) => !companies.has(id));
  for (const c of await inChunks(missing, (ids) => db.company.findMany({ where: { id: { in: ids } }, select: companySelect }))) {
    companies.set(c.id, c);
  }

  const index = (key: (c: ExistingCompany) => string | null) => {
    const m = new Map<string, ExistingCompany[]>();
    for (const c of companies.values()) {
      if (exclude.has(c.id)) continue;
      const k = key(c);
      if (!k) continue;
      const list = m.get(k);
      if (list) list.push(c);
      else m.set(k, [c]);
    }
    return m;
  };

  const personByEmail = new Map<string, ExistingPerson>();
  for (const p of persons) if (p.emailNorm) personByEmail.set(p.emailNorm, p);
  const suppressed = new Map<string, string>();
  for (const s of suppressions) suppressed.set(s.emailNorm, s.reason);

  const userIds = new Set<number>();
  for (const c of companies.values()) if (c.lastEmailedById) userIds.add(c.lastEmailedById);
  for (const p of persons) if (p.lastEmailedById) userIds.add(p.lastEmailedById);
  const users = userIds.size
    ? await db.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true } })
    : [];

  return {
    ctx: {
      companies,
      personByEmail,
      peopleByCompany: new Map(),
      suppressed,
      userNames: new Map(users.map((u) => [u.id, u.name])),
    },
    byDomain: index((c) => c.domain),
    byProfile: index((c) => c.profileKey),
    byInstagram: index((c) => c.instagram),
    byName: index((c) => c.nameNorm || null),
  };
}

async function prepareAndMatch(
  sessionId: number,
  mapping: ColumnMapping[],
  options: ImportOptions,
  exclude: ReadonlySet<number>,
  now: Date,
): Promise<Stage> {
  const rows = await loadImportRows(sessionId);
  const prepared = prepareImport(
    rows.map((r) => ({ rowNumber: r.rowNumber, cells: r.cells })),
    mapping,
    { grouping: options.grouping, extraShared: await extraSharedDomains(), now },
  );
  const { ctx, byDomain, byProfile, byInstagram, byName } = await loadMatchContext(prepared.groups, exclude);

  const matchOne = (g: ImportGroupDraft): MatchResult => {
    const exact = [
      ...g.domains.flatMap((d) => byDomain.get(d) ?? []),
      ...g.profileKeys.flatMap((p) => byProfile.get(p) ?? []),
      ...g.instagrams.flatMap((h) => byInstagram.get(h) ?? []),
    ];
    const best = pickBest(exact);
    if (best) return { kind: "exact", company: best };
    const sameName = g.nameNorm ? (byName.get(g.nameNorm) ?? []) : [];
    const sameCountry = sameName.filter((c) => (c.country ?? "") === (g.country ?? ""));
    const byNameCountry = pickBest(sameCountry);
    if (byNameCountry) return { kind: "exact", company: byNameCountry };
    if (!g.hasOwnIdentity) {
      const owners = g.emails
        .map((e) => ctx.personByEmail.get(e))
        .filter((p): p is ExistingPerson => Boolean(p))
        .map((p) => ctx.companies.get(p.companyId))
        .filter((c): c is ExistingCompany => Boolean(c) && !exclude.has(c!.id));
      const owner = pickBest(owners);
      if (owner) return { kind: "exact", company: owner };
    }
    if (sameName.length) {
      const candidates = [...sameName].sort((a, b) => (a.deletedAt ? 1 : 0) - (b.deletedAt ? 1 : 0) || a.id - b.id).slice(0, 5);
      return { kind: "possible", candidates };
    }
    return { kind: "none" };
  };

  // Two groups that land on the same existing company become one.
  const matched: Matched[] = [];
  const byTarget = new Map<number, number>();
  for (const g of prepared.groups) {
    const match = matchOne(g);
    if (match.kind === "exact") {
      const at = byTarget.get(match.company.id);
      if (at !== undefined) {
        matched[at] = { group: mergeGroupDrafts(matched[at]!.group, g), match };
        continue;
      }
      byTarget.set(match.company.id, matched.length);
    }
    matched.push({ group: g, match });
  }
  // Keep rowGroup in step with merged groups.
  for (const m of matched) for (const n of m.group.rowNumbers) prepared.rowGroup.set(n, m.group.key);

  // People of every company we might update (to fill emails into same-name people).
  const targetIds = new Set<number>();
  for (const m of matched) {
    if (m.match.kind === "exact") targetIds.add(m.match.company.id);
    if (m.match.kind === "possible") for (const c of m.match.candidates) targetIds.add(c.id);
  }
  const existingPeople = await inChunks([...targetIds], (ids) =>
    db.person.findMany({ where: { companyId: { in: ids } }, select: personSelect }),
  );
  for (const p of existingPeople) {
    const list = ctx.peopleByCompany.get(p.companyId);
    if (list) list.push(p);
    else ctx.peopleByCompany.set(p.companyId, [p]);
    if (p.emailNorm && !ctx.personByEmail.has(p.emailNorm)) ctx.personByEmail.set(p.emailNorm, p);
  }
  return { prepared, matched, ctx };
}

// Small cache so choosing an answer on the check screen doesn't re-read 50,000 rows.
const STAGE_TTL_MS = 2 * 60_000;
const stageCache = new Map<string, { at: number; stage: Promise<Stage> }>();

function stageKey(sessionId: number, mapping: ColumnMapping[], options: ImportOptions): string {
  return `${sessionId}|${options.grouping}|${JSON.stringify(mapping)}`;
}

export function forgetImportCheck(sessionId: number): void {
  for (const k of [...stageCache.keys()]) if (k.startsWith(`${sessionId}|`)) stageCache.delete(k);
}

async function getStage(
  sessionId: number,
  mapping: ColumnMapping[],
  options: ImportOptions,
  opts: { fresh?: boolean; excludeCompanyIds?: ReadonlySet<number>; now?: Date },
): Promise<Stage> {
  const exclude = opts.excludeCompanyIds ?? new Set<number>();
  if (opts.fresh || exclude.size > 0) return prepareAndMatch(sessionId, mapping, options, exclude, opts.now ?? new Date());
  const key = stageKey(sessionId, mapping, options);
  const now = Date.now();
  for (const [k, v] of stageCache) if (now - v.at > STAGE_TTL_MS) stageCache.delete(k);
  const hit = stageCache.get(key);
  if (hit) return hit.stage;
  const stage = prepareAndMatch(sessionId, mapping, options, exclude, opts.now ?? new Date(now));
  stageCache.set(key, { at: now, stage });
  stage.catch(() => stageCache.delete(key));
  while (stageCache.size > 4) stageCache.delete(stageCache.keys().next().value!);
  return stage;
}

// ───────────────────────── stage 3: decide what happens ─────────────────────────

function planPeople(group: ImportGroupDraft, outcome: GroupOutcome, target: ExistingCompany | null, ctx: MatchContext) {
  const people: PlannedPerson[] = [];
  const problems: Array<{ rowNumber: number; message: string }> = [];
  if (outcome === "skip") return { people, problems };
  const targetPeople = target ? (ctx.peopleByCompany.get(target.id) ?? []) : [];
  const usedIds = new Set<number>();
  for (const p of group.people) {
    if (p.emailNorm) {
      const existing = ctx.personByEmail.get(p.emailNorm);
      if (existing && (!target || existing.companyId !== target.id)) {
        const owner = ctx.companies.get(existing.companyId);
        const ownerText = owner
          ? `${companyCode(owner.id)} ${owner.name}${owner.deletedAt ? " (deleted)" : ""}`
          : companyCode(existing.companyId);
        problems.push({ rowNumber: p.rowNumber, message: `${p.email} already belongs to ${ownerText}, so it wasn't added here` });
        continue;
      }
      if (existing) {
        usedIds.add(existing.id);
        people.push({
          ...p,
          action: existing.deletedAt ? "restore" : outcome === "update" ? "update" : "none",
          existingId: existing.id,
          existingName: existing.name,
          existingRole: existing.role,
        });
        continue;
      }
      // An existing person with the same name but no email gets this address.
      const sameName = p.name
        ? targetPeople.find(
            (e) => !e.emailNorm && !e.deletedAt && !usedIds.has(e.id) && normalizeText(e.name) === normalizeText(p.name),
          )
        : undefined;
      if (sameName) {
        usedIds.add(sameName.id);
        people.push({ ...p, action: "fill", existingId: sameName.id, existingName: sameName.name, existingRole: sameName.role });
        continue;
      }
      people.push({ ...p, action: "create", existingId: null, existingName: null, existingRole: null });
    } else {
      const key = normalizeText(p.name);
      const sameName = targetPeople.find((e) => !e.deletedAt && normalizeText(e.name) === key);
      if (sameName) {
        if (outcome === "update" && p.role && p.role !== sameName.role) {
          people.push({ ...p, action: "update", existingId: sameName.id, existingName: sameName.name, existingRole: sameName.role });
        }
        continue;
      }
      people.push({ ...p, action: "create", existingId: null, existingName: null, existingRole: null });
    }
  }
  return { people, problems };
}

function resolve(stage: Stage, options: ImportOptions, now: Date): ImportAnalysis {
  const { prepared, matched, ctx } = stage;
  const plans: GroupPlan[] = [];
  const personProblems = new Map<number, string[]>();
  const statusNotes = new Map<number, string>();
  const rowByNumber = new Map(prepared.rows.map((r) => [r.rowNumber, r]));

  for (const { group, match } of matched) {
    let outcome: GroupOutcome = "create";
    let target: ExistingCompany | null = null;
    let restore = false;
    let decision: GroupDecision = null;
    const existingOutcome: GroupOutcome = options.duplicates === "update" ? "update" : "skip";

    if (match.kind === "exact") {
      const c = match.company;
      if (c.deletedAt) {
        const choice = options.choices[group.key];
        const wantsNew = choice ? choice.action === "new" : options.deletedMatches === "new";
        const label = c.lastEmailedAt
          ? `Restore ${companyCode(c.id)} (${emailedText(c.lastEmailedAt, c.lastEmailedById, ctx, now)})?`
          : `Restore ${companyCode(c.id)} ${c.name}?`;
        decision = { kind: "restore", company: ref(c), label, selected: wantsNew ? "new" : "restore" };
        if (!wantsNew) {
          // Bringing a deleted company back is a deliberate choice: it gets the file's data and people.
          target = c;
          restore = true;
          outcome = "update";
        }
      } else {
        target = c;
        outcome = existingOutcome;
      }
    } else if (match.kind === "possible") {
      const choice = options.choices[group.key];
      let selected: "new" | number = "new";
      if (choice?.action === "merge" && match.candidates.some((c) => c.id === choice.companyId)) selected = choice.companyId;
      else if (!choice && options.possibleDuplicates === "merge") selected = match.candidates[0]!.id;
      decision = { kind: "possible-duplicate", candidates: match.candidates.map(ref), selected };
      if (selected !== "new") {
        target = match.candidates.find((c) => c.id === selected)!;
        restore = Boolean(target.deletedAt);
        outcome = restore ? "update" : existingOutcome;
      }
    }

    const { people, problems } = planPeople(group, outcome, target, ctx);
    for (const pr of problems) {
      const list = personProblems.get(pr.rowNumber);
      if (list) list.push(pr.message);
      else personProblems.set(pr.rowNumber, [pr.message]);
    }

    // Flags.
    const flags: ImportFlag[] = [];
    const latest: { at: Date | null; by: number | null } = { at: null, by: null };
    const consider = (at: Date | null, by: number | null) => {
      if (at && (!latest.at || at > latest.at)) {
        latest.at = at;
        latest.by = by;
      }
    };
    const existingForFlags = target ?? (match.kind === "exact" ? match.company : null);
    if (existingForFlags) consider(existingForFlags.lastEmailedAt, existingForFlags.lastEmailedById);
    for (const e of group.emails) {
      const p = ctx.personByEmail.get(e);
      if (p) consider(p.lastEmailedAt, p.lastEmailedById);
    }
    const emailed = Boolean(latest.at);
    // The restore question already says who emailed them and when.
    if (latest.at && !(decision?.kind === "restore" && decision.label.includes("emailed"))) {
      flags.push({ tone: "warning", text: `Already ${emailedText(latest.at, latest.by, ctx, now)}` });
    }
    const oldDates = [existingForFlags?.importedLastContactAt ?? null, group.lastContactedAt].filter((d): d is Date => Boolean(d));
    if (oldDates.length) {
      const latest = oldDates.reduce((a, b) => (a > b ? a : b));
      flags.push({ tone: "neutral", text: `Contacted in the old tool ${timeAgo(latest, now)}` });
    }
    for (const e of group.emails) {
      const p = ctx.personByEmail.get(e);
      if (p?.unsubscribedAt) flags.push({ tone: "danger", text: `${p.email ?? e} unsubscribed` });
      else if (p?.complainedAt) flags.push({ tone: "danger", text: `${p.email ?? e} marked an email as spam` });
      else if (p?.bouncedAt) flags.push({ tone: "danger", text: `${p.email ?? e} bounced` });
      else if (ctx.suppressed.has(e)) flags.push({ tone: "danger", text: `${e} is on the do-not-email list` });
    }
    flags.push(...repliedFlags(group.emails, existingForFlags, ctx, now));
    const statusRowNumber = group.rowNumbers.find((n) => rowByNumber.get(n)?.status) ?? null;
    const keptNote = target && outcome === "update" ? keptStatusNote(target.status, group.status) : null;
    if (keptNote && statusRowNumber !== null) statusNotes.set(statusRowNumber, keptNote);
    if (target && keptNote && group.status) {
      flags.push({
        tone: "neutral",
        text: `Keeps status ${COMPANY_STATUS_LABELS[target.status]} (file says ${COMPANY_STATUS_LABELS[group.status]})`,
      });
    } else if (target && !target.deletedAt && NEVER_EMAIL_STATUSES.has(target.status)) {
      flags.push({ tone: "neutral", text: `Status: ${COMPANY_STATUS_LABELS[target.status]}` });
    }
    if (decision?.kind === "possible-duplicate") flags.unshift({ tone: "warning", text: "Possible duplicate: choose" });
    if (decision?.kind === "restore") flags.unshift({ tone: "warning", text: decision.label });

    plans.push({ group, outcome, target, restore, decision, people, flags, emailed, statusRowNumber, keptStatusNote: keptNote });
  }

  // Row outcomes.
  const rowPlans = new Map<number, RowPlan>();
  const outcomeStatus: Record<GroupOutcome, RowStatusValue> = { create: "CREATED", update: "UPDATED", skip: "SKIPPED" };
  const planByKey = new Map(plans.map((p) => [p.group.key, p]));
  for (const r of prepared.rows) {
    const issues = prepared.rowIssues.get(r.rowNumber) ?? [];
    const messages = issues.map((i) => i.message);
    const groupKey = prepared.rowGroup.get(r.rowNumber) ?? null;
    let status: RowStatusValue;
    if (!groupKey) {
      status = r.empty ? "EMPTY" : r.invalidEmails.length ? "INVALID" : "PROBLEM";
    } else {
      status = outcomeStatus[planByKey.get(groupKey)!.outcome];
      if (prepared.duplicateRows.has(r.rowNumber)) status = "SKIPPED";
      const problems = personProblems.get(r.rowNumber);
      if (problems?.length) {
        messages.push(...problems);
        status = "PROBLEM";
      } else if (r.invalidEmails.length) {
        status = "INVALID";
      }
    }
    const statusNote = statusNotes.get(r.rowNumber);
    rowPlans.set(r.rowNumber, {
      status,
      messages: [
        ...messages.map((m) => {
          if (!/isn't a valid email address$/.test(m)) return sentence(m);
          return groupKey
            ? sentence(`${m}. The rest of the row is imported; fix the address in the file and import again to add it`)
            : sentence(`${m}. Fix it in the file and import again, or skip this row`);
        }),
        ...(statusNote ? [statusNote] : []),
      ],
      groupKey,
    });
  }

  let emptyRows = 0;
  let invalidEmails = 0;
  let problemRows = 0;
  let noteRows = 0;
  for (const rp of rowPlans.values()) {
    if (rp.status === "EMPTY") emptyRows++;
    else if (rp.status === "INVALID") invalidEmails++;
    else if (rp.status === "PROBLEM") problemRows++;
    else if (rp.messages.length) noteRows++;
  }
  const summary: CheckSummary = {
    rows: prepared.rows.length,
    companies: plans.length,
    newCompanies: plans.filter((p) => p.outcome === "create").length,
    updateCompanies: plans.filter((p) => p.outcome === "update").length,
    skipCompanies: plans.filter((p) => p.outcome === "skip").length,
    restoreCompanies: plans.filter((p) => p.restore).length,
    deletedFound: plans.filter((p) => p.decision?.kind === "restore").length,
    possibleDuplicates: plans.filter((p) => p.decision?.kind === "possible-duplicate").length,
    peopleToAdd: plans.reduce((n, p) => n + p.people.filter((x) => x.action === "create").length, 0),
    alreadyEmailed: plans.filter((p) => p.emailed).length,
    emptyRows,
    invalidEmails,
    problemRows,
    noteRows,
    noEmailRows: 0,
  };
  return { prepared, plans, rowPlans, summary, roundTrip: false };
}

/**
 * The full analysis for a session: what every row and company will become.
 * `fresh` skips the check-screen cache (the commit always reads fresh data);
 * `excludeCompanyIds` hides companies this import already created (resume after a stop).
 * A round-trip mapping (a Company ID column) goes to `analyzeRoundTrip`, which ignores the options
 * (grouping, duplicates, choices): it groups by company code and never creates companies.
 */
export async function analyzeImport(
  sessionId: number,
  mapping: ColumnMapping[],
  options: ImportOptions,
  opts: { fresh?: boolean; excludeCompanyIds?: ReadonlySet<number>; now?: Date } = {},
): Promise<ImportAnalysis> {
  if (isRoundTripMapping(mapping)) return analyzeRoundTrip(sessionId, mapping, { now: opts.now });
  const stage = await getStage(sessionId, mapping, options, opts);
  return resolve(stage, options, opts.now ?? new Date());
}

// ───────────────────────── the check screen ─────────────────────────

function rowTone(status: RowStatusValue, message: string, noEmail: boolean): RowIssueTone {
  if (status === "EMPTY") return "empty";
  if (noEmail && /^No email found/.test(message)) return "no-email";
  if (status === "INVALID" && /valid email/.test(message)) return "invalid";
  if (/^Duplicate within the file/.test(message)) return "duplicate";
  if (status === "PROBLEM") return "problem";
  return "note";
}

export function buildCheckView(analysis: ImportAnalysis, options: ImportOptions, onlyProblems: boolean): CheckView {
  const rowNotesByGroup = new Map<string, string[]>();
  const rowIssues: CheckRowIssueView[] = [];
  for (const [rowNumber, rp] of analysis.rowPlans) {
    for (const m of rp.messages) {
      rowIssues.push({ rowNumber, tone: rowTone(rp.status, m, rp.noEmail === true), message: m });
      if (rp.groupKey) {
        const list = rowNotesByGroup.get(rp.groupKey);
        const text = `Row ${rowNumber}: ${m}`;
        if (list) list.push(text);
        else rowNotesByGroup.set(rp.groupKey, [text]);
      }
    }
  }
  rowIssues.sort((a, b) => a.rowNumber - b.rowNumber);

  const views: CheckGroupView[] = analysis.plans.map((p) => {
    const g = p.group;
    const rowNotes = rowNotesByGroup.get(g.key) ?? [];
    const existing = p.target ? ref(p.target) : null;
    if (analysis.roundTrip && p.target) {
      // A round trip names the company as it is in the app, and lists only the people it adds.
      const adding = p.people.filter((x) => x.action === "create" || x.action === "fill" || x.action === "restore");
      const outcome: GroupOutcome = adding.length > 0 ? "update" : "skip";
      return {
        key: g.key,
        rowNumbers: g.rowNumbers.slice(0, 8),
        rowCount: g.rowNumbers.length,
        name: p.target.name,
        website: p.target.domain ?? p.target.profileKey ?? (p.target.instagram ? `@${p.target.instagram}` : null),
        country: p.target.country,
        people: adding.slice(0, 3).map((x) => ({ name: x.name, email: x.email })),
        peopleCount: adding.length,
        outcome,
        existing,
        decision: null,
        flags: p.flags,
        rowNotes: rowNotes.slice(0, 5),
        needsLook: p.flags.some((f) => f.tone !== "neutral") || rowNotes.length > 0,
      };
    }
    return {
      key: g.key,
      rowNumbers: g.rowNumbers.slice(0, 8),
      rowCount: g.rowNumbers.length,
      name: g.name,
      website: g.website ? (g.website.isShared ? (g.website.profileKey ?? g.website.host) : g.website.host) : null,
      country: g.country,
      people: g.people.slice(0, 3).map((x) => ({ name: x.name, email: x.email })),
      peopleCount: g.people.length,
      outcome: p.outcome,
      existing,
      decision: p.decision,
      flags: p.flags,
      rowNotes: rowNotes.slice(0, 5),
      needsLook: Boolean(p.decision) || p.flags.some((f) => f.tone !== "neutral") || rowNotes.length > 0,
    };
  });
  const filtered = onlyProblems ? views.filter((v) => v.needsLook) : views;
  return {
    summary: analysis.summary,
    groups: filtered.slice(0, VIEW_LIMIT),
    totalGroups: filtered.length,
    rowIssues: rowIssues.slice(0, VIEW_LIMIT),
    totalRowIssues: rowIssues.length,
    onlyProblems,
    duplicates: options.duplicates,
    possibleDuplicates: options.possibleDuplicates,
    deletedMatches: options.deletedMatches,
    roundTrip: analysis.roundTrip,
  };
}
