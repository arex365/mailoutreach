import type { Prisma } from "@/generated/prisma/client";
import { mappingProblem } from "@/core/import/column-matching";
import type { ImportGroupDraft } from "@/core/import/grouping";
import {
  EMPTY_RESULT,
  importSourceLabel,
  importSummarySentence,
  LIST_NAME_MAX,
  readResultSummary,
  TAG_NAME_MAX,
  type ImportOptions,
  type ImportResultSummary,
} from "@/core/import/types";
import { appendPersonNotes } from "@/core/import/round-trip";
import { notesToAdd } from "@/core/import/values";
import { defaultTimeZoneFor } from "@/core/geo/countries";
import { NEVER_EMAIL_STATUSES, type CompanyStatusValue } from "@/core/labels";
import { firstNameFrom, normalizeCompanyName, normalizeText } from "@/core/text";
import { CLEARED_CHECK_FIELDS } from "@/core/verification/types";
import { logActivities, logActivity, type ActivityInput } from "@/server/activity";
import { refreshCompanySearchText } from "@/server/company-search";
import { db, dbTx, dbWrite, pauseForOtherWriters, type Tx } from "@/server/db";
import type { JobContext, JobHandler } from "@/server/jobs";
import { finishCheck } from "@/server/services/campaigns/control";
import { lastContactAt, priorityRank } from "@/server/services/companies/filters";
import { isStopStatus } from "@/server/services/companies/mutations";
import { stopCompaniesForStatus, type StopStatus } from "@/server/services/mail-events/stops";
import {
  analyzeImport,
  companySelect,
  keptStatusNote,
  personSelect,
  type ExistingCompany,
  type ExistingPerson,
  type GroupPlan,
  type RowPlan,
  type RowStatusValue,
} from "./check";
import { companyCode, loadImportRows, loadStoredSession, type StoredSession } from "./sessions";

/**
 * Worker handler for the "import.commit" job. Payload: { sessionId: number }.
 *
 * Re-runs the check from the stored rows + saved mapping/options/choices, then writes in
 * chunks (≤ 250 rows per transaction, PLAN.md B5). Each chunk also sets ImportRow.status
 * (CREATED / UPDATED / SKIPPED / INVALID / EMPTY / PROBLEM) and adds to the running totals
 * in ImportSession.summary, all in the same transaction — so a restart resumes exactly where
 * it stopped and the totals stay right.
 *
 * The check runs once, at the start; a big import takes minutes, and teammates keep working
 * meanwhile. So each chunk re-reads the companies and people it changes, inside its own
 * transaction, and works from those fresh rows: a note added in the panel is kept, a status
 * set to "Do not contact" stays, and a company deleted meanwhile is left alone (its rows are
 * reported as problems).
 *
 * A status the file sets to Replied, Client, Not interested or Do not contact stops the company's
 * open follow-ups in every campaign, in the chunk's transaction, like the same change made in the
 * panel or in bulk (M4-DESIGN §2.7, D18; `stopCompaniesForStatus`); campaigns left with nothing to
 * send are finished after the chunks. Chunks pause a moment between them so the web app can write.
 *
 * The missing-emails round trip (a Company ID column, M5-DESIGN §4.2) runs through the same chunks, but
 * never writes a company field, list, tag or custom field: it only adds people (new ones with their
 * notes, an address filled in for a same-name person, a removed person brought back) and logs one
 * "company.updated" per company that got someone. Its totals count them all as "people added".
 */

const CHUNK_ROWS = 250;
const IN_CHUNK = 400;
/** Companies per `stopCompaniesForStatus` call (M4-DESIGN §2.7: at most 50 per call). */
const STOP_COMPANIES = 50;

type Refs = {
  listId: number | null;
  listName: string | null;
  tagName: string | null;
  /** normalised list name → id (the destination list and per-row lists). */
  lists: Map<string, number>;
  /** normalised tag name → id (the import's tag and per-row tags). */
  tags: Map<string, number>;
  importTagId: number | null;
};

type Actor = { id: number | null; name: string };

type Deltas = Omit<ImportResultSummary, "rows" | "listId" | "listName" | "tagName" | "roundTrip">;

/** A round trip creates no list, tag or custom field. */
const NO_REFS: Refs = { listId: null, listName: null, tagName: null, lists: new Map(), tags: new Map(), importTagId: null };

/** What happened to one company in this import; each company is counted once, as the "biggest" of these. */
type CompanyOutcome = "created" | "restored" | "updated" | "unchanged" | "skipped";
const OUTCOME_RANK: Record<CompanyOutcome, number> = { created: 5, restored: 4, updated: 3, unchanged: 2, skipped: 1 };

function zeroDeltas(): Deltas {
  return {
    created: 0,
    updated: 0,
    unchanged: 0,
    restored: 0,
    skipped: 0,
    peopleAdded: 0,
    peopleUpdated: 0,
    invalidEmails: 0,
    emptyRows: 0,
    problems: 0,
    notes: 0,
    noEmailRows: 0,
  };
}

function readSessionId(payload: unknown): number {
  const id = (payload as { sessionId?: unknown } | null)?.sessionId;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    throw new Error("This import task is missing its file. Start the import again from the Import page.");
  }
  return id;
}

function cleanName(name: string, max: number): string {
  return name.replace(/\s+/g, " ").trim().slice(0, max);
}

function toJson(summary: ImportResultSummary): Prisma.InputJsonObject {
  return { ...summary };
}

// ───────────────────────── lists, tags and custom fields (once, before the chunks) ─────────────────────────

async function ensureRefs(session: StoredSession, plans: GroupPlan[], actor: Actor, label: string): Promise<Refs> {
  const options = session.options;
  return dbTx(async (tx) => {
    const lists = new Map<string, number>();
    const tags = new Map<string, number>();
    const activities: ActivityInput[] = [];

    const allLists = await tx.list.findMany({ select: { id: true, name: true } });
    const findList = (name: string) => allLists.find((l) => normalizeText(l.name) === normalizeText(name)) ?? null;
    const ensureList = async (raw: string): Promise<{ id: number; name: string } | null> => {
      const name = cleanName(raw, LIST_NAME_MAX);
      if (!name) return null;
      const existing = findList(name);
      if (existing) {
        lists.set(normalizeText(name), existing.id);
        return existing;
      }
      const created = await tx.list.create({
        data: { name, createdById: actor.id, description: `Created by the import of ${label}` },
        select: { id: true, name: true },
      });
      allLists.push(created);
      lists.set(normalizeText(name), created.id);
      activities.push({
        actorId: actor.id,
        type: "list.created",
        summary: `${actor.name} created the list "${created.name}" (import of ${label})`,
        data: { listId: created.id },
      });
      return created;
    };

    let listId: number | null = null;
    let listName: string | null = null;
    if (options.list.mode === "existing") {
      const list = await tx.list.findUnique({ where: { id: options.list.listId }, select: { id: true, name: true } });
      if (list) {
        listId = list.id;
        listName = list.name;
        lists.set(normalizeText(list.name), list.id);
      }
    } else if (options.list.mode === "new") {
      const list = await ensureList(options.list.name);
      if (list) {
        listId = list.id;
        listName = list.name;
      }
    }
    const rowLists = new Set<string>();
    for (const p of plans) for (const l of p.group.lists) rowLists.add(l);
    for (const l of rowLists) await ensureList(l);

    const allTags = await tx.tag.findMany({ select: { id: true, name: true } });
    const ensureTag = async (raw: string): Promise<{ id: number; name: string } | null> => {
      const name = cleanName(raw.replace(/,/g, " "), TAG_NAME_MAX);
      if (!name) return null;
      const key = normalizeText(name);
      const existing = allTags.find((t) => normalizeText(t.name) === key);
      if (existing) {
        tags.set(key, existing.id);
        return existing;
      }
      const created = await tx.tag.create({ data: { name }, select: { id: true, name: true } });
      allTags.push(created);
      tags.set(key, created.id);
      return created;
    };
    let importTagId: number | null = null;
    let tagName: string | null = null;
    if (options.tag) {
      const tag = await ensureTag(options.tag);
      importTagId = tag?.id ?? null;
      tagName = tag?.name ?? null;
    }
    const rowTags = new Set<string>();
    for (const p of plans) for (const t of p.group.tags) rowTags.add(t);
    for (const t of rowTags) await ensureTag(t);

    // Custom fields: one CustomField row per new key (values live in Company.customFields).
    const labels = new Map<string, string>();
    for (const p of plans) for (const [k, l] of Object.entries(p.group.customLabels)) if (!labels.has(k)) labels.set(k, l);
    if (labels.size) {
      const existing = await tx.customField.findMany({ where: { key: { in: [...labels.keys()] } }, select: { key: true } });
      const have = new Set(existing.map((e) => e.key));
      const missing = [...labels].filter(([k]) => !have.has(k));
      if (missing.length) {
        await tx.customField.createMany({
          data: missing.map(([key, label]) => ({ key, label: label.slice(0, 120) || key, entity: "COMPANY" })),
        });
      }
    }
    await logActivities(activities, tx);
    return { listId, listName, tagName, lists, tags, importTagId };
  });
}

// ───────────────────────── company data ─────────────────────────

function createData(g: ImportGroupDraft, options: ImportOptions, actor: Actor, now: Date): Prisma.CompanyUncheckedCreateInput {
  const name = g.name.slice(0, 200);
  const priority = g.priority ?? "NORMAL";
  return {
    name,
    nameNorm: normalizeCompanyName(name) || normalizeText(name),
    website: g.website?.url ?? null,
    domain: g.website?.domain ?? null,
    profileKey: g.website?.profileKey ?? null,
    country: g.country,
    timeZone: defaultTimeZoneFor(g.country),
    niche: g.niche,
    priority,
    priorityRank: priorityRank(priority),
    status: g.status ?? options.startStatus,
    notes: g.notes.join("\n"),
    personalLine: g.personalLine,
    personalLineSource: g.personalLine ? "import" : null,
    personalLineUpdatedAt: g.personalLine ? now : null,
    personalLineUpdatedById: g.personalLine ? actor.id : null,
    instagram: g.instagram,
    ...(Object.keys(g.custom).length ? { customFields: g.custom } : {}),
    importedLastContactAt: g.lastContactedAt,
    // Nothing was sent from this app yet, so the newest contact is the old tool's.
    lastContactAt: lastContactAt(null, g.lastContactedAt),
    createdById: actor.id,
  };
}

/**
 * Update mode: fills and overwrites the mapped fields; never deletes anything. `t` is the
 * company as it is NOW (re-read inside the chunk's transaction). A status is returned
 * separately: it's written with a compare-and-set, and Client / Not interested / Do not
 * contact are never changed by an import (`keptStatus`).
 */
function updateData(
  g: ImportGroupDraft,
  t: ExistingCompany,
  actor: Actor,
  now: Date,
): { data: Prisma.CompanyUncheckedUpdateInput; status: CompanyStatusValue | null; keptStatus: boolean; changed: string[] } {
  const data: Prisma.CompanyUncheckedUpdateInput = {};
  const changed: string[] = [];
  if (g.hasExplicitName && g.name !== t.name) {
    data.name = g.name.slice(0, 200);
    data.nameNorm = normalizeCompanyName(g.name) || normalizeText(g.name);
    changed.push("name");
  }
  if (g.website && g.website.url !== t.website) {
    data.website = g.website.url;
    data.domain = g.website.domain;
    data.profileKey = g.website.profileKey;
    changed.push("website");
  }
  if (g.country && g.country !== t.country) {
    data.country = g.country;
    // Move the time zone along unless someone chose one by hand.
    if (!t.timeZone || t.timeZone === defaultTimeZoneFor(t.country)) data.timeZone = defaultTimeZoneFor(g.country);
    changed.push("country");
  }
  if (g.niche && g.niche !== t.niche) {
    data.niche = g.niche;
    changed.push("niche");
  }
  if (g.priority && g.priority !== t.priority) {
    data.priority = g.priority;
    data.priorityRank = priorityRank(g.priority);
    changed.push("priority");
  }
  let status: CompanyStatusValue | null = null;
  let keptStatus = false;
  if (g.status && g.status !== t.status) {
    if (NEVER_EMAIL_STATUSES.has(t.status)) keptStatus = true;
    else {
      status = g.status;
      changed.push("status");
    }
  }
  const newNotes = notesToAdd(t.notes, g.notes);
  if (newNotes.length) {
    data.notes = [t.notes.trim(), ...newNotes].filter(Boolean).join("\n");
    changed.push("notes");
  }
  if (g.personalLine && g.personalLine !== t.personalLine) {
    data.personalLine = g.personalLine;
    data.personalLineSource = "import";
    data.personalLineUpdatedAt = now;
    data.personalLineUpdatedById = actor.id;
    changed.push("personal line");
  }
  if (g.instagram && g.instagram !== t.instagram) {
    data.instagram = g.instagram;
    changed.push("Instagram");
  }
  if (Object.keys(g.custom).length) {
    const current = (t.customFields && typeof t.customFields === "object" && !Array.isArray(t.customFields)
      ? (t.customFields as Record<string, unknown>)
      : {}) as Record<string, unknown>;
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries(current)) if (typeof v === "string") merged[k] = v;
    let diff = false;
    for (const [k, v] of Object.entries(g.custom)) {
      if (merged[k] !== v) {
        merged[k] = v;
        diff = true;
      }
    }
    if (diff) {
      data.customFields = merged;
      changed.push("custom fields");
    }
  }
  if (g.lastContactedAt && (!t.importedLastContactAt || g.lastContactedAt > t.importedLastContactAt)) {
    data.importedLastContactAt = g.lastContactedAt;
    data.lastContactAt = lastContactAt(t.lastEmailedAt, g.lastContactedAt);
    changed.push("last contacted");
  }
  return { data, status, keptStatus, changed };
}

// ───────────────────────── one chunk ─────────────────────────

type RowRef = { id: number; status: string };

async function applyChunk(
  tx: Tx,
  input: {
    sessionId: number;
    plans: GroupPlan[];
    looseRows: number[];
    rowPlans: Map<number, RowPlan>;
    rowRefs: Map<number, RowRef>;
    options: ImportOptions;
    refs: Refs;
    actor: Actor;
    label: string;
    now: Date;
    /** Companies already counted in the totals by an earlier chunk (or an earlier run of this import). */
    counted: ReadonlySet<number>;
    /** The missing-emails round trip: people only, the companies stay as they are. */
    roundTrip: boolean;
  },
): Promise<{ written: number; counted: number[]; campaignIds: number[] }> {
  const { plans, rowPlans, rowRefs, options, refs, actor, label, now, roundTrip } = input;
  const deltas = zeroDeltas();
  const activities: ActivityInput[] = [];
  const touched = new Set<number>();
  /** Companies whose status this chunk changed to one that stops follow-ups, per status. */
  const stops = new Map<StopStatus, number[]>();
  const rowResults: Array<{
    rowNumber: number;
    status: RowStatusValue;
    message: string | null;
    companyId: number | null;
    noEmail: boolean;
  }> = [];
  const lateProblems = new Map<number, string[]>();
  /** A "kept the status" note that changed since the check (the status was changed meanwhile). */
  const statusNoteFixes = new Map<number, { drop: string | null; add: string | null }>();
  const outcomes = new Map<number, CompanyOutcome>();
  const record = (companyId: number, what: CompanyOutcome) => {
    const current = outcomes.get(companyId);
    if (!current || OUTCOME_RANK[what] > OUTCOME_RANK[current]) outcomes.set(companyId, what);
  };

  // The companies and people this chunk changes, as they are now.
  const targetIds = [...new Set(plans.flatMap((p) => (p.target ? [p.target.id] : [])))];
  const freshCompanies = new Map<number, ExistingCompany>();
  if (targetIds.length) {
    for (const c of await tx.company.findMany({ where: { id: { in: targetIds } }, select: companySelect })) freshCompanies.set(c.id, c);
  }
  const personIds = [...new Set(plans.flatMap((p) => p.people.flatMap((x) => (x.existingId ? [x.existingId] : []))))];
  const freshPeople = new Map<number, ExistingPerson>();
  for (let i = 0; i < personIds.length; i += IN_CHUNK) {
    const ids = personIds.slice(i, i + IN_CHUNK);
    for (const p of await tx.person.findMany({ where: { id: { in: ids } }, select: personSelect })) freshPeople.set(p.id, p);
  }

  // Someone may have added one of these addresses since the check: never break on it.
  const newEmails = plans.flatMap((p) =>
    p.people.filter((x) => x.emailNorm && (x.action === "create" || x.action === "fill")).map((x) => x.emailNorm!),
  );
  const taken = new Map<string, number>();
  for (let i = 0; i < newEmails.length; i += IN_CHUNK) {
    const chunk = newEmails.slice(i, i + IN_CHUNK);
    for (const p of await tx.person.findMany({ where: { emailNorm: { in: chunk } }, select: { emailNorm: true, companyId: true } })) {
      if (p.emailNorm) taken.set(p.emailNorm, p.companyId);
    }
  }

  const memberships: Array<{ companyId: number; listId: number; isNew: boolean }> = [];
  const tagLinks: Array<{ companyId: number; tagId: number; isNew: boolean }> = [];

  for (const plan of plans) {
    const g = plan.group;
    let companyId: number;
    let changedPeople = 0;
    let changedFields: string[] = [];
    if (plan.outcome === "create") {
      const created = await tx.company.create({ data: createData(g, options, actor, now), select: { id: true } });
      companyId = created.id;
      record(companyId, "created");
      activities.push({
        actorId: actor.id,
        type: "company.created",
        summary: `Imported from ${label} by ${actor.name}`,
        companyId,
        data: { importSessionId: input.sessionId },
      });
      touched.add(companyId);
    } else {
      const planned = plan.target!;
      const current = freshCompanies.get(planned.id);
      if (!current || (current.deletedAt && !plan.restore)) {
        // Deleted by a teammate while this import ran: leave it deleted, and say so on its rows.
        const message = `${companyCode(planned.id)} ${planned.name} was deleted while this import ran, so this row wasn't imported. Restore the company, then import the row again.`;
        for (const rowNumber of g.rowNumbers) {
          const rp = rowPlans.get(rowNumber);
          if (!rp) continue;
          rowResults.push({ rowNumber, status: "PROBLEM", message: [...(rp.stored ?? rp.messages), message].join(" "), companyId: null, noEmail: false });
        }
        continue;
      }
      companyId = current.id;
      if (!roundTrip && current.deletedAt) {
        // Only one plan (and one run) brings it back, even when two groups point at it.
        const res = await tx.company.updateMany({ where: { id: companyId, deletedAt: { not: null } }, data: { deletedAt: null } });
        if (res.count === 1) {
          record(companyId, "restored");
          activities.push({
            actorId: actor.id,
            type: "company.restored",
            summary: `Restored from ${label} by ${actor.name}`,
            companyId,
            data: { importSessionId: input.sessionId },
          });
          touched.add(companyId);
        }
      }
      if (roundTrip) {
        // A round trip never changes the company itself (M5-DESIGN §4.2): only the people below.
      } else if (plan.outcome === "update") {
        const { data, status, keptStatus, changed } = updateData(g, current, actor, now);
        if (Object.keys(data).length) await tx.company.update({ where: { id: companyId }, data });
        if (status) {
          // Compare-and-set: a protected status set a moment ago is never overwritten.
          const res = await tx.company.updateMany({
            where: { id: companyId, status: { notIn: [...NEVER_EMAIL_STATUSES] } },
            data: { status },
          });
          if (res.count === 0) changed.splice(changed.indexOf("status"), 1);
          else if (isStopStatus(status)) stops.set(status, [...(stops.get(status) ?? []), companyId]);
        }
        if (changed.length) touched.add(companyId);
        changedFields = changed;
        const note = keptStatus ? keptStatusNote(current.status, g.status) : null;
        if (plan.statusRowNumber !== null && note !== plan.keptStatusNote) {
          statusNoteFixes.set(plan.statusRowNumber, { drop: plan.keptStatusNote, add: note });
        }
      } else {
        record(companyId, "skipped");
      }
    }

    // People (re-read above: someone may have edited, deleted or given them an address meanwhile).
    for (const p of plan.people) {
      if (p.emailNorm && (p.action === "create" || p.action === "fill")) {
        const owner = taken.get(p.emailNorm);
        if (owner !== undefined && owner !== companyId) {
          const list = lateProblems.get(p.rowNumber) ?? [];
          list.push(`${p.email} was added to ${companyCode(owner)} while this import ran, so it wasn't added here.`);
          lateProblems.set(p.rowNumber, list);
          continue;
        }
        if (owner === companyId) continue;
      }
      const createPerson = async () => {
        await tx.person.create({
          data: {
            companyId,
            name: p.name.slice(0, 200),
            firstName: p.firstName,
            role: p.role,
            email: p.email,
            emailNorm: p.emailNorm,
            isGeneric: p.isGeneric,
            ...(p.notes ? { notes: p.notes } : {}),
          },
        });
        deltas.peopleAdded++;
        changedPeople++;
      };
      /** A person given an address (filled in, brought back): a round trip counts them as added. */
      const countGiven = () => {
        if (roundTrip) deltas.peopleAdded++;
        else deltas.peopleUpdated++;
        changedPeople++;
      };
      const existing = p.existingId ? freshPeople.get(p.existingId) : undefined;
      const notes = appendPersonNotes(existing?.notes, p.notes);
      switch (p.action) {
        case "create":
          await createPerson();
          break;
        case "fill": {
          // Only while that person still has no address and wasn't removed. A new address needs checking
          // again: all six check fields are cleared (M5-DESIGN §2.6).
          const res = await tx.person.updateMany({
            where: { id: p.existingId!, emailNorm: null, deletedAt: null },
            data: {
              email: p.email,
              emailNorm: p.emailNorm,
              ...CLEARED_CHECK_FIELDS,
              ...(p.role && !existing?.role ? { role: p.role } : {}),
              ...(notes ? { notes } : {}),
            },
          });
          if (res.count === 1) {
            countGiven();
          } else {
            // They got another address (or were removed) meanwhile: this address becomes its own person.
            await createPerson();
          }
          break;
        }
        case "restore":
        case "update": {
          if (!existing) break;
          if (p.action === "update" && existing.deletedAt) break; // removed by a teammate meanwhile
          const data: Prisma.PersonUncheckedUpdateInput = {};
          if (existing.deletedAt) data.deletedAt = null;
          if (p.name && !p.isGeneric && p.name !== existing.name) {
            data.name = p.name.slice(0, 200);
            data.firstName = p.firstName ?? (firstNameFrom(p.name) || null);
            data.isGeneric = false;
          }
          if (p.role && p.role !== existing.role) data.role = p.role;
          if (notes) data.notes = notes;
          if (Object.keys(data).length) {
            await tx.person.update({ where: { id: existing.id }, data });
            countGiven();
          }
          break;
        }
        case "none":
          break;
      }
    }
    if (changedPeople) touched.add(companyId);
    if (roundTrip) {
      if (changedPeople) {
        activities.push({
          actorId: actor.id,
          type: "company.updated",
          summary: `Updated from ${label} by ${actor.name} (${changedPeople === 1 ? "1 person" : `${changedPeople} people`})`,
          companyId,
          data: { importSessionId: input.sessionId, fields: [], people: changedPeople, roundTrip: true },
        });
        record(companyId, "updated");
      } else {
        record(companyId, "unchanged");
      }
    } else if (plan.outcome === "update") {
      if (changedFields.length || changedPeople) {
        const what = [...changedFields];
        if (changedPeople) what.push(changedPeople === 1 ? "1 person" : `${changedPeople} people`);
        activities.push({
          actorId: actor.id,
          type: "company.updated",
          summary: `Updated from ${label} by ${actor.name} (${what.join(", ")})`,
          companyId,
          data: { importSessionId: input.sessionId, fields: changedFields, people: changedPeople },
        });
        record(companyId, "updated");
      } else {
        record(companyId, "unchanged");
      }
    }

    // Lists and tags (existing companies may already have them). A round trip adds none.
    const isNew = plan.outcome === "create";
    const listIds = new Set<number>();
    const tagIds = new Set<number>();
    if (!roundTrip) {
      if (refs.listId) listIds.add(refs.listId);
      for (const l of g.lists) {
        const id = refs.lists.get(normalizeText(cleanName(l, LIST_NAME_MAX)));
        if (id) listIds.add(id);
      }
      if (refs.importTagId) tagIds.add(refs.importTagId);
      for (const t of g.tags) {
        const id = refs.tags.get(normalizeText(cleanName(t.replace(/,/g, " "), TAG_NAME_MAX)));
        if (id) tagIds.add(id);
      }
    }
    for (const listId of listIds) memberships.push({ companyId, listId, isNew });
    for (const tagId of tagIds) tagLinks.push({ companyId, tagId, isNew });

    // Rows of this company.
    for (const rowNumber of g.rowNumbers) {
      const rp = rowPlans.get(rowNumber);
      if (!rp) continue;
      const late = lateProblems.get(rowNumber);
      const fix = statusNoteFixes.get(rowNumber);
      const messages = (rp.stored ?? rp.messages).filter((m) => !fix?.drop || m !== fix.drop);
      if (fix?.add) messages.push(fix.add);
      messages.push(...(late ?? []));
      rowResults.push({
        rowNumber,
        status: late?.length ? "PROBLEM" : rp.status,
        message: messages.length ? messages.join(" ") : null,
        companyId,
        noEmail: rp.noEmail === true,
      });
    }
  }

  for (const rowNumber of input.looseRows) {
    const rp = rowPlans.get(rowNumber);
    if (!rp) continue;
    rowResults.push({
      rowNumber,
      status: rp.status,
      message: (rp.stored ?? rp.messages).join(" ") || null,
      companyId: null,
      noEmail: rp.noEmail === true,
    });
  }

  // Memberships: skip the ones existing companies already have.
  const existingCompanyIds = [...new Set(memberships.filter((m) => !m.isNew).map((m) => m.companyId))];
  const haveLists = new Set<string>();
  if (existingCompanyIds.length) {
    for (const m of await tx.companyList.findMany({ where: { companyId: { in: existingCompanyIds } }, select: { companyId: true, listId: true } })) {
      haveLists.add(`${m.companyId}:${m.listId}`);
    }
  }
  // Two groups can land on the same company (a "possible duplicate" merged by hand): link once.
  const newMemberships = memberships.filter((m) => {
    const key = `${m.companyId}:${m.listId}`;
    if (haveLists.has(key)) return false;
    haveLists.add(key);
    return true;
  });
  if (newMemberships.length) {
    await tx.companyList.createMany({
      data: newMemberships.map((m) => ({ companyId: m.companyId, listId: m.listId, addedById: actor.id })),
    });
    for (const m of newMemberships) if (!m.isNew) touched.add(m.companyId);
  }
  const tagCompanyIds = [...new Set(tagLinks.filter((m) => !m.isNew).map((m) => m.companyId))];
  const haveTags = new Set<string>();
  if (tagCompanyIds.length) {
    for (const m of await tx.companyTag.findMany({ where: { companyId: { in: tagCompanyIds } }, select: { companyId: true, tagId: true } })) {
      haveTags.add(`${m.companyId}:${m.tagId}`);
    }
  }
  const newTags = tagLinks.filter((m) => {
    const key = `${m.companyId}:${m.tagId}`;
    if (haveTags.has(key)) return false;
    haveTags.add(key);
    return true;
  });
  if (newTags.length) await tx.companyTag.createMany({ data: newTags.map((m) => ({ companyId: m.companyId, tagId: m.tagId })) });

  // Row statuses (grouped, so equal rows share one statement). Rows finished in an earlier run keep theirs.
  const buckets = new Map<string, { ids: number[]; status: RowStatusValue; message: string | null; companyId: number | null }>();
  let written = 0;
  for (const r of rowResults) {
    const ref = rowRefs.get(r.rowNumber);
    if (!ref || ref.status !== "PENDING") continue;
    written++;
    if (r.status === "EMPTY") deltas.emptyRows++;
    else if (r.status === "INVALID") deltas.invalidEmails++;
    else if (r.status === "PROBLEM") deltas.problems++;
    else if (r.message) deltas.notes++;
    if (r.noEmail && r.status !== "PROBLEM") deltas.noEmailRows++;
    const key = `${r.status}|${r.companyId ?? ""}|${r.message ?? ""}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.ids.push(ref.id);
    else buckets.set(key, { ids: [ref.id], status: r.status, message: r.message, companyId: r.companyId });
  }
  for (const b of buckets.values()) {
    await tx.importRow.updateMany({
      where: { id: { in: b.ids }, status: "PENDING" },
      data: { status: b.status, message: b.message?.slice(0, 2000) ?? null, companyId: b.companyId },
    });
  }

  // Company totals: each company once, even when two groups (or two chunks) landed on it.
  const newlyCounted: number[] = [];
  for (const [companyId, what] of outcomes) {
    if (input.counted.has(companyId)) continue;
    deltas[what]++;
    newlyCounted.push(companyId);
  }

  if (touched.size) await refreshCompanySearchText(tx, [...touched]);
  await logActivities(activities, tx);

  // Replied / Client / Not interested / Do not contact from the file stop the companies' follow-ups, in this
  // transaction, as the same status set in the panel does (M4-DESIGN §2.7).
  const campaignIds = new Set<number>();
  for (const [status, ids] of stops) {
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += STOP_COMPANIES) {
      const stopped = await stopCompaniesForStatus(tx, { companyIds: unique.slice(i, i + STOP_COMPANIES), status, now });
      for (const id of stopped.campaignIds) campaignIds.add(id);
    }
  }

  // Running totals, in the same transaction as the rows they count.
  const session = await tx.importSession.findUnique({ where: { id: input.sessionId }, select: { summary: true } });
  const current = readResultSummary(session?.summary) ?? { ...EMPTY_RESULT };
  const next: ImportResultSummary = { ...current };
  for (const k of Object.keys(deltas) as Array<keyof Deltas>) next[k] = current[k] + deltas[k];
  await tx.importSession.update({ where: { id: input.sessionId }, data: { summary: toJson(next) } });
  return { written, counted: newlyCounted, campaignIds: [...campaignIds] };
}

// ───────────────────────── the job ─────────────────────────

function chunkPlans(plans: GroupPlan[]): GroupPlan[][] {
  const chunks: GroupPlan[][] = [];
  let current: GroupPlan[] = [];
  let rows = 0;
  for (const p of plans) {
    if (current.length && rows + p.group.rowNumbers.length > CHUNK_ROWS) {
      chunks.push(current);
      current = [];
      rows = 0;
    }
    current.push(p);
    rows += p.group.rowNumbers.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function stopIfAsked(ctx: JobContext): void {
  if (ctx.signal.aborted) {
    throw new Error("The import paused because the background sender is stopping. It carries on where it left off when it starts again.");
  }
}

/**
 * Of these companies, the ones THIS import created (its company.created entries carry the
 * import's id). Used on resume: whatever status their rows ended with (a created company's row
 * can be INVALID or PROBLEM because of one bad address), they are not "existing" companies.
 */
export async function companiesCreatedByImport(sessionId: number, companyIds: readonly number[]): Promise<Set<number>> {
  const out = new Set<number>();
  for (let i = 0; i < companyIds.length; i += IN_CHUNK) {
    const logs = await db.activityLog.findMany({
      where: { type: "company.created", companyId: { in: companyIds.slice(i, i + IN_CHUNK) } },
      select: { companyId: true, data: true },
    });
    for (const l of logs) {
      const data = l.data;
      if (
        l.companyId !== null &&
        data &&
        typeof data === "object" &&
        !Array.isArray(data) &&
        (data as Record<string, unknown>).importSessionId === sessionId
      ) {
        out.add(l.companyId);
      }
    }
  }
  return out;
}

export const runImportCommitJob: JobHandler = async (payload, ctx) => {
  const sessionId = readSessionId(payload);
  const session = await loadStoredSession(sessionId);
  if (!session) throw new Error("This import no longer exists. Upload the file again from the Import page.");
  const label = importSourceLabel(session.fileName, session.kind);

  const user = await db.user.findUnique({ where: { id: session.createdById }, select: { id: true, name: true } });
  const actor: Actor = { id: user?.id ?? null, name: user?.name ?? "a teammate" };

  if (session.status === "DONE") {
    const s = readResultSummary((await db.importSession.findUnique({ where: { id: sessionId }, select: { summary: true } }))?.summary) ?? EMPTY_RESULT;
    return { summary: importSummarySentence(label, s), sessionId, ...s };
  }
  if (session.status === "CANCELLED") throw new Error("This import was cancelled.");
  const mapping = session.mapping;
  const problem = mapping ? mappingProblem(mapping) : "The columns of this import were never matched.";
  if (!mapping || problem) {
    await dbWrite((c) => c.importSession.update({ where: { id: sessionId }, data: { status: "FAILED" } }));
    throw new Error(`${problem} Open the import and match the columns, then start it again.`);
  }

  await dbWrite((c) =>
    c.importSession.update({ where: { id: sessionId }, data: { status: "COMMITTING", jobId: ctx.jobId } }),
  );

  // Resume: rows already written keep their result; companies this import created are not "existing",
  // and companies already counted in the totals aren't counted again.
  const storedRows = await loadImportRows(sessionId);
  const rowRefs = new Map<number, RowRef>(storedRows.map((r) => [r.rowNumber, { id: r.id, status: r.status }]));
  const doneCompanyIds = [...new Set(storedRows.filter((r) => r.status !== "PENDING" && r.companyId !== null).map((r) => r.companyId!))];
  const createdByThisImport = await companiesCreatedByImport(sessionId, doneCompanyIds);
  const counted = new Set<number>(doneCompanyIds);
  const analysis = await analyzeImport(sessionId, mapping, session.options, {
    fresh: true,
    excludeCompanyIds: createdByThisImport,
  });
  const isPending = (rowNumber: number) => rowRefs.get(rowNumber)?.status === "PENDING";
  const roundTrip = analysis.roundTrip;

  // A round trip adds people only: no list, tag or custom field is created for it.
  const refs = roundTrip ? NO_REFS : await ensureRefs(session, analysis.plans, actor, label);
  // The totals start with the list/tag names; counts are added chunk by chunk.
  await dbTx(async (tx) => {
    const s = await tx.importSession.findUnique({ where: { id: sessionId }, select: { summary: true } });
    const current = readResultSummary(s?.summary) ?? { ...EMPTY_RESULT };
    await tx.importSession.update({
      where: { id: sessionId },
      data: {
        summary: toJson({
          ...current,
          rows: storedRows.length,
          listId: refs.listId,
          listName: refs.listName,
          tagName: refs.tagName,
          roundTrip,
        }),
      },
    });
  });

  const total = storedRows.length;
  let done = storedRows.filter((r) => r.status !== "PENDING").length;
  await ctx.progress(done, total);
  const now = new Date();

  const base = { sessionId, rowPlans: analysis.rowPlans, rowRefs, options: session.options, refs, actor, label, now, roundTrip };

  // Rows that belong to no company (empty, unreadable): recorded first.
  const loose = analysis.prepared.rows
    .map((r) => r.rowNumber)
    .filter((n) => !analysis.rowPlans.get(n)?.groupKey && isPending(n));
  for (let i = 0; i < loose.length; i += CHUNK_ROWS * 2) {
    stopIfAsked(ctx);
    const slice = loose.slice(i, i + CHUNK_ROWS * 2);
    const startedAt = Date.now();
    const res = await dbTx((tx) => applyChunk(tx, { ...base, plans: [], looseRows: slice, counted }));
    done += res.written;
    await ctx.progress(done, total);
    // A pause as long as a quarter of the chunk (10–50 ms): the web app gets its turn to write while the import runs.
    await pauseForOtherWriters(Date.now() - startedAt);
  }

  const pendingPlans = analysis.plans.filter((p) => p.group.rowNumbers.some(isPending));
  /** Campaigns where a status from the file stopped someone: they may have nothing left to send. */
  const stoppedCampaigns = new Set<number>();
  for (const chunk of chunkPlans(pendingPlans)) {
    stopIfAsked(ctx);
    const startedAt = Date.now();
    // `counted` only grows after the chunk's transaction committed (a retried chunk starts from the same set).
    const res = await dbTx((tx) => applyChunk(tx, { ...base, plans: chunk, looseRows: [], counted }));
    done += res.written;
    for (const id of res.counted) counted.add(id);
    for (const id of res.campaignIds) stoppedCampaigns.add(id);
    await ctx.progress(done, total);
    await pauseForOtherWriters(Date.now() - startedAt);
  }
  for (const campaignId of [...stoppedCampaigns].sort((a, b) => a - b)) {
    try {
      await finishCheck(campaignId, { now: new Date() });
    } catch (err) {
      // The 5-minute maintenance runs the finish check again.
      console.error(`[import] the finish check of campaign #${campaignId} failed`, err);
    }
  }

  // Rows that weren't in the analysis (shouldn't happen) are marked so the import can finish.
  await dbWrite((c) =>
    c.importRow.updateMany({ where: { sessionId, status: "PENDING" }, data: { status: "SKIPPED", message: "Nothing to import." } }),
  );

  const final = await db.importSession.findUnique({ where: { id: sessionId }, select: { summary: true } });
  const summary = readResultSummary(final?.summary) ?? { ...EMPTY_RESULT };
  await dbTx(async (tx) => {
    await tx.importSession.update({
      where: { id: sessionId },
      data: { status: "DONE", committedAt: new Date(), summary: toJson(summary) },
    });
    await logActivity(
      {
        actorId: actor.id,
        type: "import.done",
        summary: importSummarySentence(label, summary, actor.name),
        data: { importSessionId: sessionId, ...summary },
      },
      tx,
    );
  });
  await ctx.progress(total, total);
  return { summary: importSummarySentence(label, summary), sessionId, ...summary };
};
