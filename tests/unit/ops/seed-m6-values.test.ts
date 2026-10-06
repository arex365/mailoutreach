import { describe, expect, it } from "vitest";
import { parseEmail } from "@/core/email-address";
import { parseWebsite } from "@/core/shared-domains";
import { normalizeCompanyName } from "@/core/text";
import { LONG_VALUES, MADE_UP_NAME_COUNT, isSafeAddress, madeUpCompanyName, madeUpDomain } from "../../../scripts/lib/seed-m6-values";

/**
 * The pure parts of the manual-check seed (scripts/seed-m6-manual.ts, M6-DESIGN §9.4), checked without running it (the
 * seed writes data\manual-check\, which only the lead runs): every seeded address is on example.com or *.example, the
 * made-up company names are the ones the seed always used, and the long values the screen checks need are long enough
 * to matter on a phone (review SCREENS-04/05/06/08/12, the Review step), within the app's own limits, and where the
 * specs look for them.
 */

describe("isSafeAddress: only addresses nobody can own", () => {
  it("accepts example.com, its subdomains and *.example", () => {
    for (const a of ["arslan@example.com", "Ali.Replies@EXAMPLE.COM", "x@mail.example.com", "tess@test-mailbox.example", "y@example.com."]) {
      expect(isSafeAddress(a), a).toBe(true);
    }
  });

  it("refuses everything else, look-alikes included", () => {
    for (const a of ["someone@gmail.com", "x@example.org", "x@example.com.evil.net", "x@notexample.com", "x@example", "no-at-sign", ""]) {
      expect(isSafeAddress(a), a).toBe(false);
    }
  });
});

describe("the made-up company names", () => {
  it("are the seed's usual ones, each once, with a *.example domain", () => {
    expect(madeUpCompanyName(0)).toBe("Nord Figurenwerk");
    expect(madeUpCompanyName(1)).toBe("Alpen Figurenwerk");
    expect(madeUpCompanyName(24)).toBe("Nord Miniaturen");
    expect(madeUpDomain("Weser Resin Studio")).toBe("weser-resin-studio.example");
    const names = Array.from({ length: MADE_UP_NAME_COUNT }, (_, i) => madeUpCompanyName(i));
    expect(new Set(names).size).toBe(MADE_UP_NAME_COUNT);
    for (const n of names) expect(isSafeAddress(`info@${madeUpDomain(n)}`), n).toBe(true);
    expect(() => madeUpCompanyName(MADE_UP_NAME_COUNT)).toThrow("Out of made-up company names.");
    expect(() => madeUpCompanyName(-1)).toThrow();
  });
});

describe("LONG_VALUES: long where it matters, and still valid data", () => {
  const c = LONG_VALUES.company;

  it("every address is safe and parses as an email address", () => {
    for (const a of [c.person.email, LONG_VALUES.testAddress, LONG_VALUES.teammate.email]) {
      expect(isSafeAddress(a), a).toBe(true);
      expect(parseEmail(a)?.norm, a).toBe(a.toLowerCase());
    }
  });

  it("the company's website host is its *.example domain", () => {
    expect(isSafeAddress(`info@${c.domain}`)).toBe(true);
    expect(parseWebsite(`https://www.${c.domain}`)?.domain).toBe(c.domain);
  });

  it("the lengths the screens engineer asked for (about 60, 45 to 50, 45, 80, 40 and 35 characters)", () => {
    expect(c.name.length).toBeGreaterThanOrEqual(55);
    expect(c.name.length).toBeLessThanOrEqual(65);
    expect(c.domain.length).toBeGreaterThanOrEqual(45);
    expect(c.domain.length).toBeLessThanOrEqual(55);
    expect(c.person.email.length).toBeGreaterThanOrEqual(40);
    expect(c.person.email.length).toBeLessThanOrEqual(50);
    for (const name of [LONG_VALUES.runningCampaign, LONG_VALUES.draftCampaign]) {
      expect(name.length, name).toBeGreaterThanOrEqual(75);
      // A campaign name may have up to 120 characters (DRAFT_NAME_MAX in src/server/services/campaigns/draft.ts).
      expect(name.length, name).toBeLessThanOrEqual(120);
    }
    expect(LONG_VALUES.testAddress.length).toBeGreaterThanOrEqual(38);
    expect(LONG_VALUES.teammate.email.length).toBeGreaterThanOrEqual(32);
    // Different from the two sign-in users (tests/playwright/instances.ts E2E_USERS).
    expect(LONG_VALUES.teammate.email).not.toMatch(/^(arslan|ali)@example\.com$/);
  });

  it("the long company is on Contacts' first page in the live state (sorted by name, 50 a page)", () => {
    // The live state creates 30 prospects, 110 + 70 companies for its two campaigns and 15 for the dry run, all with
    // made-up names in order, plus "Test mailboxes" and the long company.
    const live = [...Array.from({ length: 30 + 110 + 70 + 15 }, (_, i) => madeUpCompanyName(i)), "Test mailboxes"];
    const mine = normalizeCompanyName(c.name);
    const before = live.filter((n) => normalizeCompanyName(n) < mine);
    expect(before.length).toBeLessThan(49);
    expect(before.every((n) => n.startsWith("Alpen "))).toBe(true);
  });
});
