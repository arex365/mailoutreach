import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { email, enroll, makeCampaign, makeCompany, makeInbound, makePerson, makeUser, recipient } from "./world";

const t = await createTestDb("holds");
const { db, dbTx, dbWrite } = await import("@/server/db");
const { holdCompany, releaseCompanyHold, undecidedHolds, applyPendingPossibleReplyHolds, holdReasonValuesWith } = await import(
  "@/server/services/sequences/holds"
);
const { stopCompany } = await import("@/server/services/mail-events/stops");

let ownerId: number;
let seq = 0;

beforeAll(async () => {
  ownerId = (await makeUser("Arslan", { role: "OWNER" })).id;
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

/** A company with two people in a LIVE campaign (Anna waiting for follow-up 1, Ben for his first email) and a dry run. */
async function world() {
  seq += 1;
  const company = await makeCompany(`Firma ${seq}`);
  const anna = await makePerson(company.id, `anna${seq}@firma${seq}.test`);
  const ben = await makePerson(company.id, `ben${seq}@firma${seq}.test`);
  const live = await makeCampaign({ createdById: ownerId });
  const dry = await makeCampaign({ createdById: ownerId, mode: "DRY_RUN" });
  return { company, anna, ben, live, dry };
}

describe("holdCompany / releaseCompanyHold (M4-DESIGN §2.8.1, §2.8.2)", () => {
  it("holds SCHEDULED and WAITING recipients in every campaign; their QUEUED emails stay QUEUED; release puts them back", async () => {
    const w = await world();
    const anna = await enroll(w.live, w.anna);
    const ben = await enroll(w.live, w.ben, { first: true });
    const dryAnna = await enroll(w.dry, w.anna);
    const now = new Date();
    const res = await dbTx((tx) => holdCompany(tx, { companyId: w.company.id, reason: "possible-reply", now }));
    expect(res.held).toBe(3);
    expect(res.campaignIds).toEqual([w.live.id, w.dry.id].sort((a, b) => a - b));
    for (const r of [anna, ben, dryAnna]) {
      expect(await recipient(r.recipientId)).toMatchObject({ state: "HELD", holdReason: "possible-reply", heldAt: now });
      expect((await email(r.queuedId!)).status).toBe("QUEUED");
    }
    // Holding again changes nothing (and keeps heldAt).
    expect((await dbTx((tx) => holdCompany(tx, { companyId: w.company.id, reason: "possible-reply", now: new Date(now.getTime() + 60_000) }))).held).toBe(0);
    expect((await recipient(anna.recipientId)).heldAt).toEqual(now);
    // A hold keeps the reservation (the company is still in play).
    expect(await db.companyReservation.count({ where: { campaignId: w.live.id, companyId: w.company.id, releasedAt: null } })).toBe(1);

    const released = await dbTx((tx) => releaseCompanyHold(tx, { companyId: w.company.id, reason: "possible-reply", now }));
    expect(released).toEqual({ released: 3 });
    expect(await recipient(anna.recipientId)).toMatchObject({ state: "WAITING", holdReason: null, heldAt: null });
    expect(await recipient(ben.recipientId)).toMatchObject({ state: "SCHEDULED", holdReason: null, heldAt: null });
    expect(await recipient(dryAnna.recipientId)).toMatchObject({ state: "WAITING" });
  });

  it("campaign scope holds and releases only that campaign", async () => {
    const w = await world();
    const live = await enroll(w.live, w.anna);
    const dry = await enroll(w.dry, w.anna);
    const res = await dbTx((tx) => holdCompany(tx, { companyId: w.company.id, reason: "possible-reply", campaignId: w.dry.id, now: new Date() }));
    expect(res).toEqual({ held: 1, campaignIds: [w.dry.id] });
    expect((await recipient(live.recipientId)).state).toBe("WAITING");
    expect((await recipient(dry.recipientId)).state).toBe("HELD");
    await dbTx((tx) => holdCompany(tx, { companyId: w.company.id, reason: "possible-reply", now: new Date() }));
    await dbTx((tx) => releaseCompanyHold(tx, { companyId: w.company.id, reason: "possible-reply", campaignId: w.dry.id, now: new Date() }));
    expect((await recipient(dry.recipientId)).state).toBe("WAITING");
    expect((await recipient(live.recipientId)).state).toBe("HELD");
  });

  it("two reasons: a held-for-outage recipient gains possible-reply; releasing one keeps the other; a stop clears both", async () => {
    const w = await world();
    const heldAt = new Date(Date.now() - 3_600_000);
    const anna = await enroll(w.live, w.anna, { state: "HELD", holdReason: "outage", heldAt });
    await dbTx((tx) => holdCompany(tx, { companyId: w.company.id, reason: "possible-reply", now: new Date() }));
    expect(await recipient(anna.recipientId)).toMatchObject({ state: "HELD", holdReason: "outage,possible-reply", heldAt });
    await dbTx((tx) => releaseCompanyHold(tx, { companyId: w.company.id, reason: "possible-reply", now: new Date() }));
    expect(await recipient(anna.recipientId)).toMatchObject({ state: "HELD", holdReason: "outage", heldAt });

    await dbTx((tx) => holdCompany(tx, { companyId: w.company.id, reason: "possible-reply", now: new Date() }));
    const reply = await makeInbound({ kind: "REPLY", companyId: w.company.id });
    await dbTx((tx) =>
      stopCompany(tx, { companyId: w.company.id, replierPersonIds: [w.anna.id], replierEmails: [], inboundId: reply.id, now: new Date() }),
    );
    expect(await recipient(anna.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "replied", holdReason: null, heldAt: null });
  });

  it("a release frees nobody while another undecided message (real scope) of the company remains, and only other campaigns for a campaign-scope one", async () => {
    const w = await world();
    const live = await enroll(w.live, w.anna);
    const dry = await enroll(w.dry, w.anna);
    const decided = await makeInbound({ kind: "POSSIBLE_REPLY", companyId: w.company.id });
    const other = await makeInbound({ kind: "POSSIBLE_REPLY", companyId: w.company.id });
    await dbTx((tx) => holdCompany(tx, { companyId: w.company.id, reason: "possible-reply", now: new Date() }));

    // "It was an auto-reply" on the first: the decided row is updated first, then the release.
    await dbWrite((c) => c.inboundMessage.update({ where: { id: decided.id }, data: { kind: "AUTO_REPLY", confirmedAt: new Date() } }));
    expect(await dbTx((tx) => releaseCompanyHold(tx, { companyId: w.company.id, reason: "possible-reply", now: new Date() }))).toEqual({ released: 0 });
    expect((await recipient(live.recipientId)).state).toBe("HELD");

    // The other one turns out to be a dry-run message (campaign scope): only its campaign stays held.
    await dbWrite((c) => c.inboundMessage.update({ where: { id: other.id }, data: { replyScope: "campaign", campaignId: w.dry.id } }));
    expect(await dbTx((tx) => releaseCompanyHold(tx, { companyId: w.company.id, reason: "possible-reply", now: new Date() }))).toEqual({ released: 1 });
    expect((await recipient(live.recipientId)).state).toBe("WAITING");
    expect((await recipient(dry.recipientId)).state).toBe("HELD");
  });

  it("twins (answerOutcome duplicate) and spam never keep a hold", async () => {
    const w = await world();
    const anna = await enroll(w.live, w.anna);
    const first = await makeInbound({ kind: "POSSIBLE_REPLY", companyId: w.company.id });
    await makeInbound({ kind: "POSSIBLE_REPLY", companyId: w.company.id, answeredAt: new Date(), answerOutcome: "duplicate" });
    await makeInbound({ kind: "UNLINKED", heldCompanyId: w.company.id, answeredAt: new Date(), answerOutcome: "spam" });
    await dbTx((tx) => holdCompany(tx, { companyId: w.company.id, reason: "possible-reply", now: new Date() }));
    await dbWrite((c) => c.inboundMessage.update({ where: { id: first.id }, data: { kind: "REPLY", confirmedAt: new Date() } }));
    expect(await dbTx((tx) => releaseCompanyHold(tx, { companyId: w.company.id, reason: "possible-reply", now: new Date() }))).toEqual({ released: 1 });
    expect((await recipient(anna.recipientId)).state).toBe("WAITING");
  });
});

describe("undecidedHolds (M4-DESIGN §2.8.2)", () => {
  it("lists possible replies by their stored scope and domain-held unlinked messages until answered; nothing else", async () => {
    const w1 = await world();
    const w2 = await world();
    const w3 = await world();
    const w4 = await world();
    await makeInbound({ kind: "POSSIBLE_REPLY", companyId: w1.company.id });
    await makeInbound({ kind: "POSSIBLE_REPLY", companyId: w1.company.id });
    await makeInbound({ kind: "POSSIBLE_REPLY", companyId: w2.company.id, campaignId: w2.dry.id, replyScope: "campaign" });
    await makeInbound({ kind: "UNLINKED", heldCompanyId: w3.company.id });
    // Not undecided: answered unlinked, unprocessed, a real reply, an unlinked message without a domain hold.
    await makeInbound({ kind: "UNLINKED", heldCompanyId: w4.company.id, answeredAt: new Date(), answerOutcome: "not-needed" });
    await makeInbound({ kind: null, companyId: w4.company.id, processed: false });
    await makeInbound({ kind: "REPLY", companyId: w4.company.id });
    await makeInbound({ kind: "UNLINKED" });

    const holds = await undecidedHolds(db, [w1.company.id, w2.company.id, w3.company.id, w4.company.id, w1.company.id]);
    expect(holds.sort((a, b) => a.companyId - b.companyId)).toEqual([
      { companyId: w1.company.id, campaignId: null },
      { companyId: w2.company.id, campaignId: w2.dry.id },
      { companyId: w3.company.id, campaignId: null },
    ]);
    expect(await undecidedHolds(db, [])).toEqual([]);
    expect(holdReasonValuesWith("outage")).toEqual(["outage", "outage,possible-reply"]);
    expect(holdReasonValuesWith("possible-reply").sort()).toEqual(["outage,possible-reply", "possible-reply"]);
  });
});

describe("applyPendingPossibleReplyHolds (M4-DESIGN §2.8.2)", () => {
  it("holds a recipient created after the message was processed (a new campaign), in scope only", async () => {
    const w = await world();
    const unrelated = await world();
    await makeInbound({ kind: "POSSIBLE_REPLY", companyId: w.company.id });
    await makeInbound({ kind: "UNLINKED", heldCompanyId: w.company.id });
    // Launched afterwards: nobody held yet.
    const later = await makeCampaign({ createdById: ownerId });
    const ben = await enroll(later, w.ben, { first: true });
    const anna = await enroll(later, w.anna);
    const other = await enroll(unrelated.live, unrelated.anna);

    const res = await applyPendingPossibleReplyHolds({ companyIds: [w.company.id, unrelated.company.id], campaignId: later.id, now: new Date() });
    expect(res).toEqual({ held: 2 });
    expect(await recipient(ben.recipientId)).toMatchObject({ state: "HELD", holdReason: "possible-reply" });
    expect((await recipient(anna.recipientId)).state).toBe("HELD");
    expect((await recipient(other.recipientId)).state).toBe("WAITING");
    // Again: nothing more to do.
    expect(await applyPendingPossibleReplyHolds({ companyIds: [w.company.id], now: new Date() })).toEqual({ held: 0 });
  });

  it("inside a transaction (launch, Retry), and for everything at once (the 5-minute maintenance), respecting campaign scope", async () => {
    const w = await world();
    const x = await world();
    await makeInbound({ kind: "POSSIBLE_REPLY", companyId: w.company.id, campaignId: w.dry.id, replyScope: "campaign" });
    await makeInbound({ kind: "POSSIBLE_REPLY", companyId: x.company.id });
    const wLive = await enroll(w.live, w.anna);
    const wDry = await enroll(w.dry, w.anna);
    const xLive = await enroll(x.live, x.anna);

    const inTx = await dbTx((tx) => applyPendingPossibleReplyHolds({ companyIds: [w.company.id], now: new Date(), tx }));
    expect(inTx).toEqual({ held: 1 });
    expect((await recipient(wDry.recipientId)).state).toBe("HELD");
    expect((await recipient(wLive.recipientId)).state).toBe("WAITING");

    const all = await applyPendingPossibleReplyHolds({ now: new Date() });
    expect(all.held).toBeGreaterThanOrEqual(1);
    expect((await recipient(xLive.recipientId)).state).toBe("HELD");
    expect((await recipient(wLive.recipientId)).state).toBe("WAITING");
  });

  it("holds nothing for a message that was decided", async () => {
    const w = await world();
    const m = await makeInbound({ kind: "POSSIBLE_REPLY", companyId: w.company.id });
    const anna = await enroll(w.live, w.anna);
    await dbWrite((c) => c.inboundMessage.update({ where: { id: m.id }, data: { kind: "AUTO_REPLY" } }));
    expect(await applyPendingPossibleReplyHolds({ companyIds: [w.company.id], now: new Date() })).toEqual({ held: 0 });
    expect((await recipient(anna.recipientId)).state).toBe("WAITING");
  });
});
