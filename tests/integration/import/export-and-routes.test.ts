import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import type { SessionUser } from "@/lib/auth/session";
import { createTestDb } from "../helpers/test-db";

// Route handlers read the session from cookies; here the signed-in user is set by the test.
const auth = vi.hoisted(() => ({ user: null as SessionUser | null, sameOrigin: true }));
vi.mock("@/lib/auth/dal", () => ({ getUserOrNull: async () => auth.user }));
vi.mock("@/lib/request", () => ({ isSameOrigin: () => auth.sameOrigin }));

const t = await createTestDb("import-export");
const { db, dbTx, dbWrite } = await import("@/server/db");
const { EXPORT_COLUMNS, exportCompanies } = await import("@/server/services/export");
const { parseCompanyFilters } = await import("@/server/services/companies/filters");
const { parseDelimitedText, parseUploadedFile } = await import("@/server/services/imports/parse-file");
const { createImportSession, loadStoredSession } = await import("@/server/services/imports/sessions");
const { runImportCommitJob } = await import("@/server/services/imports/commit");
const { isRoundTripMapping, retargetRoundTripColumns, suggestMapping } = await import("@/core/import/column-matching");
const { DEFAULT_IMPORT_OPTIONS } = await import("@/core/import/types");
const exportRoute = await import("@/app/api/export/companies/route");
const uploadRoute = await import("@/app/api/imports/route");
const problemsRoute = await import("@/app/api/imports/[id]/problems/route");
const { NextRequest } = await import("next/server");

const NOW = new Date("2026-09-23T10:00:00Z");
const HYPERLINK = '=HYPERLINK("https://evil.example","click")';
let acmeId: number;
let betaId: number;
let ali: SessionUser;

beforeAll(async () => {
  const user = await dbWrite((c) => c.user.create({ data: { email: "ali@example.com", name: "Ali", role: "OWNER", timeZone: "Asia/Karachi" } }));
  ali = { id: user.id, email: user.email, name: user.name, role: "OWNER", timeZone: "Asia/Karachi", sessionId: 1 };
  await dbTx(async (tx) => {
    await tx.customField.createMany({
      data: [
        { key: "followers", label: "Followers", entity: "COMPANY" },
        { key: "phone", label: "Phone", entity: "COMPANY" },
      ],
    });
    const list = await tx.list.create({ data: { name: "Germany Q4" } });
    const tag = await tx.tag.create({ data: { name: "resin" } });
    const acme = await tx.company.create({
      data: {
        name: "Acme",
        nameNorm: "acme",
        website: "https://acme.de",
        domain: "acme.de",
        country: "DE",
        niche: "Printing",
        priority: "HIGH",
        priorityRank: 1,
        status: "CLIENT",
        notes: HYPERLINK,
        customFields: { followers: "1200", phone: "+49 30 123" },
        lastEmailedAt: new Date("2026-09-11T22:30:00Z"),
        lastContactAt: new Date("2026-09-11T22:30:00Z"),
        lastEmailedById: user.id,
      },
    });
    acmeId = acme.id;
    await tx.companyList.create({ data: { companyId: acme.id, listId: list.id } });
    await tx.companyTag.create({ data: { companyId: acme.id, tagId: tag.id } });
    await tx.person.create({
      data: { companyId: acme.id, name: "Anna", firstName: "Anna", role: "CEO", email: "anna@acme.de", emailNorm: "anna@acme.de", verificationStatus: "VALID" },
    });
    await tx.person.create({
      data: { companyId: acme.id, name: "General inbox", isGeneric: true, email: "info@acme.de", emailNorm: "info@acme.de", unsubscribedAt: new Date() },
    });
    const beta = await tx.company.create({ data: { name: "Beta", nameNorm: "beta", country: "NO" } });
    betaId = beta.id;
    await tx.company.create({ data: { name: "Gone", nameNorm: "gone", deletedAt: new Date() } });
  });
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

function csvRows(body: string) {
  const table = parseDelimitedText(body);
  return { headers: table.headers, rows: table.rows.map((r) => r.cells) };
}

describe("exportCompanies", () => {
  it("writes one row per person, a row for companies without people, and every custom field", async () => {
    const file = await exportCompanies({ filters: parseCompanyFilters(new URLSearchParams()), format: "csv", timeZone: "Asia/Karachi", now: NOW });
    expect(file.fileName).toBe("contacts-2026-09-23.csv");
    expect(file.contentType).toBe("text/csv; charset=utf-8");
    const body = file.body as string;
    expect(body.startsWith("﻿")).toBe(true);
    expect(body).toContain("\r\n");
    // Formula-looking values are escaped in the file…
    expect(body).toContain(`"'=HYPERLINK(""https://evil.example"",""click"")"`);
    expect(body).toContain(`"'+49 30 123"`);

    const { headers, rows } = csvRows(body);
    expect(headers).toEqual([...EXPORT_COLUMNS, "followers", "phone"]);
    expect(rows).toHaveLength(3);
    const col = (name: string) => headers.indexOf(name);
    const [anna, info, beta] = rows as [string[], string[], string[]];
    expect(anna[col("company_id")]).toBe(`C-${acmeId}`);
    expect(anna[col("company")]).toBe("Acme");
    expect(anna[col("country")]).toBe("Germany");
    expect(anna[col("priority")]).toBe("High");
    expect(anna[col("status")]).toBe("Client");
    expect(anna[col("tags")]).toBe("resin");
    expect(anna[col("lists")]).toBe("Germany Q4");
    // 22:30 UTC on 11 Sep is already 12 Sep in Pakistan.
    expect(anna[col("last_emailed")]).toBe("2026-09-12");
    expect(anna[col("emailed_by")]).toBe("Ali");
    expect(anna[col("person_name")]).toBe("Anna");
    expect(anna[col("email")]).toBe("anna@acme.de");
    expect(anna[col("role")]).toBe("CEO");
    expect(anna[col("verification")]).toBe("Valid");
    expect(anna[col("unsubscribed")]).toBe("");
    // … and come back exactly when the file is imported again.
    expect(anna[col("notes")]).toBe(HYPERLINK);
    expect(anna[col("phone")]).toBe("+49 30 123");
    expect(anna[col("followers")]).toBe("1200");
    expect(info[col("person_name")]).toBe("General inbox");
    expect(info[col("unsubscribed")]).toBe("Yes");
    expect(beta[col("company")]).toBe("Beta");
    expect(beta[col("email")]).toBe("");
    expect(beta[col("country")]).toBe("Norway");
  });

  it("exports the Instagram profile and the old tool's last-contacted date (SPEC-7)", async () => {
    const creator = await dbWrite((c) =>
      c.company.create({
        data: {
          name: "Sculpt by Anna",
          nameNorm: "sculpt by anna",
          instagram: "sculpt_by_anna",
          country: "DE",
          importedLastContactAt: new Date("2025-06-01T12:00:00Z"),
          lastContactAt: new Date("2025-06-01T12:00:00Z"),
        },
      }),
    );
    // Emailed from the app long ago, contacted in the old tool more recently.
    const both = await dbWrite((c) =>
      c.company.create({
        data: {
          name: "Both Dates",
          nameNorm: "both dates",
          lastEmailedAt: new Date("2025-01-10T12:00:00Z"),
          lastEmailedById: ali.id,
          importedLastContactAt: new Date("2025-03-05T12:00:00Z"),
          lastContactAt: new Date("2025-03-05T12:00:00Z"),
        },
      }),
    );
    try {
      const file = await exportCompanies({ ids: [creator.id, both.id, acmeId], format: "csv", timeZone: "UTC", now: NOW });
      const { headers, rows } = csvRows(file.body as string);
      const col = (name: string) => headers.indexOf(name);
      const byName = new Map(rows.map((r) => [r[col("company")], r]));
      expect(byName.get("Sculpt by Anna")![col("instagram")]).toBe("https://www.instagram.com/sculpt_by_anna/");
      expect(byName.get("Sculpt by Anna")![col("last_emailed")]).toBe("2025-06-01");
      expect(byName.get("Sculpt by Anna")![col("emailed_by")]).toBe("Old tool");
      expect(byName.get("Both Dates")![col("last_emailed")]).toBe("2025-03-05");
      expect(byName.get("Both Dates")![col("emailed_by")]).toBe("Old tool");
      // Acme was emailed from the app, later than anything else: its sender stays.
      expect(byName.get("Acme")![col("last_emailed")]).toBe("2026-09-11");
      expect(byName.get("Acme")![col("emailed_by")]).toBe("Ali");
      expect(byName.get("Acme")![col("instagram")]).toBe("");
    } finally {
      await dbWrite((c) => c.company.deleteMany({ where: { id: { in: [creator.id, both.id] } } }));
    }
  });

  it("follows the Contacts filters", async () => {
    const file = await exportCompanies({ filters: parseCompanyFilters(new URLSearchParams("country=NO")), format: "csv", timeZone: "UTC", now: NOW });
    expect(csvRows(file.body as string).rows.map((r) => r[1])).toEqual(["Beta"]);
    const withEmail = await exportCompanies({ filters: parseCompanyFilters(new URLSearchParams("hasEmail=yes")), format: "csv", timeZone: "UTC", now: NOW });
    expect(csvRows(withEmail.body as string).rows.map((r) => r[1])).toEqual(["Acme", "Acme"]);
  });

  it("exports only the ticked companies, never deleted ones", async () => {
    const gone = await db.company.findFirstOrThrow({ where: { name: "Gone" } });
    const file = await exportCompanies({ ids: [betaId, gone.id], format: "csv", timeZone: "UTC", now: NOW });
    expect(csvRows(file.body as string).rows.map((r) => r[1])).toEqual(["Beta"]);
  });

  it("uses semicolons when asked", async () => {
    const file = await exportCompanies({ ids: [betaId], format: "csv", delimiter: ";", timeZone: "UTC", now: NOW });
    expect((file.body as string).split("\r\n")[0]).toBe(`﻿${[...EXPORT_COLUMNS, "followers", "phone"].join(";")}`);
  });

  it("writes an Excel file with the same content", async () => {
    const file = await exportCompanies({ filters: parseCompanyFilters(new URLSearchParams()), format: "xlsx", timeZone: "Asia/Karachi", now: NOW });
    expect(file.fileName).toBe("contacts-2026-09-23.xlsx");
    const wb = XLSX.read(file.body as Uint8Array, { type: "array" });
    const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, defval: "" });
    expect(rows[0]).toEqual([...EXPORT_COLUMNS, "followers", "phone"]);
    expect(rows).toHaveLength(4);
    expect(rows[1]![EXPORT_COLUMNS.indexOf("notes")]).toBe(HYPERLINK);
    expect(rows[1]![EXPORT_COLUMNS.length + 1]).toBe("+49 30 123");
  });

  it("re-imported as it is (a round trip, M5), it adds nobody and changes no company", async () => {
    const file = await exportCompanies({ filters: parseCompanyFilters(new URLSearchParams()), format: "csv", timeZone: "UTC", now: NOW });
    const parsed = parseUploadedFile(new TextEncoder().encode(file.body as string), "contacts-again.csv");
    const id = await createImportSession({ userId: ali.id, fileName: "contacts-again.csv", parsed });
    const mapping = suggestMapping(parsed.table.headers, parsed.table.rows.map((r) => r.cells)).map((s) => s.mapping);
    // The export's company_id column makes the file a round trip: people only, by company code.
    expect(isRoundTripMapping(mapping)).toBe(true);
    await dbWrite((c) => c.importSession.update({ where: { id }, data: { mapping, options: { ...DEFAULT_IMPORT_OPTIONS, duplicates: "update" }, status: "MAPPED" } }));
    const before = await db.company.findUniqueOrThrow({ where: { id: acmeId } });
    const result = await runImportCommitJob({ sessionId: id }, { jobId: 1, createdById: ali.id, signal: new AbortController().signal, progress: async () => {} });
    expect(result).toMatchObject({ roundTrip: true, created: 0, updated: 0, peopleAdded: 0, problems: 0, noEmailRows: 1 });
    expect(await db.company.count({ where: { deletedAt: null } })).toBe(2);
    expect(await db.person.count()).toBe(2);
    const after = await db.company.findUniqueOrThrow({ where: { id: acmeId } });
    expect(after).toEqual(before);
  });

  it("re-imports cleanly: nothing is duplicated", async () => {
    const file = await exportCompanies({ filters: parseCompanyFilters(new URLSearchParams()), format: "csv", timeZone: "UTC", now: NOW });
    const parsed = parseUploadedFile(new TextEncoder().encode(file.body as string), "contacts-2026-09-23.csv");
    const id = await createImportSession({ userId: ali.id, fileName: "contacts-2026-09-23.csv", parsed });
    const suggested = suggestMapping(parsed.table.headers, parsed.table.rows.map((r) => r.cells)).map((s) => s.mapping);
    // To update the companies instead, the company_id column is set to "Ignore this column" (the mapping step's
    // round-trip note says so); the other columns keep their ordinary meaning.
    const mapping = retargetRoundTripColumns(
      parsed.table.headers,
      parsed.table.rows.map((r) => r.cells),
      suggested.map((m) => (m.target === "company_id" ? { target: "ignore" as const } : m)),
      false,
    );
    expect(mapping.map((m) => m.target)).not.toContain("person_notes");
    await dbWrite((c) => c.importSession.update({ where: { id }, data: { mapping, options: { ...DEFAULT_IMPORT_OPTIONS, duplicates: "update" }, status: "MAPPED" } }));
    const result = await runImportCommitJob({ sessionId: id }, { jobId: 1, createdById: ali.id, signal: new AbortController().signal, progress: async () => {} });
    // Acme gets the exported date as its old-tool date; Beta has nothing new, so it isn't "updated" (DATA-13).
    expect(result).toMatchObject({ created: 0, updated: 1, unchanged: 1, peopleAdded: 0, problems: 0 });
    expect(result.summary).toBe("Imported contacts-2026-09-23.csv: 0 new companies, 1 updated, 1 already up to date, 0 people added.");
    expect(await db.company.count({ where: { deletedAt: null } })).toBe(2);
    const acme = await db.company.findUniqueOrThrow({ where: { id: acmeId } });
    expect(acme.notes).toBe(HYPERLINK);
    expect(acme.customFields).toEqual({ followers: "1200", phone: "+49 30 123" });
    expect((await loadStoredSession(id))?.status).toBe("DONE");
  });
});

describe("GET /api/export/companies", () => {
  it("sends a signed-out person to sign in, then back to the same Contacts view (SPEC-8)", async () => {
    auth.user = null;
    const res = await exportRoute.GET(new NextRequest("http://localhost/api/export/companies?format=csv&country=DE&list=3&sort=country"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?next=${encodeURIComponent("/contacts?list=3&country=DE&sort=country")}`);
    const selection = await exportRoute.GET(new NextRequest("http://localhost/api/export/companies?ids=1,2&format=xlsx"));
    expect(selection.headers.get("location")).toBe(`/login?next=${encodeURIComponent("/contacts")}`);
  });

  it("shows a small page with 'Back to Contacts' when the export can't be made", async () => {
    auth.user = ali;
    const spy = vi.spyOn(db.company, "count").mockResolvedValueOnce(60_000);
    try {
      const res = await exportRoute.GET(new NextRequest("http://localhost/api/export/companies?country=NO"));
      expect(res.status).toBe(413);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const html = await res.text();
      expect(html).toContain("<h1>The export didn&#39;t work</h1>");
      expect(html).toContain("This view has 60,000 companies; exports are limited to 50,000.");
      expect(html).toContain(`<a href="/contacts?country=NO">Back to Contacts</a>`);
    } finally {
      spy.mockRestore();
    }
  });

  it("downloads CSV for the filters and Excel for a selection", async () => {
    auth.user = ali;
    const res = await exportRoute.GET(new NextRequest("http://localhost/api/export/companies?format=csv&country=DE&delimiter=semicolon"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="contacts-\d{4}-\d{2}-\d{2}\.csv"/);
    const text = await res.text();
    expect(text.split("\r\n")[0]!.split(";")[0]).toBe("company_id");
    expect(text).toContain("Acme");
    expect(text).not.toContain("Beta");

    const xlsx = await exportRoute.GET(new NextRequest(`http://localhost/api/export/companies?format=xlsx&ids=${betaId}`));
    expect(xlsx.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const wb = XLSX.read(new Uint8Array(await xlsx.arrayBuffer()), { type: "array" });
    const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, defval: "" });
    expect(rows.map((r) => r[1])).toEqual(["company", "Beta"]);
  });

  it("asks for a selection when ids is empty", async () => {
    auth.user = ali;
    const res = await exportRoute.GET(new NextRequest("http://localhost/api/export/companies?ids="));
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Tick at least one company, then export again.");
    expect(html).toContain(`<a href="/contacts">Back to Contacts</a>`);
  });
});

describe("POST /api/imports", () => {
  /** What a browser sends: the multipart body with its Content-Length. */
  async function post(form: FormData, headers: Record<string, string> = {}) {
    const draft = new Request("http://localhost/api/imports", { method: "POST", body: form });
    const bytes = new Uint8Array(await draft.arrayBuffer());
    return new Request("http://localhost/api/imports", {
      method: "POST",
      body: bytes,
      headers: {
        origin: "http://localhost",
        "content-type": draft.headers.get("content-type")!,
        "content-length": String(bytes.byteLength),
        ...headers,
      },
    });
  }

  it("stores an uploaded file as an import session", async () => {
    auth.user = ali;
    auth.sameOrigin = true;
    const form = new FormData();
    form.set("file", new File(["Firma;E-Mail\nNordlys;post@nordlys.no\n"], "kunden.csv", { type: "text/csv" }));
    const res = await uploadRoute.POST(await post(form));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number; kind: string; rowCount: number; fileName: string };
    expect(body).toMatchObject({ kind: "csv", rowCount: 1, fileName: "kunden.csv" });
    const session = await loadStoredSession(body.id);
    expect(session?.headers).toEqual(["Firma", "E-Mail"]);
    expect(await db.importRow.count({ where: { sessionId: body.id } })).toBe(1);
  });

  it("takes pasted rows", async () => {
    auth.user = ali;
    const form = new FormData();
    form.set("text", "Company\tEmail\nAcme\tinfo@acme.de\n");
    const res = await uploadRoute.POST(await post(form));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ kind: "paste", fileName: "Pasted rows", rowCount: 1 });
  });

  it("refuses files over 8 MB with the size in the message", async () => {
    auth.user = ali;
    const form = new FormData();
    form.set("file", new File([new Uint8Array(12 * 1024 * 1024)], "huge.csv"));
    const res = await uploadRoute.POST(await post(form));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "This file is 12 MB; the limit is 8 MB. Split it into two files." });
  });

  it("refuses an upload that doesn't say its size (SECURITY-9)", async () => {
    auth.user = ali;
    const form = new FormData();
    form.set("text", "Company\nAcme\n");
    // No Content-Length (e.g. Transfer-Encoding: chunked): never buffered.
    const noLength = new Request("http://localhost/api/imports", { method: "POST", body: form, headers: { origin: "http://localhost" } });
    expect(noLength.headers.get("content-length")).toBeNull();
    const res = await uploadRoute.POST(noLength);
    expect(res.status).toBe(411);
    expect(((await res.json()) as { error: string }).error).toMatch(/didn't say how big it is/);

    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const chunked = new Request("http://localhost/api/imports", {
      method: "POST",
      body: endless,
      headers: { origin: "http://localhost", "content-type": "multipart/form-data; boundary=x" },
      duplex: "half",
    } as RequestInit);
    expect((await uploadRoute.POST(chunked)).status).toBe(411);
    expect(pulled).toBeLessThan(5);

    const bad = await post(form, { "content-length": "12abc" });
    expect((await uploadRoute.POST(bad)).status).toBe(411);
  });

  it("stops reading a body that is bigger than it said (SECURITY-9)", async () => {
    auth.user = ali;
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 64 * 1024;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const lying = new Request("http://localhost/api/imports", {
      method: "POST",
      body: endless,
      headers: { origin: "http://localhost", "content-type": "multipart/form-data; boundary=x", "content-length": "1000" },
      duplex: "half",
    } as RequestInit);
    const res = await uploadRoute.POST(lying);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toMatch(/bigger than the 8 MB limit/);
    // It stopped just past the limit instead of reading on forever.
    expect(sent).toBeLessThan(9 * 1024 * 1024);
  });

  it("explains a file it can't read", async () => {
    auth.user = ali;
    const form = new FormData();
    form.set("file", new File(["Company\n"], "only-header.csv"));
    const res = await uploadRoute.POST(await post(form));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/only has a header row/);
  });

  it("refuses a file with too many columns (SECURITY-3)", async () => {
    auth.user = ali;
    const form = new FormData();
    form.set("file", new File(["Company" + ",".repeat(20_000) + "x\nAcme\n"], "wide.csv"));
    const res = await uploadRoute.POST(await post(form));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/columns; the limit is 500/);
  });

  it("refuses strangers and other sites", async () => {
    auth.user = null;
    expect((await uploadRoute.POST(await post(new FormData()))).status).toBe(401);
    auth.user = ali;
    auth.sameOrigin = false;
    expect((await uploadRoute.POST(await post(new FormData()))).status).toBe(403);
    auth.sameOrigin = true;
  });
});

describe("GET /api/imports/:id/problems", () => {
  it("downloads the problem rows as CSV", async () => {
    auth.user = ali;
    const parsed = parseUploadedFile(new TextEncoder().encode("Company,Email\nBad Co,nope@@bad.de\nFine Co,hi@fine.de\n"), "list.csv");
    const id = await createImportSession({ userId: ali.id, fileName: "list.csv", parsed });
    const mapping = suggestMapping(parsed.table.headers).map((s) => s.mapping);
    await dbWrite((c) => c.importSession.update({ where: { id }, data: { mapping, options: DEFAULT_IMPORT_OPTIONS, status: "MAPPED" } }));
    await runImportCommitJob({ sessionId: id }, { jobId: 1, createdById: ali.id, signal: new AbortController().signal, progress: async () => {} });
    const res = await problemsRoute.GET(new NextRequest(`http://localhost/api/imports/${id}/problems`), {
      params: Promise.resolve({ id: String(id) }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain('filename="problem-rows-list.csv"');
    const lines = (await res.text()).replace(/^﻿/, "").trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("row,problem,Company,Email");
    expect(lines[1]).toMatch(/^2,'nope@@bad\.de' isn't a valid email address\. .*,Bad Co,nope@@bad\.de$/);
  });

  it("says when the import doesn't exist, on a page with a way back (SPEC-8)", async () => {
    auth.user = ali;
    const res = await problemsRoute.GET(new NextRequest("http://localhost/api/imports/99999/problems"), {
      params: Promise.resolve({ id: "99999" }),
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain("This import doesn&#39;t exist any more.");
    expect(html).toContain(`<a href="/import">Back to Import</a>`);
  });

  it("sends a signed-out person to sign in, then back to the import", async () => {
    auth.user = null;
    const res = await problemsRoute.GET(new NextRequest("http://localhost/api/imports/42/problems"), {
      params: Promise.resolve({ id: "42" }),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?next=${encodeURIComponent("/import/42")}`);
  });
});
