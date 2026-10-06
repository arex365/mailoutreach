import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));

const { NOTICE_TEXTS, noticeText } = await import("@/components/shell/notice-toast");

/** `?notice=` comes from the address bar (SECURITY-06): only the table's own sentences may ever reach the toast. */
describe("noticeText", () => {
  it("knows owner-only and nothing else", () => {
    expect(noticeText("owner-only")).toBe("Only the Owner can open that page.");
    expect(noticeText("something-else")).toBeNull();
    expect(noticeText("")).toBeNull();
    expect(noticeText(null)).toBeNull();
    expect(noticeText(undefined)).toBeNull();
  });

  it("never finds Object's built-ins (a function or an object as the toast's title breaks the page)", () => {
    for (const key of [
      "constructor",
      "__proto__",
      "valueOf",
      "toString",
      "hasOwnProperty",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
      "__defineGetter__",
      "__lookupGetter__",
    ]) {
      expect(noticeText(key), key).toBeNull();
    }
  });

  it("returns a plain string for every known notice", () => {
    for (const key of Object.keys(NOTICE_TEXTS)) expect(typeof noticeText(key)).toBe("string");
  });
});
