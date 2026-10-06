import { describe, expect, it } from "vitest";
import {
  LAUNCH_SETTINGS_CHANGED_TEXT,
  TEAM_FROM_REFUSED_LOCAL_PARTS,
  TEAM_FROM_TEXTS as T,
  domainOfAddress,
  formatFromHeader,
  fromAddressOf,
  mailgunDomainOf,
  messageIdDomainOf,
  routeAddressOf,
  senderAddressWords,
  senderHeaderProblem,
  senderHeaders,
  teamFromDomainFor,
  validateTeamFromAddress,
} from "@/core/sending/from-address";
import * as addresses from "@/server/services/sending/addresses";
import * as transport from "@/server/services/sending/mailgun-transport";

/**
 * The shared From address's step-C contract (docs/dev/SHARED-FROM-DESIGN.md §2.2–§2.4, §7.5): the pure helpers every
 * package builds on. Per-person mode (no shared From) must give exactly today's From lines.
 */

const D = "send.example.com";

describe("the moves (behaviour unchanged)", () => {
  it("addresses.ts and mailgun-transport.ts re-export the one implementation", () => {
    expect(addresses.formatFromHeader).toBe(formatFromHeader);
    expect(transport.fromAddressOf).toBe(fromAddressOf);
    expect(transport.domainOfAddress).toBe(domainOfAddress);
  });

  it("formats and reads From lines as before", () => {
    expect(formatFromHeader("Ali from Polygon Paradise", "ali@send.example.com")).toBe("Ali from Polygon Paradise <ali@send.example.com>");
    expect(formatFromHeader("Ali, Polygon Paradise", "ali@x.test")).toBe('"Ali, Polygon Paradise" <ali@x.test>');
    expect(formatFromHeader("Ali\r\nBcc: x@y", "ali@x.test")).toBe('"Ali Bcc: x@y" <ali@x.test>');
    expect(formatFromHeader("  ", "ali@x.test")).toBe("ali@x.test");
    expect(fromAddressOf("Ali <Ali@Send.Example.com>")).toBe("ali@send.example.com");
    expect(fromAddressOf("ali@send.example.com")).toBe("ali@send.example.com");
    expect(domainOfAddress("ali@Send.Example.com")).toBe("send.example.com");
    expect(domainOfAddress("no-at-sign")).toBeNull();
    expect(domainOfAddress("@send.example.com")).toBeNull();
  });
});

describe("teamFromDomainFor", () => {
  it("is the main domain of a sending subdomain, else null", () => {
    expect(teamFromDomainFor("mail.polygonparadise.com")).toBe("polygonparadise.com");
    expect(teamFromDomainFor("Mail.PolygonParadise.com.")).toBe("polygonparadise.com");
    expect(teamFromDomainFor(D)).toBe("example.com");
    expect(teamFromDomainFor("a.b.example.com")).toBe("example.com");
    expect(teamFromDomainFor("mail.polygonparadise.co.uk")).toBe("polygonparadise.co.uk");
    expect(teamFromDomainFor("send-studio.com")).toBeNull();
    expect(teamFromDomainFor("polygonparadise.co.uk")).toBeNull();
    expect(teamFromDomainFor("")).toBeNull();
    expect(teamFromDomainFor(null)).toBeNull();
    expect(teamFromDomainFor(undefined)).toBeNull();
  });
});

describe("validateTeamFromAddress (§2.2)", () => {
  const ok = (address: string | null) => ({ ok: true, address });
  const err = (error: string) => ({ ok: false, error });

  it("empty is per-person mode, even before Mailgun is connected", () => {
    expect(validateTeamFromAddress("", D)).toEqual(ok(null));
    expect(validateTeamFromAddress("   ", null)).toEqual(ok(null));
    expect(validateTeamFromAddress(null, null)).toEqual(ok(null));
    expect(validateTeamFromAddress(undefined, D)).toEqual(ok(null));
  });

  it("accepts an address on the main domain of the sending domain, lowercased; mailto: is forgiven", () => {
    expect(validateTeamFromAddress("contact@example.com", D)).toEqual(ok("contact@example.com"));
    expect(validateTeamFromAddress("  Contact@Example.COM ", D)).toEqual(ok("contact@example.com"));
    expect(validateTeamFromAddress("mailto:contact@example.com", D)).toEqual(ok("contact@example.com"));
    expect(validateTeamFromAddress("contact@polygonparadise.com", "mail.polygonparadise.com")).toEqual(ok("contact@polygonparadise.com"));
    expect(validateTeamFromAddress("contact@polygonparadise.co.uk", "mail.polygonparadise.co.uk")).toEqual(ok("contact@polygonparadise.co.uk"));
    for (const local of ["contact", "info", "hello", "sales", "support"]) {
      expect(validateTeamFromAddress(`${local}@polygonparadise.com`, "mail.polygonparadise.com")).toEqual(ok(`${local}@polygonparadise.com`));
    }
  });

  it("refuses without a sending domain", () => {
    expect(validateTeamFromAddress("contact@example.com", null)).toEqual(err("Connect Mailgun first: the From address must fit your sending domain."));
    expect(validateTeamFromAddress("contact@example.com", "  ")).toEqual(err(T.notConnected));
  });

  it("refuses anything but one bare address, with an example on the main domain", () => {
    const invalid = err(
      "That isn't an email address. Type it the way people should see it, for example contact@polygonparadise.com.",
    );
    const d = "mail.polygonparadise.com";
    expect(validateTeamFromAddress('"Ali" <contact@polygonparadise.com>', d)).toEqual(invalid);
    expect(validateTeamFromAddress("Ali <contact@polygonparadise.com>", d)).toEqual(invalid);
    expect(validateTeamFromAddress("contact@polygonparadise.com, info@polygonparadise.com", d)).toEqual(invalid);
    expect(validateTeamFromAddress("contact at polygonparadise.com", d)).toEqual(invalid);
    expect(validateTeamFromAddress("contact", d)).toEqual(invalid);
    expect(validateTeamFromAddress("contact@polygonparadise.com.", d)).toEqual(invalid);
    expect(validateTeamFromAddress("(contact)@polygonparadise.com", d)).toEqual(invalid);
  });

  it("needs a sending domain that is a subdomain of a main domain", () => {
    expect(validateTeamFromAddress("contact@send-studio.com", "send-studio.com")).toEqual(
      err(
        "A shared From address needs a sending domain that is part of your main domain, for example mail.polygonparadise.com. send-studio.com isn't: leave this empty, or add a subdomain such as mail.<your domain> in Mailgun and connect it above (Mailgun guide, step 4).",
      ),
    );
  });

  it("refuses the sending domain itself and anything under it", () => {
    const onSending = err(T.onSendingDomain(D, "example.com"));
    expect(validateTeamFromAddress("contact@send.example.com", D)).toEqual(onSending);
    expect(validateTeamFromAddress("a@x.send.example.com", D)).toEqual(onSending);
    expect(validateTeamFromAddress("contact@mail.polygonparadise.com", "mail.polygonparadise.com")).toEqual(
      err(
        "Leave this empty to send from each person's own address on mail.polygonparadise.com. A shared From address goes on your main domain, for example contact@polygonparadise.com.",
      ),
    );
  });

  it("refuses shared and free-mail domains, then anything off the main domain", () => {
    expect(validateTeamFromAddress("someone@gmail.com", D)).toEqual(err(T.shared("contact@example.com")));
    expect(validateTeamFromAddress("contact@other.com", D)).toEqual(err(T.wrongDomain(D, "example.com")));
    expect(validateTeamFromAddress("contact@www.example.com", D)).toEqual(err(T.wrongDomain(D, "example.com")));
    expect(validateTeamFromAddress("contact@polygonparadise.net", "mail.polygonparadise.com")).toEqual(
      err("The From address must end in @polygonparadise.com, the main domain of your sending domain mail.polygonparadise.com."),
    );
  });

  it("refuses mail-server and no-reply names and the route probe", () => {
    expect(validateTeamFromAddress("noreply@example.com", D)).toEqual(
      err("noreply@ can't receive replies or is kept for mail servers. Use the address your team reads, for example contact@example.com."),
    );
    for (const local of ["postmaster", "abuse", "hostmaster", "mailer-daemon", "no-reply", "donotreply", "do-not-reply", "bounce", "bounces", "unsubscribe", "u", "dmarc"]) {
      expect(validateTeamFromAddress(`${local}@example.com`, D)).toEqual(err(T.reserved(local, "contact@example.com")));
    }
    expect(validateTeamFromAddress("pp-route-check-1@example.com", D)).toEqual(err(T.reserved("pp-route-check-1", "contact@example.com")));
    expect(TEAM_FROM_REFUSED_LOCAL_PARTS.size).toBe(13);
    expect(TEAM_FROM_REFUSED_LOCAL_PARTS.has("contact")).toBe(false);
  });
});

describe("senderHeaders (§2.3)", () => {
  it("per-person mode: the sender's own address, no Reply-To (today's From line)", () => {
    expect(senderHeaders({ displayName: "Ali from Polygon Paradise", senderAddress: "Ali@Send.Example.com", teamFrom: null })).toEqual({
      from: "Ali from Polygon Paradise <ali@send.example.com>",
      replyTo: null,
    });
    expect(senderHeaders({ displayName: "Ali", senderAddress: "ali@send.example.com", teamFrom: "  " })).toEqual({
      from: "Ali <ali@send.example.com>",
      replyTo: null,
    });
  });

  it("shared-From mode: the shared address with the display name, the own address as Reply-To", () => {
    expect(senderHeaders({ displayName: "Arslan from Polygon Paradise", senderAddress: "arslan@mail.polygonparadise.com", teamFrom: "Contact@PolygonParadise.com" })).toEqual({
      from: "Arslan from Polygon Paradise <contact@polygonparadise.com>",
      replyTo: "arslan@mail.polygonparadise.com",
    });
    expect(senderHeaders({ displayName: "Ali, Polygon Paradise", senderAddress: "ali@send.example.com", teamFrom: "contact@example.com" })).toEqual({
      from: '"Ali, Polygon Paradise" <contact@example.com>',
      replyTo: "ali@send.example.com",
    });
  });
});

describe("routeAddressOf, mailgunDomainOf, messageIdDomainOf", () => {
  it("the route address is the Reply-To when set, else the From address", () => {
    expect(routeAddressOf("Ali <ali@send.example.com>", null)).toBe("ali@send.example.com");
    expect(routeAddressOf("Ali <contact@example.com>", " Ali@Send.Example.com ")).toBe("ali@send.example.com");
    expect(routeAddressOf("Ali <contact@example.com>", "")).toBe("contact@example.com");
    expect(routeAddressOf("Ali <contact@example.com>", undefined)).toBe("contact@example.com");
  });

  it("the Mailgun domain is the route address's domain (per-person: the From's, as today)", () => {
    expect(mailgunDomainOf("Ali <ali@send.example.com>", null)).toBe(D);
    expect(mailgunDomainOf("Ali <contact@example.com>", "ali@send.example.com")).toBe(D);
    expect(mailgunDomainOf("Ali <contact@example.com>", null)).toBe("example.com");
    expect(mailgunDomainOf("no address", null)).toBeNull();
  });

  it("reads the domain of a stored or bracketed Message-ID", () => {
    expect(messageIdDomainOf("pp.1a2b@send.example.com")).toBe(D);
    expect(messageIdDomainOf(" <pp.1a2b@Send.Example.com> ")).toBe(D);
    expect(messageIdDomainOf("pp.1a2b")).toBeNull();
    expect(messageIdDomainOf(null)).toBeNull();
    expect(messageIdDomainOf(undefined)).toBeNull();
    // addresses.ts keeps its own dry-run fallback for follow-ups (a different function on purpose).
    expect(addresses.messageIdDomainOf("pp.1a2b")).toBe(addresses.DRY_RUN_MESSAGE_ID_DOMAIN);
  });
});

describe("senderHeaderProblem (§2.4, fail closed)", () => {
  it("accepts a From on the sending domain with any Reply-To (per-person mode, as today)", () => {
    expect(senderHeaderProblem(D, "Ali <ali@send.example.com>", null)).toBeNull();
    expect(senderHeaderProblem(D, "Ali <ali@send.example.com>", "ali@reply.example.com")).toBeNull();
    expect(senderHeaderProblem("Send.Example.com.", "Ali <ALI@SEND.EXAMPLE.COM>", undefined)).toBeNull();
  });

  it("accepts a From on the main domain with one bare Reply-To on the sending domain", () => {
    expect(senderHeaderProblem(D, "Ali <contact@example.com>", "ali@send.example.com")).toBeNull();
    expect(senderHeaderProblem(D, "contact@example.com", " Ali@Send.Example.com ")).toBeNull();
  });

  it("refuses a shared From without a Reply-To on the sending domain itself", () => {
    expect(senderHeaderProblem(D, "Ali <contact@example.com>", null)).toBe("An email from the shared From address has no reply address.");
    expect(senderHeaderProblem(D, "Ali <contact@example.com>", "  ")).toBe("An email from the shared From address has no reply address.");
    const notOnD = "The reply address isn't on send.example.com.";
    expect(senderHeaderProblem(D, "Ali <contact@example.com>", "contact@example.com")).toBe(notOnD);
    expect(senderHeaderProblem(D, "Ali <contact@example.com>", "ali@x.send.example.com")).toBe(notOnD);
    expect(senderHeaderProblem(D, "Ali <contact@example.com>", "ali@send.example.com, bo@send.example.com")).toBe(notOnD);
    expect(senderHeaderProblem(D, "Ali <contact@example.com>", "Ali <ali@send.example.com>")).toBe(notOnD);
    expect(senderHeaderProblem(D, "Ali <contact@example.com>", "ali")).toBe(notOnD);
  });

  it("refuses a From that is neither on the sending domain nor on its main domain", () => {
    const notOn = "The From address isn't on send.example.com or its main domain.";
    expect(senderHeaderProblem(D, "Ali <ali@other.com>", "ali@send.example.com")).toBe(notOn);
    expect(senderHeaderProblem(D, "Ali <ali@x.send.example.com>", "ali@send.example.com")).toBe(notOn);
    expect(senderHeaderProblem(D, "Ali <ali@www.example.com>", "ali@send.example.com")).toBe(notOn);
    // A sending domain that is a main domain has no main domain above it: only its own From goes.
    expect(senderHeaderProblem("send-studio.com", "Ali <contact@studio.com>", "ali@send-studio.com")).toBe(
      "The From address isn't on send-studio.com or its main domain.",
    );
  });

  it("refuses an email without a From address or without a sending domain", () => {
    expect(senderHeaderProblem(D, "", "ali@send.example.com")).toBe("The email has no From address.");
    expect(senderHeaderProblem(D, "Ali", null)).toBe("The email has no From address.");
    expect(senderHeaderProblem("", "Ali <ali@send.example.com>", null)).toBe("The email has no From address.");
  });
});

describe("senderAddressWords and the launch text", () => {
  it("names the per-person address by mode (F19)", () => {
    expect(senderAddressWords(false)).toEqual({ label: "Sending address", lower: "sending address", noneYet: "No sending address yet", plural: "Sending addresses" });
    expect(senderAddressWords(true)).toEqual({ label: "Reply address", lower: "reply address", noneYet: "No reply address yet", plural: "Reply addresses" });
  });

  it("has the §3.7 sentence for a launch that raced a settings change", () => {
    expect(LAUNCH_SETTINGS_CHANGED_TEXT).toBe(
      "The sending settings changed while this campaign was being launched (the From address, the sending domain or going live). Open the campaign and launch it again.",
    );
  });

  it("builds the From card's sentences from their parts (§3.1)", () => {
    expect(T.hint("Arslan from Polygon Paradise", "contact@polygonparadise.com", "polygonparadise.com", "mail.polygonparadise.com")).toBe(
      'People see "Arslan from Polygon Paradise <contact@polygonparadise.com>": each person\'s display name with this address. Replies go to each person\'s own address on mail.polygonparadise.com, and from there to their reply inbox. It must end in @polygonparadise.com.',
    );
    expect(T.goodToKnow("contact@polygonparadise.com", "polygonparadise.com", "mail.polygonparadise.com")).toHaveLength(6);
    expect(T.misfit("contact@old.com", D)).toBe(
      "The From address contact@old.com doesn't fit your sending domain send.example.com. Change or clear it in Settings › Sending & Mailgun.",
    );
    expect(T.onTestList("contact@example.com")).toBe(
      "contact@example.com is on your test list. Remove it from the test list first: it can't be a test mailbox.",
    );
    expect(T.followUpReminder("contact@example.com")).toBe(
      "Replies written straight to contact@example.com don't reach the app. If someone answered there, set their company to Replied so the follow-ups stop.",
    );
  });
});
