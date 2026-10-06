import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { setSettingValue } from "../campaigns/seed";
import { makeOwner, seedEmail } from "../mail-events/seed";

/**
 * List-pulled complaints and bounces count toward the health auto-pause in own-mailbox mode (MAIN-DOMAIN-DESIGN O34,
 * §2.8, P5): with 1 day of logs a weekend with the PC off loses the Logs events, but Mailgun's lists still have the
 * addresses. The pull links a new complaints or bounces entry to the newest LIVE email SENT to that address in the 7 days
 * before the entry (a bounce gets the reason "list-bounce"), the health counts see it, and the health check runs once
 * after such a pull. App mode pulls exactly as before (nothing linked).
 */

const FROM = "contact@example.com";
const DOMAIN = "example.com";
const DAY = 86_400_000;
const t = await createTestDb("own-mailbox-list-health");
const mg = await connectFakeMailgun({
  domain: DOMAIN,
  region: "US",
  replies: "own-mailbox",
  fromAddress: FROM,
  plan: "free",
  fake: { domain: DOMAIN, region: "US", plan: "free", receivesMail: false },
});
const { db, dbWrite } = await import("@/server/db");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { runCatchUp } = await import("@/server/services/mailgun/catch-up");
const { pullSuppressions } = await import("@/server/services/mailgun/suppressions");
const { loadHealthCounts } = await import("@/server/services/sending/usage");
const { readTyped } = await import("@/server/state-typed");
const { parseHealthBaseline } = await import("@/core/system-state-parse");

const mailgun = () => getMailgunContext({ retryDelayMs: () => 0 });
let ownerId = 0;

/** A day before `now`, in whole seconds (Mailgun's lists give their dates to the second). */
const dayBefore = (now: Date) => new Date(Math.floor((now.getTime() - DAY) / 1_000) * 1_000);
const counts = () => loadHealthCounts({ since: null, bounceWindow: 200, complaintWindow: 1000, practiceCopy: false });
const listEvents = (address: string) =>
  db.mailEvent.findMany({
    where: { recipient: address, dedupeKey: { startsWith: "sup:" } },
    select: { type: true, reason: true, messageId: true, outboundEmailId: true },
  });
const warnedComplaintAt = async () => (await readTyped("health.baseline", parseHealthBaseline)).value.warnedComplaintAt;

beforeAll(async () => {
  ownerId = (await makeOwner()).id;
});

beforeEach(async () => {
  mg.fake.reset();
  await setSettingValue("mailgun.replies", "own-mailbox");
  await dbWrite(async (c) => {
    await c.mailEvent.deleteMany({});
    await c.suppression.deleteMany({});
    await c.notification.deleteMany({});
    await c.activityLog.deleteMany({});
    await c.outboundEmail.deleteMany({});
    await c.campaignRecipient.deleteMany({});
    await c.campaignStep.deleteMany({});
    await c.campaign.deleteMany({});
    await c.syncCursor.deleteMany({});
    await c.systemState.deleteMany({ where: { key: { in: ["health.baseline", "sending.pause", "notices", "mailgun.catchUp"] } } });
  });
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("a complaint Mailgun's list has, for an email the Logs no longer show", () => {
  it("is linked to that email, sets its date, counts once toward the health check, and the check runs", async () => {
    const now = new Date();
    const e = await seedEmail({ createdById: ownerId, email: "a@x.example", domain: DOMAIN, sentAt: new Date(now.getTime() - 2 * DAY) });
    mg.fake.addSuppression("complaints", "a@x.example", { createdAt: dayBefore(now) });

    await runCatchUp({ reason: "manual", now, mailgun });

    expect(await listEvents("a@x.example")).toEqual([{ type: "complained", reason: null, messageId: e.messageId, outboundEmailId: e.emailId }]);
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: e.emailId } })).complainedAt).toEqual(dayBefore(now));
    expect(await counts()).toMatchObject({ complaints: 1, complaintEmailIds: [e.emailId] });
    // The pull's own effects are as before: the address is on the list, the person stopped, one Owner notice.
    expect(await db.suppression.findUnique({ where: { emailNorm: "a@x.example" } })).toMatchObject({ reason: "COMPLAINED" });
    expect(await db.notification.count({ where: { type: "email.complained" } })).toBe(1);
    // The health check ran after the pull: the half-limit warning, with the own From's note.
    expect(await warnedComplaintAt()).not.toBeNull();
    const warning = await db.notification.findFirstOrThrow({ where: { type: "sending.warning" } });
    expect(warning.title).toBe("An email was marked as spam");
    expect(warning.body).toContain(" Your emails come from contact@example.com, so these complaints also count against your everyday email.");

    // A Logs `complained` event for the same email as well: still one complaint.
    await dbWrite((c) =>
      c.mailEvent.create({
        data: {
          dedupeKey: "logs-complained-a",
          type: "complained",
          occurredAt: new Date(now.getTime() - DAY),
          messageId: e.messageId,
          recipient: "a@x.example",
          outboundEmailId: e.emailId,
          source: "LOGS",
          raw: {},
          processedAt: now,
        },
      }),
    );
    expect((await counts()).complaints).toBe(1);

    // The next pull finds the address on the local list: nothing new is linked and the check doesn't run again.
    await dbWrite((c) => c.notification.deleteMany({ where: { type: "sending.warning" } }));
    await runCatchUp({ reason: "hourly", now: new Date(now.getTime() + 3_600_000), mailgun });
    expect(await listEvents("a@x.example")).toHaveLength(1);
    expect(await db.notification.count({ where: { type: "sending.warning" } })).toBe(0);
  });
});

describe("a bounce Mailgun's list has", () => {
  it("is linked the same way, with the reason list-bounce, and counts as a bounce", async () => {
    const now = new Date();
    const e = await seedEmail({ createdById: ownerId, email: "b@x.example", domain: DOMAIN, sentAt: new Date(now.getTime() - 3 * DAY) });
    mg.fake.addSuppression("bounces", "b@x.example", { createdAt: dayBefore(now), code: "550", error: "No such mailbox" });

    const ctx = await mailgun();
    if (!ctx.connected) throw new Error("not connected");
    const res = await pullSuppressions({ client: ctx.client, domain: DOMAIN, activeDomain: DOMAIN, now, practiceCopy: false, ownMailbox: true });
    expect(res).toMatchObject({ complete: true, added: 1, linked: 1 });

    expect(await listEvents("b@x.example")).toEqual([{ type: "failed", reason: "list-bounce", messageId: e.messageId, outboundEmailId: e.emailId }]);
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: e.emailId } })).bouncedAt).toEqual(dayBefore(now));
    expect(await counts()).toMatchObject({ bounces: 1, bounceEmailIds: [e.emailId] });
  });
});

describe("an address already on the do-not-email list for another reason (review REPLIES-10)", () => {
  // Mark unsubscribed or Add an address never counted a complaint or a bounce: a complaint whose Logs event fell into a
  // gap (1 day of logs, a weekend with the PC off) still counts through Mailgun's list.
  it("Mark unsubscribed first, then a complaint the Logs no longer show: linked, counted, the entry keeps its reason", async () => {
    const now = new Date();
    const e = await seedEmail({ createdById: ownerId, email: "anna@outlook.example", domain: DOMAIN, sentAt: new Date(now.getTime() - 3 * DAY) });
    await dbWrite((c) => c.suppression.create({ data: { emailNorm: "anna@outlook.example", reason: "UNSUBSCRIBED", source: "manual" } }));
    mg.fake.addSuppression("complaints", "anna@outlook.example", { createdAt: dayBefore(now) });

    await runCatchUp({ reason: "manual", now, mailgun });

    expect(await listEvents("anna@outlook.example")).toEqual([{ type: "complained", reason: null, messageId: e.messageId, outboundEmailId: e.emailId }]);
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: e.emailId } })).complainedAt).toEqual(dayBefore(now));
    expect(await counts()).toMatchObject({ complaints: 1, complaintEmailIds: [e.emailId] });
    // The health check ran after the pull (the half-limit warning).
    expect(await warnedComplaintAt()).not.toBeNull();
    // The local entry is kept as it was (the pull never relabels an entry the app already has).
    expect(await db.suppression.findUnique({ where: { emailNorm: "anna@outlook.example" } })).toMatchObject({ reason: "UNSUBSCRIBED" });

    // The next pull links nothing new: the counts already see this complaint.
    await runCatchUp({ reason: "hourly", now: new Date(now.getTime() + 3_600_000), mailgun });
    expect(await listEvents("anna@outlook.example")).toHaveLength(1);
    expect((await counts()).complaints).toBe(1);
  });

  it("an address added by hand (MANUAL), then a hard bounce on Mailgun's list: linked and counted as a bounce", async () => {
    const now = new Date();
    const e = await seedEmail({ createdById: ownerId, email: "gone@x.example", domain: DOMAIN, sentAt: new Date(now.getTime() - 2 * DAY) });
    await dbWrite((c) => c.suppression.create({ data: { emailNorm: "gone@x.example", reason: "MANUAL", source: "manual" } }));
    mg.fake.addSuppression("bounces", "gone@x.example", { createdAt: dayBefore(now), code: "550", error: "No such mailbox" });

    await runCatchUp({ reason: "manual", now, mailgun });

    expect(await listEvents("gone@x.example")).toEqual([{ type: "failed", reason: "list-bounce", messageId: e.messageId, outboundEmailId: e.emailId }]);
    expect(await counts()).toMatchObject({ bounces: 1, bounceEmailIds: [e.emailId] });
    expect(await db.suppression.findUnique({ where: { emailNorm: "gone@x.example" } })).toMatchObject({ reason: "MANUAL" });
  });
});

describe("entries that are not linked", () => {
  it("a complaint the counts already see (its Logs event is linked to an older email): not linked again to a newer one", async () => {
    const now = new Date();
    const older = await seedEmail({ createdById: ownerId, email: "twice@x.example", domain: DOMAIN, sentAt: new Date(now.getTime() - 5 * DAY) });
    const newer = await seedEmail({ createdById: ownerId, email: "twice@x.example", domain: DOMAIN, sentAt: new Date(now.getTime() - 2 * DAY) });
    await dbWrite(async (c) => {
      await c.mailEvent.create({
        data: {
          dedupeKey: "logs-complained-twice",
          type: "complained",
          occurredAt: new Date(now.getTime() - 4 * DAY),
          messageId: older.messageId,
          recipient: "twice@x.example",
          outboundEmailId: older.emailId,
          source: "LOGS",
          raw: {},
          processedAt: now,
        },
      });
      await c.suppression.create({ data: { emailNorm: "twice@x.example", reason: "COMPLAINED", source: "webhook" } });
    });
    mg.fake.addSuppression("complaints", "twice@x.example", { createdAt: dayBefore(now) });

    await runCatchUp({ reason: "manual", now, mailgun });

    expect(await listEvents("twice@x.example")).toEqual([{ type: "complained", reason: null, messageId: null, outboundEmailId: null }]);
    expect(await counts()).toMatchObject({ complaints: 1, complaintEmailIds: [older.emailId] });
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: newer.emailId } })).complainedAt).toBeNull();
  });

  it("an entry whose address's last email is older than 7 days", async () => {
    const now = new Date();
    await seedEmail({ createdById: ownerId, email: "old@x.example", domain: DOMAIN, sentAt: new Date(now.getTime() - 9 * DAY) });
    mg.fake.addSuppression("bounces", "old@x.example", { createdAt: new Date(now.getTime() - DAY) });

    await runCatchUp({ reason: "manual", now, mailgun });

    expect(await listEvents("old@x.example")).toEqual([{ type: "failed", reason: "suppress-bounce", messageId: null, outboundEmailId: null }]);
    expect(await counts()).toMatchObject({ bounces: 0, complaints: 0 });
    expect(await warnedComplaintAt()).toBeNull();
  });

  it("an unsubscribes entry is never linked (it isn't a health event)", async () => {
    const now = new Date();
    await seedEmail({ createdById: ownerId, email: "u@x.example", domain: DOMAIN, sentAt: new Date(now.getTime() - DAY) });
    mg.fake.addSuppression("unsubscribes", "u@x.example", { createdAt: now });
    await runCatchUp({ reason: "manual", now, mailgun });
    expect(await listEvents("u@x.example")).toEqual([{ type: "unsubscribed", reason: null, messageId: null, outboundEmailId: null }]);
  });

  it("app mode pulls as before: nothing is linked and nothing counts", async () => {
    await setSettingValue("mailgun.replies", "app");
    const now = new Date();
    await seedEmail({ createdById: ownerId, email: "c@x.example", domain: DOMAIN, sentAt: new Date(now.getTime() - 2 * DAY) });
    mg.fake.addSuppression("complaints", "c@x.example", { createdAt: new Date(now.getTime() - DAY) });

    await runCatchUp({ reason: "manual", now, mailgun });

    expect(await listEvents("c@x.example")).toEqual([{ type: "complained", reason: null, messageId: null, outboundEmailId: null }]);
    expect(await counts()).toMatchObject({ complaints: 0 });
    expect(await warnedComplaintAt()).toBeNull();
    expect(await db.suppression.findUnique({ where: { emailNorm: "c@x.example" } })).toMatchObject({ reason: "COMPLAINED" });

    // pullSuppressions without the option: `linked` is 0.
    const ctx = await mailgun();
    if (!ctx.connected) throw new Error("not connected");
    mg.fake.addSuppression("bounces", "d@x.example", { createdAt: now });
    const res = await pullSuppressions({ client: ctx.client, domain: DOMAIN, activeDomain: DOMAIN, now, practiceCopy: false });
    expect(res.linked).toBe(0);
  });
});
