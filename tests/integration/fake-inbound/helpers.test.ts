import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { postInbound, receivedIdOf, replyInput, replyTo, vectorInput, type VectorFields } from "../helpers/replies";
import { makeOwner, seedEmail } from "../mail-events/seed";

const t = await createTestDb("reply-helpers");
const mg = await connectFakeMailgun();
const { db } = await import("@/server/db");

/** Research vectors (replies-and-auto-replies.md Appendix B) in their own shape. */
const A = "pp.4f1c9a0b7e2d4c6a8b0e1f23@send.polygonparadise.com";
const SA = "3D models for your shop";
const thread = (id: string): Array<[string, string]> => [
  ["In-Reply-To", `<${id}>`],
  ["References", `<${id}>`],
];
const V01: { id: string; in: VectorFields } = {
  id: "V01 Gmail human reply",
  in: {
    subject: `Re: ${SA}`,
    fromEmail: "anna@firma.de",
    envelopeSender: "anna@firma.de",
    headers: [["From", "Anna Berg <anna@firma.de>"], ...thread(A), ["Content-Type", 'multipart/alternative; boundary="000000000000abc"']],
    strippedText: null,
    bodyPlain: "Hi Ali,\nsounds interesting. Could you send prices for 10 busts?\n\nOn Mon, Sep 21, 2026 at 10:15 AM Ali Khan <\nali@send.polygonparadise.com> wrote:\n\n> Hi Anna,",
  },
};
const V03: VectorFields = {
  subject: `Automatic reply: ${SA}`,
  fromEmail: "anna@firma.de",
  envelopeSender: "",
  headers: [...thread(A), ["Auto-Submitted", "auto-generated"], ["X-Auto-Response-Suppress", "All"], ["Thread-Topic", SA]],
  strippedText: "I am out of the office until 5 October with limited access to email.",
};
const V14: VectorFields = {
  subject: `Undeliverable: ${SA}`,
  fromEmail: "postmaster@firma.onmicrosoft.com",
  fromName: "Microsoft Outlook",
  envelopeSender: "",
  headers: [["Content-Type", 'multipart/report; report-type=delivery-status; boundary="_000_"'], ["Auto-Submitted", "auto-replied"]],
  bodyPlain: `Delivery has failed to these recipients or groups:\n\nanna@firma.de\n\nOriginal message headers:\n\nMessage-ID: <${A}>`,
};

let ownerId: number;

beforeAll(async () => {
  ownerId = (await makeOwner()).id;
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("tests/integration/helpers/replies.ts (M4-DESIGN §7.3)", () => {
  it("replyTo: the person answers a LIVE email whose id Mailgun rewrote, through the signed inbound webhook", async () => {
    const rewritten = `20260923100000.abcdef012345@${mg.domain}`;
    const s = await seedEmail({ createdById: ownerId, providerId: rewritten });
    const posted = await replyTo(mg.fake, s.emailId, { text: "Yes please." });
    expect(posted.status).toBe(200);
    expect(posted.id).not.toBeNull();
    const row = await db.inboundMessage.findUniqueOrThrow({ where: { id: posted.id! } });
    expect(row).toMatchObject({
      source: "NOTIFY",
      fromEmail: s.toNorm,
      toAddress: `arslan@${mg.domain}`,
      subject: "Re: Hello",
      inReplyTo: rewritten,
      references: rewritten,
      processedAt: null,
      kind: null,
    });
    // The same reply again (Mailgun retrying the notification) is stored once.
    expect(await db.inboundMessage.count({ where: { storageKey: posted.storageKey } })).toBe(1);
  });

  it("replyInput threads a dry-run row to its own messageId and keeps the References chain", () => {
    const dry = {
      toEmail: "anna@firma.de",
      fromAddress: "Ali Khan <ali@send.example.com>",
      subject: "Hello",
      messageId: "pp.second@send.example.com",
      providerId: "dry-run:pp.second@send.example.com",
      references: "pp.first@send.example.com",
      mode: "DRY_RUN" as const,
    };
    expect(receivedIdOf(dry)).toBe("pp.second@send.example.com");
    expect(replyInput(dry)).toMatchObject({
      from: "anna@firma.de",
      to: "ali@send.example.com",
      subject: "Re: Hello",
      inReplyTo: "pp.second@send.example.com",
      references: ["pp.first@send.example.com", "pp.second@send.example.com"],
    });
    expect(receivedIdOf({ ...dry, mode: "LIVE", providerId: null })).toBe("pp.second@send.example.com");
    expect(replyInput(dry, { subject: "Other" }).subject).toBe("Other");
  });

  it("postInbound works with the fake's fixed clock, and through the route file itself", async () => {
    const at = new Date("2026-09-23T08:00:00.000Z");
    mg.fake.setNow(() => at);
    try {
      const posted = await postInbound(mg.fake, { from: "late@firma.de", to: `ali@${mg.domain}`, subject: "Re: Hello", text: "Hi" });
      expect(posted.status).toBe(200);
      expect((await db.inboundMessage.findUniqueOrThrow({ where: { id: posted.id! } })).receivedAt).toEqual(at);
    } finally {
      mg.fake.setNow(() => new Date());
    }
    const viaRoute = await postInbound(mg.fake, { from: "route@firma.de", to: `ali@${mg.domain}`, subject: "Re: Hello", text: "Hi" }, { viaRoute: true, multipart: true });
    expect(viaRoute.status).toBe(200);
    expect(viaRoute.id).not.toBeNull();
  });

  it("vectorInput turns research vectors into fake input, swapping the research ids for real ones", async () => {
    const s = await seedEmail({ createdById: ownerId, email: "anna@firma.de" });
    const ids = { [A]: s.messageId };

    const ooo = vectorInput(V03, { ids });
    expect(ooo).toMatchObject({
      from: "anna@firma.de",
      to: "ali@send.example.com",
      subject: `Automatic reply: ${SA}`,
      envelopeSender: "",
      inReplyTo: s.messageId,
      references: [s.messageId],
      strippedText: V03.strippedText,
      text: V03.strippedText,
      bodyPlain: V03.strippedText,
    });
    expect(ooo.headers).toEqual([
      ["Auto-Submitted", "auto-generated"],
      ["X-Auto-Response-Suppress", "All"],
      ["Thread-Topic", SA],
    ]);

    const human = vectorInput(V01, { to: `arslan@${mg.domain}` });
    expect(human).toMatchObject({ from: "Anna Berg <anna@firma.de>", strippedText: null, contentType: 'multipart/alternative; boundary="000000000000abc"', inReplyTo: A.toLowerCase() });
    expect(human.bodyPlain).toContain("Could you send prices for 10 busts?");

    const ndr = vectorInput(V14, { ids, overrides: { at: new Date() } });
    expect(ndr.from).toBe("Microsoft Outlook <postmaster@firma.onmicrosoft.com>");
    expect(ndr.bodyPlain).toContain(`Message-ID: <${s.messageId}>`);
    expect(ndr.contentType).toBe('multipart/report; report-type=delivery-status; boundary="_000_"');
    expect(ndr.inReplyTo).toBeUndefined();

    const posted = await postInbound(mg.fake, ooo);
    expect(posted.status).toBe(200);
    const row = await db.inboundMessage.findUniqueOrThrow({ where: { id: posted.id! } });
    expect(row).toMatchObject({ fromEmail: "anna@firma.de", inReplyTo: s.messageId, subject: `Automatic reply: ${SA}` });
    expect(row.headers).toEqual(expect.arrayContaining([["Auto-Submitted", "auto-generated"]]));
  });
});
