import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { email, enroll, makeCampaign, makeCompany, makePerson, makeUser } from "./world";

/**
 * excludeUnsent (M5-DESIGN §2.7 "Left out", D24): the one door that leaves out, after launch, a recipient who never
 * got an email. A recipient who got one (or may have) is refused: the caller stops it instead.
 */

const t = await createTestDb("stops-exclude");
const { db, dbTx, dbWrite } = await import("@/server/db");
const { excludeUnsent, unsentRecipientIds } = await import("@/server/services/mail-events/stops");

let ownerId: number;

beforeAll(async () => {
  ownerId = (await makeUser("Arslan", { role: "OWNER" })).id;
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

const REASON = "The address check said this address doesn't exist";

async function full(id: number) {
  return db.campaignRecipient.findUniqueOrThrow({
    where: { id },
    select: { state: true, included: true, exclusionReason: true, nextDueAt: true, holdReason: true, heldAt: true, stopReason: true },
  });
}

async function reserved(campaignId: number, companyId: number) {
  return (await db.companyReservation.count({ where: { campaignId, companyId, releasedAt: null } })) > 0;
}

async function scenario() {
  const n = Math.random().toString(36).slice(2, 7);
  const company = await makeCompany(`Firma ${n}`);
  const anna = await makePerson(company.id, `anna.${n}@firma.test`);
  const ben = await makePerson(company.id, `ben.${n}@firma.test`);
  const live = await makeCampaign({ createdById: ownerId, mode: "LIVE" });
  return { company, anna, ben, live };
}

describe("excludeUnsent", () => {
  it("leaves out a never-emailed recipient: EXCLUDED, not included, the reason, its QUEUED email cancelled, the company let go", async () => {
    const w = await scenario();
    const r = await enroll(w.live, w.anna, { first: true });
    await dbWrite((c) => c.campaignRecipient.update({ where: { id: r.recipientId }, data: { nextDueAt: new Date() } }));
    const now = new Date();
    const n = await dbTx((tx) => excludeUnsent(tx, { recipientIds: [r.recipientId, r.recipientId], reason: REASON, now }));
    expect(n).toBe(1);
    expect(await full(r.recipientId)).toEqual({
      state: "EXCLUDED",
      included: false,
      exclusionReason: REASON,
      nextDueAt: null,
      holdReason: null,
      heldAt: null,
      stopReason: null,
    });
    expect(await email(r.queuedId!)).toEqual({ status: "CANCELLED", lastError: REASON });
    expect(await reserved(w.live.id, w.company.id)).toBe(false);
  });

  it("leaves out HELD and RECHECK recipients too, clearing the hold fields; keeps the reservation while someone is open", async () => {
    const w = await scenario();
    const held = await enroll(w.live, w.anna, { first: true, state: "HELD", holdReason: "possible-reply" });
    const recheck = await enroll(w.live, w.ben, { first: true, state: "RECHECK" });
    expect(await dbTx((tx) => excludeUnsent(tx, { recipientIds: [held.recipientId], reason: "Address couldn't be checked", now: new Date() }))).toBe(1);
    expect(await full(held.recipientId)).toMatchObject({ state: "EXCLUDED", holdReason: null, heldAt: null, exclusionReason: "Address couldn't be checked" });
    // Ben is still open (RECHECK), so the campaign keeps the company.
    expect(await reserved(w.live.id, w.company.id)).toBe(true);
    expect(await dbTx((tx) => excludeUnsent(tx, { recipientIds: [recheck.recipientId], reason: "Address couldn't be checked", now: new Date() }))).toBe(1);
    expect(await full(recheck.recipientId)).toMatchObject({ state: "EXCLUDED", included: false });
    expect(await reserved(w.live.id, w.company.id)).toBe(false);
  });

  it("refuses a recipient who already got an email (SENT, or UNKNOWN: it may have gone out), and says so in the log", async () => {
    const w = await scenario();
    const waiting = await enroll(w.live, w.anna);
    const maybe = await enroll(w.live, w.ben, { first: true });
    await dbWrite((c) => c.outboundEmail.update({ where: { id: maybe.queuedId! }, data: { status: "UNKNOWN" } }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const n = await dbTx((tx) => excludeUnsent(tx, { recipientIds: [waiting.recipientId, maybe.recipientId], reason: REASON, now: new Date() }));
      expect(n).toBe(0);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0]![0])).toMatch(/already got an email/);
    } finally {
      warn.mockRestore();
    }
    expect(await full(waiting.recipientId)).toMatchObject({ state: "WAITING", included: true, exclusionReason: null });
    expect((await email(waiting.queuedId!)).status).toBe("QUEUED");
    expect(await unsentRecipientIds(db, [waiting.recipientId, maybe.recipientId])).toEqual([]);
  });

  it("a claimed (SENDING) first email doesn't count as sent; closed recipients are left alone", async () => {
    const w = await scenario();
    const claimed = await enroll(w.live, w.anna, { first: true });
    await dbWrite((c) => c.outboundEmail.update({ where: { id: claimed.queuedId! }, data: { status: "SENDING", claimedAt: new Date() } }));
    const stopped = await enroll(w.live, w.ben, { first: true, state: "STOPPED", stopReason: "bounced", queuedStep: null });
    expect(await dbTx((tx) => unsentRecipientIds(tx, [claimed.recipientId]))).toEqual([claimed.recipientId]);
    const n = await dbTx((tx) => excludeUnsent(tx, { recipientIds: [claimed.recipientId, stopped.recipientId], reason: REASON, now: new Date() }));
    expect(n).toBe(1);
    expect(await full(stopped.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "bounced", exclusionReason: null });
    // The loop owns its claim: the SENDING row stays as it is (its final check sees the recipient left out).
    expect((await email(claimed.queuedId!)).status).toBe("SENDING");
  });

  it("does nothing without ids or a reason", async () => {
    const w = await scenario();
    const r = await enroll(w.live, w.anna, { first: true });
    expect(await dbTx((tx) => excludeUnsent(tx, { recipientIds: [], reason: REASON, now: new Date() }))).toBe(0);
    expect(await dbTx((tx) => excludeUnsent(tx, { recipientIds: [r.recipientId], reason: "  ", now: new Date() }))).toBe(0);
    expect((await full(r.recipientId)).state).toBe("SCHEDULED");
  });
});
