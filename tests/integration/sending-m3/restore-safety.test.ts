import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { setSettingValue } from "../campaigns/seed";
import { clearPacer, launchTo, resetSendingState, setupM3, tickDeps, worldClock, type M3World } from "./helpers";

/**
 * The restore hold can always be ended, and copies are recognised (M3-DESIGN §4.3.7; review CRASH-3, CRASH-4, CRASH-6):
 *  - a restore check that fails or can't reach Mailgun after the Owner resumed pauses sending again, so the pause card
 *    with its tick box comes back and the confirmation ends the hold;
 *  - a check left "running" with no job to finish it is failed at the next start;
 *  - a database copied at the same place (the app folder copied to another computer, the file swapped for another
 *    database, or, M6-DESIGN §3.7 L8, the database file alone copied to a new PC) pauses sending, while normal
 *    restarts and restores don't.
 * Only the local fake Mailgun is used.
 */

const t = await createTestDb("m3-restore-safety");
const { db, dbWrite } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");
const restore = await import("@/server/services/sending/restore");
const { getPauseState, pauseSending, resumeSending } = await import("@/server/services/sending/pause");
const { readTyped } = await import("@/server/state-typed");
const { setState } = await import("@/server/state");
const { parseRestoreState } = await import("@/core/system-state-parse");
const { restoreScanJob } = await import("../../../worker/jobs/mailgun-restore-scan");

const LIST = ["s1@safety-1.de", "s2@safety-2.de"];
const [A, B] = LIST as [string, string];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-restore-safety-"));
type Log = { info?: (m: string) => void; warn: (m: string) => void; error: (m: string, err?: unknown) => void };
const quiet: Log = { info: () => undefined, warn: () => undefined, error: () => undefined };
const notConnected = async () => ({ connected: false as const, reason: "no-key" as const, text: "The Mailgun API key isn't saved yet." });

let world: M3World;

beforeAll(async () => {
  world = await setupM3({ testList: LIST });
});

beforeEach(async () => {
  world.mg.fake.reset();
  await resetSendingState();
  await setSettingValue("sending.testList", LIST);
  await setSettingValue("sending.mode", "LIVE");
  await dbWrite(async (c) => {
    await c.job.deleteMany({});
    await c.notification.deleteMany({});
    await c.systemState.deleteMany({ where: { key: "instance" } });
    await c.outboundEmail.updateMany({ where: { status: "SENT" }, data: { sentAt: new Date("2020-01-01T00:00:00Z") } });
  });
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

let markers = 0;
function writeMarker(at: Date): string {
  const file = path.join(dir, `RESTORED-${++markers}`);
  fs.writeFileSync(file, JSON.stringify({ version: 3, restoredFrom: "2026-09-23T06:00:00.000Z", at: at.toISOString(), file: "backup.db" }));
  return file;
}

const restoreState = async () => (await readTyped("restore", parseRestoreState)).value;
const owner = () => ({ actorId: world.owner.id, actorName: "Arslan" });

describe("a restore check that ends without covering Mailgun after the Owner resumed (CRASH-3)", () => {
  it("fails for good: sending pauses again, the tick box is asked for, and confirming ends the hold", async () => {
    const clock = worldClock(world);
    await restore.handleRestoreMarker({ now: clock.now(), markerPath: writeMarker(clock.now()), logger: quiet });
    // "The restore check is still running. Resume now and dry runs continue": the Owner resumes.
    expect((await resumeSending({ ...owner(), now: clock.now() })).resumed).toBe(true);
    expect((await getPauseState()).paused).toBe(false);
    await dbWrite((c) => c.notification.deleteMany({}));

    // The check then fails for good (the job's failure notice).
    restoreScanJob.failureNotice!({ pass: 2 }, "Mailgun didn't answer.");
    await vi.waitFor(async () => expect(await getPauseState()).toMatchObject({ paused: true, kind: "restore", reason: "restored from a backup" }));
    expect(await restoreState()).toMatchObject({ status: "failed", acknowledgedAt: null });
    expect(await db.notification.count({ where: { type: "sending.paused", title: "Sending paused: restored from a backup" } })).toBe(1);

    // Mailgun emails wait; resuming without the tick box is refused.
    await launchTo(world, [A], { now: clock.now() });
    await clearPacer();
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ paused: true, sent: 0 });
    const refused = await resumeSending({ ...owner(), now: clock.now() });
    expect(refused.resumed).toBe(false);
    expect(refused.summary).toMatch(/^Tick the box to confirm that emails sent after .+ may go out a second time\.$/);

    // Confirmed: acknowledged, the hold ends and the email goes.
    expect((await resumeSending({ ...owner(), now: clock.now(), confirmRestoreRisk: true })).resumed).toBe(true);
    const state = await restoreState();
    expect(state.acknowledgedById).toBe(world.owner.id);
    expect(restore.restoreHoldActive(state)).toBe(false);
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);

    // Once acknowledged, nothing pauses again for this restore.
    await restore.markRestoreScanFailed("Mailgun didn't answer again.", clock.now());
    await restore.settleRestoreCheck({ now: clock.now(), logger: quiet });
    expect((await getPauseState()).paused).toBe(false);
  });

  it("can't reach Mailgun: sending pauses again with the restore cause", async () => {
    const clock = worldClock(world);
    await restore.handleRestoreMarker({ now: clock.now(), markerPath: writeMarker(clock.now()), logger: quiet });
    expect((await resumeSending({ ...owner(), now: clock.now() })).resumed).toBe(true);
    const report = await restore.runRestoreScan({ now: clock.now(), pass: 1, mailgun: notConnected });
    expect(report.mailgunChecked).toBe(false);
    expect(await getPauseState()).toMatchObject({ paused: true, kind: "restore" });
    expect(restore.restoreNeedsAcknowledgement(await restoreState())).toBe(true);
    expect((await resumeSending({ ...owner(), now: clock.now() })).resumed).toBe(false);
    expect((await resumeSending({ ...owner(), now: clock.now(), confirmRestoreRisk: true })).resumed).toBe(true);
  });

  it("paused by hand meanwhile: the restore cause is added, and resuming still needs the tick box", async () => {
    const clock = worldClock(world);
    await restore.handleRestoreMarker({ now: clock.now(), markerPath: writeMarker(clock.now()), logger: quiet });
    expect((await resumeSending({ ...owner(), now: clock.now() })).resumed).toBe(true);
    await pauseSending({ kind: "manual", reason: "checking a complaint", fixText: "Click Resume.", byUserId: world.owner.id, now: clock.now() });
    await restore.markRestoreScanFailed("Mailgun didn't answer.", clock.now());
    const pause = await getPauseState();
    expect(pause).toMatchObject({ paused: true, kind: "manual" });
    expect(pause.also.map((a) => a.kind)).toEqual(["restore"]);
    expect((await resumeSending({ ...owner(), now: clock.now() })).resumed).toBe(false);
    expect((await resumeSending({ ...owner(), now: clock.now(), confirmRestoreRisk: true })).resumed).toBe(true);
  });

  it("a check that finishes with Mailgun checked never pauses again", async () => {
    const clock = worldClock(world);
    await restore.handleRestoreMarker({ now: clock.now(), markerPath: writeMarker(clock.now()), logger: quiet });
    expect((await resumeSending({ ...owner(), now: clock.now() })).resumed).toBe(true);
    await restore.runRestoreScan({ now: clock.advance(60_000), pass: 1, mailgun: world.mailgun });
    await restore.runRestoreScan({ now: clock.advance(35 * 60_000), pass: 2, mailgun: world.mailgun });
    expect(await restoreState()).toMatchObject({ status: "done", report: { mailgunChecked: true } });
    expect((await getPauseState()).paused).toBe(false);
    await launchTo(world, [B], { now: clock.now() });
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
  });
});

describe("a restore check left behind at start-up (CRASH-4)", () => {
  const scanning = (status: "pending" | "scanning" | "failed" | "done", extra: object = {}) =>
    setState("restore", {
      status,
      restoredFrom: "2026-09-23T06:00:00.000Z",
      scanFrom: "2026-09-23T05:00:00.000Z",
      markerAt: "2026-09-23T08:00:00.000Z",
      file: "backup.db",
      handledAt: "2026-09-23T08:00:00.000Z",
      report: null,
      acknowledgedAt: null,
      acknowledgedById: null,
      ...extra,
    });

  it("still 'scanning' with no job queued or running: failed, and sending pauses for the confirmation", async () => {
    await scanning("scanning");
    // No marker: the start-up only settles what it finds.
    expect(await restore.handleRestoreMarker({ now: new Date(), markerPath: path.join(dir, "none"), logger: quiet })).toEqual({ handled: false });
    expect(await restoreState()).toMatchObject({ status: "failed", report: { error: restore.RESTORE_CHECK_STOPPED } });
    expect(await getPauseState()).toMatchObject({ paused: true, kind: "restore" });
    expect(restore.restoreHoldActive(await restoreState())).toBe(true);
  });

  it("a queued or running check is left alone", async () => {
    await scanning("scanning");
    const { enqueueJob } = await import("@/server/jobs");
    await enqueueJob({ type: "mailgun.restoreScan", payload: { pass: 2 }, runAt: new Date(Date.now() + 30 * 60_000), dedupeKey: restore.RESTORE_SCAN_SECOND_DEDUPE });
    await restore.settleRestoreCheck({ logger: quiet });
    expect((await restoreState()).status).toBe("scanning");
    expect((await getPauseState()).paused).toBe(false);
    await dbWrite((c) => c.job.updateMany({ data: { status: "RUNNING" } }));
    await restore.settleRestoreCheck({ logger: quiet });
    expect((await restoreState()).status).toBe("scanning");
  });

  it("failed or unchecked and not acknowledged, but not paused (the pause couldn't be written): paused now", async () => {
    await scanning("failed", { report: { ...emptyReport(), error: "Mailgun didn't answer." } });
    await restore.settleRestoreCheck({ logger: quiet });
    expect(await getPauseState()).toMatchObject({ paused: true, kind: "restore" });
    await resetSendingState();
    await scanning("done", { report: { ...emptyReport(), mailgunChecked: false } });
    await restore.settleRestoreCheck({ logger: quiet });
    expect((await getPauseState()).kind).toBe("restore");
  });

  it("acknowledged, checked, or no restore at all: nothing happens", async () => {
    await scanning("failed", { acknowledgedAt: "2026-09-23T09:00:00.000Z", acknowledgedById: world.owner.id, report: emptyReport() });
    await restore.settleRestoreCheck({ logger: quiet });
    await scanning("done", { report: { ...emptyReport(), mailgunChecked: true } });
    await restore.settleRestoreCheck({ logger: quiet });
    await resetSendingState();
    await restore.settleRestoreCheck({ logger: quiet });
    await restore.markRestoreScanFailed("no restore", new Date());
    expect((await restoreState()).status).toBe("none");
    expect((await getPauseState()).paused).toBe(false);
  });
});

function emptyReport() {
  return {
    finishedAt: "2026-09-23T09:00:00.000Z",
    mailgunChecked: false,
    passes: 1,
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
    error: null,
  };
}

describe("copies at the same place (CRASH-6)", () => {
  let note: string;
  let n = 0;
  beforeEach(() => {
    note = path.join(dir, `app-${++n}.db.instance`);
  });

  const check = (host: string, markerSeen = false, logger = quiet) =>
    restore.checkDatabaseInstance({ now: new Date("2026-09-23T08:00:00.000Z"), markerSeen, notePath: note, hostName: host, logger });
  const instance = async () =>
    (await db.systemState.findUniqueOrThrow({ where: { key: "instance" } })).value as { dbPath: string; id: string; firstSeenAt: string; host?: string };
  const readNote = () => JSON.parse(fs.readFileSync(note, "utf8")) as { version: number; id: string; host: string; dbPath: string };
  const clearPause = () => dbWrite((c) => c.systemState.deleteMany({ where: { key: "sending.pause" } }));

  it("the note lives next to the database file", () => {
    expect(restore.instanceNotePath()).toBe(path.resolve(t.file) + ".instance");
  });

  it("first start and normal restarts never pause; the note names this database and this computer", async () => {
    expect(await check("OFFICE-PC")).toEqual({ copied: false });
    const first = await instance();
    expect(readNote()).toMatchObject({ version: 1, id: first.id, host: "OFFICE-PC", dbPath: first.dbPath });
    for (let i = 0; i < 3; i++) expect(await check("OFFICE-PC")).toEqual({ copied: false });
    // Windows may report the name in another case: the same computer.
    expect(await check("office-pc")).toEqual({ copied: false });
    expect((await getPauseState()).paused).toBe(false);
    expect((await instance()).id).toBe(first.id);
  });

  it("the whole app folder copied to another computer (same place): paused, naming the other computer", async () => {
    await check("OFFICE-PC");
    expect(await check("NEW-LAPTOP")).toEqual({ copied: true });
    const pause = await getPauseState();
    expect(pause).toMatchObject({ paused: true, kind: "copied-database", reason: "this database last ran on another computer" });
    expect(pause.fixText).toBe(
      "The app's database last ran on another computer (OFFICE-PC). If the app still runs there, don't resume: both computers would send the same emails. If you moved the app to this computer on purpose, click Resume.",
    );
    // Recorded: once the Owner resumes, the next start here is normal.
    expect(readNote().host).toBe("NEW-LAPTOP");
    await clearPause();
    expect(await check("NEW-LAPTOP")).toEqual({ copied: false });
    expect((await getPauseState()).paused).toBe(false);
  });

  it("another database put in place of the file by hand: paused", async () => {
    await check("OFFICE-PC");
    const here = await instance();
    await setState("instance", { dbPath: here.dbPath, id: "database-from-elsewhere", firstSeenAt: "2026-09-01T00:00:00.000Z" });
    expect(await check("OFFICE-PC")).toEqual({ copied: true });
    expect(await getPauseState()).toMatchObject({ paused: true, kind: "copied-database", reason: "the database file was replaced" });
    expect(readNote().id).toBe("database-from-elsewhere");
    await clearPause();
    expect(await check("OFFICE-PC")).toEqual({ copied: false });
  });

  it("a restore (marker seen) never pauses here, whatever changed; it only records the new state", async () => {
    await check("OFFICE-PC");
    const here = await instance();
    await setState("instance", { dbPath: here.dbPath, id: "restored-backup", firstSeenAt: here.firstSeenAt });
    expect(await check("NEW-LAPTOP", true)).toEqual({ copied: false });
    expect((await getPauseState()).paused).toBe(false);
    expect(readNote()).toMatchObject({ id: "restored-backup", host: "NEW-LAPTOP" });
    expect(await check("NEW-LAPTOP")).toEqual({ copied: false });
  });

  it("a database that ran before the note existed, or an unreadable note: recorded, never paused", async () => {
    await check("OFFICE-PC");
    fs.rmSync(note);
    expect(await check("OFFICE-PC")).toEqual({ copied: false });
    expect(fs.existsSync(note)).toBe(true);
    fs.writeFileSync(note, "{ half a no");
    expect(await check("OFFICE-PC")).toEqual({ copied: false });
    expect(readNote().host).toBe("OFFICE-PC");
    expect((await getPauseState()).paused).toBe(false);
  });

  it("another place still wins (the existing check): moved or copied", async () => {
    await check("OFFICE-PC");
    await setState("instance", { dbPath: "d:/elsewhere/app.db", id: "abc", firstSeenAt: "2026-09-01T00:00:00.000Z" });
    expect(await check("NEW-LAPTOP")).toEqual({ copied: true });
    expect(await getPauseState()).toMatchObject({ kind: "copied-database", reason: "this database was copied or moved" });
  });

  it("the database file alone copied to the same place on a new PC (no note there): paused, naming the old computer (M6, L8)", async () => {
    await check("OFFICE-PC");
    // The database remembers the computer it last started on.
    expect((await instance()).host).toBe("OFFICE-PC");
    // A fresh install on the new PC, then data\app.db alone copied over: no note next to it.
    fs.rmSync(note);
    expect(await check("NEW-LAPTOP")).toEqual({ copied: true });
    const pause = await getPauseState();
    expect(pause).toMatchObject({ paused: true, kind: "copied-database", reason: "this database last ran on another computer" });
    expect(pause.fixText).toContain("another computer (OFFICE-PC)");
    // Recorded: once the Owner resumes, the next start here is normal (a renamed PC costs one Resume the same way).
    expect((await instance()).host).toBe("NEW-LAPTOP");
    expect(readNote().host).toBe("NEW-LAPTOP");
    await clearPause();
    expect(await check("NEW-LAPTOP")).toEqual({ copied: false });
    expect(await check("new-laptop")).toEqual({ copied: false });
    expect((await getPauseState()).paused).toBe(false);
  });

  it("a database from before M6 (no computer recorded) without a note: recorded, never paused", async () => {
    await check("OFFICE-PC");
    const here = await instance();
    await setState("instance", { dbPath: here.dbPath, id: here.id, firstSeenAt: here.firstSeenAt });
    fs.rmSync(note);
    expect(await check("NEW-LAPTOP")).toEqual({ copied: false });
    expect((await getPauseState()).paused).toBe(false);
    expect((await instance()).host).toBe("NEW-LAPTOP");
  });

  it("a restore marker still wins over the computer the database knows", async () => {
    await check("OFFICE-PC");
    fs.rmSync(note);
    expect(await check("NEW-LAPTOP", true)).toEqual({ copied: false });
    expect((await getPauseState()).paused).toBe(false);
  });

  it("a note that can't be written is logged and doesn't stop the start-up", async () => {
    fs.mkdirSync(path.join(note, "in-the-way"), { recursive: true });
    const warnings: string[] = [];
    expect(await check("OFFICE-PC", false, { ...quiet, warn: (m: string) => void warnings.push(m) })).toEqual({ copied: false });
    expect(warnings.some((w) => /^Couldn't write .+\.instance next to the database/.test(w))).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("copyCause (pure)", () => {
    const cur = { dbPath: "c:/a/app.db", id: "x", firstSeenAt: "2026-09-01T00:00:00.000Z" };
    expect(restore.copyCause(null, { id: "y", host: "PC" }, "c:/a/app.db", "PC")).toBeNull();
    expect(restore.copyCause(cur, null, "c:/a/app.db", "PC")).toBeNull();
    expect(restore.copyCause(cur, null, "c:/b/app.db", "PC")).toBe("moved");
    expect(restore.copyCause(cur, { id: "x", host: "OLD" }, "c:/a/app.db", "PC")).toBe("other-computer");
    expect(restore.copyCause(cur, { id: "y", host: "pc" }, "c:/a/app.db", "PC")).toBe("replaced");
    expect(restore.copyCause(cur, { id: "x", host: "pc" }, "c:/a/app.db", "PC")).toBeNull();
    // M6 (L8): without the note, the computer the database itself names decides.
    expect(restore.copyCause({ ...cur, host: "OLD" }, null, "c:/a/app.db", "PC")).toBe("other-computer");
    expect(restore.copyCause({ ...cur, host: "pc" }, null, "c:/a/app.db", "PC")).toBeNull();
    expect(restore.copyCause({ ...cur, host: "OLD" }, null, "c:/b/app.db", "PC")).toBe("moved");
    // With the note, the note decides (as before).
    expect(restore.copyCause({ ...cur, host: "OLD" }, { id: "x", host: "PC" }, "c:/a/app.db", "PC")).toBeNull();
  });
});
