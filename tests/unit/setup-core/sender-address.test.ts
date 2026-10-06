import { describe, expect, it } from "vitest";
import {
  LOCAL_PART_TEXTS,
  RESERVED_LOCAL_PARTS,
  reservedLocalPartText,
  SENDING_DOMAIN_TEXTS,
  suggestedLocalPart,
  validateLocalPart,
  validateSendingDomain,
} from "@/core/sender-address";

describe("validateLocalPart", () => {
  it("trims and lowercases a good name", () => {
    expect(validateLocalPart("  Ali.Khan ")).toEqual({ ok: true, localPart: "ali.khan" });
    expect(validateLocalPart("a")).toEqual({ ok: true, localPart: "a" });
    expect(validateLocalPart("sara_b-2")).toEqual({ ok: true, localPart: "sara_b-2" });
  });

  it("explains an empty or badly formed name", () => {
    expect(validateLocalPart("")).toEqual({ ok: false, error: LOCAL_PART_TEXTS.empty });
    expect(validateLocalPart("   ")).toEqual({ ok: false, error: LOCAL_PART_TEXTS.empty });
    for (const bad of [".ali", "ali.", "-ali", "ali-", "al..i", "ali khan", "ali@x", "ålí", "a+b", "x".repeat(65)]) {
      expect(validateLocalPart(bad)).toEqual({ ok: false, error: LOCAL_PART_TEXTS.invalid });
    }
    expect(validateLocalPart("x".repeat(64)).ok).toBe(true);
  });

  it("keeps mail-server and app names reserved", () => {
    for (const r of ["postmaster", "abuse", "dmarc", "noreply", "no-reply", "unsubscribe", "info", "hello", "pp-route-check"]) {
      expect(RESERVED_LOCAL_PARTS.has(r)).toBe(true);
      expect(validateLocalPart(r.toUpperCase())).toEqual({ ok: false, error: reservedLocalPartText(r) });
    }
    expect(validateLocalPart("pp-route-check-abc123")).toEqual({ ok: false, error: reservedLocalPartText("pp-route-check-abc123") });
    expect(reservedLocalPartText("postmaster")).toBe(
      "postmaster is kept for mail servers and can't be a sender address. Pick another name, for example your first name.",
    );
  });
});

describe("suggestedLocalPart", () => {
  it("uses the first name, cleaned", () => {
    expect(suggestedLocalPart("Ali Khan", "ali.khan@polygonparadise.com")).toBe("ali");
    expect(suggestedLocalPart("Åse Müller", "x@y.com")).toBe("ase");
  });
  it("falls back to the sign-in email, then to sender", () => {
    expect(suggestedLocalPart("Info", "sara.b@polygonparadise.com")).toBe("sara.b");
    expect(suggestedLocalPart("", "info@x.com")).toBe("sender");
  });
});

describe("validateSendingDomain", () => {
  it("accepts a sending domain, lowercased, forgiving a pasted https:// and trailing dot", () => {
    expect(validateSendingDomain("Mail.PolygonParadise.com")).toEqual({ ok: true, domain: "mail.polygonparadise.com" });
    expect(validateSendingDomain("https://send.example.com/")).toEqual({ ok: true, domain: "send.example.com" });
    expect(validateSendingDomain("send.example.co.uk.")).toEqual({ ok: true, domain: "send.example.co.uk" });
  });
  it("refuses the website itself, shared email domains and anything that isn't a domain", () => {
    expect(validateSendingDomain("polygonparadise.com")).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.website });
    expect(validateSendingDomain("www.polygonparadise.com")).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.website });
    expect(validateSendingDomain("gmail.com")).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.shared });
    expect(validateSendingDomain("")).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.empty });
    for (const bad of ["localhost", "-bad.com", "bad-.com", "a..b.com", "has space.com", "under_score.com", "1.2.3.4", `${"a".repeat(64)}.com`]) {
      expect(validateSendingDomain(bad)).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.invalid });
    }
  });

  it("refuses Mailgun's sandbox domains, and points the website domain to the From address card (SHARED-FROM-DESIGN F30)", () => {
    for (const sandbox of ["sandbox123.mailgun.org", "mailgun.org", "Sandbox9f2c.MAILGUN.org.", "https://sandbox1.mailgun.org/"]) {
      expect(validateSendingDomain(sandbox)).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.sandbox });
    }
    expect(SENDING_DOMAIN_TEXTS.sandbox).toBe(
      "That's Mailgun's sandbox domain, for tests only. Type mail.polygonparadise.com (add it in Mailgun first: Send › Domains › Add new domain).",
    );
    expect(validateSendingDomain("polygonparadise.com")).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.website });
    expect(SENDING_DOMAIN_TEXTS.website).toBe(
      "polygonparadise.com is your own domain. To send through it, choose From polygonparadise.com itself above. For replies through the app, type mail.polygonparadise.com here (Mailgun guide, step 4).",
    );
    // Only Mailgun's own sandbox: a domain that merely contains the name is fine.
    expect(validateSendingDomain("mail.mailgun-fans.com")).toEqual({ ok: true, domain: "mail.mailgun-fans.com" });
    expect(validateSendingDomain("mailgun.org.example.com")).toEqual({ ok: true, domain: "mailgun.org.example.com" });
  });
});

/**
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O7, O30, §2.2): polygonparadise.com itself may be the sending domain only there;
 * every own-mailbox refusal uses polygonparadise.com as its example, never mail.polygonparadise.com. App mode (absent or
 * "app") keeps today's rules and sentences.
 */
describe("validateSendingDomain in own-mailbox mode", () => {
  const OWN = { replies: "own-mailbox" } as const;
  const OWN_SENTENCES = [
    SENDING_DOMAIN_TEXTS.www,
    SENDING_DOMAIN_TEXTS.emptyOwn,
    SENDING_DOMAIN_TEXTS.invalidOwn,
    SENDING_DOMAIN_TEXTS.sandboxOwn,
    SENDING_DOMAIN_TEXTS.sharedOwn,
  ];

  it("polygonparadise.com: refused in app mode with the sentence naming the choice, allowed in own-mailbox mode", () => {
    for (const app of [undefined, { replies: "app" as const }, {}]) {
      expect(validateSendingDomain("polygonparadise.com", app)).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.website });
    }
    expect(validateSendingDomain("polygonparadise.com", OWN)).toEqual({ ok: true, domain: "polygonparadise.com" });
    expect(validateSendingDomain(" https://PolygonParadise.com/ ", OWN)).toEqual({ ok: true, domain: "polygonparadise.com" });
    expect(validateSendingDomain("polygonparadise.com.", OWN)).toEqual({ ok: true, domain: "polygonparadise.com" });
  });

  it("a www. name is refused in own-mailbox mode (and stays the website sentence in app mode)", () => {
    expect(validateSendingDomain("www.polygonparadise.com", OWN)).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.www });
    expect(validateSendingDomain("www.example.com", OWN)).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.www });
    expect(validateSendingDomain("www.polygonparadise.com")).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.website });
    expect(SENDING_DOMAIN_TEXTS.www).toBe("Type your domain without www., for example polygonparadise.com.");
  });

  it("Mailgun's sandbox and shared domains are refused in both modes, each with its own mode's sentence", () => {
    for (const sandbox of ["sandbox123.mailgun.org", "mailgun.org", "https://sandbox1.mailgun.org/"]) {
      expect(validateSendingDomain(sandbox)).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.sandbox });
      expect(validateSendingDomain(sandbox, OWN)).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.sandboxOwn });
    }
    expect(validateSendingDomain("gmail.com")).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.shared });
    expect(validateSendingDomain("gmail.com", OWN)).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.sharedOwn });
  });

  it("empty and invalid input give the own-mailbox sentences", () => {
    expect(validateSendingDomain("", OWN)).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.emptyOwn });
    expect(validateSendingDomain("   ", OWN)).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.emptyOwn });
    for (const bad of ["localhost", "-bad.com", "a..b.com", "has space.com", "1.2.3.4", `${"a".repeat(64)}.com`]) {
      expect(validateSendingDomain(bad, OWN)).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.invalidOwn });
    }
  });

  it("the exact own-mailbox sentences, none of which names mail.polygonparadise.com", () => {
    expect(SENDING_DOMAIN_TEXTS.emptyOwn).toBe("Enter the domain you send from, exactly as Mailgun shows it, for example polygonparadise.com.");
    expect(SENDING_DOMAIN_TEXTS.invalidOwn).toBe("That isn't a domain name. Enter it the way Mailgun shows it, for example polygonparadise.com.");
    expect(SENDING_DOMAIN_TEXTS.sandboxOwn).toBe(
      "That's Mailgun's sandbox domain, for tests only. Type polygonparadise.com, the domain Mailgun lists under Send › Domains next to it.",
    );
    expect(SENDING_DOMAIN_TEXTS.sharedOwn).toBe("That domain belongs to an email provider. Type your own domain, for example polygonparadise.com.");
    for (const s of OWN_SENTENCES) {
      expect(s).not.toContain("mail.polygonparadise.com");
      expect(s).toContain("polygonparadise.com");
    }
  });

  it("an ordinary sending domain is allowed in both modes", () => {
    expect(validateSendingDomain("send.example.com")).toEqual({ ok: true, domain: "send.example.com" });
    expect(validateSendingDomain("send.example.com", OWN)).toEqual({ ok: true, domain: "send.example.com" });
    expect(validateSendingDomain("mail.polygonparadise.com", OWN)).toEqual({ ok: true, domain: "mail.polygonparadise.com" });
  });
});
