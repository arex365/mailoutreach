import { describe, expect, it } from "vitest";
import {
  detectDateOrder,
  isAmbiguousDate,
  mapImportStatus,
  notesToAdd,
  parseImportDate,
  parsePriority,
  splitEmails,
  splitMulti,
} from "@/core/import/values";

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

describe("parseImportDate", () => {
  it("reads ISO dates, with and without a time", () => {
    expect(day(parseImportDate("2026-03-04"))).toBe("2026-03-04");
    expect(parseImportDate("2026-03-04")!.toISOString()).toBe("2026-03-04T12:00:00.000Z");
    expect(parseImportDate("2026-03-04T14:30")!.toISOString()).toBe("2026-03-04T14:30:00.000Z");
    expect(day(parseImportDate("2026-03-04T23:30:00+02:00"))).toBe("2026-03-04");
    expect(day(parseImportDate("2026/3/4"))).toBe("2026-03-04");
  });

  it("reads Excel serial day numbers", () => {
    const serial = (Date.UTC(2026, 2, 4) - Date.UTC(1899, 11, 30)) / 86_400_000;
    expect(day(parseImportDate(String(serial)))).toBe("2026-03-04");
    expect(day(parseImportDate(`${serial}.75`))).toBe("2026-03-04");
    expect(parseImportDate("12345")).toBeNull();
  });

  it("reads dd.mm.yyyy (German, Norwegian)", () => {
    expect(day(parseImportDate("04.03.2026"))).toBe("2026-03-04");
    expect(day(parseImportDate("4.3.26"))).toBe("2026-03-04");
    expect(day(parseImportDate("04.03.2026 14:05"))).toBe("2026-03-04");
  });

  it("reads slashes day first, unless the day can't be first", () => {
    expect(day(parseImportDate("13/03/2026"))).toBe("2026-03-13");
    expect(day(parseImportDate("03/13/2026"))).toBe("2026-03-13");
    expect(day(parseImportDate("03/04/2026"))).toBe("2026-04-03"); // ambiguous → dd/mm
    expect(day(parseImportDate("4-3-2026"))).toBe("2026-03-04");
  });

  it("reads ambiguous slash dates in the column's order", () => {
    expect(day(parseImportDate("12/01/2026", "mdy"))).toBe("2026-12-01");
    expect(day(parseImportDate("09/10/2026", "mdy"))).toBe("2026-09-10");
    expect(day(parseImportDate("09/10/2026", "dmy"))).toBe("2026-10-09");
    // Values that can only be read one way ignore the order.
    expect(day(parseImportDate("12/25/2026", "dmy"))).toBe("2026-12-25");
    expect(day(parseImportDate("25/12/2026", "mdy"))).toBe("2026-12-25");
    // Dots are always day first (German, Norwegian).
    expect(day(parseImportDate("09.10.2026", "mdy"))).toBe("2026-10-09");
  });

  it("reads month names in English, German and Norwegian", () => {
    expect(day(parseImportDate("3 Mar 2026"))).toBe("2026-03-03");
    expect(day(parseImportDate("3. März 2026"))).toBe("2026-03-03");
    expect(day(parseImportDate("March 3, 2026"))).toBe("2026-03-03");
    expect(day(parseImportDate("4. mars 2026"))).toBe("2026-03-04");
    expect(day(parseImportDate("17 desember 2025"))).toBe("2025-12-17");
    expect(day(parseImportDate("Oct 2025"))).toBe("2025-10-01");
  });

  it("refuses what isn't a real date", () => {
    expect(parseImportDate("31.02.2026")).toBeNull();
    expect(parseImportDate("yesterday")).toBeNull();
    expect(parseImportDate("")).toBeNull();
    expect(parseImportDate("13/13/2026")).toBeNull();
    expect(parseImportDate("01.01.1850")).toBeNull();
  });
});

describe("detectDateOrder (once per column, DATA-5)", () => {
  it("finds month-first from a US-style value", () => {
    expect(detectDateOrder(["12/01/2026", "09/10/2026", "12/25/2026"])).toEqual({ order: "mdy", sure: true });
  });

  it("finds day-first from a European value", () => {
    expect(detectDateOrder(["01/12/2026", "25/12/2026", "", "Never"])).toEqual({ order: "dmy", sure: true });
  });

  it("isn't sure without proof, or with proof both ways", () => {
    expect(detectDateOrder(["01/12/2026", "03/04/2026"])).toEqual({ order: "dmy", sure: false });
    expect(detectDateOrder(["25/12/2026", "12/25/2026"])).toEqual({ order: "dmy", sure: false });
    expect(detectDateOrder(["2026-03-04", "04.03.2026"])).toEqual({ order: "dmy", sure: false });
  });

  it("tells which values could be read both ways", () => {
    expect(isAmbiguousDate("03/04/2026")).toBe(true);
    expect(isAmbiguousDate("04/04/2026")).toBe(false);
    expect(isAmbiguousDate("13/04/2026")).toBe(false);
    expect(isAmbiguousDate("04.03.2026")).toBe(false);
  });
});

describe("notesToAdd (DATA-10)", () => {
  it("compares whole notes, not parts of words", () => {
    const existing = "Makes resin busts, not ok with our price";
    expect(notesToAdd(existing, ["busts"])).toEqual(["busts"]);
    expect(notesToAdd(existing, ["ok", "resin", "2025"])).toEqual(["ok", "resin", "2025"]);
  });

  it("skips notes that are already there, ignoring case, accents and spacing", () => {
    expect(notesToAdd("Old note\nBig  Printer", ["big printer", "Old Note", "new one"])).toEqual(["new one"]);
    expect(notesToAdd("Müller called", ["muller called"])).toEqual([]);
  });

  it("treats a multi-line note as present only when its lines are there together", () => {
    const existing = "Intro\nLine A\nLine B\nOutro";
    expect(notesToAdd(existing, ["Line A\nLine B"])).toEqual([]);
    expect(notesToAdd(existing, ["Line A\nOutro"])).toEqual(["Line A\nOutro"]);
  });

  it("doesn't add the same new note twice", () => {
    expect(notesToAdd("", ["Fair 2026", "fair 2026", ""])).toEqual(["Fair 2026"]);
  });
});

describe("mapImportStatus", () => {
  it("maps the old tool's labels", () => {
    expect(mapImportStatus("Not Contacted")).toBe("NOT_CONTACTED");
    expect(mapImportStatus("Contacted")).toBe("CONTACTED");
    expect(mapImportStatus("Replied")).toBe("REPLIED");
    expect(mapImportStatus("Hired")).toBe("CLIENT");
    expect(mapImportStatus("Rejected")).toBe("NOT_INTERESTED");
    expect(mapImportStatus(" HIRED ")).toBe("CLIENT");
  });

  it("reads our own export labels and a few German/Norwegian words", () => {
    expect(mapImportStatus("Not interested")).toBe("NOT_INTERESTED");
    expect(mapImportStatus("Do not contact")).toBe("DO_NOT_CONTACT");
    expect(mapImportStatus("Client")).toBe("CLIENT");
    expect(mapImportStatus("not_contacted")).toBe("NOT_CONTACTED");
    expect(mapImportStatus("Kontaktiert")).toBe("CONTACTED");
    expect(mapImportStatus("Ikke kontaktet")).toBe("NOT_CONTACTED");
    expect(mapImportStatus("Kein Interesse")).toBe("NOT_INTERESTED");
  });

  it("returns null for unknown labels", () => {
    expect(mapImportStatus("Maybe")).toBeNull();
    expect(mapImportStatus("")).toBeNull();
  });
});

describe("parsePriority", () => {
  it("understands words, numbers and letters", () => {
    expect(parsePriority("High")).toBe("HIGH");
    expect(parsePriority("hoch")).toBe("HIGH");
    expect(parsePriority("Høy")).toBe("HIGH");
    expect(parsePriority("1")).toBe("HIGH");
    expect(parsePriority("Normal")).toBe("NORMAL");
    expect(parsePriority("Mittel")).toBe("NORMAL");
    expect(parsePriority("Low")).toBe("LOW");
    expect(parsePriority("lav")).toBe("LOW");
    expect(parsePriority("C")).toBe("LOW");
    expect(parsePriority("High priority")).toBe("HIGH");
    expect(parsePriority("whenever")).toBeNull();
  });
});

describe("multi-value cells", () => {
  it("splits tags on ; , and |, without duplicates", () => {
    expect(splitMulti("resin, figurines; Resin | busts", { commas: true })).toEqual(["resin", "figurines", "busts"]);
    expect(splitMulti("Germany Q4; Norway, fairs")).toEqual(["Germany Q4", "Norway, fairs"]);
  });

  it("splits several addresses in one cell", () => {
    expect(splitEmails("a@x.de; b@x.de")).toEqual(["a@x.de", "b@x.de"]);
    expect(splitEmails("a@x.de, b@x.de / c@x.de")).toEqual(["a@x.de", "b@x.de", "c@x.de"]);
    expect(splitEmails("Anna Schmidt <anna@x.de>")).toEqual(["Anna Schmidt <anna@x.de>"]);
    expect(splitEmails("")).toEqual([]);
  });
});
