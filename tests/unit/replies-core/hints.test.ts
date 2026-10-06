import { describe, expect, it } from "vitest";
import { heldCompanyHint, removedContactHint, sameDomainHint, senderDomain, suggestedContact } from "@/core/replies/hints";
import { extractNewText } from "@/core/replies/quote";
import { vector } from "./vectors";

describe("senderDomain", () => {
  it("gives the registrable domain, never a shared or free-mail one", () => {
    expect(senderDomain("jonas@firma.de")).toBe("firma.de");
    expect(senderDomain("Jonas@Mail.Firma.DE")).toBe("firma.de");
    expect(senderDomain("anna@gmail.com")).toBeNull();
    expect(senderDomain("anna@outlook.com")).toBeNull();
    expect(senderDomain("not an address")).toBeNull();
    expect(senderDomain(null)).toBeNull();
  });
});

describe("sameDomainHint", () => {
  const companies = [
    { id: 1042, name: "Firma GmbH", domain: "firma.de" },
    { id: 1043, name: "Firma Studio", domain: "FIRMA.DE" },
    { id: 7, name: "Other", domain: "other.de" },
    { id: 1044, name: "Firma Print", domain: "firma.de" },
    { id: 1045, name: "Firma Four", domain: "firma.de" },
    { id: 1042, name: "Firma GmbH", domain: "firma.de" },
  ];

  it("names up to 3 live companies on the sender's domain", () => {
    expect(sameDomainHint("jonas@firma.de", companies)).toEqual([
      { companyId: 1042, text: "Same domain as Firma GmbH (C-1042)." },
      { companyId: 1043, text: "Same domain as Firma Studio (C-1043)." },
      { companyId: 1044, text: "Same domain as Firma Print (C-1044)." },
    ]);
  });

  it("never hints shared or free-mail domains", () => {
    expect(sameDomainHint("someone@gmail.com", [{ id: 1, name: "Gmail fans", domain: "gmail.com" }])).toEqual([]);
    expect(sameDomainHint("shop@instagram.com", [{ id: 2, name: "Insta", domain: "instagram.com" }])).toEqual([]);
    expect(sameDomainHint("jonas@firma.de", [{ id: 3, name: "No domain", domain: null }])).toEqual([]);
  });
});

describe("removedContactHint and heldCompanyHint", () => {
  it("uses the design's sentences", () => {
    expect(removedContactHint({ fromEmail: "anna@firma.de", personName: "Anna Berg", companyId: 1042, companyName: "Firma GmbH" })).toBe(
      "anna@firma.de was Anna Berg at Firma GmbH (C-1042), who was removed.",
    );
    expect(
      removedContactHint({ fromEmail: "anna@firma.de", personName: null, companyId: 1042, companyName: "Firma GmbH", companyRemoved: true }),
    ).toBe("anna@firma.de was a contact at Firma GmbH (C-1042), which was removed.");
    expect(removedContactHint({ fromEmail: "info@firma.de", personName: "General inbox", companyId: 1042, companyName: "Firma GmbH" })).toBe(
      "info@firma.de was a contact at Firma GmbH (C-1042), who was removed.",
    );
    expect(heldCompanyHint("Firma GmbH")).toBe("Follow-ups to Firma GmbH wait until you link this reply or mark it.");
  });
});

describe("suggestedContact", () => {
  const own = ["send.polygonparadise.com"];

  it("V38: the address the automatic reply suggests", () => {
    const v = vector("V38");
    expect(
      suggestedContact(extractNewText(v.in.strippedText, v.in.bodyPlain), { fromEmail: "anna@firma.de", companyDomain: "firma.de", ownDomains: own }),
    ).toBe("info@firma.de");
  });

  it("prefers an address on the company's domain", () => {
    const text = "Please write to backoffice@agency.example or to sales@firma.de.";
    expect(suggestedContact(text, { fromEmail: "anna@firma.de", companyDomain: "firma.de", ownDomains: own })).toBe("sales@firma.de");
    expect(suggestedContact(text, { fromEmail: "anna@firma.de", companyDomain: null, ownDomains: own })).toBe("backoffice@agency.example");
    expect(suggestedContact("Contact team@shop.firma.de", { fromEmail: "anna@firma.de", companyDomain: "firma.de", ownDomains: own })).toBe(
      "team@shop.firma.de",
    );
  });

  it("skips our own domains, the sender and no-reply addresses", () => {
    const text = "Anna (anna@firma.de) left. Your email to ali@send.polygonparadise.com or ali@polygonparadise.com; noreply@firma.de; mailer-daemon@firma.de.";
    expect(suggestedContact(text, { fromEmail: "Anna@Firma.de", companyDomain: "firma.de", ownDomains: own })).toBeNull();
    expect(suggestedContact(`${text} Try ben@firma.de`, { fromEmail: "anna@firma.de", companyDomain: "firma.de", ownDomains: own })).toBe(
      "ben@firma.de",
    );
  });

  it("returns null without any address", () => {
    expect(suggestedContact("Anna has left.", { fromEmail: "anna@firma.de", companyDomain: "firma.de", ownDomains: own })).toBeNull();
    expect(suggestedContact(null, { fromEmail: "anna@firma.de", companyDomain: "firma.de", ownDomains: [] })).toBeNull();
  });
});
