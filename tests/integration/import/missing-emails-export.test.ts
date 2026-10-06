import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth/session";
import { createTestDb } from "../helpers/test-db";

// Route handlers read the session from cookies; here the signed-in user is set by the test.
const auth = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock("@/lib/auth/dal", () => ({ getUserOrNull: async () => auth.user }));

const t = await createTestDb("missing-emails-export");
const { db, dbTx, dbWrite } = await import("@/server/db");
const { MISSING_EMAIL_COLUMNS, exportMissingEmails } = await import("@/server/services/export");
const { parseCompanyFilters } = await import("@/server/services/companies/filters");
const { parseDelimitedText } = await import("@/server/services/imports/parse-file");
const route = await import("@/app/api/export/missing-emails/route");
const { NextRequest } = await import("next/server");

const NOW = new Date("2026-09-23T10:00:00Z");
let ali: SessionUser;
let nordlysId: number;
let creatorId: number;

beforeAll(async () => {
  const user = await dbWrite((c) => c.user.create({ data: { email: "ali@example.com", name: "Ali", role: "OWNER", timeZone: "Asia/Karachi" } }));
  ali = { id: user.id, email: user.email, name: user.name, role: "OWNER", timeZone: "Asia/Karachi", sessionId: 1 };
  await dbTx(async (tx) => {
    // Has an email: never in the file.
    const acme = await tx.company.create({ data: { name: "Acme", nameNorm: "acme", website: "https://acme.de", domain: "acme.de", country: "DE" } });
    await tx.person.create({ data: { companyId: acme.id, name: "Anna", email: "anna@acme.de", emailNorm: "anna@acme.de" } });
    // No people at all.
    const nordlys = await tx.company.create({ data: { name: "Nordlys", nameNorm: "nordlys", website: "https://nordlys.no", domain: "nordlys.no", country: "NO" } });
    nordlysId = nordlys.id;
    // A person without an address, and an Instagram creator without a website.
    const creator = await tx.company.create({ data: { name: "Sculpt by Anna", nameNorm: "sculpt by anna", instagram: "sculpt_by_anna", country: "DE" } });
    creatorId = creator.id;
    await tx.person.create({ data: { companyId: creator.id, name: "Anna S" } });
    // Only a removed person has the address: still missing.
    const removed = await tx.company.create({ data: { name: "Zeta", nameNorm: "zeta", country: "NO" } });
    await tx.person.create({ data: { companyId: removed.id, name: "Old", email: "old@zeta.no", emailNorm: "old@zeta.no", deletedAt: new Date() } });
    // Deleted company: never exported.
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

describe("exportMissingEmails", () => {
  it("lists only live companies without an email, with the columns Claude fills in", async () => {
    const file = await exportMissingEmails({ filters: parseCompanyFilters(new URLSearchParams()), format: "csv", timeZone: "Asia/Karachi", now: NOW });
    expect(file.fileName).toBe("missing-emails-2026-09-23.csv");
    const { headers, rows } = csvRows(file.body as string);
    expect(headers).toEqual([...MISSING_EMAIL_COLUMNS]);
    expect(rows.map((r) => r[1])).toEqual(["Nordlys", "Sculpt by Anna", "Zeta"]);
    expect(rows[0]).toEqual([`C-${nordlysId}`, "Nordlys", "https://nordlys.no", "Norway", "", "", "", "", ""]);
    expect(rows[1]!.slice(0, 3)).toEqual([`C-${creatorId}`, "Sculpt by Anna", "https://www.instagram.com/sculpt_by_anna/"]);
  });

  it("follows the other Contacts filters", async () => {
    const file = await exportMissingEmails({ filters: parseCompanyFilters(new URLSearchParams("country=NO")), format: "csv", timeZone: "UTC", now: NOW });
    expect(csvRows(file.body as string).rows.map((r) => r[1])).toEqual(["Nordlys", "Zeta"]);
  });
});

describe("GET /api/export/missing-emails", () => {
  it("sends a signed-out person to sign in, then back to the Missing email view (SPEC-8)", async () => {
    auth.user = null;
    const res = await route.GET(new NextRequest("http://localhost/api/export/missing-emails?country=DE&format=xlsx"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?next=${encodeURIComponent("/contacts?view=missing-email&country=DE")}`);
  });

  it("shows a page with a way back when the export fails", async () => {
    auth.user = ali;
    const spy = vi.spyOn(db.company, "count").mockRejectedValueOnce(new Error("disk I/O error"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await route.GET(new NextRequest("http://localhost/api/export/missing-emails?country=NO"));
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const html = await res.text();
      expect(html).toContain("The export didn&#39;t work");
      expect(html).toContain("The export couldn&#39;t be made just now.");
      expect(html).toContain(`<a href="/contacts?view=missing-email&amp;country=NO">Back to Contacts</a>`);
      expect(html).not.toContain("disk I/O");
    } finally {
      spy.mockRestore();
      errors.mockRestore();
    }
  });

  it("downloads the CSV for the Missing email view's filters", async () => {
    auth.user = ali;
    const res = await route.GET(new NextRequest("http://localhost/api/export/missing-emails?country=DE&hasEmail=yes"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="missing-emails-\d{4}-\d{2}-\d{2}\.csv"/);
    // The file is always about missing emails, whatever else the link says: only the header here.
    const lines = (await res.text()).replace(/^﻿/, "").trim().split("\r\n");
    expect(lines).toEqual([MISSING_EMAIL_COLUMNS.join(",")]);
    const de = await route.GET(new NextRequest("http://localhost/api/export/missing-emails?country=DE"));
    expect(csvRows(await de.text()).rows.map((r) => r[1])).toEqual(["Sculpt by Anna"]);
  });
});
