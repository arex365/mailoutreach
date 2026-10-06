import { describe, expect, it } from "vitest";
import {
  DRY_RUN_MESSAGE_ID_DOMAIN,
  NoSenderAddressError,
  formatFromHeader,
  messageIdDomainOf,
  newMessageId,
  newSendId,
  nextReferences,
  senderLocalPart,
  senderSnapshot,
} from "@/server/services/sending/addresses";
import { DryRunTransport, SENDABLE_MODES, TransportError, transportFor } from "@/server/services/sending/transport";

describe("own-mailbox mode's snapshot (MAIN-DOMAIN-DESIGN §2.3, O5)", () => {
  const ali = { name: "Ali Khan", email: "ali@polygonparadise.test", senderDisplayName: "Ali from Polygon Paradise" };
  const own = { from: "Contact@Example.com", domainId: 7, domainName: "Example.com" };
  const address = { address: "ali@example.com", domainId: 3, domainName: "example.com" };

  it("test and live: the display name with the own From, no Reply-To, the sending domain's row and Message-ID domain", () => {
    for (const mode of ["TEST", "LIVE"] as const) {
      expect(senderSnapshot(ali, mode, null, { ownMailbox: own })).toEqual({
        fromName: "Ali from Polygon Paradise",
        fromAddress: "contact@example.com",
        fromHeader: "Ali from Polygon Paradise <contact@example.com>",
        replyTo: null,
        sendingDomainId: 7,
        messageIdDomain: "example.com",
      });
    }
  });

  it("the sender's own address is ignored (nobody needs one), and a dry run's Message-IDs stay on dry-run.invalid", () => {
    expect(senderSnapshot(ali, "LIVE", address, { ownMailbox: own })).toMatchObject({ fromAddress: "contact@example.com", replyTo: null, sendingDomainId: 7 });
    expect(senderSnapshot(ali, "DRY_RUN", null, { ownMailbox: own })).toEqual({
      fromName: "Ali from Polygon Paradise",
      fromAddress: "contact@example.com",
      fromHeader: "Ali from Polygon Paradise <contact@example.com>",
      replyTo: null,
      sendingDomainId: 7,
      messageIdDomain: DRY_RUN_MESSAGE_ID_DOMAIN,
    });
  });

  it("a shared From and own-mailbox mode together are a programming error", () => {
    expect(() => senderSnapshot(ali, "LIVE", address, { teamFrom: "contact@example.com", ownMailbox: own })).toThrow(/can't be used together/);
    expect(() => senderSnapshot(ali, "DRY_RUN", null, { teamFrom: "contact@example.com", ownMailbox: own })).toThrow(/can't be used together/);
  });

  it("without the option nothing changes (a null option is app mode)", () => {
    expect(senderSnapshot(ali, "LIVE", address, { ownMailbox: null })).toEqual(senderSnapshot(ali, "LIVE", address));
    expect(senderSnapshot(ali, "DRY_RUN", null, { ownMailbox: null })).toEqual(senderSnapshot(ali, "DRY_RUN"));
  });
});

describe("the dry-run From line", () => {
  it("uses the display name and the login email's local part on the placeholder domain", () => {
    const s = senderSnapshot({ name: "Ali Khan", email: "Ali.Khan@Gmail.com", senderDisplayName: "Ali from Polygon Paradise" }, "DRY_RUN");
    expect(s).toEqual({
      fromName: "Ali from Polygon Paradise",
      fromAddress: "ali.khan@your-sending-domain",
      fromHeader: "Ali from Polygon Paradise <ali.khan@your-sending-domain>",
      replyTo: null,
      sendingDomainId: null,
      messageIdDomain: "dry-run.invalid",
    });
  });

  it("falls back to the person's name, and uses a real sender address when there is one", () => {
    const noDisplay = senderSnapshot({ name: "Sara", email: "sara@studio.pk", senderDisplayName: "  " }, "DRY_RUN");
    expect(noDisplay.fromHeader).toBe("Sara <sara@your-sending-domain>");
    const real = senderSnapshot({ name: "Sara", email: "sara@studio.pk", senderDisplayName: null }, "DRY_RUN", {
      address: "Sara@Send.Example.com",
      domainId: 4,
      domainName: "send.example.com",
    });
    expect(real).toMatchObject({ fromAddress: "sara@send.example.com", sendingDomainId: 4, messageIdDomain: "dry-run.invalid" });
    const live = senderSnapshot({ name: "Sara", email: "sara@studio.pk", senderDisplayName: null }, "LIVE", {
      address: "sara@send.example.com",
      domainId: 4,
      domainName: "Send.Example.com",
    });
    expect(live.messageIdDomain).toBe("send.example.com");
  });

  it("never uses the placeholder for test mode or live (defence in depth behind the launch check)", () => {
    const user = { name: "Sara", email: "sara@studio.pk", senderDisplayName: null };
    expect(() => senderSnapshot(user, "LIVE")).toThrow(NoSenderAddressError);
    expect(() => senderSnapshot(user, "TEST", null)).toThrow("Sara has no sending address yet. Sara can add one in Settings › My profile.");
    expect(senderSnapshot(user, "DRY_RUN").fromAddress).toBe("sara@your-sending-domain");
  });

  it("quotes display names that need it", () => {
    expect(formatFromHeader("Ali, Polygon Paradise", "ali@x.test")).toBe('"Ali, Polygon Paradise" <ali@x.test>');
    expect(formatFromHeader('Ali "3D" Khan', "ali@x.test")).toBe('"Ali \\"3D\\" Khan" <ali@x.test>');
    expect(formatFromHeader("", "ali@x.test")).toBe("ali@x.test");
    expect(senderLocalPart("Weird Name!@x.de")).toBe("weirdname");
    expect(senderLocalPart("@x.de")).toBe("sender");
  });
});

describe("the shared From address (SHARED-FROM-DESIGN §2.3)", () => {
  const ali = { name: "Ali Khan", email: "ali@polygonparadise.test", senderDisplayName: "Ali from Polygon Paradise" };
  const own = { address: "Ali@Send.Example.com", domainId: 4, domainName: "Send.Example.com" };

  it("test and live: From the shared address with the display name, Reply-To the sender's own address, ids on the sending domain", () => {
    for (const mode of ["TEST", "LIVE"] as const) {
      expect(senderSnapshot(ali, mode, own, { teamFrom: "Contact@Example.com" })).toEqual({
        fromName: "Ali from Polygon Paradise",
        fromAddress: "contact@example.com",
        fromHeader: "Ali from Polygon Paradise <contact@example.com>",
        replyTo: "ali@send.example.com",
        sendingDomainId: 4,
        messageIdDomain: "send.example.com",
      });
    }
  });

  it("quotes a display name that needs it, exactly as in per-person mode", () => {
    const quoted = senderSnapshot({ ...ali, senderDisplayName: "Ali, Polygon Paradise" }, "LIVE", own, { teamFrom: "contact@example.com" });
    expect(quoted.fromHeader).toBe('"Ali, Polygon Paradise" <contact@example.com>');
  });

  it("a dry run with an address: the team headers, Message-IDs on dry-run.invalid", () => {
    expect(senderSnapshot(ali, "DRY_RUN", own, { teamFrom: "contact@example.com" })).toMatchObject({
      fromAddress: "contact@example.com",
      fromHeader: "Ali from Polygon Paradise <contact@example.com>",
      replyTo: "ali@send.example.com",
      sendingDomainId: 4,
      messageIdDomain: "dry-run.invalid",
    });
  });

  it("a dry run without an address: From the shared address, no Reply-To, dry-run.invalid ids", () => {
    expect(senderSnapshot(ali, "DRY_RUN", null, { teamFrom: "contact@example.com" })).toEqual({
      fromName: "Ali from Polygon Paradise",
      fromAddress: "contact@example.com",
      fromHeader: "Ali from Polygon Paradise <contact@example.com>",
      replyTo: null,
      sendingDomainId: null,
      messageIdDomain: "dry-run.invalid",
    });
  });

  it("test and live without an address refuse with the reply-address words", () => {
    const sara = { name: "Sara", email: "sara@studio.pk", senderDisplayName: null };
    expect(() => senderSnapshot(sara, "TEST", null, { teamFrom: "contact@example.com" })).toThrow(NoSenderAddressError);
    expect(() => senderSnapshot(sara, "LIVE", null, { teamFrom: "contact@example.com" })).toThrow(
      "Sara has no reply address yet. Sara can add one in Settings › My profile.",
    );
    expect(new NoSenderAddressError("  ", { teamFrom: true }).message).toBe(
      "The sender has no reply address yet. The sender can add one in Settings › My profile.",
    );
  });

  it("per-person mode is unchanged: no teamFrom, null or empty gives today's snapshot", () => {
    const today = senderSnapshot(ali, "LIVE", own);
    expect(today).toEqual({
      fromName: "Ali from Polygon Paradise",
      fromAddress: "ali@send.example.com",
      fromHeader: "Ali from Polygon Paradise <ali@send.example.com>",
      replyTo: null,
      sendingDomainId: 4,
      messageIdDomain: "send.example.com",
    });
    expect(senderSnapshot(ali, "LIVE", own, { teamFrom: null })).toEqual(today);
    expect(senderSnapshot(ali, "LIVE", own, { teamFrom: "  " })).toEqual(today);
    expect(new NoSenderAddressError("Sara").message).toBe("Sara has no sending address yet. Sara can add one in Settings › My profile.");
  });
});

describe("message ids and threading", () => {
  it("makes lowercase Message-IDs without angle brackets, and random send ids", () => {
    const a = newMessageId();
    const b = newMessageId();
    expect(a).toMatch(/^pp\.[0-9a-f]{24}@dry-run\.invalid$/);
    expect(a).not.toBe(b);
    expect(newMessageId("Send.Example.COM")).toMatch(/@send\.example\.com$/);
    expect(newSendId()).toMatch(/^[0-9a-f]{32}$/);
    expect(messageIdDomainOf(a)).toBe(DRY_RUN_MESSAGE_ID_DOMAIN);
  });

  it("builds References oldest first", () => {
    expect(nextReferences(null, "a@x")).toBe("a@x");
    expect(nextReferences("a@x", "b@x")).toBe("a@x b@x");
    expect(nextReferences("a@x b@x", "b@x")).toBe("a@x b@x");
  });
});

describe("transports", () => {
  it("the dry-run transport accepts everything without a network call", async () => {
    const at = new Date("2026-10-01T10:00:00Z");
    const t = new DryRunTransport(() => at);
    const res = await t.send({
      emailId: 1,
      campaignId: 1,
      step: 0,
      from: "Ali <ali@your-sending-domain>",
      to: "anna@acme.de",
      toNorm: "anna@acme.de",
      subject: "Hi",
      text: "Hello",
      html: "<p>Hello</p>",
      messageId: "pp.1@dry-run.invalid",
      inReplyTo: null,
      references: null,
      sendId: "s",
    });
    expect(res).toEqual({ providerId: "dry-run:pp.1@dry-run.invalid", acceptedAt: at });
  });

  it("every mode can send, but the plain transportFor only sends dry runs: Mailgun emails go through the gates", async () => {
    expect(SENDABLE_MODES).toEqual(["DRY_RUN", "TEST", "LIVE"]);
    expect(transportFor("DRY_RUN")).toBeInstanceOf(DryRunTransport);
    const message = {
      emailId: 1,
      campaignId: 1,
      step: 0,
      from: "Ali <ali@send.example.com>",
      to: "anna@acme.de",
      toNorm: "anna@acme.de",
      subject: "Hi",
      text: "Hello",
      html: "<p>Hello</p>",
      messageId: "pp.1@send.example.com",
      inReplyTo: null,
      references: null,
      sendId: "s",
    };
    for (const mode of ["LIVE", "TEST"] as const) {
      const err = await transportFor(mode).send(message).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).failure.kind).toBe("blocked");
    }
  });
});
