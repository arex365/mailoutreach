import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { setSettingValue } from "../campaigns/seed";
import { DAY, HOUR, enroll, makeCampaign, makeCompany, makePerson, makeUser, readOutage, recipient, setOutage } from "../stops-holds/world";

/**
 * Own-mailbox mode's log retention and the outage gap (MAIN-DOMAIN-DESIGN O26, O27, §2.8, P5): with 5 days saved and no
 * plan chosen, the app counts on the Free plan's 1 day of logs: the catch-up's window starts 23 hours back and a cursor
 * 30 hours old records a gap; the outage hold then holds nobody (the daily inbox check does that job); the restore scan
 * treats a 2-day-old backup as beyond Mailgun's logs. App mode, in the same database, keeps today's 5 days and holds.
 */

const FROM = "contact@example.com";
const DOMAIN = "example.com";
const t = await createTestDb("own-mailbox-retention");
const mg = await connectFakeMailgun({
  domain: DOMAIN,
  region: "US",
  replies: "own-mailbox",
  fromAddress: FROM,
  // No plan chosen: own-mailbox mode assumes the Free plan's limits (O22).
  plan: null,
  fake: { domain: DOMAIN, region: "US", plan: "free", receivesMail: false },
});
const { db, dbWrite } = await import("@/server/db");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { runCatchUp } = await import("@/server/services/mailgun/catch-up");
const { applyOutageHold } = await import("@/server/services/sequences/holds");
const restore = await import("@/server/services/sending/restore");
const { loadPlanLimits } = await import("@/server/services/mailgun/plan");

const mailgun = () => getMailgunContext({ retryDelayMs: () => 0 });
let owner: { id: number; name: string };

async function setCursor(domain: string, at: Date) {
  const key = `${domain}:logs`;
  await dbWrite((c) => c.syncCursor.upsert({ where: { key }, create: { key, value: at.toISOString() }, update: { value: at.toISOString() } }));
}

async function inAppMode<T>(fn: () => Promise<T>): Promise<T> {
  await setSettingValue("mailgun.replies", "app");
  try {
    return await fn();
  } finally {
    await setSettingValue("mailgun.replies", "own-mailbox");
  }
}

/** The `start` of every Logs query the fake received since `from` (index into `requests`). */
function logStarts(from: number): number[] {
  return mg.fake.requests
    .slice(from)
    .filter((r) => r.method === "POST" && r.path === "/v1/analytics/logs")
    .map((r) => Date.parse(String((r.body as { start?: unknown } | null)?.start ?? "")));
}

/** A LIVE follow-up waiting at a new company, its first email sent `sentAt`. */
let seq = 0;
async function waitingFollowUp(sentAt: Date) {
  seq += 1;
  const campaign = await makeCampaign({ createdById: owner.id, senderId: owner.id, mode: "LIVE" });
  const company = await makeCompany(`Gap ${seq}`);
  return enroll(campaign, await makePerson(company.id, `p${seq}@gap${seq}.example`), { sent: [{ step: 0, sentAt }] });
}

function gap(now: Date) {
  return {
    detectedAt: now.toISOString(),
    from: new Date(now.getTime() - 30 * HOUR).toISOString(),
    to: new Date(now.getTime() - 23 * HOUR).toISOString(),
    beyondLogRetention: true,
    beyondMessageRetention: false,
    handledAt: null,
    heldFor: null,
    heldTo: null,
    heldCount: 0,
  };
}

beforeAll(async () => {
  const o = await makeUser("Arslan", { role: "OWNER" });
  owner = { id: o.id, name: o.name };
});

beforeEach(async () => {
  mg.fake.reset();
  await setSettingValue("mailgun.replies", "own-mailbox");
  await setSettingValue("mailgun.logRetentionDays", 5);
  await dbWrite(async (c) => {
    await c.systemState.deleteMany({ where: { key: { in: ["sending.pause", "mailgun.catchUp", "catchup.outage", "notices", "restore"] } } });
    await c.syncCursor.deleteMany({});
    await c.notification.deleteMany({});
    await c.activityLog.deleteMany({});
    await c.job.deleteMany({});
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

describe("the plan's log retention", () => {
  it("own-mailbox mode without a chosen plan counts on the Free plan's 1 day; app mode without one on the saved days", async () => {
    expect(await loadPlanLimits()).toMatchObject({ plan: "free", assumed: true, logDays: 1 });
    expect(await inAppMode(() => loadPlanLimits())).toBeNull();
  });
});

describe("the catch-up (saved 5 days, own-mailbox mode)", () => {
  it("its Logs window starts 23 hours back", async () => {
    const now = new Date();
    const before = mg.fake.requests.length;
    await runCatchUp({ reason: "manual", now, mailgun });
    const starts = logStarts(before);
    expect(starts.length).toBeGreaterThan(0);
    for (const start of starts) expect(Math.abs(start - (now.getTime() - 23 * HOUR))).toBeLessThan(1_000);
    expect((await readOutage()).from).toBeNull();
  });

  it("a cursor 30 hours old records a gap up to the window's start; app mode (5 days) records none", async () => {
    const now = new Date();
    const cursor = new Date(now.getTime() - 30 * HOUR);
    await setCursor(DOMAIN, cursor);
    await runCatchUp({ reason: "hourly", now, mailgun });
    expect(await readOutage()).toMatchObject({
      from: cursor.toISOString(),
      to: new Date(now.getTime() - 23 * HOUR).toISOString(),
      beyondLogRetention: true,
      handledAt: null,
    });

    await dbWrite((c) => c.systemState.deleteMany({ where: { key: "catchup.outage" } }));
    // The run above moved the cursor on: put it back 30 hours.
    await setCursor(DOMAIN, cursor);
    const before = mg.fake.requests.length;
    await inAppMode(() => runCatchUp({ reason: "hourly", now, mailgun }));
    expect((await readOutage()).from).toBeNull();
    // The walk re-reads an hour before the cursor: well inside 5 days.
    const starts = logStarts(before);
    expect(starts).toContain(Math.floor((cursor.getTime() - HOUR) / 1_000) * 1_000);
  });
});

describe("the outage hold", () => {
  it("holds nobody in own-mailbox mode: the gap is marked handled, the window kept, and nobody is told", async () => {
    const now = new Date();
    const r = await waitingFollowUp(new Date(now.getTime() - 2 * DAY));
    const g = gap(now);
    await setOutage(g);
    expect(await applyOutageHold({ now })).toEqual({ applied: true, held: 0, senderIds: [] });
    expect((await recipient(r.recipientId)).state).toBe("WAITING");
    expect(await readOutage()).toMatchObject({ handledAt: now.toISOString(), heldFor: g.from, heldTo: g.to, heldCount: 0, from: g.from, to: g.to });
    expect(await db.notification.count({ where: { type: "outage.hold" } })).toBe(0);
    expect(await db.activityLog.count({ where: { type: "followups.held" } })).toBe(0);
    // Handled: a second run does nothing.
    expect(await applyOutageHold({ now })).toEqual({ applied: false, held: 0, senderIds: [] });
  });

  it("holds as today in app mode", async () => {
    const now = new Date();
    const r = await waitingFollowUp(new Date(now.getTime() - 2 * DAY));
    await setOutage(gap(now));
    const res = await inAppMode(() => applyOutageHold({ now }));
    expect(res).toMatchObject({ applied: true, held: 1 });
    expect(await recipient(r.recipientId)).toMatchObject({ state: "HELD", holdReason: "outage" });
    expect(await readOutage()).toMatchObject({ heldCount: 1 });
  });
});

describe("the restore scan", () => {
  async function restoredTwoDaysAgo(now: Date) {
    const from = new Date(now.getTime() - 2 * DAY).toISOString();
    await dbWrite((c) =>
      c.systemState.create({
        data: {
          key: "restore",
          version: 1,
          value: {
            status: "pending",
            restoredFrom: from,
            scanFrom: from,
            markerAt: now.toISOString(),
            file: "backup.db",
            handledAt: now.toISOString(),
            report: null,
            acknowledgedAt: null,
            acknowledgedById: null,
            domainsBefore: [],
          },
        },
      }),
    );
  }

  it("treats a 2-day-old backup as beyond Mailgun's logs on the Free plan (app mode's 5 days: within)", async () => {
    const now = new Date();
    await restoredTwoDaysAgo(now);
    const own = await restore.runRestoreScan({ now, pass: 1, mailgun });
    expect(own.olderThanRetention).toBe(true);
    expect(own.windowFrom).toBe(new Date(now.getTime() - DAY + HOUR).toISOString());

    await dbWrite(async (c) => {
      await c.systemState.deleteMany({ where: { key: "restore" } });
      await c.job.deleteMany({});
    });
    await restoredTwoDaysAgo(now);
    const app = await inAppMode(() => restore.runRestoreScan({ now, pass: 1, mailgun }));
    expect(app.olderThanRetention).toBe(false);
    expect(app.windowFrom).toBe(new Date(now.getTime() - 2 * DAY).toISOString());
  });
});
