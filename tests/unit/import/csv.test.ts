import { describe, expect, it } from "vitest";
import { CSV_BOM, stripFormulaEscape, toCsv } from "@/core/csv";
import { parseDelimitedText, parseUploadedFile } from "@/server/services/imports/parse-file";

describe("toCsv", () => {
  it("starts with a UTF-8 BOM and uses CRLF line endings", () => {
    const csv = toCsv([["Müller", "Ørsted"]], ["a", "b"]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv).toBe(`${CSV_BOM}a,b\r\nMüller,Ørsted\r\n`);
  });

  it("escapes cells that Excel would run as formulas", () => {
    const csv = toCsv([["=HYPERLINK(\"http://x\",\"y\")", "+49 30 123", "-5", "@SUM(A1)", "\tx", "plain"]], ["a", "b", "c", "d", "e", "f"]);
    const line = csv.split("\r\n")[1]!;
    expect(line).toBe(`"'=HYPERLINK(""http://x"",""y"")","'+49 30 123","'-5","'@SUM(A1)","'\tx",plain`);
  });

  it("escapes multi-line formulas too (Papa's own pattern misses them)", () => {
    const csv = toCsv([["=cmd|' /C calc'!A0\nsecond line"]], ["a"]);
    expect(csv).toContain(`"'=cmd|' /C calc'!A0\nsecond line"`);
  });

  it("adds one more apostrophe to values that already start with one before a formula character", () => {
    const csv = toCsv([["'=x", "'hello"]], ["a", "b"]);
    expect(csv.split("\r\n")[1]).toBe(`"''=x",'hello`);
  });

  it("leaves real numbers alone, including negative ones", () => {
    const csv = toCsv([[-5, 3.5, null, undefined, true]], ["a", "b", "c", "d", "e"]);
    expect(csv.split("\r\n")[1]).toBe("-5,3.5,,,TRUE");
  });

  it("can use semicolons for German and Norwegian Excel", () => {
    const csv = toCsv([["a;b", "c"]], ["x", "y"], { delimiter: ";" });
    expect(csv.split("\r\n")[0]).toBe(`${CSV_BOM}x;y`);
    expect(csv.split("\r\n")[1]).toBe(`"a;b";c`);
  });
});

describe("stripFormulaEscape", () => {
  it("removes exactly one apostrophe before = + - @ tab or CR", () => {
    expect(stripFormulaEscape("'=SUM(1)")).toBe("=SUM(1)");
    expect(stripFormulaEscape("'+49 30 123")).toBe("+49 30 123");
    expect(stripFormulaEscape("'-5")).toBe("-5");
    expect(stripFormulaEscape("'@x")).toBe("@x");
    expect(stripFormulaEscape("'\tx")).toBe("\tx");
    expect(stripFormulaEscape("''=x")).toBe("'=x");
    expect(stripFormulaEscape("'hello")).toBe("'hello");
    expect(stripFormulaEscape("'5")).toBe("'5");
    expect(stripFormulaEscape("'")).toBe("'");
    expect(stripFormulaEscape("=x")).toBe("=x");
  });
});

describe("export → import round trip", () => {
  const values = ["+49 30 123", "=HYPERLINK(\"https://evil.example\",\"click\")", "-12", "@handle", "'=already quoted", "Müller; Söhne", "line1\nline2"];

  it("survives with commas", () => {
    const csv = toCsv([values], values.map((_, i) => `c${i}`));
    const table = parseUploadedFile(new TextEncoder().encode(csv), "export.csv");
    expect(table.table.rows[0]!.cells).toEqual(values);
  });

  it("survives with semicolons", () => {
    const csv = toCsv([values], values.map((_, i) => `c${i}`), { delimiter: ";" });
    const table = parseDelimitedText(csv);
    expect(table.rows[0]!.cells).toEqual(values);
  });
});
