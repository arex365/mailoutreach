import { describe, expect, it } from "vitest";
import type { ColumnMapping } from "@/core/import/column-matching";
import { mergeGroupDrafts, normalizeRow, prepareImport, type GroupingMode } from "@/core/import/grouping";

const M = (...targets: Array<ColumnMapping["target"] | { custom: string }>): ColumnMapping[] =>
  targets.map((t) =>
    typeof t === "object" ? { target: "custom", key: t.custom, label: t.custom } : t === "custom" ? { target: "custom", key: "x", label: "x" } : ({ target: t } as ColumnMapping),
  );

function prep(rows: string[][], mapping: ColumnMapping[], grouping: GroupingMode = "website-and-name") {
  return prepareImport(
    rows.map((cells, i) => ({ rowNumber: i + 2, cells })),
    mapping,
    { grouping },
  );
}

const names = (p: ReturnType<typeof prep>) => p.groups.map((g) => g.name);

describe("normalizeRow", () => {
  const mapping = M("company", "website", "email", "name", "country", "status", "last_contacted", "tags", { custom: "followers" });

  it("normalises every field", () => {
    const r = normalizeRow(
      2,
      ["Müller 3D-Druck GmbH", "www.mueller-3d.de/kontakt", "Anna.Schmidt@Mueller-3D.DE", "Anna Schmidt", "Deutschland", "Hired", "04.03.2026", "resin, busts", "12k"],
      mapping,
    );
    expect(r.explicitName).toBe("Müller 3D-Druck GmbH");
    expect(r.nameNorm).toBe("muller 3d druck");
    expect(r.website?.domain).toBe("mueller-3d.de");
    expect(r.country).toBe("DE");
    expect(r.status).toBe("CLIENT");
    expect(r.lastContactedAt?.toISOString().slice(0, 10)).toBe("2026-03-04");
    expect(r.tags).toEqual(["resin", "busts"]);
    expect(r.custom).toEqual({ followers: "12k" });
    expect(r.people).toHaveLength(1);
    expect(r.people[0]).toMatchObject({
      email: "Anna.Schmidt@mueller-3d.de",
      emailNorm: "anna.schmidt@mueller-3d.de",
      emailDomain: "mueller-3d.de",
      name: "Anna Schmidt",
      firstName: "Anna",
      isGeneric: false,
    });
    expect(r.issues).toEqual([]);
  });

  it("names role addresses 'General inbox'", () => {
    const r = normalizeRow(2, ["Acme", "", "info@acme.de", "", "", "", "", "", ""], mapping);
    expect(r.people[0]).toMatchObject({ name: "General inbox", isGeneric: true, firstName: null });
  });

  it("notes unknown countries, statuses and dates instead of failing", () => {
    const r = normalizeRow(2, ["Acme", "", "", "", "Atlantis", "Maybe", "someday", "", ""], mapping);
    expect(r.country).toBeNull();
    expect(r.status).toBeNull();
    expect(r.issues.map((i) => i.message)).toEqual([
      "unknown country 'Atlantis'",
      "unknown status 'Maybe', so the starting status is used",
      "couldn't read the date 'someday'",
    ]);
  });

  it("treats placeholders like '-', 'n/a' and 'Never' as empty", () => {
    const r = normalizeRow(2, ["Acme", "-", "n/a", "", "", "", "Never", "", ""], mapping);
    expect(r.issues).toEqual([]);
    expect(r.invalidEmails).toEqual([]);
    expect(r.website).toBeNull();
    expect(r.lastContactedAt).toBeNull();
  });

  it("reads a country out of a location", () => {
    expect(normalizeRow(2, ["Acme", "", "", "", "Berlin, Germany", "", "", "", ""], mapping).country).toBe("DE");
  });

  it("flags invalid emails but keeps the rest of the row", () => {
    const r = normalizeRow(14, ["Studio", "", "anna@@studio.de", "Anna", "", "", "", "", ""], mapping);
    expect(r.invalidEmails).toEqual(["anna@@studio.de"]);
    expect(r.issues[0]).toEqual({ kind: "invalid-email", message: "'anna@@studio.de' isn't a valid email address" });
    expect(r.hasIdentity).toBe(true);
    expect(r.people).toEqual([expect.objectContaining({ name: "Anna", emailNorm: null })]);
  });

  it("splits several addresses in one cell into several people", () => {
    const r = normalizeRow(2, ["Acme", "", "anna@acme.de; info@acme.de", "Anna", "", "", "", "", ""], mapping);
    expect(r.people.map((p) => [p.emailNorm, p.name])).toEqual([
      ["anna@acme.de", "Anna"],
      ["info@acme.de", "General inbox"],
    ]);
  });

  it("recognises empty rows and rows with nothing to import", () => {
    expect(normalizeRow(2, ["", "", "", "", "", "", "", "", ""], mapping).issues[0]!.kind).toBe("empty");
    const noId = normalizeRow(3, ["", "", "", "", "DE", "", "", "resin", ""], mapping);
    expect(noId.hasIdentity).toBe(false);
    expect(noId.issues.at(-1)!.kind).toBe("no-identity");
  });

  it("finds Instagram handles in the website column", () => {
    const m = M("company", "website", "instagram");
    expect(normalizeRow(2, ["Anna", "https://www.instagram.com/anna.sculpts/", ""], m).instagram).toBe("anna.sculpts");
    expect(normalizeRow(2, ["Anna", "@anna.sculpts", ""], m).instagram).toBe("anna.sculpts");
    expect(normalizeRow(2, ["Anna", "", "instagram.com/Anna.Sculpts"], m).instagram).toBe("anna.sculpts");
  });
});

describe("grouping rows into companies", () => {
  const mapping = M("company", "website", "email", "name", "country");

  it("joins rows with the same website domain", () => {
    const p = prep(
      [
        ["Acme 3D", "https://www.acme3d.de", "anna@acme3d.de", "Anna", "DE"],
        ["ACME Printing", "shop.acme3d.de/about", "bob@acme3d.de", "Bob", "DE"],
        ["Other", "other.de", "", "", "DE"],
      ],
      mapping,
    );
    expect(p.groups).toHaveLength(2);
    expect(p.groups[0]!.rowNumbers).toEqual([2, 3]);
    expect(p.groups[0]!.people.map((x) => x.name)).toEqual(["Anna", "Bob"]);
    expect(p.groups[0]!.name).toBe("Acme 3D");
  });

  it("joins rows with the same company email domain", () => {
    const p = prep(
      [
        ["Nordlys Print", "nordlys-print.no", "", "", "NO"],
        ["", "", "post@nordlys-print.no", "", ""],
      ],
      mapping,
    );
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0]!.people[0]!.emailNorm).toBe("post@nordlys-print.no");
  });

  it("joins the same name in the same country, not in another country", () => {
    const p = prep(
      [
        ["Müller 3D GmbH", "", "a@gmail.com", "A", "Germany"],
        ["Muller 3D", "", "b@gmail.com", "B", "DE"],
        ["Müller 3D", "", "c@gmail.com", "C", "Norway"],
      ],
      mapping,
    );
    expect(p.groups.map((g) => g.rowNumbers)).toEqual([[2, 3], [4]]);
  });

  it("never joins 500 Instagram profiles", () => {
    const rows = Array.from({ length: 500 }, (_, i) => [
      `Creator ${i}`,
      `https://www.instagram.com/creator_${i}/`,
      `creator${i}@gmail.com`,
      "",
      "",
    ]);
    // Same (empty) country and different names: nothing in common but shared hosts.
    const p = prep(rows, mapping);
    expect(p.groups).toHaveLength(500);
    expect(p.groups[0]!.website?.domain).toBeNull();
    expect(p.groups[0]!.profileKeys).toEqual(["instagram.com/creator_0"]);
    expect(p.groups[0]!.domains).toEqual([]);
  });

  it("never joins gmail.com rows by their domain", () => {
    const p = prep(
      [
        ["Anna Figures", "", "anna@gmail.com", "", ""],
        ["Bob Busts", "", "bob@gmail.com", "", ""],
        ["", "", "carl@gmail.com", "Carl", ""],
      ],
      mapping,
    );
    expect(p.groups).toHaveLength(3);
    expect(names(p)).toEqual(["Anna Figures", "Bob Busts", "Carl"]);
  });

  it("joins the same Instagram profile and the same exact address", () => {
    const p = prep(
      [
        ["Anna", "instagram.com/anna_x", "", "", ""],
        ["Anna X", "https://instagram.com/anna_x/", "anna@gmail.com", "", ""],
        ["Anna again", "", "anna@gmail.com", "", ""],
      ],
      mapping,
    );
    expect(p.groups).toHaveLength(1);
  });

  it("marks duplicates within the file", () => {
    const p = prep(
      [
        ["Acme", "acme.de", "anna@acme.de", "Anna", "DE"],
        ["Acme", "acme.de", "anna@acme.de", "Anna", "DE"],
        ["Acme GmbH", "acme.de", "anna@acme.de", "Anna Schmidt", "DE"],
      ],
      mapping,
    );
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0]!.people).toHaveLength(1);
    expect(p.duplicateRows.get(3)).toBe(2);
    expect(p.rowIssues.get(3)![0]!.message).toBe("duplicate within the file: same as row 2");
    expect(p.rowIssues.get(4)![0]!.message).toBe("duplicate within the file: anna@acme.de is also on row 2");
  });

  it("keeps empty and unusable rows out of the companies", () => {
    const p = prep(
      [
        ["", "", "", "", ""],
        ["", "", "not-an-email", "", ""],
        ["Acme", "", "", "", ""],
      ],
      mapping,
    );
    expect(p.groups).toHaveLength(1);
    expect(p.rowGroup.has(2)).toBe(false);
    expect(p.rowIssues.get(2)![0]!.kind).toBe("empty");
    expect(p.rowIssues.get(3)![0]!.kind).toBe("invalid-email");
  });

  it("gives companies without a name a sensible one", () => {
    const p = prep(
      [
        ["", "https://www.studio-berg.no", "", "", ""],
        ["", "", "", "Kari Nordmann", ""],
        ["", "@troll.forge", "", "", ""],
      ],
      M("company", "website", "email", "name", "country"),
    );
    expect(names(p)).toEqual(["studio-berg.no", "Kari Nordmann", "@troll.forge"]);
  });

  it("follows the grouping mode", () => {
    const rows = [
      ["Acme", "acme.de", "", "", "DE"],
      ["Acme", "acme-shop.de", "", "", "DE"],
      ["Beta", "acme.de", "", "", "DE"],
    ];
    expect(prep(rows, mapping, "website-and-name").groups).toHaveLength(1);
    expect(prep(rows, mapping, "name").groups.map((g) => g.rowNumbers)).toEqual([[2, 3], [4]]);
    expect(prep(rows, mapping, "website").groups.map((g) => g.rowNumbers)).toEqual([[2, 4], [3]]);
  });

  it("collects tags, lists and the latest old-tool date from all rows", () => {
    const m = M("company", "tags", "list", "last_contacted", "notes");
    const p = prep(
      [
        ["Acme", "resin", "Germany Q4", "01.02.2026", "Big printer"],
        ["Acme", "busts, Resin", "Fairs", "04.03.2026", "Big printer"],
      ],
      m,
    );
    const g = p.groups[0]!;
    expect(g.tags).toEqual(["resin", "busts"]);
    expect(g.lists).toEqual(["Germany Q4", "Fairs"]);
    expect(g.lastContactedAt?.toISOString().slice(0, 10)).toBe("2026-03-04");
    expect(g.notes).toEqual(["Big printer"]);
  });
});

describe("platform links (DATA-1)", () => {
  const mapping = M("company", "website", "country");

  it("keeps two Etsy shops apart (they used to become one company)", () => {
    const p = prep(
      [
        ["Foo Minis", "https://www.etsy.com/shop/FooMinis", "DE"],
        ["Bar Busts", "https://www.etsy.com/shop/BarBusts", "NO"],
      ],
      mapping,
    );
    expect(names(p)).toEqual(["Foo Minis", "Bar Busts"]);
    expect(p.groups.map((g) => g.profileKeys)).toEqual([["etsy.com/shop/foominis"], ["etsy.com/shop/barbusts"]]);
  });

  it("keeps two Facebook profile.php profiles apart, and joins the same one", () => {
    const p = prep(
      [
        ["Anna", "https://www.facebook.com/profile.php?id=111111", ""],
        ["Bob", "https://www.facebook.com/profile.php?id=222222", ""],
        ["Anna again", "https://m.facebook.com/profile.php?id=111111&fbclid=x", ""],
      ],
      mapping,
    );
    expect(p.groups.map((g) => g.rowNumbers)).toEqual([[2, 4], [3]]);
    expect(p.groups[0]!.website?.url).toBe("https://www.facebook.com/profile.php?id=111111");
  });

  it("never joins rows by generic platform pages", () => {
    const p = prep(
      [
        ["Anna", "https://www.instagram.com/p/AAA111/", ""],
        ["Bob", "https://www.instagram.com/p/BBB222/", ""],
        ["Carl", "https://cults3d.com/en", ""],
        ["Dora", "https://cults3d.com/en", ""],
        ["Eve", "https://www.youtube.com/watch?v=1", ""],
        ["Finn", "https://www.youtube.com/watch?v=2", ""],
      ],
      mapping,
    );
    expect(p.groups).toHaveLength(6);
    expect(p.groups.every((g) => g.profileKeys.length === 0 && g.instagrams.length === 0)).toBe(true);
  });

  it("never takes 'p' or 'reel' as an Instagram handle, and notes the link", () => {
    const m = M("company", "instagram");
    const post = normalizeRow(2, ["Anna", "https://www.instagram.com/p/CxYz123/"], m);
    expect(post.instagram).toBeNull();
    expect(post.issues.map((i) => i.message)).toEqual([
      "'https://www.instagram.com/p/CxYz123/' isn't an Instagram profile (a link to a post or reel, or not a handle)",
    ]);
    expect(normalizeRow(2, ["Anna", "https://www.instagram.com/reel/CxYz123/"], m).instagram).toBeNull();
    const w = M("company", "website");
    expect(normalizeRow(2, ["Anna", "https://www.instagram.com/reel/CxYz123/"], w).instagram).toBeNull();
    expect(normalizeRow(2, ["Anna", "@reels"], w).instagram).toBeNull();
  });
});

describe("last-contacted dates (DATA-5)", () => {
  const mapping = M("company", "last_contacted");
  const NOW = new Date("2026-09-23T10:00:00Z");
  const run = (dates: string[]) =>
    prepareImport(
      dates.map((d, i) => ({ rowNumber: i + 2, cells: [`Co ${i}`, d] })),
      mapping,
      { grouping: "website-and-name", now: NOW },
    );
  const days = (p: ReturnType<typeof run>) => p.rows.map((r) => r.lastContactedAt?.toISOString().slice(0, 10) ?? null);

  it("reads a whole US-format column month first once one value proves it", () => {
    const p = run(["12/25/2025", "12/01/2025", "09/10/2025"]);
    expect(days(p)).toEqual(["2025-12-25", "2025-12-01", "2025-09-10"]);
    expect(p.rows.every((r) => r.issues.length === 0)).toBe(true);
  });

  it("reads a European column day first without notes", () => {
    const p = run(["25/12/2025", "01/12/2025", "09/10/2025"]);
    expect(days(p)).toEqual(["2025-12-25", "2025-12-01", "2025-10-09"]);
    expect(p.rows.every((r) => r.issues.length === 0)).toBe(true);
  });

  it("notes ambiguous dates when the column doesn't say", () => {
    const p = run(["03/04/2026", "05/05/2026"]);
    expect(days(p)).toEqual(["2026-04-03", "2026-05-05"]);
    expect(p.rows[0]!.issues.map((i) => i.message)).toEqual([
      "read the date '03/04/2026' as 3 Apr 2026 (day first); if the month comes first, change the date in the file",
    ]);
    expect(p.rows[1]!.issues).toEqual([]);
  });

  it("refuses dates in the future with a note", () => {
    const p = run(["2026-12-24", "2026-09-23", "24.09.2026"]);
    expect(days(p)).toEqual([null, "2026-09-23", "2026-09-24"]);
    expect(p.rows[0]!.issues.map((i) => i.message)).toEqual(["the date '2026-12-24' is in the future, so it wasn't used"]);
  });

  it("a US column in September: '09/10/2026' is 10 Sep, not a future 9 Oct", () => {
    const p = run(["12/25/2025", "09/10/2026"]);
    expect(days(p)).toEqual(["2025-12-25", "2026-09-10"]);
  });
});

describe("mergeGroupDrafts", () => {
  it("keeps the earlier group's values and combines the rest", () => {
    const p = prep(
      [
        ["Acme", "acme.de", "anna@acme.de", "Anna", "DE"],
        ["Acme Norway", "", "bob@gmail.com", "Bob", "NO"],
      ],
      M("company", "website", "email", "name", "country"),
    );
    expect(p.groups).toHaveLength(2);
    const merged = mergeGroupDrafts(p.groups[1]!, p.groups[0]!);
    expect(merged.key).toBe("r2");
    expect(merged.rowNumbers).toEqual([2, 3]);
    expect(merged.name).toBe("Acme");
    expect(merged.country).toBe("DE");
    expect(merged.people.map((x) => x.name)).toEqual(["Anna", "Bob"]);
  });
});
