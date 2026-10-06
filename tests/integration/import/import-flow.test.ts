import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ColumnMapping } from "@/core/import/column-matching";
import type { ImportOptions } from "@/core/import/types";
import type { JobContext } from "@/server/jobs";
import { createTestDb } from "../helpers/test-db";

const t = await createTestDb("import-flow");
const { db, dbTx, dbWrite } = await import("@/server/db");
const { parsePastedText, parseUploadedFile } = await import("@/server/services/imports/parse-file");
const { createImportSession, getImportSessionView, loadStoredSession } = await import("@/server/services/imports/sessions");
const { analyzeImport, buildCheckView } = await import("@/server/services/imports/check");
const { runImportCommitJob } = await import("@/server/services/imports/commit");
const { buildProblemRowsCsv } = await import("@/server/services/imports/problems");
const { suggestMapping } = await import("@/core/import/column-matching");
const { DEFAULT_IMPORT_OPTIONS } = await import("@/core/import/types");

let ali: { id: number; name: string };
const DAY = 86_400_000;

beforeAll(async () => {
  ali = await dbWrite((c) => c.user.create({ data: { email: "ali@example.com", name: "Ali", role: "OWNER" }, select: { id: true, name: true } }));
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

async function stage(text: string, fileName: string, options: Partial<ImportOptions> = {}, mapping?: ColumnMapping[]) {
  const parsed = fileName === "paste" ? parsePastedText(text) : parseUploadedFile(new TextEncoder().encode(text), fileName);
  const id = await createImportSession({ userId: ali.id, fileName: fileName === "paste" ? "Pasted rows" : fileName, parsed });
  const map = mapping ?? suggestMapping(parsed.table.headers, parsed.table.rows.map((r) => r.cells)).map((s) => s.mapping);
  const opts: ImportOptions = { ...DEFAULT_IMPORT_OPTIONS, ...options };
  await dbWrite((c) => c.importSession.update({ where: { id }, data: { mapping: map, options: opts, status: "MAPPED" } }));
  return id;
}

async function check(id: number, onlyProblems = false) {
  const s = (await loadStoredSession(id))!;
  const analysis = await analyzeImport(id, s.mapping!, s.options, { fresh: true });
  return buildCheckView(analysis, s.options, onlyProblems);
}

async function setOptions(id: number, patch: Partial<ImportOptions>) {
  const s = (await loadStoredSession(id))!;
  await dbWrite((c) => c.importSession.update({ where: { id }, data: { options: { ...s.options, ...patch } } }));
}

function ctx(signal?: AbortSignal, onProgress?: (done: number, total: number) => void): JobContext {
  return {
    jobId: 1,
    createdById: ali.id,
    signal: signal ?? new AbortController().signal,
    progress: async (done, total) => onProgress?.(done, total),
  };
}

async function rowStatuses(sessionId: number) {
  const rows = await db.importRow.findMany({ where: { sessionId }, orderBy: { rowNumber: "asc" }, select: { rowNumber: true, status: true, message: true } });
  return rows;
}

async function company(name: string) {
  return db.company.findFirstOrThrow({
    where: { name, deletedAt: null },
    include: { people: { orderBy: { id: "asc" } }, lists: { include: { list: true } }, tags: { include: { tag: true } } },
  });
}

describe("upload → check → commit", () => {
  it("creates companies, people, the list, the tag and custom fields", async () => {
    const csv = [
      "ID,Company,Website,Email,Contact Person,Country,Status,Last contacted,Members,Tags",
      "1,Acme 3D,acme3d.de,anna@acme3d.de,Anna Schmidt,Germany,Hired,04.03.2026,1200,resin",
      "2,Acme 3D,www.acme3d.de,info@acme3d.de,,Germany,,,,",
      "3,Nordlys Print,nordlys.no,post@nordlys.no,,Norway,Rejected,,,",
      "4,Solo Sculptor,,solo@gmail.com,Sam Solo,Atlantis,Maybe,,,",
      "5,Broken Co,broken.de,anna@@broken.de,,Germany,,,,",
      "6,,,,,,,,,",
    ].join("\n");
    const id = await stage(csv, "contacts.csv", { list: { mode: "new", name: "Germany Q4" }, tag: "Fair 2026" });

    const view = await getImportSessionView(id);
    expect(view?.rowCount).toBe(6);
    expect(view?.mapping[0]).toEqual({ target: "ignore" });

    const c = await check(id);
    expect(c.summary).toMatchObject({ rows: 6, companies: 4, newCompanies: 4, peopleToAdd: 4, invalidEmails: 1, emptyRows: 1 });
    expect(c.groups.map((g) => g.name)).toEqual(["Acme 3D", "Nordlys Print", "Solo Sculptor", "Broken Co"]);
    expect(c.rowIssues.map((r) => [r.rowNumber, r.tone])).toEqual([
      [5, "note"],
      [5, "note"],
      [6, "invalid"],
      [7, "empty"],
    ]);
    expect(c.rowIssues[2]!.message).toBe(
      "'anna@@broken.de' isn't a valid email address. The rest of the row is imported; fix the address in the file and import again to add it.",
    );

    const progress: Array<[number, number]> = [];
    const result = await runImportCommitJob({ sessionId: id }, ctx(undefined, (d, tot) => progress.push([d, tot])));
    expect(result.summary).toBe(
      "Imported contacts.csv: 4 new companies, 4 people added, 1 invalid email, 1 empty row.",
    );
    expect(progress.at(-1)).toEqual([6, 6]);

    const acme = await company("Acme 3D");
    expect(acme).toMatchObject({ status: "CLIENT", country: "DE", timeZone: "Europe/Berlin", domain: "acme3d.de", createdById: ali.id });
    expect(acme.importedLastContactAt?.toISOString().slice(0, 10)).toBe("2026-03-04");
    expect(acme.customFields).toEqual({ followers: "1200" });
    expect(acme.people.map((p) => [p.name, p.emailNorm, p.isGeneric])).toEqual([
      ["Anna Schmidt", "anna@acme3d.de", false],
      ["General inbox", "info@acme3d.de", true],
    ]);
    expect(acme.searchText).toContain("anna schmidt");
    expect(acme.lists.map((l) => l.list.name)).toEqual(["Germany Q4"]);
    expect(acme.tags.map((x) => x.tag.name).sort()).toEqual(["Fair 2026", "resin"]);

    expect((await company("Nordlys Print")).status).toBe("NOT_INTERESTED");
    const solo = await company("Solo Sculptor");
    expect(solo).toMatchObject({ status: "NOT_CONTACTED", country: null });
    expect((await company("Broken Co")).people).toEqual([]);

    expect(await db.customField.findMany({ select: { key: true, label: true, entity: true } })).toEqual([
      { key: "followers", label: "Followers", entity: "COMPANY" },
    ]);
    const list = await db.list.findFirstOrThrow({ where: { name: "Germany Q4" }, include: { _count: { select: { companies: true } } } });
    expect(list._count.companies).toBe(4);

    const statuses = await rowStatuses(id);
    expect(statuses.map((r) => r.status)).toEqual(["CREATED", "CREATED", "CREATED", "CREATED", "INVALID", "EMPTY"]);
    expect(statuses[3]!.message).toBe(
      "Unknown country 'Atlantis'. Unknown status 'Maybe', so the starting status is used.",
    );

    const session = await db.importSession.findUniqueOrThrow({ where: { id } });
    expect(session.status).toBe("DONE");
    expect(session.summary).toMatchObject({
      rows: 6,
      created: 4,
      updated: 0,
      skipped: 0,
      peopleAdded: 4,
      invalidEmails: 1,
      emptyRows: 1,
      problems: 0,
      notes: 1,
      listName: "Germany Q4",
      tagName: "Fair 2026",
    });

    const created = await db.activityLog.findMany({ where: { type: "company.created" } });
    expect(created).toHaveLength(4);
    expect(created[0]!.summary).toBe("Imported from contacts.csv by Ali");
    const done = await db.activityLog.findFirstOrThrow({ where: { type: "import.done" } });
    expect(done.summary.startsWith("Ali imported contacts.csv: 4 new companies")).toBe(true);

    const problems = await buildProblemRowsCsv(id);
    expect(problems?.fileName).toBe("problem-rows-contacts.csv");
    expect(problems?.count).toBe(2);
    const lines = problems!.csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("row,problem,ID,Company,Website,Email,Contact Person,Country,Status,Last contacted,Members,Tags");
    expect(lines[1]!.startsWith("5,")).toBe(true);
    expect(lines[2]!.startsWith("6,")).toBe(true);
  });

  it("reads pasted rows from the old tool (Instagram creators)", async () => {
    const tsv = [
      "Name\tInstagram\tFollowers\tEmail\tStatus",
      "Anna Sculpts\t@anna.sculpts\t12.5k\tanna.sculpts@gmail.com\tNot Contacted",
      "Troll Forge\thttps://www.instagram.com/trollforge/\t48000\t\tContacted",
    ].join("\n");
    const id = await stage(tsv, "paste");
    await runImportCommitJob({ sessionId: id }, ctx());
    const anna = await company("Anna Sculpts");
    expect(anna).toMatchObject({ instagram: "anna.sculpts", status: "NOT_CONTACTED", customFields: { followers: "12.5k" } });
    const troll = await company("Troll Forge");
    expect(troll).toMatchObject({ instagram: "trollforge", status: "CONTACTED", domain: null });
    const done = await db.activityLog.findFirstOrThrow({ where: { type: "import.done" }, orderBy: { id: "desc" } });
    expect(done.summary).toMatch(/^Ali imported pasted rows: 2 new companies/);
  });
});

describe("companies that already exist", () => {
  let existingId: number;

  beforeAll(async () => {
    const emailedAt = new Date(Date.now() - 12 * DAY);
    existingId = await dbTx(async (tx) => {
      const c = await tx.company.create({
        data: {
          name: "Acme GmbH",
          nameNorm: "acme",
          website: "https://acme-ex.de",
          domain: "acme-ex.de",
          country: "DE",
          niche: "Printing",
          notes: "Old note",
          lastEmailedAt: emailedAt,
          lastContactAt: emailedAt,
          lastEmailedById: ali.id,
        },
      });
      return c.id;
    });
  });

  const csv = "Company,Website,Email,Contact Person,Niche,Notes\nAcme,acme-ex.de,bob@acme-ex.de,Bob Berg,Figurines,New note\n";

  it("skips them (but still adds them to the list) when asked to skip", async () => {
    const id = await stage(csv, "acme.csv", { duplicates: "skip", list: { mode: "new", name: "Skip list" } });
    const c = await check(id);
    expect(c.summary).toMatchObject({ newCompanies: 0, skipCompanies: 1 });
    expect(c.groups[0]!.outcome).toBe("skip");
    expect(c.groups[0]!.existing?.code).toBe(`C-${existingId}`);
    expect(c.groups[0]!.flags.map((f) => f.text)).toContain("Already emailed by Ali 12 days ago");
    expect(c.summary.alreadyEmailed).toBe(1);

    await runImportCommitJob({ sessionId: id }, ctx());
    const acme = await db.company.findUniqueOrThrow({ where: { id: existingId }, include: { people: true, lists: { include: { list: true } } } });
    expect(acme).toMatchObject({ name: "Acme GmbH", niche: "Printing", notes: "Old note" });
    expect(acme.people).toEqual([]);
    expect(acme.lists.map((l) => l.list.name)).toEqual(["Skip list"]);
    expect((await rowStatuses(id)).map((r) => r.status)).toEqual(["SKIPPED"]);
    expect((await db.importSession.findUniqueOrThrow({ where: { id } })).summary).toMatchObject({ skipped: 1, created: 0 });
  });

  it("fills and overwrites the matched fields when asked to update, never deleting", async () => {
    const id = await stage(csv, "acme.csv", { duplicates: "update" });
    await runImportCommitJob({ sessionId: id }, ctx());
    const acme = await db.company.findUniqueOrThrow({ where: { id: existingId }, include: { people: true } });
    expect(acme).toMatchObject({ name: "Acme", niche: "Figurines", notes: "Old note\nNew note", country: "DE", website: "https://acme-ex.de" });
    expect(acme.people.map((p) => [p.name, p.emailNorm])).toEqual([["Bob Berg", "bob@acme-ex.de"]]);
    expect(acme.searchText).toContain("bob berg");
    expect((await rowStatuses(id)).map((r) => r.status)).toEqual(["UPDATED"]);
    expect((await db.importSession.findUniqueOrThrow({ where: { id } })).summary).toMatchObject({ updated: 1, peopleAdded: 1 });
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "company.updated", companyId: existingId } });
    expect(log.summary).toBe("Updated from acme.csv by Ali (name, niche, notes, 1 person)");

    // Importing the same file again changes nothing and adds nobody twice.
    const again = await stage(csv, "acme.csv", { duplicates: "update" });
    await runImportCommitJob({ sessionId: again }, ctx());
    expect(await db.person.count({ where: { companyId: existingId } })).toBe(1);
  });

  it("offers 'possible duplicate: choose' for the same name in another country", async () => {
    await dbWrite((c) => c.company.create({ data: { name: "Berg Figuren", nameNorm: "berg figuren", country: "DE" } }));
    const id = await stage("Company,Country,Email\nBerg Figuren,Norway,berg@berg.no\n", "berg.csv", { duplicates: "update" });
    const first = await check(id, true);
    expect(first.summary.possibleDuplicates).toBe(1);
    const g = first.groups[0]!;
    expect(g.flags[0]!.text).toBe("Possible duplicate: choose");
    expect(g.decision?.kind).toBe("possible-duplicate");
    if (g.decision?.kind !== "possible-duplicate") throw new Error("expected a decision");
    expect(g.decision.selected).toBe("new");
    const existing = g.decision.candidates[0]!;

    await setOptions(id, { choices: { [g.key]: { action: "merge", companyId: existing.id } } });
    const second = await check(id);
    expect(second.groups[0]!.outcome).toBe("update");
    await runImportCommitJob({ sessionId: id }, ctx());
    expect(await db.company.count({ where: { name: "Berg Figuren" } })).toBe(1);
    expect(await db.person.findUnique({ where: { emailNorm: "berg@berg.no" } })).toMatchObject({ companyId: existing.id });
  });
});

describe("deleted companies", () => {
  it("offers to restore them, and restores by default", async () => {
    const emailedAt = new Date(Date.now() - 12 * DAY);
    const gone = await dbTx(async (tx) => {
      const c = await tx.company.create({
        data: {
          name: "Gone Studio",
          nameNorm: "gone studio",
          domain: "gone.de",
          website: "https://gone.de",
          deletedAt: new Date(Date.now() - 2 * DAY),
          lastEmailedAt: emailedAt,
          lastContactAt: emailedAt,
          lastEmailedById: ali.id,
        },
      });
      await tx.person.create({ data: { companyId: c.id, name: "Carl", email: "carl@gone.de", emailNorm: "carl@gone.de", deletedAt: new Date() } });
      return c;
    });
    const id = await stage("Company,Website,Email\nGone Studio,gone.de,carl@gone.de\n", "gone.csv");
    const c = await check(id);
    const d = c.groups[0]!.decision;
    expect(d?.kind).toBe("restore");
    if (d?.kind !== "restore") throw new Error("expected a restore decision");
    expect(d.label).toBe(`Restore C-${gone.id} (emailed by Ali 12 days ago)?`);
    expect(d.selected).toBe("restore");
    expect(c.groups[0]!.flags.map((f) => f.text)).toEqual([d.label]);
    expect(c.groups[0]!.outcome).toBe("update");
    expect(c.summary).toMatchObject({ restoreCompanies: 1, deletedFound: 1, newCompanies: 0, alreadyEmailed: 1 });

    await runImportCommitJob({ sessionId: id }, ctx());
    const back = await db.company.findUniqueOrThrow({ where: { id: gone.id }, include: { people: true } });
    expect(back.deletedAt).toBeNull();
    expect(back.people.map((p) => [p.emailNorm, p.deletedAt])).toEqual([["carl@gone.de", null]]);
    expect((await db.importSession.findUniqueOrThrow({ where: { id } })).summary).toMatchObject({ restored: 1, created: 0, updated: 0 });
    expect(await db.activityLog.count({ where: { type: "company.restored", companyId: gone.id } })).toBe(1);
  });

  it("creates a new company when asked, and reports the address that belongs to the old one", async () => {
    const gone = await dbTx(async (tx) => {
      const c = await tx.company.create({
        data: { name: "Gone Two", nameNorm: "gone two", domain: "gone2.de", deletedAt: new Date() },
      });
      await tx.person.create({ data: { companyId: c.id, name: "Dora", email: "dora@gone2.de", emailNorm: "dora@gone2.de", deletedAt: new Date() } });
      return c;
    });
    const id = await stage("Company,Website,Email\nGone Two,gone2.de,dora@gone2.de\n", "gone2.csv", { deletedMatches: "new" });
    const c = await check(id);
    expect(c.groups[0]!.decision).toMatchObject({ kind: "restore", selected: "new" });
    await runImportCommitJob({ sessionId: id }, ctx());
    const all = await db.company.findMany({ where: { name: "Gone Two" }, include: { people: true } });
    expect(all).toHaveLength(2);
    const fresh = all.find((x) => x.id !== gone.id)!;
    expect(fresh.deletedAt).toBeNull();
    expect(fresh.people).toEqual([]);
    const rows = await rowStatuses(id);
    expect(rows[0]!.status).toBe("PROBLEM");
    expect(rows[0]!.message).toBe(`dora@gone2.de already belongs to C-${gone.id} Gone Two (deleted), so it wasn't added here.`);
  });
});

describe("an email that belongs to another company", () => {
  it("is a row problem, never an error", async () => {
    const one = await dbTx(async (tx) => {
      const c = await tx.company.create({ data: { name: "Studio One", nameNorm: "studio one" } });
      await tx.person.create({ data: { companyId: c.id, name: "Anna", email: "anna.one@gmail.com", emailNorm: "anna.one@gmail.com" } });
      return c;
    });
    const id = await stage("Company,Website,Email\nStudio Two,studiotwo.de,anna.one@gmail.com\n", "two.csv");
    const c = await check(id);
    expect(c.summary).toMatchObject({ newCompanies: 1, problemRows: 1, peopleToAdd: 0 });
    expect(c.rowIssues[0]).toMatchObject({
      rowNumber: 2,
      tone: "problem",
      message: `anna.one@gmail.com already belongs to C-${one.id} Studio One, so it wasn't added here.`,
    });
    await runImportCommitJob({ sessionId: id }, ctx());
    expect((await company("Studio Two")).people).toEqual([]);
    expect(await db.person.findUnique({ where: { emailNorm: "anna.one@gmail.com" } })).toMatchObject({ companyId: one.id });
    expect((await db.importSession.findUniqueOrThrow({ where: { id } })).summary).toMatchObject({ problems: 1, created: 1 });
  });
});

describe("resuming", () => {
  it("carries on where it stopped, without creating anything twice", async () => {
    const lines = ["Company,Website"];
    for (let i = 0; i < 600; i++) lines.push(`Resume Co ${i},resume${i}.de`);
    const id = await stage(lines.join("\n"), "resume.csv");

    const controller = new AbortController();
    let calls = 0;
    await expect(
      runImportCommitJob(
        { sessionId: id },
        ctx(controller.signal, () => {
          calls++;
          if (calls === 2) controller.abort();
        }),
      ),
    ).rejects.toThrow(/paused/);
    expect(await db.importRow.count({ where: { sessionId: id, status: "CREATED" } })).toBe(250);
    expect(await db.company.count({ where: { name: { startsWith: "Resume Co " } } })).toBe(250);
    expect((await db.importSession.findUniqueOrThrow({ where: { id } })).status).toBe("COMMITTING");

    const result = await runImportCommitJob({ sessionId: id }, ctx());
    expect(result.summary).toBe("Imported resume.csv: 600 new companies, 0 people added.");
    expect(await db.company.count({ where: { name: { startsWith: "Resume Co " } } })).toBe(600);
    expect(await db.importRow.count({ where: { sessionId: id, status: "PENDING" } })).toBe(0);
    expect((await db.importSession.findUniqueOrThrow({ where: { id } })).summary).toMatchObject({ created: 600, rows: 600 });

    // Once more: the job is finished and changes nothing.
    await runImportCommitJob({ sessionId: id }, ctx());
    expect(await db.company.count({ where: { name: { startsWith: "Resume Co " } } })).toBe(600);
  });
});
