import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ImportOptions } from "@/core/import/types";
import type { JobContext } from "@/server/jobs";
import { createTestDb } from "../helpers/test-db";

const t = await createTestDb("import-commit-fresh");
const { db, dbTx, dbWrite } = await import("@/server/db");
const { parseUploadedFile } = await import("@/server/services/imports/parse-file");
const { createImportSession, loadStoredSession } = await import("@/server/services/imports/sessions");
const { analyzeImport, buildCheckView } = await import("@/server/services/imports/check");
const { runImportCommitJob } = await import("@/server/services/imports/commit");
const { recomputeProfileKeys } = await import("@/server/services/imports/profile-keys");
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

async function stage(text: string, fileName: string, options: Partial<ImportOptions> = {}) {
  const parsed = parseUploadedFile(new TextEncoder().encode(text), fileName);
  const id = await createImportSession({ userId: ali.id, fileName, parsed });
  const mapping = suggestMapping(parsed.table.headers, parsed.table.rows.map((r) => r.cells)).map((s) => s.mapping);
  await dbWrite((c) => c.importSession.update({ where: { id }, data: { mapping, options: { ...DEFAULT_IMPORT_OPTIONS, ...options }, status: "MAPPED" } }));
  return id;
}

async function check(id: number) {
  const s = (await loadStoredSession(id))!;
  return buildCheckView(await analyzeImport(id, s.mapping!, s.options, { fresh: true }), s.options, false);
}

/** A job context whose progress callback can change data between chunks (like a teammate would). */
function ctx(onProgress?: (call: number) => Promise<void> | void, signal?: AbortSignal): JobContext {
  let calls = 0;
  return {
    jobId: 1,
    createdById: ali.id,
    signal: signal ?? new AbortController().signal,
    progress: async () => {
      calls++;
      await onProgress?.(calls);
    },
  };
}

async function rows(sessionId: number) {
  return db.importRow.findMany({ where: { sessionId }, orderBy: { rowNumber: "asc" }, select: { rowNumber: true, status: true, message: true, companyId: true } });
}

function fillers(n: number, prefix: string): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i},${prefix.toLowerCase().replace(/\s+/g, "")}${i}.de,Germany,,,,`);
}

describe("changes made while an import runs (DATA-2)", () => {
  it("works from the company as it is now: keeps a new note and 'Do not contact', skips deleted companies, never overwrites a new address", async () => {
    const target = await dbTx(async (tx) => {
      const c = await tx.company.create({
        data: { name: "Target Co", nameNorm: "target co", website: "https://target.de", domain: "target.de", country: "DE", notes: "old note" },
      });
      const bob = await tx.person.create({ data: { companyId: c.id, name: "Bob Berg" } });
      return { id: c.id, bobId: bob.id };
    });
    const gone = await dbWrite((c) =>
      c.company.create({ data: { name: "Gone Co", nameNorm: "gone co", website: "https://gone-co.de", domain: "gone-co.de", country: "DE" } }),
    );
    const csv = [
      "Company,Website,Country,Status,Notes,Email,Contact Person",
      ...fillers(300, "Filler Co"),
      "Target Co,target.de,Germany,Contacted,imported note,bob@target.de,Bob Berg",
      "Gone Co,gone-co.de,Germany,Contacted,,,",
    ].join("\n");
    const id = await stage(csv, "fresh.csv", { duplicates: "update", list: { mode: "new", name: "Fresh list" } });

    const result = await runImportCommitJob(
      { sessionId: id },
      ctx(async (call) => {
        if (call !== 2) return; // after the first chunk of 250 rows
        await dbTx(async (tx) => {
          await tx.company.update({ where: { id: target.id }, data: { notes: "old note\nteammate note", status: "DO_NOT_CONTACT" } });
          await tx.person.update({ where: { id: target.bobId }, data: { email: "bob.private@gmail.com", emailNorm: "bob.private@gmail.com" } });
          await tx.company.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
        });
      }),
    );

    const after = await db.company.findUniqueOrThrow({ where: { id: target.id }, include: { people: { orderBy: { id: "asc" } } } });
    expect(after.notes).toBe("old note\nteammate note\nimported note");
    expect(after.status).toBe("DO_NOT_CONTACT");
    // Bob got another address meanwhile: the file's address became its own person, his wasn't replaced.
    expect(after.people.map((p) => [p.name, p.emailNorm])).toEqual([
      ["Bob Berg", "bob.private@gmail.com"],
      ["Bob Berg", "bob@target.de"],
    ]);

    const goneAfter = await db.company.findUniqueOrThrow({ where: { id: gone.id }, include: { lists: true } });
    expect(goneAfter.deletedAt).not.toBeNull();
    expect(goneAfter.status).toBe("NOT_CONTACTED");
    expect(goneAfter.lists).toEqual([]);

    const r = await rows(id);
    const targetRow = r.find((x) => x.rowNumber === 302)!;
    expect(targetRow.status).toBe("UPDATED");
    expect(targetRow.message).toBe(
      "Kept the status Do not contact (the file says Contacted): an import never changes Client, Not interested or Do not contact.",
    );
    const goneRow = r.find((x) => x.rowNumber === 303)!;
    expect(goneRow).toMatchObject({ status: "PROBLEM", companyId: null });
    expect(goneRow.message).toBe(`C-${gone.id} Gone Co was deleted while this import ran, so this row wasn't imported. Restore the company, then import the row again.`);
    expect(result).toMatchObject({ created: 300, updated: 1, problems: 1, peopleAdded: 1 });
  });
});

describe("protected statuses (DATA-3)", () => {
  it("never changes Client or Not interested, says so on the check screen and on the row", async () => {
    await dbTx(async (tx) => {
      await tx.company.create({ data: { name: "Client Co", nameNorm: "client co", website: "https://client-co.de", domain: "client-co.de", status: "CLIENT" } });
      await tx.company.create({ data: { name: "Declined Co", nameNorm: "declined co", website: "https://declined.de", domain: "declined.de", status: "NOT_INTERESTED" } });
      await tx.company.create({ data: { name: "Talking Co", nameNorm: "talking co", website: "https://talking.de", domain: "talking.de", status: "CONTACTED" } });
    });
    const csv = [
      "Company,Website,Status",
      "Client Co,client-co.de,Not Contacted",
      "Declined Co,declined.de,Contacted",
      "Talking Co,talking.de,Replied",
    ].join("\n");
    const id = await stage(csv, "statuses.csv", { duplicates: "update" });

    const view = await check(id);
    const flags = (name: string) => view.groups.find((g) => g.name === name)!.flags.map((f) => f.text);
    expect(flags("Client Co")).toContain("Keeps status Client (file says Not contacted)");
    expect(flags("Declined Co")).toContain("Keeps status Not interested (file says Contacted)");
    expect(flags("Talking Co")).toEqual([]);
    expect(view.rowIssues.map((i) => [i.rowNumber, i.tone])).toEqual([
      [2, "note"],
      [3, "note"],
    ]);

    await runImportCommitJob({ sessionId: id }, ctx());
    const status = async (name: string) => (await db.company.findFirstOrThrow({ where: { name } })).status;
    expect(await status("Client Co")).toBe("CLIENT");
    expect(await status("Declined Co")).toBe("NOT_INTERESTED");
    expect(await status("Talking Co")).toBe("REPLIED");
    const r = await rows(id);
    expect(r[0]!.message).toBe(
      "Kept the status Client (the file says Not contacted): an import never changes Client, Not interested or Do not contact.",
    );
    expect(r[2]!.message).toBeNull();
  });
});

describe("resuming (DATA-4)", () => {
  it("doesn't treat a company it created as 'existing' when that row ended INVALID", async () => {
    const lines = [
      "Company,Website,Country,Email",
      "Twin Acme,acme-a.de,Germany,x@acme-a.de; bad@@acme",
      ...Array.from({ length: 300 }, (_, i) => `Resume Filler ${i},resumefill${i}.de,Germany,`),
      "Twin Acme,acme-z.de,Germany,",
    ];
    const id = await stage(lines.join("\n"), "resume-invalid.csv", { grouping: "website" });
    const controller = new AbortController();
    await expect(
      runImportCommitJob(
        { sessionId: id },
        ctx((call) => {
          if (call === 2) controller.abort();
        }, controller.signal),
      ),
    ).rejects.toThrow(/paused/);
    expect((await rows(id))[0]!.status).toBe("INVALID");

    const result = await runImportCommitJob({ sessionId: id }, ctx());
    // Same as an uninterrupted run: both Twin Acme companies exist.
    const twins = await db.company.findMany({ where: { name: "Twin Acme" }, orderBy: { id: "asc" } });
    expect(twins.map((c) => c.domain)).toEqual(["acme-a.de", "acme-z.de"]);
    const last = (await rows(id)).at(-1)!;
    expect(last.status).toBe("CREATED");
    expect(result).toMatchObject({ created: 302, skipped: 0 });
  });
});

describe("totals count each company once (DATA-13)", () => {
  it("restores a company once when two groups land on it", async () => {
    const twin = await dbWrite((c) =>
      c.company.create({ data: { name: "Double Studio", nameNorm: "double studio", deletedAt: new Date(Date.now() - DAY) } }),
    );
    // Same name, two countries, free-mail addresses: two groups, both "possible duplicate" of the deleted company.
    const csv = ["Company,Country,Email", "Double Studio,Germany,double.de@gmail.com", "Double Studio,Norway,double.no@gmail.com"].join("\n");
    const id = await stage(csv, "double.csv", { duplicates: "update", possibleDuplicates: "merge" });
    const view = await check(id);
    expect(view.groups.map((g) => g.decision?.kind)).toEqual(["possible-duplicate", "possible-duplicate"]);

    const result = await runImportCommitJob({ sessionId: id }, ctx());
    expect(result).toMatchObject({ restored: 1, updated: 0, created: 0, peopleAdded: 2 });
    expect(await db.activityLog.count({ where: { type: "company.restored", companyId: twin.id } })).toBe(1);
    const back = await db.company.findUniqueOrThrow({ where: { id: twin.id }, include: { people: true } });
    expect(back.deletedAt).toBeNull();
    expect(back.people).toHaveLength(2);
  });

  it("counts a company whose data didn't change as 'already up to date', not 'updated'", async () => {
    await dbWrite((c) =>
      c.company.create({ data: { name: "Steady Co", nameNorm: "steady co", website: "https://steady.de", domain: "steady.de", country: "DE", niche: "Busts" } }),
    );
    const csv = "Company,Website,Country,Niche\nSteady Co,steady.de,Germany,Busts\n";
    const id = await stage(csv, "steady.csv", { duplicates: "update" });
    const result = await runImportCommitJob({ sessionId: id }, ctx());
    expect(result).toMatchObject({ updated: 0, unchanged: 1 });
    expect(result.summary).toBe("Imported steady.csv: 0 new companies, 1 already up to date, 0 people added.");
  });
});

describe("notes (DATA-10)", () => {
  it("adds a short note even when its word appears in the existing notes", async () => {
    const c = await dbWrite((x) =>
      x.company.create({ data: { name: "Notes Co", nameNorm: "notes co", website: "https://notes-co.de", domain: "notes-co.de", notes: "Makes resin busts, not ok with our price" } }),
    );
    const id = await stage("Company,Website,Notes\nNotes Co,notes-co.de,busts\n", "notes.csv", { duplicates: "update" });
    await runImportCommitJob({ sessionId: id }, ctx());
    expect((await db.company.findUniqueOrThrow({ where: { id: c.id } })).notes).toBe("Makes resin busts, not ok with our price\nbusts");
  });
});

describe("Company.lastContactAt (SPEC-3)", () => {
  it("is the newer of the app's last email and the old tool's date, on create and on update", async () => {
    const emailedLater = await dbWrite((c) =>
      c.company.create({
        data: {
          name: "Later Co",
          nameNorm: "later co",
          website: "https://later.de",
          domain: "later.de",
          lastEmailedAt: new Date("2026-06-01T12:00:00Z"),
          lastContactAt: new Date("2026-06-01T12:00:00Z"),
        },
      }),
    );
    const emailedEarlier = await dbWrite((c) =>
      c.company.create({
        data: {
          name: "Earlier Co",
          nameNorm: "earlier co",
          website: "https://earlier.de",
          domain: "earlier.de",
          lastEmailedAt: new Date("2025-01-01T12:00:00Z"),
          lastContactAt: new Date("2025-01-01T12:00:00Z"),
        },
      }),
    );
    const csv = [
      "Company,Website,Last contacted",
      "New Dated Co,newdated.de,2026-03-04",
      "Later Co,later.de,2026-03-04",
      "Earlier Co,earlier.de,2026-03-04",
    ].join("\n");
    const id = await stage(csv, "dates.csv", { duplicates: "update" });
    await runImportCommitJob({ sessionId: id }, ctx());
    const day = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
    const created = await db.company.findFirstOrThrow({ where: { name: "New Dated Co" } });
    expect([day(created.importedLastContactAt), day(created.lastContactAt)]).toEqual(["2026-03-04", "2026-03-04"]);
    const later = await db.company.findUniqueOrThrow({ where: { id: emailedLater.id } });
    expect([day(later.importedLastContactAt), day(later.lastContactAt)]).toEqual(["2026-03-04", "2026-06-01"]);
    const earlier = await db.company.findUniqueOrThrow({ where: { id: emailedEarlier.id } });
    expect([day(earlier.importedLastContactAt), day(earlier.lastContactAt)]).toEqual(["2026-03-04", "2026-03-04"]);
  });
});

describe("platform links (DATA-1)", () => {
  it("imports two Etsy shops as two companies and never matches another shop to an existing one", async () => {
    await dbWrite((c) =>
      c.company.create({
        data: { name: "Old Shop", nameNorm: "old shop", website: "https://www.etsy.com/shop/OldShop", profileKey: "etsy.com/shop/oldshop", country: "DE" },
      }),
    );
    const csv = [
      "Company,Website,Country",
      "Foo Minis,https://www.etsy.com/shop/FooMinis,Germany",
      "Bar Busts,https://www.etsy.com/shop/BarBusts,Norway",
      "Old Shop Renamed,https://www.etsy.com/shop/OldShop?ref=x,Germany",
    ].join("\n");
    const id = await stage(csv, "etsy.csv", { duplicates: "update" });
    const view = await check(id);
    expect(view.groups.map((g) => [g.name, g.outcome])).toEqual([
      ["Foo Minis", "create"],
      ["Bar Busts", "create"],
      ["Old Shop Renamed", "update"],
    ]);
    await runImportCommitJob({ sessionId: id }, ctx());
    const shops = await db.company.findMany({ where: { profileKey: { startsWith: "etsy.com/shop/" } }, orderBy: { id: "asc" } });
    expect(shops.map((s) => [s.name, s.profileKey])).toEqual([
      ["Old Shop Renamed", "etsy.com/shop/oldshop"],
      ["Foo Minis", "etsy.com/shop/foominis"],
      ["Bar Busts", "etsy.com/shop/barbusts"],
    ]);
  });

  it("repairs profile keys saved by older versions (one-off recompute)", async () => {
    const made = await dbTx(async (tx) => {
      const a = await tx.company.create({
        data: { name: "Legacy A", nameNorm: "legacy a", website: "https://www.etsy.com/shop/LegacyA", profileKey: "etsy.com/shop" },
      });
      const b = await tx.company.create({
        data: { name: "Legacy B", nameNorm: "legacy b", website: "https://www.facebook.com/profile.php", profileKey: "facebook.com/profile.php" },
      });
      const cc = await tx.company.create({
        data: { name: "Legacy C", nameNorm: "legacy c", website: "https://www.instagram.com/p/AAA", profileKey: "instagram.com/p", instagram: "p" },
      });
      const d = await tx.company.create({
        data: { name: "Legacy D", nameNorm: "legacy d", website: "https://legacy-d.de", domain: "legacy-d.de" },
      });
      return { a: a.id, b: b.id, c: cc.id, d: d.id };
    });
    const first = await recomputeProfileKeys();
    expect(first.changed).toBeGreaterThanOrEqual(3);
    const get = (id: number) => db.company.findUniqueOrThrow({ where: { id } });
    expect((await get(made.a)).profileKey).toBe("etsy.com/shop/legacya");
    expect((await get(made.a)).searchText).toContain("etsy.com/shop/legacya");
    expect((await get(made.b)).profileKey).toBeNull();
    expect(await get(made.c)).toMatchObject({ profileKey: null, instagram: null });
    expect(await get(made.d)).toMatchObject({ profileKey: null, domain: "legacy-d.de" });
    // Running it again changes nothing.
    expect((await recomputeProfileKeys()).changed).toBe(0);
  });
});
