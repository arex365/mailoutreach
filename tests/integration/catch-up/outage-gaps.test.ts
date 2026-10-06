import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { DAY, HOUR, enroll, makeCampaign, makeCompany, makePerson, makeUser, readOutage, recipient, setOutage } from "../stops-holds/world";

const OLD_DOMAIN = "old.example.com";
const t = await createTestDb("outage-gaps");
const mg = await connectFakeMailgun({ fake: { otherDomains: [OLD_DOMAIN] } });
const { db, dbWrite } = await import("@/server/db");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { runCatchUp, recordOutageGap } = await import("@/server/services/mailgun/catch-up");
const { applyOutageHold, releaseOutageHold } = await import("@/server/services/sequences/holds");

const mailgun = () => getMailgunContext({ retryDelayMs: () => 0 });
/** Mailgun keeps its logs 5 days (Setting default): the window a run can still check starts 5 days − 1 hour back. */
const floorOf = (now: Date) => new Date(now.getTime() - 5 * DAY + HOUR);

let ali: { id: number; name: string; role: "OWNER" | "MEMBER" };
let seq = 0;

beforeAll(async () => {
  await makeUser("Arslan", { role: "OWNER" });
  const a = await makeUser("Ali");
  ali = { id: a.id, name: a.name, role: "MEMBER" };
  await dbWrite((c) =>
    c.sendingDomain.create({ data: { name: OLD_DOMAIN, region: "EU", active: false, lastLiveSendAt: new Date(Date.now() - 10 * DAY) } }),
  );
});

beforeEach(async () => {
  mg.fake.reset();
  await dbWrite(async (c) => {
    await c.systemState.deleteMany({ where: { key: { in: ["sending.pause", "mailgun.catchUp", "catchup.outage", "notices", "mailgun.setup"] } } });
    await c.syncCursor.deleteMany({});
    await c.notification.deleteMany({});
    await c.activityLog.deleteMany({});
    await c.outboundEmail.deleteMany({});
    await c.companyReservation.deleteMany({});
    await c.campaignRecipient.deleteMany({});
    await c.campaignStep.deleteMany({});
    await c.campaign.deleteMany({});
  });
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

async function setCursor(domain: string, at: Date) {
  const key = `${domain}:logs`;
  await dbWrite((c) => c.syncCursor.upsert({ where: { key }, create: { key, value: at.toISOString() }, update: { value: at.toISOString() } }));
}

/** Ali's LIVE campaign with one person waiting for a follow-up, whose first email went out `sentAt`. */
async function followUp(sentAt: Date) {
  seq += 1;
  const campaign = await makeCampaign({ createdById: ali.id, senderId: ali.id, mode: "LIVE" });
  const company = await makeCompany(`Gap ${seq}`);
  return enroll(campaign, await makePerson(company.id, `p${seq}@gap${seq}.test`), { sent: [{ step: 0, sentAt }] });
}

async function outageNotices() {
  return db.notification.count({ where: { type: "outage.hold" } });
}

describe("the catch-up's outage gap record (M4-DESIGN §2.8.3)", () => {
  it("merges the gaps of two domains into one record (earliest from, latest to), also across runs before the hold", async () => {
    const now = new Date();
    await setCursor(mg.domain, new Date(now.getTime() - 8 * DAY));
    await setCursor(OLD_DOMAIN, new Date(now.getTime() - 10 * DAY));
    const first = await runCatchUp({ reason: "startup", now, mailgun });
    expect(first.domains).toEqual([mg.domain, OLD_DOMAIN]);
    expect(first.oldDomainProblems).toEqual([]);
    expect(await readOutage()).toMatchObject({
      from: new Date(now.getTime() - 10 * DAY).toISOString(),
      to: floorOf(now).toISOString(),
      beyondLogRetention: true,
      handledAt: null,
      detectedAt: now.toISOString(),
    });

    // The old domain's walk is read again later (its cursor still before the window): the record grows, never splits.
    const later = new Date(now.getTime() + 2 * HOUR);
    await setCursor(OLD_DOMAIN, new Date(now.getTime() - 10 * DAY));
    await runCatchUp({ reason: "hourly", now: later, mailgun });
    expect(await readOutage()).toMatchObject({
      from: new Date(now.getTime() - 10 * DAY).toISOString(),
      to: floorOf(later).toISOString(),
      handledAt: null,
      detectedAt: later.toISOString(),
    });

    // A later-starting gap merged in keeps the earliest start.
    expect(await recordOutageGap({ from: new Date(now.getTime() - 9 * DAY), to: floorOf(now) }, later)).toBe(true);
    expect((await readOutage()).from).toBe(new Date(now.getTime() - 10 * DAY).toISOString());
    expect((await readOutage()).to).toBe(floorOf(later).toISOString());
  });

  it("the same gap recorded again after its hold changes nothing and re-holds nobody (a sender already continued)", async () => {
    const now = new Date();
    const r = await followUp(new Date(now.getTime() - 8 * DAY));
    await setCursor(mg.domain, new Date(now.getTime() - 7 * DAY));
    await runCatchUp({ reason: "startup", now, mailgun });
    expect(await applyOutageHold({ now })).toMatchObject({ applied: true, held: 1 });
    expect((await recipient(r.recipientId)).state).toBe("HELD");
    const held = await readOutage();
    expect(held).toMatchObject({ heldFor: new Date(now.getTime() - 7 * DAY).toISOString(), heldTo: floorOf(now).toISOString(), heldCount: 1 });
    const notices = await outageNotices();
    expect(notices).toBe(2);

    await releaseOutageHold(ali, { senderId: ali.id });
    expect((await recipient(r.recipientId)).state).toBe("WAITING");

    // An incomplete walk: the cursor is still where it was, so the same gap shows up again an hour later.
    const later = new Date(now.getTime() + HOUR);
    await setCursor(mg.domain, new Date(now.getTime() - 7 * DAY));
    await runCatchUp({ reason: "hourly", now: later, mailgun });
    expect(await readOutage()).toEqual(held);
    expect(await applyOutageHold({ now: later })).toEqual({ applied: false, held: 0, senderIds: [] });
    expect((await recipient(r.recipientId)).state).toBe("WAITING");
    expect(await outageNotices()).toBe(notices);
  });

  it("an older domain's earlier gap after a hold is a new record and a new hold", async () => {
    const now = new Date();
    const first = await followUp(new Date(now.getTime() - 8 * DAY));
    await setCursor(mg.domain, new Date(now.getTime() - 7 * DAY));
    await runCatchUp({ reason: "startup", now, mailgun });
    await applyOutageHold({ now });
    const heldTo = floorOf(now).toISOString();

    const second = await followUp(new Date(now.getTime() - 9 * DAY));
    const later = new Date(now.getTime() + HOUR);
    await setCursor(OLD_DOMAIN, new Date(now.getTime() - 12 * DAY));
    await runCatchUp({ reason: "hourly", now: later, mailgun });
    expect(await readOutage()).toMatchObject({
      from: new Date(now.getTime() - 12 * DAY).toISOString(),
      to: floorOf(later).toISOString(),
      handledAt: null,
      heldFor: new Date(now.getTime() - 7 * DAY).toISOString(),
      heldTo,
    });
    expect(await applyOutageHold({ now: later })).toMatchObject({ applied: true, held: 2 });
    expect((await recipient(first.recipientId)).state).toBe("HELD");
    expect((await recipient(second.recipientId)).state).toBe("HELD");
    expect(await readOutage()).toMatchObject({ heldFor: new Date(now.getTime() - 12 * DAY).toISOString(), heldTo: floorOf(later).toISOString(), heldCount: 2 });
    expect(await outageNotices()).toBe(4);
  });

  it("a new outage after the held window is a new record and a new hold", async () => {
    const now = new Date();
    const r = await followUp(new Date(now.getTime() - 8 * DAY));
    await setCursor(mg.domain, new Date(now.getTime() - 7 * DAY));
    await runCatchUp({ reason: "startup", now, mailgun });
    await applyOutageHold({ now });
    await releaseOutageHold(ali, { senderId: ali.id });
    expect((await recipient(r.recipientId)).state).toBe("WAITING");

    // Ten days later, after the PC was off again from tomorrow on.
    const later = new Date(now.getTime() + 10 * DAY);
    await setCursor(mg.domain, new Date(now.getTime() + DAY));
    await setCursor(OLD_DOMAIN, new Date(later.getTime() - HOUR));
    await runCatchUp({ reason: "startup", now: later, mailgun });
    expect(await readOutage()).toMatchObject({ from: new Date(now.getTime() + DAY).toISOString(), to: floorOf(later).toISOString(), handledAt: null });
    expect(await applyOutageHold({ now: later })).toMatchObject({ applied: true, held: 1 });
    expect((await recipient(r.recipientId)).state).toBe("HELD");
  });

  it("a reply older than Mailgun keeps messages only notes it: the handled hold stays handled", async () => {
    const handled = {
      detectedAt: "2026-09-01T10:00:00.000Z",
      from: "2026-08-20T10:00:00.000Z",
      to: "2026-08-27T11:00:00.000Z",
      beyondLogRetention: true,
      beyondMessageRetention: false,
      handledAt: "2026-09-01T10:05:00.000Z",
      heldFor: "2026-08-20T10:00:00.000Z",
      heldTo: "2026-08-27T11:00:00.000Z",
      heldCount: 3,
    };
    await setOutage(handled);
    const received = new Date();
    mg.fake.receive({ from: "late@firma.de", to: `arslan@${mg.domain}`, subject: "Re: Old", text: "Gone by now", at: received });
    const later = new Date(received.getTime() + 2 * DAY);
    mg.fake.setNow(() => later);
    try {
      expect((await runCatchUp({ reason: "startup", now: later, mailgun })).inboundStored).toBe(1);
    } finally {
      mg.fake.setNow(() => new Date());
    }
    expect(await readOutage()).toEqual({ ...handled, beyondMessageRetention: true });
    expect(await db.inboundMessage.findFirstOrThrow({ where: { fromEmail: "late@firma.de" } })).toMatchObject({ snippet: "", bodyAvailable: false });
    expect(await applyOutageHold({ now: later })).toEqual({ applied: false, held: 0, senderIds: [] });

    // With no record yet it is found (detectedAt), and the hold step marks it handled without holding anyone.
    await setOutage(null);
    mg.fake.receive({ from: "later@firma.de", to: `arslan@${mg.domain}`, subject: "Re: Old", text: "Gone too", at: received });
    await dbWrite((c) => c.syncCursor.deleteMany({}));
    mg.fake.setNow(() => later);
    try {
      await runCatchUp({ reason: "hourly", now: later, mailgun });
    } finally {
      mg.fake.setNow(() => new Date());
    }
    expect(await readOutage()).toMatchObject({ detectedAt: later.toISOString(), from: null, beyondMessageRetention: true, handledAt: null });
    expect(await applyOutageHold({ now: later })).toEqual({ applied: true, held: 0, senderIds: [] });
  });
});
