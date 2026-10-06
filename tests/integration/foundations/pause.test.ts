import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeUser } from "../campaigns/seed";

/** The global pause (M3-DESIGN §4.2.6). */

const t = await createTestDb("foundations-pause");
const { db, dbWrite } = await import("@/server/db");
const { pauseSending, resumeSending, getPauseState } = await import("@/server/services/sending/pause");
const { getSendingState } = await import("@/server/sending-state");
const { readTyped } = await import("@/server/state-typed");
const { setState } = await import("@/server/state");
const { parseHealthBaseline, parseRestoreState } = await import("@/core/system-state-parse");
const { STATE_KEYS } = await import("@/core/system-state");

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

const owner = await makeUser("Arslan", { role: "OWNER", email: "arslan@polygonparadise.test" });
const member = await makeUser("Ali", { email: "ali@polygonparadise.test" });
await dbWrite((c) => c.user.update({ where: { id: owner.id }, data: { timeZone: "Asia/Karachi" } }));

const NOW = new Date("2026-09-23T10:00:00Z");
const BOUNCE = {
  kind: "health-bounce" as const,
  reason: "7 of the last 200 emails bounced",
  fixText: "Your limit is 6. Open the bounced list in Settings › Deliverability, then click Resume.",
  detail: { count: 7, sample: 200, window: 200, limit: 6 },
};

beforeEach(async () => {
  await dbWrite(async (c) => {
    await c.systemState.deleteMany({});
    await c.notification.deleteMany({});
    await c.activityLog.deleteMany({});
  });
});

const notifications = () => db.notification.findMany({ where: { type: "sending.paused" } });
const activities = (type: string) => db.activityLog.findMany({ where: { type }, orderBy: { id: "asc" } });

describe("pauseSending", () => {
  it("pauses, logs and notifies the Owner once; the first cause wins", async () => {
    const first = await pauseSending({ ...BOUNCE, now: NOW });
    expect(first.newlyPaused).toBe(true);
    expect(first.state).toEqual({
      paused: true,
      reason: BOUNCE.reason,
      kind: "health-bounce",
      fixText: BOUNCE.fixText,
      since: NOW.toISOString(),
      byUserId: null,
      detail: BOUNCE.detail,
      also: [],
    });
    const later = new Date(NOW.getTime() + 60_000);
    const second = await pauseSending({
      kind: "mailgun-auth",
      reason: "Mailgun didn't accept the API key",
      fixText: "Save a new key.",
      detail: { mailgunMessage: "Forbidden" },
      now: later,
    });
    expect(second.newlyPaused).toBe(false);
    expect(second.state.kind).toBe("health-bounce");
    expect(second.state.reason).toBe(BOUNCE.reason);
    expect(second.state.also).toEqual([
      { kind: "mailgun-auth", reason: "Mailgun didn't accept the API key", at: later.toISOString(), detail: { mailgunMessage: "Forbidden" } },
    ]);

    const n = await notifications();
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({
      userId: owner.id,
      title: "Sending paused: 7 of the last 200 emails bounced",
      body: BOUNCE.fixText,
      link: "/settings/sending",
    });
    const a = await activities("sending.paused");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actorId: null, summary: "Sending paused: 7 of the last 200 emails bounced" });
  });

  it("is idempotent for the same kind; a health kind in `also` gets its numbers refreshed", async () => {
    await pauseSending({ kind: "manual", reason: "by Arslan", fixText: "Click Resume.", byUserId: owner.id, now: NOW });
    const again = await pauseSending({ kind: "manual", reason: "by Arslan again", fixText: "x", byUserId: owner.id, now: NOW });
    expect(again.state.reason).toBe("by Arslan");
    expect(again.state.also).toEqual([]);

    await pauseSending({ ...BOUNCE, now: NOW });
    const refreshed = await pauseSending({
      ...BOUNCE,
      reason: "8 of the last 200 emails bounced",
      detail: { count: 8, sample: 200, window: 200, limit: 6 },
      now: new Date(NOW.getTime() + 1000),
    });
    expect(refreshed.state.also).toHaveLength(1);
    expect(refreshed.state.also[0]).toMatchObject({ kind: "health-bounce", reason: "8 of the last 200 emails bounced", detail: { count: 8 } });

    // a non-health kind already in `also` stays as it was
    await pauseSending({ kind: "mailgun-queue", reason: "Mailgun stopped accepting emails", fixText: "x", now: NOW });
    const same = await pauseSending({ kind: "mailgun-queue", reason: "other text", fixText: "y", now: NOW });
    expect(same.state.also.find((x) => x.kind === "mailgun-queue")?.reason).toBe("Mailgun stopped accepting emails");
  });

  it("doesn't notify when the Owner paused by hand, but does for a Member", async () => {
    await pauseSending({ kind: "manual", reason: "by Arslan", fixText: "Click Resume.", byUserId: owner.id, now: NOW });
    expect(await notifications()).toHaveLength(0);
    // SPEC-04: the same wording as the top bar ("Paused by Arslan") and the pause card, never "Sending paused: by Arslan".
    expect((await activities("sending.paused"))[0]).toMatchObject({ actorId: owner.id, summary: "Sending paused by Arslan" });
    await resumeSending({ actorId: owner.id, actorName: "Arslan", now: NOW });
    await pauseSending({ kind: "manual", reason: "by Ali", fixText: "Click Resume.", byUserId: member.id, now: NOW });
    const n = await notifications();
    expect(n).toHaveLength(1);
    expect(n[0]?.title).toBe("Sending paused by Ali");
  });

  it("keeps the Milestone 2 reader working (the top-bar pill)", async () => {
    expect(await getSendingState()).toEqual({ kind: "dry-run" });
    await pauseSending({ ...BOUNCE, now: NOW });
    expect(await getSendingState()).toEqual({ kind: "paused", reason: BOUNCE.reason });
    expect((await getPauseState()).paused).toBe(true);
  });

  it("survives both processes pausing at the same moment", async () => {
    const results = await Promise.all([
      pauseSending({ kind: "manual", reason: "by Arslan", fixText: "x", byUserId: owner.id, now: NOW }),
      pauseSending({ ...BOUNCE, now: NOW }),
      pauseSending({ kind: "mailgun-auth", reason: "key", fixText: "y", now: NOW }),
    ]);
    expect(results.filter((r) => r.newlyPaused)).toHaveLength(1);
    const state = await getPauseState();
    expect([state.kind, ...state.also.map((a) => a.kind)].sort()).toEqual(["health-bounce", "mailgun-auth", "manual"]);
  });
});

describe("resumeSending", () => {
  it("does nothing when not paused", async () => {
    expect(await resumeSending({ actorId: owner.id, actorName: "Arslan", now: NOW })).toMatchObject({
      resumed: false,
      summary: "Sending isn't paused.",
    });
  });

  it("resets the health baseline, then clears the pause, then logs the acknowledged numbers", async () => {
    await setState(STATE_KEYS.healthBaseline, {
      since: null,
      resumedById: null,
      acknowledged: null,
      warnedBounceAt: "2026-09-20T10:00:00.000Z",
      warnedComplaintAt: null,
    });
    await pauseSending({ ...BOUNCE, now: NOW });
    const later = new Date(NOW.getTime() + 3_600_000);
    const res = await resumeSending({ actorId: owner.id, actorName: "Arslan", now: later });
    expect(res).toMatchObject({ resumed: true, summary: "Resumed by Arslan with 7 of 200 acknowledged" });
    expect(res.state.paused).toBe(false);
    expect((await getPauseState()).paused).toBe(false);
    expect((await readTyped(STATE_KEYS.healthBaseline, parseHealthBaseline)).value).toEqual({
      since: later.toISOString(),
      resumedById: owner.id,
      acknowledged: { kind: "health-bounce", count: 7, sample: 200 },
      warnedBounceAt: null,
      warnedComplaintAt: null,
    });
    const a = await activities("sending.resumed");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actorId: owner.id, summary: "Resumed by Arslan with 7 of 200 acknowledged" });
  });

  it("resets the baseline when health is only an `also` cause", async () => {
    await pauseSending({ kind: "manual", reason: "by Arslan", fixText: "x", byUserId: owner.id, now: NOW });
    await pauseSending({
      kind: "health-complaint",
      reason: "2 of the last 1,000 emails were marked as spam",
      fixText: "Check it.",
      detail: { count: 2, sample: 1000, window: 1000, limit: 1 },
      now: NOW,
    });
    const res = await resumeSending({ actorId: owner.id, actorName: "Arslan", now: NOW });
    expect(res.summary).toBe("Resumed by Arslan with 2 of 1000 acknowledged");
    expect((await readTyped(STATE_KEYS.healthBaseline, parseHealthBaseline)).value.acknowledged).toEqual({
      kind: "health-complaint",
      count: 2,
      sample: 1000,
    });
  });

  it("leaves the baseline alone for other causes", async () => {
    await pauseSending({ kind: "mailgun-auth", reason: "Mailgun didn't accept the API key", fixText: "x", now: NOW });
    const res = await resumeSending({ actorId: owner.id, actorName: "Arslan", now: NOW });
    expect(res).toMatchObject({ resumed: true, summary: "Resumed by Arslan" });
    expect((await readTyped(STATE_KEYS.healthBaseline, parseHealthBaseline)).version).toBeNull();
  });

  it("refuses a restore whose Mailgun check failed until the risk is confirmed", async () => {
    await setState(STATE_KEYS.restore, {
      status: "failed",
      restoredFrom: "2026-09-20T09:00:00.000Z",
      scanFrom: null,
      markerAt: null,
      file: null,
      handledAt: null,
      report: null,
      acknowledgedAt: null,
      acknowledgedById: null,
    });
    await pauseSending({ kind: "restore", reason: "restored from a backup", fixText: "Check the restore report.", now: NOW });
    const refused = await resumeSending({ actorId: owner.id, actorName: "Arslan", now: NOW });
    // 09:00Z = 14:00 in Karachi (the Owner's zone); "Sep" or "Sept" depends on the ICU data (@/core/time/format)
    expect(refused.resumed).toBe(false);
    expect(refused.summary).toMatch(/^Tick the box to confirm that emails sent after 20 Sept? 14:00 may go out a second time\.$/);
    expect((await getPauseState()).paused).toBe(true);

    const ok = await resumeSending({ actorId: owner.id, actorName: "Arslan", now: NOW, confirmRestoreRisk: true });
    expect(ok.resumed).toBe(true);
    expect((await readTyped(STATE_KEYS.restore, parseRestoreState)).value).toMatchObject({
      acknowledgedAt: NOW.toISOString(),
      acknowledgedById: owner.id,
    });
  });

  it("also refuses a finished restore that couldn't check Mailgun, even as an `also` cause", async () => {
    await setState(STATE_KEYS.restore, {
      status: "done",
      restoredFrom: "2026-09-20T09:00:00.000Z",
      report: {
        finishedAt: "2026-09-23T09:00:00.000Z",
        mailgunChecked: false,
        passes: 2,
        windowFrom: null,
        windowTo: null,
        olderThanRetention: false,
        acceptedEvents: 0,
        matchedByMessageId: 0,
        matchedBySendId: 0,
        matchedByRecipient: 0,
        rowsCreated: 0,
        externalSends: 0,
        madeUnconfirmed: 0,
        error: "Mailgun isn't connected",
      },
    });
    await pauseSending({ kind: "manual", reason: "by Arslan", fixText: "x", byUserId: owner.id, now: NOW });
    await pauseSending({ kind: "restore", reason: "restored from a backup", fixText: "x", now: NOW });
    expect((await resumeSending({ actorId: owner.id, actorName: "Arslan", now: NOW })).resumed).toBe(false);
    expect((await resumeSending({ actorId: owner.id, actorName: "Arslan", now: NOW, confirmRestoreRisk: true })).resumed).toBe(true);
  });

  it("allows resuming while the restore check is still running or after it succeeded", async () => {
    for (const restore of [{ status: "scanning" }, { status: "pending" }, { status: "done", report: { finishedAt: NOW.toISOString(), mailgunChecked: true } }]) {
      await dbWrite((c) => c.systemState.deleteMany({}));
      await setState(STATE_KEYS.restore, restore);
      await pauseSending({ kind: "restore", reason: "restored from a backup", fixText: "x", now: NOW });
      expect((await resumeSending({ actorId: owner.id, actorName: "Arslan", now: NOW })).resumed, restore.status).toBe(true);
    }
  });
});
