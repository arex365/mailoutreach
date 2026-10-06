import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ImportOptions } from "@/core/import/types";
import { createTestDb } from "../helpers/test-db";

/**
 * The import check's replied flag (M4-DESIGN §6 row 9): "anna@firma.de replied 3 days ago" for an address in the file
 * whose person replied, else "Replied 3 days ago" for a matched company that replied; neutral tone.
 */

const t = await createTestDb("import-replied");
const { db, dbWrite } = await import("@/server/db");
const { parsePastedText } = await import("@/server/services/imports/parse-file");
const { createImportSession, loadStoredSession } = await import("@/server/services/imports/sessions");
const { analyzeImport, buildCheckView } = await import("@/server/services/imports/check");
const { suggestMapping } = await import("@/core/import/column-matching");
const { DEFAULT_IMPORT_OPTIONS } = await import("@/core/import/types");

const DAY = 86_400_000;
let userId = 0;

async function company(name: string, domain: string, repliedDaysAgo: number | null, people: Array<{ email: string; repliedDaysAgo?: number }>) {
  const now = Date.now();
  const c = await dbWrite((tx) =>
    tx.company.create({
      data: {
        name,
        nameNorm: name.toLowerCase(),
        domain,
        website: `https://${domain}`,
        repliedAt: repliedDaysAgo === null ? null : new Date(now - repliedDaysAgo * DAY),
      },
    }),
  );
  for (const p of people) {
    await dbWrite((tx) =>
      tx.person.create({
        data: {
          companyId: c.id,
          name: p.email.split("@")[0]!,
          email: p.email,
          emailNorm: p.email,
          repliedAt: p.repliedDaysAgo === undefined ? null : new Date(now - p.repliedDaysAgo * DAY),
        },
      }),
    );
  }
  return c;
}

async function check(text: string, options: Partial<ImportOptions> = {}) {
  const parsed = parsePastedText(text);
  const id = await createImportSession({ userId, fileName: "Pasted rows", parsed });
  const mapping = suggestMapping(parsed.table.headers, parsed.table.rows.map((r) => r.cells)).map((s) => s.mapping);
  const opts: ImportOptions = { ...DEFAULT_IMPORT_OPTIONS, ...options };
  await dbWrite((c) => c.importSession.update({ where: { id }, data: { mapping, options: opts, status: "MAPPED" } }));
  const s = (await loadStoredSession(id))!;
  return buildCheckView(await analyzeImport(id, s.mapping!, s.options, { fresh: true }), s.options, false);
}

beforeAll(async () => {
  userId = (await dbWrite((c) => c.user.create({ data: { email: "ali@pp.test", name: "Ali", role: "OWNER" } }))).id;
  await company("Firma GmbH", "firma.de", 3, [{ email: "anna@firma.de", repliedDaysAgo: 3 }, { email: "ben@firma.de" }]);
  await company("Studio Nord", "studio.no", 3, [{ email: "ola@studio.no", repliedDaysAgo: 3 }]);
  await company("Quiet Prints", "quiet.de", null, [{ email: "hello@quiet.de" }]);
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("import check: who has replied", () => {
  it("flags the person who replied, else the company, neutrally", async () => {
    const view = await check(
      [
        "Company\tWebsite\tEmail",
        "Firma GmbH\tfirma.de\tanna@firma.de",
        "Firma GmbH\tfirma.de\tben@firma.de",
        "Studio Nord\tstudio.no\tinfo@studio.no",
        "Quiet Prints\tquiet.de\thello@quiet.de",
      ].join("\n"),
    );
    const flags = (name: string) => view.groups.find((g) => g.name === name)!.flags;

    expect(flags("Firma GmbH")).toContainEqual({ tone: "neutral", text: "anna@firma.de replied 3 days ago" });
    expect(flags("Firma GmbH").some((f) => f.text === "Replied 3 days ago")).toBe(false); // the person says more
    // Ola (who replied) isn't in the file: the company's reply is flagged.
    expect(flags("Studio Nord")).toContainEqual({ tone: "neutral", text: "Replied 3 days ago" });
    expect(flags("Studio Nord").some((f) => f.text.includes("ola@studio.no"))).toBe(false);
    expect(flags("Quiet Prints").some((f) => /replied/i.test(f.text))).toBe(false);
  });

  it("doesn't make a replied company need a look on its own", async () => {
    const view = await check(["Company\tWebsite\tEmail", "Studio Nord\tstudio.no\tinfo@studio.no"].join("\n"), { duplicates: "update" });
    const g = view.groups.find((x) => x.name === "Studio Nord")!;
    expect(g.flags).toContainEqual({ tone: "neutral", text: "Replied 3 days ago" });
    expect(g.flags.filter((f) => f.tone !== "neutral")).toEqual([]);
    expect(g.needsLook).toBe(false);
  });
});
