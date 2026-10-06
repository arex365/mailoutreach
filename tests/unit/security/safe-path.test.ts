import { describe, expect, it } from "vitest";
import { safeAppPath } from "@/core/safe-path";

/** SECURITY-1: the page opened after sign-in (and notification links) must stay on this site. */
describe("safeAppPath", () => {
  it("keeps ordinary in-app paths with their query and hash", () => {
    expect(safeAppPath("/contacts")).toBe("/contacts");
    expect(safeAppPath("/contacts?company=12&tab=people#notes")).toBe("/contacts?company=12&tab=people#notes");
    expect(safeAppPath("  /settings/team  ")).toBe("/settings/team");
    expect(safeAppPath("/import/42")).toBe("/import/42");
  });

  it("refuses anything that a browser could read as another site", () => {
    const attacks = [
      "https://evil.example.com",
      "//evil.example.com",
      "/\\evil.example.com", // "/\evil.com" → https://evil.com/
      "\\\\evil.example.com",
      "/\t/evil.example.com", // tab is dropped by the URL parser → "//evil.com"
      "/\n/evil.example.com",
      "/\r/evil.example.com",
      "/\\/evil.example.com",
      "/.//evil.example.com", // normalises to "//evil.com"
      "/%2e//evil.example.com",
      "/a/..//evil.example.com",
      "javascript:alert(1)",
      "evil.example.com",
      "/a b",
      "/a b",
      "/a\u0000b",
      "/a\u007fb",
      "/a\u0085b",
      "",
      "   ",
    ];
    for (const value of attacks) expect(safeAppPath(value), JSON.stringify(value)).toBeNull();
  });

  it("never returns a value that resolves to another origin", () => {
    const inputs = ["/.//x.test", "/%2e%2e//x.test", "/x/../..//x.test", "/./contacts", "/..", "/%5Cx.test", "/%2F%2Fx.test"];
    for (const value of inputs) {
      const out = safeAppPath(value);
      if (out === null) continue;
      expect(new URL(out, "https://app.example").origin, value).toBe("https://app.example");
      expect(out.startsWith("//")).toBe(false);
    }
  });

  it("refuses non-strings and values over the length limit", () => {
    expect(safeAppPath(null)).toBeNull();
    expect(safeAppPath(undefined)).toBeNull();
    expect(safeAppPath(42)).toBeNull();
    expect(safeAppPath(["/contacts"])).toBeNull();
    expect(safeAppPath("/" + "a".repeat(2000))).toBeNull();
    expect(safeAppPath("/" + "a".repeat(499), 500)).toBe("/" + "a".repeat(499));
    expect(safeAppPath("/" + "a".repeat(500), 500)).toBeNull();
  });
});
