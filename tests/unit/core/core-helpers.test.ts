import { describe, expect, it } from "vitest";
import { firstNameFrom, normalizeCompanyName, normalizeText } from "@/core/text";
import { isRoleAddress, parseEmail } from "@/core/email-address";
import { parseWebsite, usableEmailDomain } from "@/core/shared-domains";
import { defaultTimeZoneFor, normalizeCountry } from "@/core/geo/countries";

describe("text", () => {
  it("normalises accents and special letters", () => {
    expect(normalizeText("  Müller  Ørsted ßtraße ")).toBe("muller orsted sstrasse");
  });
  it("strips legal suffixes for company keys", () => {
    expect(normalizeCompanyName("Müller 3D-Druck GmbH & Co. KG")).toBe("muller 3d druck");
    expect(normalizeCompanyName("Nordic Prints AS")).toBe("nordic prints");
  });
  it("finds first names", () => {
    expect(firstNameFrom("Anna Schmidt")).toBe("Anna");
    expect(firstNameFrom("Dr. Jonas Berg")).toBe("Jonas");
    expect(firstNameFrom("General inbox", true)).toBe("");
  });
});

describe("email addresses", () => {
  it("parses display names, mailto and punctuation", () => {
    expect(parseEmail("Anna <Anna.Schmidt@Studio.DE>")?.email).toBe("Anna.Schmidt@studio.de");
    expect(parseEmail("mailto:info@acme.de;")?.norm).toBe("info@acme.de");
    expect(parseEmail("not an email")).toBeNull();
    expect(parseEmail("anna@@studio.de")).toBeNull();
  });
  it("converts international domains to punycode", () => {
    const d = parseEmail("post@blåbær.no")?.domain ?? "";
    expect(d.startsWith("xn--")).toBe(true);
    expect(d.endsWith(".no")).toBe(true);
  });
  it("recognises role addresses", () => {
    expect(isRoleAddress("info@x.de")).toBe(true);
    expect(isRoleAddress("kontakt")).toBe(true);
    expect(isRoleAddress("anna@x.de")).toBe(false);
  });
});

describe("shared domains", () => {
  it("keeps real company domains", () => {
    expect(parseWebsite("www.acme-3d.de/about")?.domain).toBe("acme-3d.de");
    expect(parseWebsite("https://shop.acme.co.uk")?.domain).toBe("acme.co.uk");
  });
  it("never uses social or marketplace hosts as a company domain", () => {
    const ig = parseWebsite("https://www.instagram.com/sculpt_by_anna/");
    expect(ig?.domain).toBeNull();
    expect(ig?.profileKey).toBe("instagram.com/sculpt_by_anna");
    expect(parseWebsite("linktr.ee/someone")?.domain).toBeNull();
  });
  it("keeps hosted sub-domains distinct", () => {
    expect(parseWebsite("https://annasculpts.wixsite.com/shop")?.domain).toBe("annasculpts.wixsite.com");
  });
  it("ignores free-mail domains", () => {
    expect(usableEmailDomain("gmail.com")).toBeNull();
    expect(usableEmailDomain("gmx.de")).toBeNull();
    expect(usableEmailDomain("acme.de")).toBe("acme.de");
  });
});

describe("countries", () => {
  it("normalises names in several languages", () => {
    expect(normalizeCountry("Germany")).toBe("DE");
    expect(normalizeCountry("Deutschland")).toBe("DE");
    expect(normalizeCountry("Norge")).toBe("NO");
    expect(normalizeCountry("UK")).toBe("GB");
    expect(normalizeCountry("DEU")).toBe("DE");
    expect(normalizeCountry("Atlantis")).toBeNull();
  });
  it("picks default zones", () => {
    expect(defaultTimeZoneFor("NO")).toBe("Europe/Oslo");
    expect(defaultTimeZoneFor("US")).toBe("America/New_York");
    expect(defaultTimeZoneFor("IN")).toBe("Asia/Kolkata");
  });
});
