import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { enroll, makeCampaign, makeCompany, makePerson, makeUser, readOutage, recipient, setOutage } from "./world";

const t = await createTestDb("outage-hold");
const { db, dbWrite } = await import("@/server/db");
const holds = await import("@/server/services/sequences/holds");
const { applyOutageHold, releaseOutageHold, outageHoldSummary, myOutageHold, outageHoldCopy, releaseOrphanedOutageHolds } = holds;
const { CampaignError } = await import("@/server/services/campaigns/errors");
const { Prisma } = await import("@/generated/prisma/client");

/** The unchecked window: in New York it starts on 2 Oct and ends on 8 Oct, in Berlin and Karachi 3 Oct to 9 Oct. */
const FROM = "2026-10-03T03:00:00.000Z";
const TO = "2026-10-09T02:30:00.000Z";
const NOW = new Date("2026-10-09T12:00:00.000Z");
const BEFORE = new Date("2026-10-02T09:00:00.000Z");
const AFTER = new Date("2026-10-09T05:00:00.000Z");

let owner: { id: number; name: string; role: "OWNER" | "MEMBER" };
let ali: { id: number; name: string; role: "OWNER" | "MEMBER" };
let sara: { id: number; name: string; role: "OWNER" | "MEMBER" };
let zed: { id: number };
let seq = 0;

beforeAll(async () => {
  const o = await makeUser("Arslan", { role: "OWNER", timeZone: "Asia/Karachi" });
  const a = await makeUser("Ali", { timeZone: "Europe/Berlin" });
  const s = await makeUser("Sara", { timeZone: "America/New_York" });
  owner = { id: o.id, name: o.name, role: "OWNER" };
  ali = { id: a.id, name: a.name, role: "MEMBER" };
  sara = { id: s.id, name: s.name, role: "MEMBER" };
  zed = await makeUser("Zed", { active: false });
});

beforeEach(async () => {
  await dbWrite(async (c) => {
    await c.notification.deleteMany({});
    await c.activityLog.deleteMany({});
    await c.outboundEmail.deleteMany({});
    await c.companyReservation.deleteMany({});
    await c.campaignRecipient.deleteMany({});
    await c.campaignStep.deleteMany({});
    await c.campaign.deleteMany({});
    await c.systemState.deleteMany({ where: { key: "catchup.outage" } });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

async function person(companyId: number, name: string) {
  seq += 1;
  return makePerson(companyId, `${name.toLowerCase()}${seq}@c${companyId}.test`, name);
}

const gap = { detectedAt: NOW.toISOString(), from: FROM, to: TO, beyondLogRetention: true, beyondMessageRetention: false, handledAt: null };

async function notifications(userId: number) {
  return db.notification.findMany({ where: { userId, type: "outage.hold" } });
}

describe("applyOutageHold (M4-DESIGN §2.8.3)", () => {
  it("holds follow-ups sent before the end of the window and everyone open at those companies, then notifies each sender in their zone and the Owner", async () => {
    const aliLive = await makeCampaign({ createdById: ali.id, senderId: ali.id, mode: "LIVE" });
    const aliDry = await makeCampaign({ createdById: ali.id, senderId: ali.id, mode: "DRY_RUN" });
    const saraLive = await makeCampaign({ createdById: sara.id, senderId: sara.id, mode: "LIVE" });
    const saraTest = await makeCampaign({ createdById: sara.id, senderId: sara.id, mode: "TEST", status: "PAUSED" });
    const zedLive = await makeCampaign({ createdById: owner.id, senderId: zed.id, mode: "LIVE" });
    const nobody = await makeCampaign({ createdById: owner.id, senderId: null, mode: "LIVE" });
    const finished = await makeCampaign({ createdById: ali.id, senderId: ali.id, mode: "LIVE", status: "FINISHED" });

    const a = await makeCompany("A");
    const b = await makeCompany("B");
    const c = await makeCompany("C");
    const d = await makeCompany("D (unaffected)");
    const e = await makeCompany("E");
    const g = await makeCompany("G");
    const anna = await enroll(aliLive, await person(a.id, "Anna"), { sent: [{ step: 0, sentAt: BEFORE }] });
    const benPerson = await person(a.id, "Ben");
    const ben = await enroll(saraLive, benPerson, { first: true });
    const benDry = await enroll(aliDry, benPerson, { sent: [{ step: 0, sentAt: BEFORE }] });
    const bo = await enroll(aliLive, await person(b.id, "Bo"), { state: "HELD", holdReason: "possible-reply", heldAt: BEFORE, sent: [{ step: 0, sentAt: BEFORE }] });
    const cy = await enroll(saraTest, await person(c.id, "Cy"), { sent: [{ step: 0, sentAt: BEFORE }] });
    const dee = await enroll(aliLive, await person(d.id, "Dee"), { sent: [{ step: 0, sentAt: BEFORE }, { step: 1, sentAt: AFTER }], queuedStep: 2, currentStep: 2 });
    const deeColleague = await enroll(saraLive, await person(d.id, "Dan"), { first: true });
    const eve = await enroll(zedLive, await person(e.id, "Eve"), { sent: [{ step: 0, sentAt: BEFORE }] });
    const gil = await enroll(nobody, await person(g.id, "Gil"), { sent: [{ step: 0, sentAt: BEFORE }] });
    const done = await enroll(finished, await person(g.id, "Gus"), { sent: [{ step: 0, sentAt: BEFORE }] });
    await setOutage(gap);

    // Two calls at once: one run, one set of notifications (single-flight).
    const [r1, r2] = await Promise.all([applyOutageHold({ now: NOW }), applyOutageHold({ now: NOW })]);
    expect(r1).toEqual(r2);
    expect(r1).toMatchObject({ applied: true, held: 6 });
    expect([...r1.senderIds].sort((x, y) => x - y)).toEqual([ali.id, sara.id, zed.id].sort((x, y) => x - y));

    for (const r of [anna, ben, cy, eve, gil]) expect(await recipient(r.recipientId)).toMatchObject({ state: "HELD", holdReason: "outage", heldAt: NOW });
    expect(await recipient(bo.recipientId)).toMatchObject({ state: "HELD", holdReason: "outage,possible-reply", heldAt: BEFORE });
    for (const r of [benDry, dee, deeColleague, done]) expect((await recipient(r.recipientId)).holdReason).toBeNull();
    expect((await recipient(dee.recipientId)).state).toBe("WAITING");
    expect((await recipient(deeColleague.recipientId)).state).toBe("SCHEDULED");
    // The QUEUED emails stay QUEUED (the candidate query skips held recipients).
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: anna.queuedId! } })).status).toBe("QUEUED");

    expect(await readOutage()).toMatchObject({ handledAt: NOW.toISOString(), heldFor: FROM, heldTo: TO, heldCount: 6, from: FROM, to: TO });

    const [aliNote] = await notifications(ali.id);
    expect(await notifications(ali.id)).toHaveLength(1);
    expect(aliNote).toMatchObject({
      title: "Follow-ups are on hold: replies from 3 Oct to 9 Oct may have been missed",
      body:
        "The PC was off too long for the app to see every reply. Check your inbox for replies to your campaigns from those days, " +
        "then click I've checked my inbox. Follow-ups of 2 people are waiting.",
      link: "/notifications#on-hold",
    });
    const saraNotes = await notifications(sara.id);
    expect(saraNotes).toHaveLength(1);
    expect(saraNotes[0]).toMatchObject({
      title: "Follow-ups are on hold: replies from 2 Oct to 8 Oct may have been missed",
      body:
        "The PC was off too long for the app to see every reply. Check your inbox for replies to your campaigns from those days, " +
        "then click I've checked my inbox. Follow-ups of 1 person are waiting. First emails to 1 other person at those companies wait too.",
    });
    expect(await notifications(zed.id)).toHaveLength(0);
    const ownerNotes = await notifications(owner.id);
    expect(ownerNotes).toHaveLength(1);
    expect(ownerNotes[0]).toMatchObject({
      title: "Follow-ups are on hold: replies from 3 Oct to 9 Oct may have been missed",
      body:
        "Follow-ups of 5 people wait until their senders have checked their inbox (Ali 2, Sara 1, Unknown sender 1, Zed 1). " +
        "You can continue them for anyone in Settings › Sending & Mailgun.",
      link: "/settings/sending",
    });
    const activity = await db.activityLog.findMany({ where: { type: "followups.held" } });
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      actorId: null,
      summary:
        "Follow-ups of 5 people were put on hold because the PC was off too long to check for replies. First emails to 1 other person at those companies wait too.",
      data: { from: FROM, to: TO, count: 6, followUps: 5, firstEmails: 1 },
    });

    // Handled: a later call does nothing.
    expect(await applyOutageHold({ now: NOW })).toEqual({ applied: false, held: 0, senderIds: [] });
    expect(await db.notification.count({ where: { type: "outage.hold" } })).toBe(3);
  });

  it("marks the outage handled without holding or notifying anyone when nobody needs it", async () => {
    const dry = await makeCampaign({ createdById: ali.id, senderId: ali.id, mode: "DRY_RUN" });
    const live = await makeCampaign({ createdById: ali.id, senderId: ali.id, mode: "LIVE" });
    const x = await makeCompany("X");
    const dryOne = await enroll(dry, await person(x.id, "Xena"), { sent: [{ step: 0, sentAt: BEFORE }] });
    const late = await enroll(live, await person(x.id, "Xavi"), { sent: [{ step: 0, sentAt: AFTER }] });
    await setOutage(gap);
    expect(await applyOutageHold({ now: NOW })).toEqual({ applied: true, held: 0, senderIds: [] });
    expect(await readOutage()).toMatchObject({ handledAt: NOW.toISOString(), heldFor: FROM, heldTo: TO, heldCount: 0 });
    expect((await recipient(dryOne.recipientId)).state).toBe("WAITING");
    expect((await recipient(late.recipientId)).state).toBe("WAITING");
    expect(await db.notification.count()).toBe(0);
    expect(await db.activityLog.count({ where: { type: "followups.held" } })).toBe(0);
  });

  it("with only message retention passed (no log gap): marked handled, nobody held; nothing found: nothing at all", async () => {
    const live = await makeCampaign({ createdById: ali.id, senderId: ali.id });
    const r = await enroll(live, await person((await makeCompany("Y")).id, "Yan"), { sent: [{ step: 0, sentAt: BEFORE }] });
    expect(await applyOutageHold({ now: NOW })).toEqual({ applied: false, held: 0, senderIds: [] });
    await setOutage({ detectedAt: NOW.toISOString(), from: null, to: null, beyondLogRetention: false, beyondMessageRetention: true, handledAt: null });
    expect(await applyOutageHold({ now: NOW })).toEqual({ applied: true, held: 0, senderIds: [] });
    expect(await readOutage()).toMatchObject({ handledAt: NOW.toISOString(), from: null, heldFor: null, heldCount: 0 });
    expect((await recipient(r.recipientId)).state).toBe("WAITING");
    expect(await applyOutageHold({ now: NOW })).toEqual({ applied: false, held: 0, senderIds: [] });
  });

  it("a gap inside the window already held is marked handled and never re-holds anyone a sender released", async () => {
    const live = await makeCampaign({ createdById: ali.id, senderId: ali.id });
    const r = await enroll(live, await person((await makeCompany("Z")).id, "Zoe"), { sent: [{ step: 0, sentAt: BEFORE }] });
    await setOutage({ ...gap, from: "2026-10-04T00:00:00.000Z", heldFor: FROM, heldTo: TO, heldCount: 4 });
    expect(await applyOutageHold({ now: NOW })).toEqual({ applied: true, held: 0, senderIds: [] });
    expect((await recipient(r.recipientId)).state).toBe("WAITING");
    expect(await readOutage()).toMatchObject({ handledAt: NOW.toISOString(), heldFor: FROM, heldTo: TO, heldCount: 4 });
  });

  it("stops between chunks of 500 when the outage was handled meanwhile", async () => {
    const live = await makeCampaign({ createdById: ali.id, senderId: ali.id });
    const other = await makeCampaign({ createdById: sara.id, senderId: sara.id });
    const h = await makeCompany("Big");
    await enroll(live, await person(h.id, "Hal"), { sent: [{ step: 0, sentAt: BEFORE }] });
    await dbWrite((c) =>
      c.person.createMany({ data: Array.from({ length: 500 }, (_, i) => ({ companyId: h.id, name: `P${i}`, email: `p${i}@big.test`, emailNorm: `p${i}@big.test` })) }),
    );
    const people = await db.person.findMany({ where: { companyId: h.id, emailNorm: { endsWith: "@big.test" } }, select: { id: true, emailNorm: true } });
    await dbWrite((c) =>
      c.campaignRecipient.createMany({
        data: people.map((p) => ({ campaignId: other.id, companyId: h.id, personId: p.id, emailNorm: p.emailNorm!, state: "SCHEDULED" as const })),
      }),
    );
    await setOutage(gap);

    const original = db.$transaction.bind(db) as (fn: unknown, opts?: unknown) => Promise<unknown>;
    let calls = 0;
    vi.spyOn(db, "$transaction").mockImplementation((async (fn: unknown, opts?: unknown) => {
      const result = await original(fn, opts);
      calls += 1;
      // Someone marked the outage handled right after the first chunk.
      if (calls === 1) {
        await db.systemState.update({
          where: { key: "catchup.outage" },
          data: { value: { ...gap, handledAt: NOW.toISOString() }, version: { increment: 1 } },
        });
      }
      return result;
    }) as never);
    const res = await applyOutageHold({ now: NOW });
    vi.restoreAllMocks();
    expect(res).toEqual({ applied: false, held: 0, senderIds: [] });
    expect(await db.campaignRecipient.count({ where: { companyId: h.id, state: "HELD" } })).toBe(500);
    expect(await db.campaignRecipient.count({ where: { companyId: h.id } })).toBe(501);
    expect(await readOutage()).toMatchObject({ handledAt: NOW.toISOString(), heldCount: 0 });
    expect(await db.notification.count()).toBe(0);
  });
});

describe("releaseOutageHold and the summaries (M4-DESIGN §2.8.3 release, §9.1, §9.9)", () => {
  /** A held outage: company A (Ali's Anna, Sara's Ben emailed; colleagues Cleo in Ali's and Dan in Sara's campaign), B, C, D. */
  async function heldWorld() {
    const aliLive = await makeCampaign({ createdById: ali.id, senderId: ali.id });
    const saraLive = await makeCampaign({ createdById: sara.id, senderId: sara.id });
    const nobody = await makeCampaign({ createdById: owner.id, senderId: null });
    const a = await makeCompany("A");
    const b = await makeCompany("B");
    const c = await makeCompany("C");
    const d = await makeCompany("D");
    const held = { state: "HELD" as const, holdReason: "outage", sent: [{ step: 0, sentAt: BEFORE }] };
    const firstHeld = { first: true, state: "HELD" as const, holdReason: "outage" };
    const w = {
      anna: await enroll(aliLive, await person(a.id, "Anna"), held),
      ben: await enroll(saraLive, await person(a.id, "Ben"), held),
      cleo: await enroll(aliLive, await person(a.id, "Cleo"), firstHeld),
      dan: await enroll(saraLive, await person(a.id, "Dan"), firstHeld),
      bo: await enroll(aliLive, await person(b.id, "Bo"), { ...held, holdReason: "outage,possible-reply" }),
      cy: await enroll(nobody, await person(c.id, "Cy"), held),
      dee: await enroll(saraLive, await person(d.id, "Dee"), firstHeld),
    };
    await setOutage({ ...gap, handledAt: NOW.toISOString(), heldFor: FROM, heldTo: TO, heldCount: 7 });
    return w;
  }

  it("summarises who is held, per sender, and each sender's own card", async () => {
    await heldWorld();
    const summary = await outageHoldSummary();
    expect(summary).toMatchObject({ detected: true, applied: true, from: FROM, to: TO, total: 7, textOnly: false });
    expect(summary.bySender).toEqual([
      { userId: ali.id, name: "Ali", active: true, held: 2, firstEmailsWaiting: 1 },
      { userId: sara.id, name: "Sara", active: true, held: 1, firstEmailsWaiting: 2 },
      { userId: null, name: "Unknown sender", active: false, held: 1, firstEmailsWaiting: 0 },
    ]);
    expect(await myOutageHold(ali.id)).toEqual({ held: 2, firstEmailsWaiting: 1, from: FROM, to: TO });
    expect(await myOutageHold(owner.id)).toEqual({ held: 0, firstEmailsWaiting: 0, from: FROM, to: TO });

    await setOutage({ detectedAt: NOW.toISOString(), from: null, to: null, beyondLogRetention: false, beyondMessageRetention: true, handledAt: NOW.toISOString() });
    expect(await outageHoldSummary()).toMatchObject({ detected: true, applied: true, from: null, to: null, textOnly: true });
    await setOutage(null);
    expect(await outageHoldSummary()).toMatchObject({ detected: false, applied: false, from: null, to: null, textOnly: false });
    expect(await myOutageHold(ali.id)).toMatchObject({ from: null, to: null });
  });

  it("a sender continues their own follow-ups; colleagues wait until every sender who emailed their company has checked", async () => {
    const w = await heldWorld();
    const denied = await releaseOutageHold(sara, { senderId: ali.id }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(denied).toBeInstanceOf(CampaignError);
    expect(denied).toMatchObject({ message: "Only Ali or the Owner can continue Ali's follow-ups.", code: "not-allowed" });
    await expect(releaseOutageHold(sara, { senderId: null })).rejects.toThrow("Only the Owner can continue these follow-ups.");

    const mine = await releaseOutageHold(ali, { senderId: ali.id, now: NOW });
    // Anna and Bo continue (Bo still waits for his possible reply); D had nobody emailed left, so Dee goes too.
    expect(mine).toEqual({ released: 2, firstEmails: 1 });
    expect(await recipient(w.anna.recipientId)).toMatchObject({ state: "WAITING", holdReason: null, heldAt: null });
    expect(await recipient(w.bo.recipientId)).toMatchObject({ state: "HELD", holdReason: "possible-reply" });
    expect(await recipient(w.dee.recipientId)).toMatchObject({ state: "SCHEDULED", holdReason: null });
    // Sara's Ben is still held at A, so A's colleagues (in Ali's and Sara's campaigns) wait.
    for (const r of [w.ben, w.cleo, w.dan]) expect((await recipient(r.recipientId)).state).toBe("HELD");
    await expect(releaseOutageHold(ali, { senderId: ali.id })).rejects.toThrow("Nothing of yours is on hold.");

    const forSara = await releaseOutageHold(owner, { senderId: sara.id });
    expect(forSara).toEqual({ released: 1, firstEmails: 2 });
    expect((await recipient(w.ben.recipientId)).state).toBe("WAITING");
    for (const r of [w.cleo, w.dan]) expect(await recipient(r.recipientId)).toMatchObject({ state: "SCHEDULED", holdReason: null });

    expect(await releaseOutageHold(owner, { senderId: null })).toEqual({ released: 1, firstEmails: 0 });
    expect((await recipient(w.cy.recipientId)).state).toBe("WAITING");
    await expect(releaseOutageHold(owner, { senderId: ali.id })).rejects.toThrow("Nothing is on hold for Ali.");
    await expect(releaseOutageHold(owner, { senderId: null })).rejects.toThrow("Nothing is on hold for campaigns whose sender account is gone.");

    const activity = await db.activityLog.findMany({ where: { type: "followups.released" }, orderBy: { id: "asc" } });
    expect(activity.map((x) => x.summary)).toEqual([
      "Ali checked their inbox: follow-ups of 2 people continue, and first emails to 1 other person",
      "Arslan continued Sara's follow-ups after the PC was off (1 person); first emails to 2 other people continue too",
      "Arslan continued the follow-ups of campaigns whose sender account is gone after the PC was off (1 person)",
    ]);
    expect(activity.map((x) => x.actorId)).toEqual([ali.id, owner.id, owner.id]);
    expect(activity[1]!.data).toEqual({ count: 1, senderId: sara.id, firstEmails: 2, from: FROM, to: TO });
    // Bo is still held, but only for his possible reply.
    expect(await outageHoldSummary()).toMatchObject({ total: 0, bySender: [] });
    expect(await recipient(w.bo.recipientId)).toMatchObject({ state: "HELD", holdReason: "possible-reply" });
  });

  it("keeps the audit entry when releasing colleagues fails after the sender's follow-ups were released (DATA-05)", async () => {
    const w = await heldWorld();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const original = db.$transaction.bind(db) as (fn: unknown, opts?: unknown) => Promise<unknown>;
    let calls = 0;
    vi.spyOn(db, "$transaction").mockImplementation((async (fn: unknown, opts?: unknown) => {
      calls += 1;
      // Ali's own chunk commits; releasing the colleagues afterwards fails.
      if (calls >= 2) throw new Error("The disk is full.");
      return original(fn, opts);
    }) as never);
    const res = await releaseOutageHold(ali, { senderId: ali.id, now: NOW });
    vi.restoreAllMocks();

    expect(res).toEqual({ released: 2, firstEmails: 0 });
    expect(await recipient(w.anna.recipientId)).toMatchObject({ state: "WAITING", holdReason: null });
    // Dee's first email waits for the 5-minute maintenance instead.
    expect((await recipient(w.dee.recipientId)).state).toBe("HELD");
    const entries = await db.activityLog.findMany({ where: { type: "followups.released" } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorId: ali.id,
      summary: "Ali checked their inbox: follow-ups of 2 people continue",
      data: { count: 2, senderId: ali.id, firstEmails: 0, from: FROM, to: TO },
    });
    expect(await releaseOrphanedOutageHolds()).toEqual({ released: 1 });
    expect((await recipient(w.dee.recipientId)).state).toBe("SCHEDULED");
  });

  it("when a later chunk fails, what was released stays released and recorded, and the person is asked to try again (DATA-05)", async () => {
    const live = await makeCampaign({ createdById: ali.id, senderId: ali.id });
    const big = await makeCompany("Bigger");
    await dbWrite((c) =>
      c.person.createMany({ data: Array.from({ length: 501 }, (_, i) => ({ companyId: big.id, name: `P${i}`, email: `p${i}@bigger.test`, emailNorm: `p${i}@bigger.test` })) }),
    );
    const people = await db.person.findMany({ where: { companyId: big.id }, select: { id: true, emailNorm: true } });
    await dbWrite((c) =>
      c.campaignRecipient.createMany({
        data: people.map((p) => ({
          campaignId: live.id,
          companyId: big.id,
          personId: p.id,
          emailNorm: p.emailNorm!,
          state: "HELD" as const,
          holdReason: "outage",
          heldAt: BEFORE,
          currentStep: 1,
        })),
      }),
    );
    await setOutage({ ...gap, handledAt: NOW.toISOString(), heldFor: FROM, heldTo: TO, heldCount: 501 });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const original = db.$transaction.bind(db) as (fn: unknown, opts?: unknown) => Promise<unknown>;
    let calls = 0;
    vi.spyOn(db, "$transaction").mockImplementation((async (fn: unknown, opts?: unknown) => {
      calls += 1;
      // The first 500 commit; the database then stays busy through every retry of the second chunk.
      if (calls >= 2) throw new Prisma.PrismaClientKnownRequestError("Operation has timed out", { code: "P1008", clientVersion: "7.10.0" });
      return original(fn, opts);
    }) as never);
    const failed = await releaseOutageHold(ali, { senderId: ali.id, now: NOW }).then(
      () => null,
      (err: unknown) => err,
    );
    vi.restoreAllMocks();

    expect(failed).toBeInstanceOf(CampaignError);
    expect(failed).toMatchObject({
      code: "unfinished",
      message: "Follow-ups of 500 people continue, but the app was too busy to finish. Try again in a moment for the rest.",
    });
    expect(await db.campaignRecipient.count({ where: { campaignId: live.id, state: "WAITING" } })).toBe(500);
    expect(await db.campaignRecipient.count({ where: { campaignId: live.id, state: "HELD" } })).toBe(1);
    const first = await db.activityLog.findMany({ where: { type: "followups.released" } });
    expect(first.map((e) => [e.summary, e.data])).toEqual([
      ["Ali checked their inbox: follow-ups of 500 people continue", { count: 500, senderId: ali.id, firstEmails: 0, from: FROM, to: TO }],
    ]);

    // Trying again continues the rest, with an entry of its own.
    expect(await releaseOutageHold(ali, { senderId: ali.id, now: NOW })).toEqual({ released: 1, firstEmails: 0 });
    expect(await db.campaignRecipient.count({ where: { campaignId: live.id, state: "HELD" } })).toBe(0);
    expect(await db.activityLog.count({ where: { type: "followups.released" } })).toBe(2);
  });

  it("saves nothing and says so when the very first chunk fails", async () => {
    const w = await heldWorld();
    vi.spyOn(db, "$transaction").mockRejectedValue(new Error("The disk is full."));
    await expect(releaseOutageHold(ali, { senderId: ali.id, now: NOW })).rejects.toThrow("The disk is full.");
    vi.restoreAllMocks();
    expect((await recipient(w.anna.recipientId)).state).toBe("HELD");
    expect(await db.activityLog.count({ where: { type: "followups.released" } })).toBe(0);
  });

  it("records a release of colleagues' first emails only in the transaction that released them", async () => {
    const live = await makeCampaign({ createdById: sara.id, senderId: sara.id });
    const lone = await enroll(live, await person((await makeCompany("Lone Co")).id, "Lone"), { first: true, state: "HELD", holdReason: "outage" });
    await setOutage({ ...gap, handledAt: NOW.toISOString(), heldFor: FROM, heldTo: TO, heldCount: 1 });
    expect(await releaseOutageHold(owner, { senderId: sara.id, now: NOW })).toEqual({ released: 0, firstEmails: 1 });
    expect(await recipient(lone.recipientId)).toMatchObject({ state: "SCHEDULED", holdReason: null });
    const entries = await db.activityLog.findMany({ where: { type: "followups.released" } });
    expect(entries.map((e) => [e.actorId, e.summary, e.data])).toEqual([
      [owner.id, "Arslan continued first emails to 1 person after the PC was off", { count: 0, senderId: sara.id, firstEmails: 1, from: FROM, to: TO }],
    ]);
  });

  it("releases colleagues whose company has nobody emailed left on hold", async () => {
    const live = await makeCampaign({ createdById: sara.id, senderId: sara.id });
    const e = await makeCompany("E");
    const f = await makeCompany("F");
    const lone = await enroll(live, await person(e.id, "Lone"), { first: true, state: "HELD", holdReason: "outage,possible-reply" });
    const kept = await enroll(live, await person(f.id, "Kept"), { first: true, state: "HELD", holdReason: "outage" });
    await enroll(live, await person(f.id, "Emailed"), { state: "HELD", holdReason: "outage", sent: [{ step: 0, sentAt: BEFORE }] });
    expect(await releaseOrphanedOutageHolds()).toEqual({ released: 1 });
    expect(await recipient(lone.recipientId)).toMatchObject({ state: "HELD", holdReason: "possible-reply" });
    expect((await recipient(kept.recipientId)).holdReason).toBe("outage");
  });
});

describe("outageHoldCopy", () => {
  it("builds the sender and Owner versions with singular counts, in the given zone (an unknown zone falls back)", () => {
    const sender = outageHoldCopy({ audience: "sender", from: FROM, to: TO, zone: "America/New_York", now: NOW, followUps: 1, firstEmails: 2 });
    expect(sender).toEqual({
      type: "outage.hold",
      title: "Follow-ups are on hold: replies from 2 Oct to 8 Oct may have been missed",
      body:
        "The PC was off too long for the app to see every reply. Check your inbox for replies to your campaigns from those days, " +
        "then click I've checked my inbox. Follow-ups of 1 person are waiting. First emails to 2 other people at those companies wait too.",
      link: "/notifications#on-hold",
    });
    const ownerCopy = outageHoldCopy({ audience: "owner", from: FROM, to: TO, zone: "Not/AZone", now: NOW, followUps: 12, bySender: [{ name: "Ali", count: 8 }, { name: "Sara", count: 4 }] });
    expect(ownerCopy.title).toBe("Follow-ups are on hold: replies from 3 Oct to 9 Oct may have been missed");
    expect(ownerCopy.body).toBe(
      "Follow-ups of 12 people wait until their senders have checked their inbox (Ali 8, Sara 4). You can continue them for anyone in Settings › Sending & Mailgun.",
    );
    expect(outageHoldCopy({ audience: "sender", from: FROM, to: TO, zone: null, now: new Date("2027-01-10T00:00:00Z"), followUps: 3, firstEmails: 0 }).title).toBe(
      "Follow-ups are on hold: replies from 3 Oct 2026 to 9 Oct 2026 may have been missed",
    );
  });
});
