import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { resetSendingState, setupM3, worldClock, type M3World } from "../sending-m3/helpers";

/**
 * Settings › Backups' "Last restore" card (M6-DESIGN §3.7, D18): kept after Resume. resumeSending records who resumed
 * and when (`restore.resumedAt/resumedById`) whenever the pause it clears has a "restore" cause; lastRestoreView words
 * the card: when and from which backup, the report (restoreReportLines), and "stays paused", "resumed while the check
 * is still running" or "resumed by <name> on <date>". The local fake Mailgun only.
 */

const t = await createTestDb("backups-last-restore");
const { db, dbWrite } = await import("@/server/db");
const restore = await import("@/server/services/sending/restore");
const { pauseSending, resumeSending } = await import("@/server/services/sending/pause");
const { readTyped } = await import("@/server/state-typed");
const { setState } = await import("@/server/state");
const { parseRestoreState } = await import("@/core/system-state-parse");
const { formatShortDate } = await import("@/core/time/format");

const ZONE = "Europe/Berlin";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-last-restore-"));
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const notConnected = async () => ({ connected: false as const, reason: "no-key" as const, text: "The Mailgun API key isn't saved yet." });
const restoreState = async () => (await readTyped("restore", parseRestoreState)).value;
/** September as the app writes it (the platform's en-GB short month: "Sep" or "Sept"). */
const SEP = formatShortDate("2026-09-23T08:00:00.000Z", ZONE, new Date("2026-09-23T08:00:00.000Z")).replace(/^\d+ /, "");

let world: M3World;
let markers = 0;

/** A restore marker as restore.bat writes it: the backup of 08:00 (Berlin) restored at the clock's time. */
function writeMarker(at: Date): string {
  const file = path.join(dir, `RESTORED-${++markers}`);
  fs.writeFileSync(file, JSON.stringify({ version: 3, restoredFrom: "2026-09-23T06:00:00.000Z", at: at.toISOString(), file: "backup.db" }));
  return file;
}
const owner = () => ({ actorId: world.owner.id, actorName: "Arslan" });

beforeAll(async () => {
  world = await setupM3({ testList: [] });
});

beforeEach(async () => {
  world.mg.fake.reset();
  await resetSendingState();
  await dbWrite((c) => c.job.deleteMany({}));
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("lastRestoreView", () => {
  it("is null when there was never a restore", async () => {
    expect(await restore.lastRestoreView(ZONE, new Date())).toBeNull();
  });

  it("while the check runs and sending is paused, then resumed while it still runs, then done", async () => {
    const clock = worldClock(world); // Wednesday 23 Sep 2026, 10:00 in Berlin
    await restore.handleRestoreMarker({ now: clock.now(), markerPath: writeMarker(clock.now()), logger: quiet });

    const paused = await restore.lastRestoreView(ZONE, clock.now());
    expect(paused).toEqual({
      restoredLine: `Restored on 23 ${SEP} at 10:00 from the backup of 23 ${SEP}, 08:00.`,
      report: {
        text: "Checking Mailgun for emails sent after the backup. This finishes about 35 minutes after the restore.",
        risk: false,
        running: true,
        details: [],
      },
      resumeLine: "Sending stays paused until the Owner reads this and clicks Resume in Settings › Sending & Mailgun.",
    });

    // The Owner resumes while the check still runs: recorded.
    clock.advance(5 * 60_000);
    expect((await resumeSending({ ...owner(), now: clock.now() })).resumed).toBe(true);
    expect(await restoreState()).toMatchObject({ status: "pending", resumedAt: clock.now().toISOString(), resumedById: world.owner.id });
    expect((await restore.lastRestoreView(ZONE, clock.now()))!.resumeLine).toBe(
      "Sending was resumed while the check is still running; emails through Mailgun wait until it finishes.",
    );

    // The check finishes with Mailgun checked: the card keeps the report and says who resumed, and when.
    await restore.runRestoreScan({ now: clock.advance(60_000), pass: 1, mailgun: world.mailgun });
    await restore.runRestoreScan({ now: clock.advance(35 * 60_000), pass: 2, mailgun: world.mailgun });
    const done = await restore.lastRestoreView(ZONE, clock.now());
    expect(done!.report).toMatchObject({ risk: false, running: false });
    expect(done!.report.text).toMatch(/^Checked Mailgun for sends after the backup \(.+\): 0 confirmed as sent, 0 found that the backup didn't know about, 0 marked 'Not sure it was sent'\.$/);
    expect(done!.resumeLine).toBe(`Sending was resumed by Arslan on 23 ${SEP} at 10:05.`);
  });

  it("a check that didn't reach Mailgun pauses again; the confirmed resume is recorded", async () => {
    const clock = worldClock(world);
    await restore.handleRestoreMarker({ now: clock.now(), markerPath: writeMarker(clock.now()), logger: quiet });
    await restore.runRestoreScan({ now: clock.now(), pass: 1, mailgun: notConnected });
    const risky = await restore.lastRestoreView(ZONE, clock.now());
    expect(risky!.report).toEqual({
      text: "The app couldn't check Mailgun for emails sent after the backup.",
      risk: true,
      running: false,
      details: ["Why: The Mailgun API key isn't saved yet."],
    });
    expect(risky!.resumeLine).toBe("Sending stays paused until the Owner reads this and clicks Resume in Settings › Sending & Mailgun.");

    clock.advance(40 * 60_000);
    expect((await resumeSending({ ...owner(), now: clock.now(), confirmRestoreRisk: true })).resumed).toBe(true);
    expect(await restoreState()).toMatchObject({ acknowledgedById: world.owner.id, resumedById: world.owner.id, resumedAt: clock.now().toISOString() });
    expect((await restore.lastRestoreView(ZONE, clock.now()))!.resumeLine).toBe(`Sending was resumed by Arslan on 23 ${SEP} at 10:40.`);
  });

  it("a restore pause that is only one cause (paused by hand first) still records the resume", async () => {
    const clock = worldClock(world);
    await pauseSending({ kind: "manual", reason: "checking a complaint", fixText: "Click Resume.", byUserId: world.owner.id, now: clock.now() });
    await restore.handleRestoreMarker({ now: clock.now(), markerPath: writeMarker(clock.now()), logger: quiet });
    expect((await restore.lastRestoreView(ZONE, clock.now()))!.resumeLine).toMatch(/^Sending stays paused/);
    expect((await resumeSending({ ...owner(), now: clock.advance(60_000) })).resumed).toBe(true);
    expect((await restoreState()).resumedById).toBe(world.owner.id);
  });

  it("a pause without a restore cause doesn't touch the last restore", async () => {
    const clock = worldClock(world);
    await setState("restore", {
      status: "done",
      restoredFrom: "2026-09-20T06:00:00.000Z",
      scanFrom: "2026-09-20T05:00:00.000Z",
      markerAt: "2026-09-21T12:00:00.000Z",
      file: "backup.db",
      handledAt: "2026-09-21T12:00:05.000Z",
      report: null,
      acknowledgedAt: null,
      acknowledgedById: null,
      resumedAt: "2026-09-21T13:00:00.000Z",
      resumedById: world.owner.id,
    });
    await pauseSending({ kind: "manual", reason: "a break", fixText: "Click Resume.", byUserId: world.member.id, now: clock.now() });
    expect((await resumeSending({ actorId: world.member.id, actorName: "Ali", now: clock.now() })).resumed).toBe(true);
    expect(await restoreState()).toMatchObject({ resumedAt: "2026-09-21T13:00:00.000Z", resumedById: world.owner.id });
    expect((await restore.lastRestoreView(ZONE, clock.now()))!.resumeLine).toBe(`Sending was resumed by Arslan on 21 ${SEP} at 15:00.`);
  });

  it("a restore from before this version: the acknowledgement names who resumed; else just that it was resumed", async () => {
    const base = {
      status: "done" as const,
      restoredFrom: "2025-12-20T06:00:00.000Z",
      scanFrom: null,
      markerAt: "2025-12-21T12:00:00.000Z",
      file: null,
      handledAt: null,
      report: null,
    };
    await setState("restore", { ...base, acknowledgedAt: "2025-12-21T13:30:00.000Z", acknowledgedById: world.owner.id });
    const now = new Date("2026-09-23T08:00:00.000Z");
    const view = await restore.lastRestoreView(ZONE, now);
    expect(view!.restoredLine).toBe("Restored on 21 Dec 2025 at 13:00 from the backup of 20 Dec 2025, 07:00.");
    expect(view!.resumeLine).toBe("Sending was resumed by Arslan on 21 Dec 2025 at 14:30.");
    await setState("restore", { ...base, acknowledgedAt: null, acknowledgedById: null, restoredFrom: null });
    const bare = await restore.lastRestoreView(ZONE, now);
    expect(bare!.restoredLine).toBe("Restored on 21 Dec 2025 at 13:00 from a backup.");
    expect(bare!.resumeLine).toBe("Sending was resumed.");
  });

  it("a new restore starts a fresh card (the previous resume is forgotten)", async () => {
    const clock = worldClock(world);
    await restore.handleRestoreMarker({ now: clock.now(), markerPath: writeMarker(clock.now()), logger: quiet });
    await resumeSending({ ...owner(), now: clock.advance(60_000) });
    expect((await restoreState()).resumedAt).toBeTruthy();
    await dbWrite((c) => c.systemState.deleteMany({ where: { key: "sending.pause" } }));
    await restore.handleRestoreMarker({ now: clock.advance(60 * 60_000), markerPath: writeMarker(clock.now()), logger: quiet });
    const fresh = await restoreState();
    expect(fresh.status).toBe("pending");
    expect(fresh.resumedAt).toBeUndefined();
    expect(fresh.resumedById).toBeUndefined();
  });
});
