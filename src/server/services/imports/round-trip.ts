import { firstValue, mapRow, type ColumnMapping, type TargetKey } from "@/core/import/column-matching";
import { normalizeRow, type ImportGroupDraft, type NormalizedRow, type PreparedImport } from "@/core/import/grouping";
import { claudeNoteOf, companyNamesDiffer, parseCompanyCode, personNotesText, ROUND_TRIP_TEXT } from "@/core/import/round-trip";
import type { CheckSummary, ImportFlag } from "@/core/import/types";
import { COMPANY_STATUS_LABELS, NEVER_EMAIL_STATUSES } from "@/core/labels";
import { normalizeText } from "@/core/text";
import { db } from "@/server/db";
import {
  companySelect,
  personSelect,
  sentence,
  type ExistingCompany,
  type ExistingPerson,
  type GroupPlan,
  type ImportAnalysis,
  type PlannedPerson,
  type RowPlan,
  type RowStatusValue,
} from "./check";
import { companyCode, loadImportRows } from "./sessions";

/**
 * The missing-emails round trip's planner (M5-DESIGN §4.2, PLAN.md B6.13): `analyzeImport` calls it when
 * the mapping has a Company ID column. Claude's CSV comes back with the company codes the app exported
 * ("C-1042"), so rows are grouped by that code, never by name or website, and only people are planned:
 *  - company-level values (name, website, country, notes, status, tags, list, personal line) are ignored,
 *    and so are the import options; no company is ever created, restored or changed;
 *  - each row's email, name (or first and last name), role and "Notes about the person" are used;
 *  - an address already at the company is skipped; one that belongs to another company, or to a removed
 *    person there, is a problem row (it is never moved or restored into the wrong company); a removed
 *    person with the same address at the same company is brought back; a person there with the same name
 *    and no address gets it ("fill"); anyone else is created.
 * The result is an ordinary `ImportAnalysis` (plans with outcome "update", `roundTrip: true`), so the check
 * screen and the commit job take it like any other import.
 */

const IN_CHUNK = 400;

/** The only targets a round trip reads besides the Company ID, the company name (for a note) and the person notes. */
const PERSON_TARGETS: ReadonlySet<TargetKey> = new Set<TargetKey>(["email", "name", "first_name", "last_name", "role"]);

/** One stored row as the round trip reads it. */
export type RowFacts = {
  rowNumber: number;
  /** Nothing in a mapped column. */
  empty: boolean;
  /** The company code's raw text, or null when the cell is empty. */
  codeRaw: string | null;
  companyId: number | null;
  /** The company name the file gives (only used for the "the file says …" note). */
  fileName: string | null;
  notesValues: string[];
  /** The row read with only the person columns: people (General inbox for role addresses) and invalid addresses. */
  normalized: NormalizedRow;
  fingerprint: string;
};

type Group = {
  key: string;
  company: ExistingCompany;
  rowNumbers: number[];
  people: PlannedPerson[];
};

async function inChunks<T, R>(values: T[], fn: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) out.push(...(await fn(values.slice(i, i + IN_CHUNK))));
  return out;
}

function isAdd(p: PlannedPerson): boolean {
  return p.action === "create" || p.action === "fill" || p.action === "restore";
}

/** The rows of a session, read for a round trip (pure apart from the rows given). */
export function readRoundTripRows(
  rows: ReadonlyArray<{ rowNumber: number; cells: ReadonlyArray<string> }>,
  mapping: ReadonlyArray<ColumnMapping>,
  now: Date,
): RowFacts[] {
  const personMapping: ColumnMapping[] = mapping.map((m) =>
    m.target !== "ignore" && m.target !== "custom" && PERSON_TARGETS.has(m.target) ? m : { target: "ignore" },
  );
  return [...rows]
    .sort((a, b) => a.rowNumber - b.rowNumber)
    .map((r) => {
      const mapped = mapRow(mapping, r.cells);
      const codeRaw = firstValue(mapped, "company_id") || null;
      return {
        rowNumber: r.rowNumber,
        empty: Object.keys(mapped.fields).length === 0 && mapped.custom.length === 0,
        codeRaw,
        companyId: codeRaw ? parseCompanyCode(codeRaw) : null,
        fileName: firstValue(mapped, "company") || null,
        notesValues: mapped.fields.person_notes ?? [],
        normalized: normalizeRow(r.rowNumber, r.cells, personMapping, { now }),
        fingerprint: r.cells.map((c) => normalizeText(c)).join("\u0001"),
      };
    });
}

/** "C-1043 Other GmbH" (+ " (deleted)"), as the ordinary import says it. */
function ownerText(companyId: number, companies: ReadonlyMap<number, ExistingCompany>): string {
  const owner = companies.get(companyId);
  return owner ? `${companyCode(owner.id)} ${owner.name}${owner.deletedAt ? " (deleted)" : ""}` : companyCode(companyId);
}

/**
 * The round-trip analysis of a session (M5-DESIGN §4.2). Reads the stored rows and the companies, people
 * and do-not-email entries they name; writes nothing.
 */
export async function analyzeRoundTrip(
  sessionId: number,
  mapping: ColumnMapping[],
  opts: { now?: Date } = {},
): Promise<ImportAnalysis> {
  const now = opts.now ?? new Date();
  const stored = await loadImportRows(sessionId);
  const facts = readRoundTripRows(stored, mapping, now);

  // The companies the file names (deleted ones too, to say so), and the addresses it brings.
  const ids = [...new Set(facts.flatMap((f) => (f.companyId ? [f.companyId] : [])))];
  const companies = new Map<number, ExistingCompany>();
  for (const c of await inChunks(ids, (chunk) => db.company.findMany({ where: { id: { in: chunk } }, select: companySelect }))) {
    companies.set(c.id, c);
  }
  const live = (f: RowFacts) => (f.companyId ? companies.get(f.companyId) : undefined);
  const emails = [
    ...new Set(
      facts.flatMap((f) => (live(f) && !live(f)!.deletedAt ? f.normalized.people.flatMap((p) => (p.emailNorm ? [p.emailNorm] : [])) : [])),
    ),
  ];
  const personByEmail = new Map<string, ExistingPerson>();
  for (const p of await inChunks(emails, (chunk) => db.person.findMany({ where: { emailNorm: { in: chunk } }, select: personSelect }))) {
    if (p.emailNorm) personByEmail.set(p.emailNorm, p);
  }
  // Owners of addresses that already exist elsewhere, for "already belongs to C-1043 Other GmbH".
  const ownerIds = [...new Set([...personByEmail.values()].map((p) => p.companyId))].filter((id) => !companies.has(id));
  for (const c of await inChunks(ownerIds, (chunk) => db.company.findMany({ where: { id: { in: chunk } }, select: companySelect }))) {
    companies.set(c.id, c);
  }
  // People of the named companies without an address (a same-name person gets the address).
  const targetIds = ids.filter((id) => companies.get(id) && !companies.get(id)!.deletedAt);
  const peopleByCompany = new Map<number, ExistingPerson[]>();
  for (const p of await inChunks(targetIds, (chunk) =>
    db.person.findMany({ where: { companyId: { in: chunk }, emailNorm: null, deletedAt: null }, select: personSelect }),
  )) {
    const list = peopleByCompany.get(p.companyId);
    if (list) list.push(p);
    else peopleByCompany.set(p.companyId, [p]);
  }
  const suppressed = new Set(
    (await inChunks(emails, (chunk) => db.suppression.findMany({ where: { emailNorm: { in: chunk } }, select: { emailNorm: true } }))).map(
      (s) => s.emailNorm,
    ),
  );

  const rowPlans = new Map<number, RowPlan>();
  const rowGroup = new Map<number, string>();
  const duplicateRows = new Map<number, number>();
  const groups = new Map<number, Group>();
  const firstRowOfEmail = new Map<string, number>();
  const fingerprints = new Map<string, number>();
  const filledIds = new Set<number>();
  const loose = (f: RowFacts, message: string) =>
    rowPlans.set(f.rowNumber, { status: "PROBLEM", messages: [message], groupKey: null });

  for (const f of facts) {
    if (f.empty) {
      rowPlans.set(f.rowNumber, { status: "EMPTY", messages: [sentence("empty row")], groupKey: null });
      continue;
    }
    if (!f.codeRaw) {
      loose(f, ROUND_TRIP_TEXT.noCompanyId);
      continue;
    }
    if (!f.companyId) {
      loose(f, ROUND_TRIP_TEXT.notACompanyId(f.codeRaw));
      continue;
    }
    const company = companies.get(f.companyId);
    if (!company) {
      loose(f, ROUND_TRIP_TEXT.unknownCompany(f.companyId));
      continue;
    }
    if (company.deletedAt) {
      loose(f, ROUND_TRIP_TEXT.deletedCompany(company.id, company.name));
      continue;
    }

    let group = groups.get(company.id);
    if (!group) {
      group = { key: `r${f.rowNumber}`, company, rowNumbers: [], people: [] };
      groups.set(company.id, group);
    }
    group.rowNumbers.push(f.rowNumber);
    rowGroup.set(f.rowNumber, group.key);

    // An exact copy of an earlier row adds nothing.
    const earlier = fingerprints.get(f.fingerprint);
    if (earlier !== undefined) {
      duplicateRows.set(f.rowNumber, earlier);
      rowPlans.set(f.rowNumber, {
        status: "SKIPPED",
        messages: [sentence(`duplicate within the file: same as row ${earlier}`)],
        stored: [],
        groupKey: group.key,
      });
      continue;
    }
    fingerprints.set(f.fingerprint, f.rowNumber);

    const messages: string[] = [];
    const keep: string[] = [];
    if (f.fileName && companyNamesDiffer(f.fileName, company.name)) {
      const note = ROUND_TRIP_TEXT.nameDiffers(f.fileName, company.id, company.name);
      messages.push(note);
      keep.push(note);
    }

    const withEmail = f.normalized.people.filter((p) => p.emailNorm);
    const invalid = f.normalized.issues.filter((i) => i.kind === "invalid-email").map((i) => i.message);
    if (withEmail.length === 0 && invalid.length === 0) {
      // Claude found nothing: its note says why. Nothing to fix, so the row stays out of the problem download.
      messages.push(ROUND_TRIP_TEXT.noEmail(claudeNoteOf(f.notesValues)));
      rowPlans.set(f.rowNumber, { status: "SKIPPED", messages, stored: [], groupKey: group.key, noEmail: true });
      continue;
    }

    const notes = personNotesText(f.notesValues);
    let added = 0;
    let problem = false;
    for (const p of withEmail) {
      const email = p.email ?? p.emailNorm!;
      const emailNorm = p.emailNorm!;
      // The address is added once, on the first row that adds it (a row that couldn't add it doesn't count).
      const first = firstRowOfEmail.get(emailNorm);
      if (first !== undefined) {
        messages.push(sentence(`duplicate within the file: ${email} is also on row ${first}`));
        continue;
      }
      const base = { ...p, rowNumber: f.rowNumber, notes };
      const existing = personByEmail.get(emailNorm);
      if (existing) {
        if (existing.companyId === company.id) {
          if (!existing.deletedAt) {
            messages.push(ROUND_TRIP_TEXT.alreadyAtCompany(email, company.id, company.name));
            continue;
          }
          // Removed from this very company: brought back, with their history.
          group.people.push({ ...base, action: "restore", existingId: existing.id, existingName: existing.name, existingRole: existing.role });
          firstRowOfEmail.set(emailNorm, f.rowNumber);
          added++;
          continue;
        }
        const owner = companies.get(existing.companyId);
        const text = existing.deletedAt
          ? ROUND_TRIP_TEXT.removedPersonElsewhere(email, existing.companyId, owner?.name ?? companyCode(existing.companyId))
          : sentence(`${email} already belongs to ${ownerText(existing.companyId, companies)}, so it wasn't added here`);
        messages.push(text);
        keep.push(text);
        problem = true;
        continue;
      }
      // Someone at the company with the same name and no address yet gets this one.
      const key = normalizeText(p.name);
      const sameName = key
        ? (peopleByCompany.get(company.id) ?? []).find((x) => !filledIds.has(x.id) && normalizeText(x.name) === key)
        : undefined;
      if (sameName) {
        filledIds.add(sameName.id);
        group.people.push({ ...base, action: "fill", existingId: sameName.id, existingName: sameName.name, existingRole: sameName.role });
      } else {
        group.people.push({ ...base, action: "create", existingId: null, existingName: null, existingRole: null });
      }
      firstRowOfEmail.set(emailNorm, f.rowNumber);
      added++;
    }
    for (const m of invalid) {
      const text = sentence(
        withEmail.length > 0
          ? `${m}. The rest of the row is imported; fix the address in the file and import again to add it`
          : `${m}. Fix it in the file and import again, or skip this row`,
      );
      messages.push(text);
      keep.push(text);
    }
    const status: RowStatusValue = problem ? "PROBLEM" : invalid.length ? "INVALID" : added > 0 ? "UPDATED" : "SKIPPED";
    rowPlans.set(f.rowNumber, { status, messages, stored: keep, groupKey: group.key });
  }

  // One plan per company, in file order.
  const plans: GroupPlan[] = [...groups.values()].map((g): GroupPlan => {
    const flags: ImportFlag[] = [];
    for (const p of g.people) {
      if (p.emailNorm && suppressed.has(p.emailNorm)) flags.push({ tone: "danger", text: `${p.email ?? p.emailNorm} is on the do-not-email list` });
    }
    if (NEVER_EMAIL_STATUSES.has(g.company.status)) flags.push({ tone: "neutral", text: `Status: ${COMPANY_STATUS_LABELS[g.company.status]}` });
    const draft: ImportGroupDraft = {
      key: g.key,
      rowNumbers: g.rowNumbers,
      name: g.company.name,
      nameNorm: g.company.nameNorm,
      hasOwnIdentity: true,
      hasExplicitName: false,
      website: null,
      domains: [],
      profileKeys: [],
      instagrams: [],
      emails: g.people.flatMap((p) => (p.emailNorm ? [p.emailNorm] : [])),
      country: g.company.country,
      niche: null,
      notes: [],
      personalLine: null,
      instagram: null,
      priority: null,
      status: null,
      lastContactedAt: null,
      tags: [],
      lists: [],
      custom: {},
      customLabels: {},
      people: g.people,
    };
    return {
      group: draft,
      outcome: "update",
      target: g.company,
      restore: false,
      decision: null,
      people: g.people,
      flags,
      emailed: false,
      statusRowNumber: null,
      keptStatusNote: null,
    };
  });

  let emptyRows = 0;
  let invalidEmails = 0;
  let problemRows = 0;
  let noteRows = 0;
  let noEmailRows = 0;
  for (const rp of rowPlans.values()) {
    if (rp.status === "EMPTY") emptyRows++;
    else if (rp.status === "INVALID") invalidEmails++;
    else if (rp.status === "PROBLEM") problemRows++;
    else if (rp.noEmail) noEmailRows++;
    else if (rp.messages.length) noteRows++;
  }
  const updateCompanies = plans.filter((p) => p.people.some(isAdd)).length;
  const summary: CheckSummary = {
    rows: facts.length,
    companies: plans.length,
    newCompanies: 0,
    updateCompanies,
    skipCompanies: plans.length - updateCompanies,
    restoreCompanies: 0,
    deletedFound: 0,
    possibleDuplicates: 0,
    peopleToAdd: plans.reduce((n, p) => n + p.people.filter(isAdd).length, 0),
    alreadyEmailed: 0,
    emptyRows,
    invalidEmails,
    problemRows,
    noteRows,
    noEmailRows,
  };
  const prepared: PreparedImport = {
    rows: facts.map((f) => f.normalized),
    groups: plans.map((p) => p.group),
    rowGroup,
    rowIssues: new Map(),
    duplicateRows,
  };
  return { prepared, plans, rowPlans, summary, roundTrip: true };
}
