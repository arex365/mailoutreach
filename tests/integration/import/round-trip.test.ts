import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";

/**
 * The missing-emails round trip (M5-DESIGN §4, PLAN.md B6.13, B12 "round-trip re-import"): Export for Claude
 * → Claude's CSV → Import. Rows go to companies by company_id only; people are added, companies never change.
 */

type TestUser = { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number };
const auth = vi.hoisted(() => ({ user: null as TestUser | null }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/dal", () => {
  class AuthError extends Error {
    constructor(
      message: string,
      readonly status: 401 | 403,
    ) {
      super(message);
      this.name = "AuthError";
    }
  }
  const requireUserAction = async () => {
    if (!auth.user) throw new AuthError("Your session has ended. Please sign in again.", 401);
    return auth.user;
  };
  return { AuthError, getUserOrNull: async () => auth.user, requireUserAction, requireOwnerAction: requireUserAction };
});

const t = await createTestDb("import-round-trip");
const { db, dbTx, dbWrite } = await import("@/server/db");
const { toCsv } = await import("@/core/csv");
const { parseUploadedFile, parseDelimitedText } = await import("@/server/services/imports/parse-file");
const { createImportSession, loadStoredSession } = await import("@/server/services/imports/sessions");
const { analyzeImport, buildCheckView } = await import("@/server/services/imports/check");
const { runImportCommitJob } = await import("@/server/services/imports/commit");
const { buildProblemRowsCsv } = await import("@/server/services/imports/problems");
const { exportMissingEmails } = await import("@/server/services/export");
const { parseCompanyFilters } = await import("@/server/services/companies/filters");
const { getContactsSidebar } = await import("@/server/services/companies/query");
const { suggestMapping, ROUND_TRIP_NEEDS_EMAIL } = await import("@/core/import/column-matching");
const { ROUND_TRIP_OPTIONS } = await import("@/core/import/round-trip");
const { DEFAULT_IMPORT_OPTIONS } = await import("@/core/import/types");
const actions = await import("@/app/(app)/import/actions");

let ali: TestUser;
const CLAUDE_COLUMNS = ["company_id", "company", "email", "contact_name", "role", "source_url", "note"];

beforeAll(async () => {
  const u = await dbWrite((c) => c.user.create({ data: { email: "ali@example.com", name: "Ali", role: "OWNER" } }));
  ali = { id: u.id, email: u.email, name: u.name, role: "OWNER", timeZone: "Asia/Karachi", sessionId: 1 };
  auth.user = ali;
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

/** Uploads a CSV, maps it with the suggestion (as the mapping step does), and saves the options the round trip saves. */
async function stage(rows: string[][], fileName = "claude.csv", columns = CLAUDE_COLUMNS) {
  const csv = toCsv(rows, columns);
  const parsed = parseUploadedFile(new TextEncoder().encode(csv), fileName);
  const id = await createImportSession({ userId: ali.id, fileName, parsed });
  const mapping = suggestMapping(parsed.table.headers, parsed.table.rows.map((r) => r.cells)).map((s) => s.mapping);
  await dbWrite((c) => c.importSession.update({ where: { id }, data: { mapping, options: DEFAULT_IMPORT_OPTIONS, status: "MAPPED" } }));
  return { id, mapping };
}

async function analyze(id: number) {
  const s = (await loadStoredSession(id))!;
  const analysis = await analyzeImport(id, s.mapping!, s.options, { fresh: true });
  return { analysis, view: buildCheckView(analysis, s.options, false) };
}

function ctx(signal?: AbortSignal, onProgress?: () => void) {
  return { jobId: 1, createdById: ali.id, signal: signal ?? new AbortController().signal, progress: async () => onProgress?.() };
}

async function company(data: { name: string; website?: string; country?: string; deletedAt?: Date }) {
  return dbWrite((c) =>
    c.company.create({
      data: {
        name: data.name,
        nameNorm: data.name.toLowerCase(),
        website: data.website ?? null,
        domain: data.website ? new URL(data.website).hostname : null,
        country: data.country ?? null,
        deletedAt: data.deletedAt ?? null,
      },
    }),
  );
}

async function missingCount() {
  return (await getContactsSidebar()).missingEmailCount;
}

describe("Part C: Export for Claude → Claude's CSV → Import", () => {
  it("adds people to the right companies, lists the problems, and never creates a company", async () => {
    const a = await company({ name: "Round A", website: "https://a.test", country: "DE" });
    const b = await company({ name: "Round B", country: "NO" });
    const c = await company({ name: "Round C" });
    const d = await company({ name: "Round D" });
    await dbWrite((x) => x.person.create({ data: { companyId: d.id, name: "Dave", email: "dave@d.test", emailNorm: "dave@d.test" } }));

    // 1. The export has the three companies without an email, with their codes.
    const file = await exportMissingEmails({
      filters: parseCompanyFilters(new URLSearchParams()),
      format: "csv",
      timeZone: "UTC",
      now: new Date("2026-09-26T10:00:00Z"),
    });
    const exported = parseDelimitedText(file.body as string);
    expect(exported.rows.map((r) => [r.cells[0], r.cells[1]])).toEqual([
      [`C-${a.id}`, "Round A"],
      [`C-${b.id}`, "Round B"],
      [`C-${c.id}`, "Round C"],
    ]);

    // 2. What Claude sends back.
    const { id, mapping } = await stage([
      [`C-${a.id}`, "Round A", "anna@a.test", "Anna Berg", "Buyer", "https://a.test/team", "Named on the team page"],
      [`C-${a.id}`, "Round A", "info@a.test", "", "", "https://a.test/kontakt", ""],
      [`C-${b.id}`, "Round B", "dave@d.test", "Dave", "", "", ""],
      ["C-99999", "Nobody", "x@nobody.test", "", "", "", ""],
      [`C-${c.id}`, "Round C", "", "", "", "", "Only a contact form"],
      ["Foo", "Foo Ltd", "foo@foo.test", "", "", "", ""],
    ]);

    // 3. The suggested mapping is a round trip, with the person's notes.
    expect(mapping.map((m) => m.target)).toEqual(["company_id", "company", "email", "name", "role", "person_notes", "person_notes"]);
    const { analysis, view } = await analyze(id);
    expect(analysis.roundTrip).toBe(true);
    expect(view.roundTrip).toBe(true);
    expect(view.summary).toMatchObject({ peopleToAdd: 2, updateCompanies: 1, newCompanies: 0, problemRows: 3, noEmailRows: 1 });
    expect(view.rowIssues.map((r) => [r.rowNumber, r.tone, r.message])).toEqual([
      [4, "problem", `dave@d.test already belongs to C-${d.id} Round D, so it wasn't added here.`],
      [5, "problem", "C-99999 isn't a company in the app."],
      [6, "no-email", "No email found. Claude's note: “Only a contact form”"],
      [7, "problem", "“Foo” isn't a company ID like C-1042."],
    ]);
    const groupA = view.groups.find((g) => g.existing?.id === a.id)!;
    expect(groupA).toMatchObject({ name: "Round A", website: "a.test", outcome: "update", peopleCount: 2 });
    expect(groupA.existing?.code).toBe(`C-${a.id}`);
    expect(groupA.people).toEqual([
      { name: "Anna Berg", email: "anna@a.test" },
      { name: "General inbox", email: "info@a.test" },
    ]);
    expect(view.groups.find((g) => g.existing?.id === c.id)?.rowNotes).toEqual([`Row 6: No email found. Claude's note: “Only a contact form”`]);

    const companiesBefore = await db.company.count();
    const missingBefore = await missingCount();

    // 4. The commit job.
    const result = await runImportCommitJob({ sessionId: id }, ctx());
    expect(result.summary).toBe("Imported claude.csv: 2 people added to 1 company, 1 row without an email, 3 rows need a look.");
    expect(await db.company.count()).toBe(companiesBefore);
    expect(await missingCount()).toBe(missingBefore - 1);

    const people = await db.person.findMany({ where: { companyId: a.id }, orderBy: { id: "asc" } });
    expect(people.map((p) => [p.name, p.firstName, p.role, p.emailNorm, p.isGeneric, p.notes])).toEqual([
      ["Anna Berg", "Anna", "Buyer", "anna@a.test", false, "https://a.test/team · Named on the team page"],
      ["General inbox", null, null, "info@a.test", true, "https://a.test/kontakt"],
    ]);
    // Company fields stay as they were.
    expect(await db.company.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ name: "Round A", website: "https://a.test", country: "DE", notes: "" });
    expect(await db.company.findUniqueOrThrow({ where: { id: a.id } }).then((x) => x.searchText)).toContain("anna berg");
    // dave stays at D.
    expect(await db.person.findUniqueOrThrow({ where: { emailNorm: "dave@d.test" } })).toMatchObject({ companyId: d.id });

    const session = await db.importSession.findUniqueOrThrow({ where: { id } });
    expect(session.status).toBe("DONE");
    expect(session.summary).toMatchObject({ roundTrip: true, peopleAdded: 2, updated: 1, unchanged: 2, created: 0, problems: 3, noEmailRows: 1, listId: null, tagName: null });

    const done = await db.activityLog.findFirstOrThrow({ where: { type: "import.done" }, orderBy: { id: "desc" } });
    expect(done.summary).toBe("Ali imported claude.csv: 2 people added to 1 company, 1 row without an email, 3 rows need a look.");
    const updated = await db.activityLog.findFirstOrThrow({ where: { type: "company.updated", companyId: a.id } });
    expect(updated.summary).toBe("Updated from claude.csv by Ali (2 people)");

    // The problem rows: the three that need a look, not the row without an email.
    const problems = await buildProblemRowsCsv(id);
    expect(problems?.count).toBe(3);
    const lines = problems!.csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(`row,problem,${CLAUDE_COLUMNS.join(",")}`);
    expect(lines.slice(1).map((l) => l.split(",")[0])).toEqual(["4", "5", "7"]);
    expect(lines[2]).toContain("C-99999 isn't a company in the app.");
    const rows = await db.importRow.findMany({ where: { sessionId: id }, orderBy: { rowNumber: "asc" }, select: { status: true, message: true } });
    expect(rows.map((r) => r.status)).toEqual(["UPDATED", "UPDATED", "PROBLEM", "PROBLEM", "SKIPPED", "PROBLEM"]);
    expect(rows[4]!.message).toBeNull();
  });
});

describe("every row rule of M5-DESIGN §4.2", () => {
  it("plans each row, and the commit follows the plan", async () => {
    const alpha = await company({ name: "Alpha Figuren", website: "https://alpha.test", country: "DE" });
    const beta = await company({ name: "Beta Werkstatt" });
    const gamma = await company({ name: "Gamma" });
    const delta = await company({ name: "Delta" });
    await dbWrite((x) => x.person.create({ data: { companyId: delta.id, name: "Dora", email: "dora@delta.test", emailNorm: "dora@delta.test" } }));
    const gone = await company({ name: "Epsilon", deletedAt: new Date() });
    const foxtrot = await company({ name: "Foxtrot" });
    const golfOther = await company({ name: "Golf Other" });
    await dbWrite((x) =>
      x.person.create({ data: { companyId: golfOther.id, name: "Rita", email: "rita@removed.test", emailNorm: "rita@removed.test", deletedAt: new Date() } }),
    );
    const golf = await company({ name: "Golf" });
    const gina = await dbWrite((x) =>
      x.person.create({
        data: { companyId: golf.id, name: "Gina", email: "gina@golf.test", emailNorm: "gina@golf.test", verificationStatus: "VALID", deletedAt: new Date() },
      }),
    );
    const hotel = await company({ name: "Hotel" });
    const hanna = await dbWrite((x) =>
      x.person.create({
        data: {
          companyId: hotel.id,
          name: "Hanna Berg",
          notes: "Met at the fair",
          // An old result on a person without an address can't be right; it must go when the address comes.
          verificationStatus: "VALID",
          verificationRisk: "LOW",
          verifiedAt: new Date(),
          verificationProvider: "mailgun",
          verificationDisposable: true,
          verificationUnknowns: 2,
        },
      }),
    );
    await dbWrite((x) => x.suppression.create({ data: { emailNorm: "anna2@alpha.test", reason: "MANUAL", source: "manual" } }));

    const columns = ["company_id", "company", "website", "country", "email", "contact_name", "role", "source_url", "note"];
    const A = `C-${alpha.id}`;
    const { id, mapping } = await stage(
      [
        /* 2 */ [A, "Alpha Figuren", "https://other.example", "Norway", "anna@alpha.test", "Anna Berg", "Buyer", "https://alpha.test/team", "Named on the team page"],
        /* 3 */ [A, "Alpha Figuren", "", "", "info@alpha.test", "", "", "", ""],
        /* 4 */ [`C-${beta.id}`, "Beta Werkstatt", "", "", "dora@delta.test", "Dora", "", "", ""],
        /* 5 */ ["C-99999", "Nobody", "", "", "x@nobody.test", "", "", "", ""],
        /* 6 */ [`C-${gamma.id}`, "Gamma", "", "", "", "", "", "https://gamma.test", "Only a contact form on the site."],
        /* 7 */ ["Firma", "Foo Ltd", "", "", "foo@foo.test", "", "", "", ""],
        /* 8 */ ["", "Nameless", "", "", "n@n.test", "", "", "", ""],
        /* 9 */ [`C-${gone.id}`, "Epsilon", "", "", "e@e.test", "", "", "", ""],
        /* 10 */ [`C-${delta.id}`, "Delta", "", "", "dora@delta.test", "", "", "", ""],
        /* 11 */ [`C-${foxtrot.id}`, "Foxtrot", "", "", "rita@removed.test", "", "", "", ""],
        /* 12 */ [`c ${golf.id}`, "Golf", "", "", "gina@golf.test", "Gina", "", "https://golf.test", ""],
        /* 13 */ [`${hotel.id}`, "Hotel", "", "", "hanna@hotel.test", "Hanna Berg", "Owner", "https://hotel.test/about", ""],
        /* 14 */ [A, "Totally Different Ltd", "", "", "anna2@alpha.test", "", "", "", ""],
        /* 15 */ [A, "Alpha Figuren", "https://other.example", "Norway", "anna@alpha.test", "Anna Berg", "Buyer", "https://alpha.test/team", "Named on the team page"],
        /* 16 */ [`C-${beta.id}`, "Beta", "", "", "ANNA@alpha.test", "", "", "", ""],
        /* 17 */ [`C-${gamma.id}`, "Gamma", "", "", "bad@@gamma.test", "", "", "", ""],
        /* 18 */ ["", "", "", "", "", "", "", "", ""],
        /* 19 */ [`C-${beta.id}`, "Beta", "", "", "good@beta.test; nope@@beta.test", "", "", "", ""],
      ],
      "claude-2.csv",
      columns,
    );
    expect(mapping.map((m) => m.target)).toEqual(["company_id", "company", "website", "country", "email", "name", "role", "person_notes", "person_notes"]);

    const { view } = await analyze(id);
    const issues = new Map<number, string[]>();
    for (const r of view.rowIssues) issues.set(r.rowNumber, [...(issues.get(r.rowNumber) ?? []), `${r.tone}: ${r.message}`]);
    expect(Object.fromEntries(issues)).toEqual({
      4: [`problem: dora@delta.test already belongs to C-${delta.id} Delta, so it wasn't added here.`],
      5: ["problem: C-99999 isn't a company in the app."],
      6: ["no-email: No email found. Claude's note: “Only a contact form on the site.”"],
      7: ["problem: “Firma” isn't a company ID like C-1042."],
      8: ["problem: No company_id. Use the file exported from the app."],
      9: [`problem: C-${gone.id} (Epsilon) was deleted. Restore it first, or leave this row out.`],
      10: [`note: dora@delta.test is already at C-${delta.id} (Delta).`],
      11: [`problem: rita@removed.test belonged to a removed person at C-${golfOther.id} (Golf Other). Restore that person there, or leave this row out.`],
      14: [`note: The file says “Totally Different Ltd” for C-${alpha.id} (Alpha Figuren); the ID is used.`],
      15: ["duplicate: Duplicate within the file: same as row 2."],
      16: ["duplicate: Duplicate within the file: ANNA@alpha.test is also on row 2."],
      17: ["invalid: 'bad@@gamma.test' isn't a valid email address. Fix it in the file and import again, or skip this row."],
      18: ["empty: Empty row."],
      19: ["invalid: 'nope@@beta.test' isn't a valid email address. The rest of the row is imported; fix the address in the file and import again to add it."],
    });
    expect(view.summary).toMatchObject({
      rows: 18,
      companies: 7,
      newCompanies: 0,
      restoreCompanies: 0,
      possibleDuplicates: 0,
      peopleToAdd: 6,
      updateCompanies: 4,
      problemRows: 6,
      invalidEmails: 2,
      emptyRows: 1,
      noEmailRows: 1,
    });
    const alphaView = view.groups.find((g) => g.existing?.id === alpha.id)!;
    expect(alphaView.people.map((p) => p.email)).toEqual(["anna@alpha.test", "info@alpha.test", "anna2@alpha.test"]);
    expect(alphaView.flags).toEqual([{ tone: "danger", text: "anna2@alpha.test is on the do-not-email list" }]);
    expect(alphaView.decision).toBeNull();
    expect(view.groups.find((g) => g.existing?.id === hotel.id)?.people).toEqual([{ name: "Hanna Berg", email: "hanna@hotel.test" }]);

    const companiesBefore = await db.company.findMany({ orderBy: { id: "asc" } });
    const result = await runImportCommitJob({ sessionId: id }, ctx());
    expect(result).toMatchObject({ roundTrip: true, peopleAdded: 6, peopleUpdated: 0, updated: 4, created: 0, restored: 0, problems: 6, invalidEmails: 2 });

    // No company was created, restored or changed (the file's website and country are ignored).
    const companiesAfter = await db.company.findMany({ orderBy: { id: "asc" } });
    expect(companiesAfter.map((x) => ({ ...x, searchText: "", updatedAt: null }))).toEqual(
      companiesBefore.map((x) => ({ ...x, searchText: "", updatedAt: null })),
    );
    expect(await db.companyList.count()).toBe(0);
    expect(await db.companyTag.count()).toBe(0);
    expect(await db.list.count()).toBe(0);

    // Gina is back at Golf (her result kept: same address), with the source link.
    expect(await db.person.findUniqueOrThrow({ where: { id: gina.id } })).toMatchObject({
      deletedAt: null,
      verificationStatus: "VALID",
      notes: "https://golf.test",
    });
    // Hanna got the address; all six check fields are cleared; her notes keep the old line.
    expect(await db.person.findUniqueOrThrow({ where: { id: hanna.id } })).toMatchObject({
      email: "hanna@hotel.test",
      emailNorm: "hanna@hotel.test",
      role: "Owner",
      notes: "Met at the fair\nhttps://hotel.test/about",
      verificationStatus: null,
      verificationRisk: null,
      verifiedAt: null,
      verificationProvider: null,
      verificationDisposable: false,
      verificationUnknowns: 0,
    });
    expect(await db.person.count({ where: { companyId: hotel.id } })).toBe(1);
    // Rita stays removed at Golf Other; Foxtrot got nobody.
    expect(await db.person.findUniqueOrThrow({ where: { emailNorm: "rita@removed.test" } })).toMatchObject({ companyId: golfOther.id });
    expect(await db.person.count({ where: { companyId: foxtrot.id } })).toBe(0);
    expect((await db.person.findMany({ where: { companyId: beta.id } })).map((p) => p.emailNorm)).toEqual(["good@beta.test"]);
    expect(await db.person.count({ where: { emailNorm: { in: ["x@nobody.test", "foo@foo.test", "n@n.test", "e@e.test"] } } })).toBe(0);

    const rows = await db.importRow.findMany({ where: { sessionId: id }, orderBy: { rowNumber: "asc" }, select: { rowNumber: true, status: true, message: true } });
    expect(rows.map((r) => [r.rowNumber, r.status])).toEqual([
      [2, "UPDATED"],
      [3, "UPDATED"],
      [4, "PROBLEM"],
      [5, "PROBLEM"],
      [6, "SKIPPED"],
      [7, "PROBLEM"],
      [8, "PROBLEM"],
      [9, "PROBLEM"],
      [10, "SKIPPED"],
      [11, "PROBLEM"],
      [12, "UPDATED"],
      [13, "UPDATED"],
      [14, "UPDATED"],
      [15, "SKIPPED"],
      [16, "SKIPPED"],
      [17, "INVALID"],
      [18, "EMPTY"],
      [19, "INVALID"],
    ]);
    // Rows that need nothing done carry no message, so they stay out of the problem-rows download.
    const quiet = rows.filter((r) => [6, 10, 15, 16].includes(r.rowNumber));
    expect(quiet.every((r) => r.message === null)).toBe(true);
    expect(rows.find((r) => r.rowNumber === 14)?.message).toBe(`The file says “Totally Different Ltd” for C-${alpha.id} (Alpha Figuren); the ID is used.`);
    const problems = await buildProblemRowsCsv(id);
    expect(problems?.count).toBe(9); // 6 problems, 2 invalid, 1 note

    // Importing the same file again adds nobody twice.
    const again = await stage(
      [[A, "Alpha Figuren", "", "", "anna@alpha.test", "Anna Berg", "Buyer", "", ""]],
      "claude-again.csv",
      columns,
    );
    const second = await analyze(again.id);
    expect(second.view.summary.peopleToAdd).toBe(0);
    expect(second.view.rowIssues[0]?.message).toBe(`anna@alpha.test is already at C-${alpha.id} (Alpha Figuren).`);
    const againResult = await runImportCommitJob({ sessionId: again.id }, ctx());
    expect(againResult.summary).toBe("Imported claude-again.csv: 0 people added.");
    expect(await db.person.count({ where: { emailNorm: "anna@alpha.test" } })).toBe(1);
  });
});

describe("the formula-escape round trip (B12)", () => {
  it("brings back formula-looking values exactly, as plain text", async () => {
    const shop = await company({ name: "Formula Shop" });
    const HYPERLINK = '=HYPERLINK("https://evil.example","click")';
    const { id } = await stage([[`C-${shop.id}`, "Formula Shop", "sales@formula.test", "+49 Team", "", "https://formula.test", HYPERLINK]], "claude-formula.csv");
    // The file has them escaped for Excel ("'=HYPERLINK…", "'+49 …", toCsv); the upload takes the apostrophes off again…
    expect(toCsv([["=x", "+49"]], ["a", "b"])).toContain(`"'=x","'+49"`);
    const raw = await db.importRow.findFirstOrThrow({ where: { sessionId: id } });
    expect(raw.data).toEqual([`C-${shop.id}`, "Formula Shop", "sales@formula.test", "+49 Team", "", "https://formula.test", HYPERLINK]);
    // …and the person gets exactly what Claude wrote, as plain text.
    await runImportCommitJob({ sessionId: id }, ctx());
    expect(await db.person.findUniqueOrThrow({ where: { emailNorm: "sales@formula.test" } })).toMatchObject({
      companyId: shop.id,
      name: "+49 Team",
      notes: `https://formula.test · ${HYPERLINK}`,
    });
  });
});

describe("the import screens' actions", () => {
  it("the Options step saves the defaults unchanged and the Check step works as for any import", async () => {
    const shop = await company({ name: "Action Shop" });
    const csv = toCsv([[`C-${shop.id}`, "Action Shop", "hi@actionshop.test", "", "", "", ""]], CLAUDE_COLUMNS);
    const parsed = parseUploadedFile(new TextEncoder().encode(csv), "claude-actions.csv");
    const id = await createImportSession({ userId: ali.id, fileName: "claude-actions.csv", parsed });
    const suggested = suggestMapping(parsed.table.headers, parsed.table.rows.map((r) => r.cells)).map((s) => s.mapping);

    // A round trip without an email column is refused, with what to do.
    const noEmail = await actions.saveImportMappingAction({ sessionId: id, mapping: suggested.map((m) => (m.target === "email" ? { target: "ignore" } : m)) });
    expect(noEmail).toMatchObject({ ok: false, error: ROUND_TRIP_NEEDS_EMAIL });

    expect(await actions.saveImportMappingAction({ sessionId: id, mapping: suggested })).toMatchObject({ ok: true });
    // A new upload proposes a new list named after the file; the round trip's Options step saves the defaults.
    expect((await loadStoredSession(id))!.options.list).toEqual({ mode: "new", name: "claude-actions" });
    expect(await actions.saveImportOptionsAction({ sessionId: id, options: ROUND_TRIP_OPTIONS })).toMatchObject({ ok: true });
    expect((await loadStoredSession(id))!.options).toEqual(DEFAULT_IMPORT_OPTIONS);

    const check = await actions.checkImportAction({ sessionId: id });
    if (!check.ok) throw new Error(check.error);
    expect(check.data.roundTrip).toBe(true);
    expect(check.data.summary).toMatchObject({ peopleToAdd: 1, updateCompanies: 1, companies: 1 });
    expect(check.data.groups[0]).toMatchObject({ name: "Action Shop", peopleCount: 1, decision: null });

    const started = await actions.startImportAction({ sessionId: id });
    if (!started.ok) throw new Error(started.error);
    await runImportCommitJob({ sessionId: id }, { ...ctx(), jobId: started.data.jobId });
    expect(await db.person.findUniqueOrThrow({ where: { emailNorm: "hi@actionshop.test" } })).toMatchObject({ companyId: shop.id, name: "General inbox", isGeneric: true });
    expect(await db.list.count({ where: { name: "claude-actions" } })).toBe(0);
  });
});

describe("resuming a round trip", () => {
  it("carries on where it stopped and counts everyone once", async () => {
    const ids = await dbTx(async (tx) => {
      const out: number[] = [];
      for (let i = 0; i < 300; i++) out.push((await tx.company.create({ data: { name: `Resume RT ${i}`, nameNorm: `resume rt ${i}` } })).id);
      return out;
    });
    const { id } = await stage(ids.map((cid, i) => [`C-${cid}`, `Resume RT ${i}`, `p${i}@resume-rt.test`, `Person ${i}`, "", "", ""]), "claude-big.csv");

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
    expect(await db.person.count({ where: { emailNorm: { endsWith: "@resume-rt.test" } } })).toBe(250);

    const result = await runImportCommitJob({ sessionId: id }, ctx());
    expect(result.summary).toBe("Imported claude-big.csv: 300 people added to 300 companies.");
    expect(await db.person.count({ where: { emailNorm: { endsWith: "@resume-rt.test" } } })).toBe(300);
    expect(await db.company.count({ where: { name: { startsWith: "Resume RT " } } })).toBe(300);
  });
});

describe("the ordinary import's fill", () => {
  it("clears all six check fields when a same-name person gets an address", async () => {
    const co = await company({ name: "Fill Co", website: "https://fillco.test" });
    const bob = await dbWrite((x) =>
      x.person.create({
        data: {
          companyId: co.id,
          name: "Bob Berg",
          verificationStatus: "UNKNOWN",
          verificationRisk: "UNKNOWN",
          verifiedAt: new Date(),
          verificationProvider: "mailgun",
          verificationDisposable: true,
          verificationUnknowns: 1,
        },
      }),
    );
    const csv = "Company,Website,Email,Contact Person\nFill Co,fillco.test,bob@fillco.test,Bob Berg\n";
    const parsed = parseUploadedFile(new TextEncoder().encode(csv), "fill.csv");
    const id = await createImportSession({ userId: ali.id, fileName: "fill.csv", parsed });
    const mapping = suggestMapping(parsed.table.headers).map((s) => s.mapping);
    await dbWrite((c) => c.importSession.update({ where: { id }, data: { mapping, options: { ...DEFAULT_IMPORT_OPTIONS, duplicates: "update" }, status: "MAPPED" } }));
    const result = await runImportCommitJob({ sessionId: id }, ctx());
    expect(result).toMatchObject({ roundTrip: false, peopleUpdated: 1, peopleAdded: 0 });
    expect(await db.person.findUniqueOrThrow({ where: { id: bob.id } })).toMatchObject({
      emailNorm: "bob@fillco.test",
      verificationStatus: null,
      verificationRisk: null,
      verifiedAt: null,
      verificationProvider: null,
      verificationDisposable: false,
      verificationUnknowns: 0,
    });
  });
});
