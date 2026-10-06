import { describe, expect, it } from "vitest";
import {
  TEAM_FROM_TEXTS as T,
  mailgunDomainOf,
  messageIdDomainOf,
  routeAddressOf,
  senderHeaderProblem,
  senderHeaders,
  validateTeamFromAddress,
} from "@/core/sending/from-address";

/**
 * Every email's From and Reply-To (docs/dev/SHARED-FROM-DESIGN.md §2.2–§2.4, package P1's table): the shared From
 * address's validation, the headers of one sender in both modes, where a reply lands, which Mailgun domain an email
 * goes through, and the fail-closed sender check the transport and the client share.
 */

const D = "send.example.com";

describe("validateTeamFromAddress (§2.2)", () => {
  const ok = (input: string, domain = D) => validateTeamFromAddress(input, domain);

  it("accepts an address on the main domain of the sending domain, lowercase; mailto: and case are forgiven", () => {
    expect(ok("contact@example.com")).toEqual({ ok: true, address: "contact@example.com" });
    expect(ok("  Contact@Example.COM ")).toEqual({ ok: true, address: "contact@example.com" });
    expect(ok("mailto:Contact@Example.com")).toEqual({ ok: true, address: "contact@example.com" });
    // The owner's real shape, and a main domain under a two-part public suffix.
    expect(ok("contact@polygonparadise.com", "mail.polygonparadise.com")).toEqual({ ok: true, address: "contact@polygonparadise.com" });
    expect(ok("contact@polygonparadise.co.uk", "mail.polygonparadise.co.uk")).toEqual({ ok: true, address: "contact@polygonparadise.co.uk" });
    // contact, info, hello… are allowed here (they stay reserved for per-person addresses).
    for (const local of ["info", "hello", "sales", "support"]) expect(ok(`${local}@example.com`)).toEqual({ ok: true, address: `${local}@example.com` });
  });

  it("empty is per-person mode; no sending domain is 'connect first'", () => {
    for (const empty of ["", "   ", null, undefined]) expect(validateTeamFromAddress(empty, D)).toEqual({ ok: true, address: null });
    expect(validateTeamFromAddress("contact@example.com", null)).toEqual({ ok: false, error: T.notConnected });
    expect(validateTeamFromAddress("contact@example.com", "  ")).toEqual({ ok: false, error: T.notConnected });
  });

  it("refuses the sending domain itself and anything under it", () => {
    expect(ok("contact@send.example.com")).toEqual({ ok: false, error: T.onSendingDomain(D, "example.com") });
    expect(ok("a@x.send.example.com")).toEqual({ ok: false, error: T.onSendingDomain(D, "example.com") });
  });

  it("refuses anything off the main domain, www included, and free-mail domains", () => {
    expect(ok("contact@other.com")).toEqual({ ok: false, error: T.wrongDomain(D, "example.com") });
    expect(ok("contact@www.example.com")).toEqual({ ok: false, error: T.wrongDomain(D, "example.com") });
    expect(ok("me@gmail.com")).toEqual({ ok: false, error: T.shared("contact@example.com") });
  });

  it("needs a sending domain that is a subdomain of a main domain", () => {
    expect(ok("contact@send-studio.com", "send-studio.com")).toEqual({ ok: false, error: T.noSubdomain("send-studio.com") });
  });

  it("refuses mail-server, no-reply and route-probe names", () => {
    expect(ok("noreply@example.com")).toEqual({ ok: false, error: T.reserved("noreply", "contact@example.com") });
    expect(ok("postmaster@example.com")).toEqual({ ok: false, error: T.reserved("postmaster", "contact@example.com") });
    expect(ok("pp-route-check-1@example.com")).toEqual({ ok: false, error: T.reserved("pp-route-check-1", "contact@example.com") });
  });

  it("refuses anything but one bare address", () => {
    for (const bad of ['"Ali" <contact@example.com>', "Ali <contact@example.com>", "contact@example.com, info@example.com", "contact @example.com", "not an address"]) {
      expect(ok(bad), bad).toEqual({ ok: false, error: T.invalid("contact@example.com") });
    }
  });
});

describe("senderHeaders (§2.3)", () => {
  it("per-person mode: From the sender's own address, no Reply-To", () => {
    expect(senderHeaders({ displayName: "Ali from Polygon Paradise", senderAddress: "Ali@Send.Example.com", teamFrom: null })).toEqual({
      from: "Ali from Polygon Paradise <ali@send.example.com>",
      replyTo: null,
    });
    expect(senderHeaders({ displayName: "Ali", senderAddress: "ali@send.example.com", teamFrom: "  " }).replyTo).toBeNull();
  });

  it("shared-From mode: From the shared address with the display name, Reply-To the sender's own address", () => {
    expect(senderHeaders({ displayName: "Ali from Polygon Paradise", senderAddress: "Ali@Send.Example.com", teamFrom: "Contact@Example.com" })).toEqual({
      from: "Ali from Polygon Paradise <contact@example.com>",
      replyTo: "ali@send.example.com",
    });
  });

  it("quotes a display name that needs it in both modes", () => {
    const name = 'Ali "3D" Khan, Polygon Paradise';
    expect(senderHeaders({ displayName: name, senderAddress: "ali@send.example.com", teamFrom: null }).from).toBe(
      '"Ali \\"3D\\" Khan, Polygon Paradise" <ali@send.example.com>',
    );
    expect(senderHeaders({ displayName: name, senderAddress: "ali@send.example.com", teamFrom: "contact@example.com" }).from).toBe(
      '"Ali \\"3D\\" Khan, Polygon Paradise" <contact@example.com>',
    );
  });
});

describe("where replies land and which Mailgun domain an email goes through", () => {
  it("routeAddressOf: the Reply-To when set, else the From address (lowercase)", () => {
    expect(routeAddressOf("Ali <Ali@Send.Example.com>", null)).toBe("ali@send.example.com");
    expect(routeAddressOf("Ali <contact@example.com>", " Ali@Send.Example.com ")).toBe("ali@send.example.com");
    expect(routeAddressOf("ali@send.example.com", "")).toBe("ali@send.example.com");
  });

  it("mailgunDomainOf: the route address's domain (per-person: the From's, as before)", () => {
    expect(mailgunDomainOf("Ali <ali@send.example.com>", null)).toBe(D);
    expect(mailgunDomainOf("Ali <contact@example.com>", "ali@send.example.com")).toBe(D);
    // A shared-From row that lost its Reply-To names the main domain, which has no SendingDomain row: NOT_ON_DOMAIN.
    expect(mailgunDomainOf("Ali <contact@example.com>", null)).toBe("example.com");
    expect(mailgunDomainOf("no address", null)).toBeNull();
  });

  it("messageIdDomainOf: the domain of a stored or bracketed Message-ID", () => {
    expect(messageIdDomainOf("pp.1a2b@Send.Example.com")).toBe(D);
    expect(messageIdDomainOf("<pp.1a2b@send.example.com>")).toBe(D);
    expect(messageIdDomainOf("")).toBeNull();
    expect(messageIdDomainOf(null)).toBeNull();
  });
});

describe("senderHeaderProblem (§2.4, fail closed)", () => {
  it("accepts a From on the sending domain with any Reply-To (per-person mode, as today)", () => {
    expect(senderHeaderProblem(D, "Ali <ali@send.example.com>", null)).toBeNull();
    // The existing client test's case: a Reply-To elsewhere never refused a per-person email.
    expect(senderHeaderProblem(D, "Ali Khan <ali@send.example.com>", "ali@reply.example.com")).toBeNull();
    expect(senderHeaderProblem("Send.Example.com.", "ali@SEND.example.com", null)).toBeNull();
  });

  it("accepts a From on the main domain with one bare Reply-To on the sending domain", () => {
    expect(senderHeaderProblem(D, "Ali from Polygon Paradise <contact@example.com>", "ali@send.example.com")).toBeNull();
    expect(senderHeaderProblem(D, "contact@example.com", "Ali@Send.Example.com")).toBeNull();
  });

  it("refuses a shared From without a Reply-To, or with one that isn't one bare address on the sending domain itself", () => {
    const from = "Ali <contact@example.com>";
    expect(senderHeaderProblem(D, from, null)).toBe("An email from the shared From address has no reply address.");
    expect(senderHeaderProblem(D, from, "  ")).toBe("An email from the shared From address has no reply address.");
    for (const replyTo of ["contact@example.com", "ali@x.send.example.com", "ali@other.com", "Ali <ali@send.example.com>", "a@send.example.com, b@send.example.com", "ali @send.example.com"]) {
      expect(senderHeaderProblem(D, from, replyTo), replyTo).toBe(`The reply address isn't on ${D}.`);
    }
  });

  it("refuses a From that is neither on the sending domain nor on its main domain", () => {
    expect(senderHeaderProblem(D, "Anna <anna@firma.de>", "ali@send.example.com")).toBe(`The From address isn't on ${D} or its main domain.`);
    expect(senderHeaderProblem(D, "Ali <contact@www.example.com>", "ali@send.example.com")).toBe(`The From address isn't on ${D} or its main domain.`);
    // A sending domain that is itself a main domain has no main domain to share.
    expect(senderHeaderProblem("send-studio.com", "Ali <contact@studio.com>", "ali@send-studio.com")).toBe(
      "The From address isn't on send-studio.com or its main domain.",
    );
  });

  it("refuses an email without a From address or without a sending domain", () => {
    expect(senderHeaderProblem(D, "", null)).toBe("The email has no From address.");
    expect(senderHeaderProblem(D, "Ali <>", null)).toBe("The email has no From address.");
    expect(senderHeaderProblem("", "Ali <ali@send.example.com>", null)).toBe("The email has no From address.");
  });
});
