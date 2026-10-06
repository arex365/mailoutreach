import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { email, enroll, makeCampaign, makeCompany, makeInbound, makePerson, makeUser, recipient } from "../stops-holds/world";

const t = await createTestDb("stops-recipients");
const { db, dbTx } = await import("@/server/db");
const { stopRecipients, stopRank, canReplace, STOP_SKIP_TEXT, statusStopCode } = await import("@/server/services/mail-events/stops");

let ownerId: number;

beforeAll(async () => {
  ownerId = (await makeUser("Arslan", { role: "OWNER" })).id;
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("stop ranks and texts (M4-DESIGN §2.6, D16)", () => {
  it("ranks suppressed < invalid < company_replied < replied < bounced < unsubscribed < complained; anything else never ranks", () => {
    const order = ["suppressed", "invalid", "company_replied", "replied", "bounced", "unsubscribed", "complained"];
    expect(order.map(stopRank)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (const other of ["failed", "status:CLIENT", "campaign_cancelled", "Skipped by Ali", "", null, undefined]) {
      expect(stopRank(other)).toBe(-1);
    }
  });

  it("a stronger code replaces a weaker one; `failed` gives way to reply stops only; status codes never", () => {
    expect(canReplace("company_replied", "replied")).toBe(true);
    expect(canReplace("replied", "company_replied")).toBe(false);
    expect(canReplace("replied", "bounced")).toBe(true);
    expect(canReplace("bounced", "replied")).toBe(false);
    expect(canReplace("suppressed", "company_replied")).toBe(true);
    expect(canReplace("failed", "replied")).toBe(true);
    expect(canReplace("failed", "company_replied")).toBe(true);
    expect(canReplace("failed", "bounced")).toBe(false);
    expect(canReplace("status:CLIENT", "complained")).toBe(false);
    expect(canReplace("campaign_cancelled", "replied")).toBe(false);
    expect(statusStopCode("NOT_INTERESTED")).toBe("status:NOT_INTERESTED");
  });

  it("has a skip text for every code", () => {
    expect(STOP_SKIP_TEXT).toEqual({
      bounced: "Stopped: this address bounced",
      unsubscribed: "Stopped: this address unsubscribed",
      complained: "Stopped: this address marked an email as spam",
      suppressed: "Stopped: this address is on the do-not-email list",
      invalid: "Stopped: the address check said not to email this address",
      replied: "Stopped: they replied",
      company_replied: "Stopped: someone at the company replied",
    });
  });
});

describe("stopRecipients (by address)", () => {
  it("stops every open recipient with the address, clears holds, writes the stopping message and releases reservations", async () => {
    const c = await makeCompany("Studio");
    const anna = await makePerson(c.id, "anna@studio.test");
    const live = await makeCampaign({ createdById: ownerId });
    const dry = await makeCampaign({ createdById: ownerId, mode: "DRY_RUN" });
    const held = await enroll(live, anna, { state: "HELD", holdReason: "possible-reply" });
    const waiting = await enroll(dry, anna);
    const notice = await makeInbound({ kind: "BOUNCE_NOTICE", companyId: c.id });
    const stopped = await dbTx((tx) =>
      stopRecipients(tx, { emailNorm: " Anna@Studio.test ", reason: "bounced", scope: "real", inboundId: notice.id, now: new Date() }),
    );
    expect(stopped).toBe(2);
    for (const r of [held, waiting]) {
      expect(await recipient(r.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "bounced", holdReason: null, heldAt: null, stoppedByInboundId: notice.id });
      expect(await email(r.queuedId!)).toEqual({ status: "SKIPPED", lastError: "Stopped: this address bounced" });
    }
    expect(await db.companyReservation.count({ where: { companyId: c.id, releasedAt: null } })).toBe(0);
  });

  it("upgrades a reply stop to a bounce (and its skipped emails' text), never the other way round", async () => {
    const c = await makeCompany("Studio 2");
    const ben = await makePerson(c.id, "ben@studio2.test");
    const live = await makeCampaign({ createdById: ownerId });
    const r = await enroll(live, ben);
    const reply = await makeInbound({ kind: "REPLY", companyId: c.id });
    await dbTx((tx) => stopRecipients(tx, { emailNorm: "ben@studio2.test", reason: "replied", scope: "real", inboundId: reply.id, now: new Date() }));
    expect(await recipient(r.recipientId)).toMatchObject({ stopReason: "replied", stoppedByInboundId: reply.id });
    expect(await email(r.queuedId!)).toEqual({ status: "SKIPPED", lastError: "Stopped: they replied" });

    const later = await dbTx((tx) => stopRecipients(tx, { emailNorm: "ben@studio2.test", reason: "bounced", scope: "real", now: new Date() }));
    expect(later).toBe(0);
    expect(await recipient(r.recipientId)).toMatchObject({ stopReason: "bounced", stoppedByInboundId: null });
    expect(await email(r.queuedId!)).toEqual({ status: "SKIPPED", lastError: "Stopped: this address bounced" });

    await dbTx((tx) => stopRecipients(tx, { emailNorm: "ben@studio2.test", reason: "company_replied", scope: "real", inboundId: reply.id, now: new Date() }));
    expect((await recipient(r.recipientId)).stopReason).toBe("bounced");
  });

  it("a reply stop overwrites `failed`; a bounce doesn't", async () => {
    const c = await makeCompany("Studio 3");
    const live = await makeCampaign({ createdById: ownerId });
    const cara = await enroll(live, await makePerson(c.id, "cara@studio3.test"), { state: "STOPPED", stopReason: "failed", queuedStep: null });
    const dan = await enroll(live, await makePerson(c.id, "dan@studio3.test"), { state: "STOPPED", stopReason: "failed", queuedStep: null });
    await dbTx((tx) => stopRecipients(tx, { emailNorm: "cara@studio3.test", reason: "replied", scope: "real", now: new Date() }));
    await dbTx((tx) => stopRecipients(tx, { emailNorm: "dan@studio3.test", reason: "bounced", scope: "real", now: new Date() }));
    expect((await recipient(cara.recipientId)).stopReason).toBe("replied");
    expect((await recipient(dan.recipientId)).stopReason).toBe("failed");
  });

  it("campaign scope stops only the one recipient", async () => {
    const c = await makeCompany("Studio 4");
    const eve = await makePerson(c.id, "eve@studio4.test");
    const one = await enroll(await makeCampaign({ createdById: ownerId, mode: "DRY_RUN" }), eve);
    const two = await enroll(await makeCampaign({ createdById: ownerId }), eve);
    const n = await dbTx((tx) =>
      stopRecipients(tx, { emailNorm: "eve@studio4.test", reason: "bounced", scope: "campaign", recipientId: one.recipientId, now: new Date() }),
    );
    expect(n).toBe(1);
    expect((await recipient(one.recipientId)).state).toBe("STOPPED");
    expect((await recipient(two.recipientId)).state).toBe("WAITING");
    // Campaign scope without a recipient stops nothing.
    expect(await dbTx((tx) => stopRecipients(tx, { emailNorm: "eve@studio4.test", reason: "bounced", scope: "campaign", now: new Date() }))).toBe(0);
  });
});
