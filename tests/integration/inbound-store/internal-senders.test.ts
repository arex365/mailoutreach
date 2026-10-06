import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeUser } from "../stops-holds/world";

const t = await createTestDb("internal-senders");
const { db, dbTx, dbWrite } = await import("@/server/db");
const { internalSenders } = await import("@/server/services/mail-events/internal-senders");

beforeAll(async () => {
  const ali = await makeUser("Ali", { email: "ali@polygonparadise.com", replyInbox: "ali.khan@gmail.com" });
  await makeUser("Old", { email: "old@polygonparadise.com", replyInbox: null, active: false });
  const domain = await dbWrite((c) => c.sendingDomain.create({ data: { name: "send.polygonparadise.com", region: "EU" } }));
  await dbWrite((c) => c.sendingDomain.create({ data: { name: "old.polygonparadise.com", region: "EU", active: false } }));
  await dbWrite((c) =>
    c.senderAddress.create({ data: { userId: ali.id, domainId: domain.id, localPart: "ali", address: "ali@send.polygonparadise.com" } }),
  );
  await dbWrite((c) =>
    c.senderAddress.create({
      data: { userId: ali.id, domainId: domain.id, localPart: "retired", address: "ali.retired@other-sending.example", retiredAt: new Date() },
    }),
  );
  await dbWrite((c) =>
    c.setting.create({ data: { key: "sending.testList", value: ["Test.Gmail@gmail.com", "someone@outlook.com", 42] as never } }),
  );
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("internalSenders (M4-DESIGN §3.3.0, §3.3.1)", () => {
  it("counts the team's addresses, sender addresses and anything on our sending domains as internal", async () => {
    const s = await internalSenders();
    for (const internal of [
      "ali@polygonparadise.com",
      "Ali Khan <ALI.KHAN@gmail.com>",
      "old@polygonparadise.com",
      "ali@send.polygonparadise.com",
      "ali.retired@other-sending.example",
      "sara@send.polygonparadise.com",
      "anything@old.polygonparadise.com",
    ]) {
      expect(s.isInternal(internal), internal).toBe(true);
    }
    for (const external of ["anna@firma.de", "test.gmail@gmail.com", "x@polygonparadise.com", "ali@send.polygonparadise.com.evil.test", "", "not an address"]) {
      expect(s.isInternal(external), external).toBe(false);
    }
  });

  it("one of our addresses answering the email that went to it is not internal (REPLY-01)", async () => {
    const s = await internalSenders();
    // Ali's reply inbox is also a test-list mailbox that got a campaign email: its answer is a reply.
    expect(s.isInternal("ali.khan@gmail.com", ["ali.khan@gmail.com"])).toBe(false);
    expect(s.isInternal("Ali Khan <ALI.KHAN@gmail.com>", ["Ali.Khan@Gmail.com"])).toBe(false);
    expect(s.isInternal("ali@polygonparadise.com", ["anna@firma.de", "ali@polygonparadise.com"])).toBe(false);
    // Ali forwarding Anna's reply still points at the email to Anna: internal.
    expect(s.isInternal("ali.khan@gmail.com", ["anna@firma.de"])).toBe(true);
    expect(s.isInternal("ali.khan@gmail.com", [])).toBe(true);
    expect(s.isInternal("robot@send.polygonparadise.com", ["anna@firma.de"])).toBe(true);
    // Outsiders stay outsiders.
    expect(s.isInternal("anna@firma.de", ["anna@firma.de"])).toBe(false);
  });

  it("shared-From mode: the From address and every address on its domain are the team's (SHARED-FROM-DESIGN F16)", async () => {
    const put = (key: string, value: unknown) =>
      dbWrite((c) => c.setting.upsert({ where: { key }, create: { key, value: value as never }, update: { value: value as never } }));
    // Per-person mode (no From address): the main domain is an outsider, as before.
    expect((await internalSenders()).isInternal("info@example.com")).toBe(false);
    await put("mailgun.domain", "send.example.com");
    await put("mailgun.fromAddress", "contact@example.com");
    try {
      const s = await internalSenders();
      for (const internal of ["contact@example.com", "Contact <CONTACT@example.com>", "info@example.com", "ali@polygonparadise.com"]) {
        expect(s.isInternal(internal), internal).toBe(true);
      }
      // Only the From domain itself, never a look-alike or another domain.
      for (const external of ["anna@firma.de", "x@example.com.evil.test", "x@notexample.com", "x@polygonparadise.com"]) {
        expect(s.isInternal(external), external).toBe(false);
      }
      // A test-list mailbox on the main domain answering the email it got is a reply, not the team's note.
      expect(s.isInternal("tess@example.com", ["tess@example.com"])).toBe(false);
      expect(s.isInternal("tess@example.com", ["anna@firma.de"])).toBe(true);
      // The same inside a transaction.
      expect((await dbTx((tx) => internalSenders(tx))).isInternal("info@example.com")).toBe(true);

      // A saved From address that doesn't fit the sending domain isn't shared-From mode: nothing extra is internal.
      await put("mailgun.fromAddress", "contact@other.example.org");
      const misfit = await internalSenders();
      expect(misfit.isInternal("contact@other.example.org")).toBe(false);
      expect(misfit.isInternal("info@example.com")).toBe(false);
    } finally {
      await dbWrite((c) => c.setting.deleteMany({ where: { key: { in: ["mailgun.domain", "mailgun.fromAddress"] } } }));
    }
    expect((await internalSenders()).isInternal("contact@example.com")).toBe(false);
  });

  it("a test reply comes from the test's own mailbox, a user or the test list; a prospect answering a forwarded test email doesn't", async () => {
    const s = await dbTx((tx) => internalSenders(tx));
    expect(s.isTestSender("Mailbox@Example.org", "mailbox@example.org")).toBe(true);
    expect(s.isTestSender("ali.khan@gmail.com", null)).toBe(true);
    expect(s.isTestSender("test.gmail@gmail.com", "other@example.org")).toBe(true);
    expect(s.isTestSender("someone@outlook.com", null)).toBe(true);
    expect(s.isTestSender("anna@firma.de", "mailbox@example.org")).toBe(false);
    expect(s.isTestSender("anna@firma.de", null)).toBe(false);
    expect(s.isTestSender("", "")).toBe(false);
  });
});
