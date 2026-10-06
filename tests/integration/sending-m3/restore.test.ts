import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { setSettingValue } from "../campaigns/seed";
import { clearPacer, launchTo, resetSendingState, setupM3, tickDeps, worldClock, type M3World, type TestClock } from "./helpers";

/**
 * After a restore, and for a copied database (PLAN B6.7, M3-DESIGN §4.3.7): sending pauses, Mailgun's logs are checked
 * twice for emails sent after the backup, every one of them is recorded as sent (never sent again), and emails the
 * backup never knew about become ExternalSend rows.
 */

const t = await createTestDb("m3-restore");
const { db, dbWrite } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");
const restore = await import("@/server/services/sending/restore");
const { getPauseState, resumeSending } = await import("@/server/services/sending/pause");
const { readTyped } = await import("@/server/state-typed");
const { setState } = await import("@/server/state");
const { parseRestoreState } = await import("@/core/system-state-parse");
const { restoreScanJob, restorePassFromPayload } = await import("../../../worker/jobs/mailgun-restore-scan");

const LIST = ["x1@restore-1.de", "x2@restore-2.de", "x3@restore-3.de", "x4@restore-4.de", "x5@restore-5.de"];
const [A, B, C, D, E] = LIST as [string, string, string, string, string];
const MIN = 60_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-restore-"));
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

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
    await c.externalSend.deleteMany({});
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

function writeMarker(name: string, marker: object): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(marker));
  return file;
}

/** Sends one live email for real (Mailgun has it and its accepted event). */
async function sendOne(clock: TestClock, to: string) {
  const launched = await launchTo(world, [to], { now: clock.now() });
  await clearPacer();
  expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
  return { ...launched, email: await db.outboundEmail.findFirstOrThrow({ where: { campaignId: launched.campaignId } }) };
}

describe("handleRestoreMarker", () => {
  it("pauses, queues the check, records the restore and deletes the marker; a second start changes nothing", async () => {
    const clock = worldClock(world);
    const at = clock.now().toISOString();
    const file = writeMarker("RESTORED-1", { version: 3, restoredFrom: "2026-09-23T06:00:00.000Z", at, file: "backup-1.db" });
    expect(await restore.handleRestoreMarker({ now: clock.now(), markerPath: file, logger: quiet })).toEqual({ handled: true });
    expect(fs.existsSync(file)).toBe(false);
    expect(await getPauseState()).toMatchObject({ paused: true, kind: "restore", reason: "restored from a backup" });
    const state = (await readTyped("restore", parseRestoreState)).value;
    expect(state).toMatchObject({ status: "pending", restoredFrom: "2026-09-23T06:00:00.000Z", markerAt: at, file: "backup-1.db" });
    expect(await db.job.count({ where: { type: "mailgun.restoreScan", activeDedupeKey: "mailgun:restore-scan", priority: 40 } })).toBe(1);
    // No marker: nothing to do.
    expect(await restore.handleRestoreMarker({ now: clock.now(), markerPath: file, logger: quiet })).toEqual({ handled: false });
  });

  it("a crash after any step still ends paused, and repeating is harmless", async () => {
    const clock = worldClock(world);
    const at = clock.now().toISOString();
    const marker = { version: 3, restoredFrom: "2026-09-23T06:00:00.000Z", at, file: "b.db" };
    // Crashed after step 1 (paused, nothing else).
    await (await import("@/server/services/sending/pause")).pauseSending({ ...restore.RESTORE_PAUSE, now: clock.now() });
    let file = writeMarker("RESTORED-2", marker);
    await restore.handleRestoreMarker({ now: clock.now(), markerPath: file, logger: quiet });
    expect((await readTyped("restore", parseRestoreState)).value.status).toBe("pending");
    expect(await db.job.count({ where: { type: "mailgun.restoreScan" } })).toBe(1);
    // Crashed after step 3 (the marker is still there): only the marker goes.
    file = writeMarker("RESTORED-2", marker);
    await restore.handleRestoreMarker({ now: clock.now(), markerPath: file, logger: quiet });
    expect(fs.existsSync(file)).toBe(false);
    expect(await db.job.count({ where: { type: "mailgun.restoreScan" } })).toBe(1);
    expect((await getPauseState()).paused).toBe(true);
  });

  it("ignores a marker that can't be deleted (an antivirus lock)", async () => {
    const clock = worldClock(world);
    const file = writeMarker("RESTORED-3", { version: 3, restoredFrom: null, at: clock.now().toISOString(), file: null });
    const warnings: string[] = [];
    const locked = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
      const err = new Error("EBUSY: resource busy or locked") as NodeJS.ErrnoException;
      err.code = "EBUSY";
      throw err;
    });
    try {
      const res = await restore.handleRestoreMarker({ now: clock.now(), markerPath: file, logger: { ...quiet, warn: (m: string) => warnings.push(m) } });
      expect(res.handled).toBe(true);
    } finally {
      locked.mockRestore();
    }
    expect(warnings.some((w) => /Couldn't delete the restore marker \(EBUSY\)/.test(w))).toBe(true);
    expect((await getPauseState()).kind).toBe("restore");
    // The next start finds the same marker: it is only deleted now, nothing is repeated.
    expect(await restore.handleRestoreMarker({ now: clock.now(), markerPath: file, logger: quiet })).toEqual({ handled: true });
    expect(fs.existsSync(file)).toBe(false);
    expect(await db.job.count({ where: { type: "mailgun.restoreScan" } })).toBe(1);
  });

  it("starts the scan from the newest activity when it is earlier than the backup time", async () => {
    const clock = worldClock(world);
    await dbWrite(async (c) => {
      await c.activityLog.deleteMany({});
      await c.activityLog.create({ data: { at: new Date("2026-09-23T04:00:00Z"), type: "company.updated", summary: "Last change in the backup" } });
    });
    let file = writeMarker("RESTORED-4", { version: 3, restoredFrom: "2026-09-23T07:00:00.000Z", at: clock.now().toISOString(), file: null });
    await restore.handleRestoreMarker({ now: clock.now(), markerPath: file, logger: quiet });
    expect((await readTyped("restore", parseRestoreState)).value.scanFrom).toBe("2026-09-23T03:00:00.000Z");
    // A backup made before the newest activity: the backup time decides.
    await dbWrite((c) => c.systemState.deleteMany({ where: { key: { in: ["restore", "sending.pause"] } } }));
    file = writeMarker("RESTORED-5", { version: 3, restoredFrom: "2026-09-23T02:00:00.000Z", at: new Date(clock.now().getTime() + 1_000).toISOString(), file: null });
    await restore.handleRestoreMarker({ now: clock.now(), markerPath: file, logger: quiet });
    expect((await readTyped("restore", parseRestoreState)).value.scanFrom).toBe("2026-09-23T01:00:00.000Z");
  });
});

describe("the restore check with Mailgun", () => {
  it("records the sends the backup didn't know, holds Mailgun emails until the second pass, and never sends twice", async () => {
    const clock = worldClock(world);
    const sent = await sendOne(clock, A);
    // The backup (made before that send) still has the email waiting.
    await dbWrite(async (c) => {
      await c.outboundEmail.update({ where: { id: sent.email.id }, data: { status: "QUEUED", sentAt: null, providerId: null, claimedAt: null } });
      await c.campaignRecipient.updateMany({ where: { campaignId: sent.campaignId }, data: { state: "SCHEDULED" } });
      await c.campaign.update({ where: { id: sent.campaignId }, data: { status: "RUNNING", finishedAt: null } });
    });
    const markerAt = clock.advance(10 * MIN);
    const file = writeMarker("RESTORED-6", { version: 3, restoredFrom: new Date(markerAt.getTime() - 20 * MIN).toISOString(), at: markerAt.toISOString(), file: null });
    await restore.handleRestoreMarker({ now: markerAt, markerPath: file, logger: quiet });
    // Resuming now is allowed (the check still runs), but Mailgun emails wait for it.
    expect((await resumeSending({ actorId: world.owner.id, actorName: "Arslan", now: markerAt })).resumed).toBe(true);
    await clearPacer();
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ picked: 0, waiting: { reason: "restore-check" } });

    const report = await restore.runRestoreScan({ now: clock.advance(MIN), pass: 1, mailgun: world.mailgun });
    expect(report).toMatchObject({ mailgunChecked: true, passes: 1, acceptedEvents: 1, matchedByMessageId: 1, externalSends: 0 });
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: sent.email.id } })).toMatchObject({ status: "SENT", providerId: sent.email.messageId });
    expect((await readTyped("restore", parseRestoreState)).value.status).toBe("scanning");
    const second = await db.job.findFirstOrThrow({ where: { type: "mailgun.restoreScan", activeDedupeKey: "mailgun:restore-scan-2" } });
    expect(second.runAt.toISOString()).toBe(new Date(markerAt.getTime() + 35 * MIN).toISOString());
    expect(restorePassFromPayload(second.payload)).toBe(2);
    // Still held until the second pass.
    await launchTo(world, [B], { now: clock.now() });
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ picked: 0, waiting: { reason: "restore-check" } });

    const report2 = await restore.runRestoreScan({ now: clock.advance(35 * MIN), pass: 2, mailgun: world.mailgun });
    expect(report2).toMatchObject({ passes: 2, matchedByMessageId: 1 });
    expect((await readTyped("restore", parseRestoreState)).value.status).toBe("done");
    expect(await db.notification.count({ where: { type: "restore.checked", title: "Restore check finished" } })).toBe(1);
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    // A was never sent a second time.
    expect(world.mg.fake.messages.filter((m) => m.fields.to?.[0] === A)).toHaveLength(1);
  });

  it("matches by (campaign, step, recipient) only for campaigns the backup knew; creates the missing row and links earlier events", async () => {
    const clock = worldClock(world);
    const restoredFrom = new Date(clock.now().getTime() + MIN);
    // Known campaign: launched before the backup; its email went out after it.
    const known = await launchTo(world, [C], { now: clock.now() });
    clock.advance(2 * MIN);
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    const knownEmail = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: known.campaignId } });
    // Unknown to the backup: the row itself. A report for it is already stored, unlinked.
    await dbWrite(async (c) => {
      await c.outboundEmail.delete({ where: { id: knownEmail.id } });
      await c.campaignRecipient.updateMany({ where: { campaignId: known.campaignId }, data: { state: "SCHEDULED" } });
      await c.campaign.update({ where: { id: known.campaignId }, data: { status: "RUNNING", finishedAt: null } });
      await c.mailEvent.create({
        data: {
          dedupeKey: "delivered-before-restore",
          type: "delivered",
          occurredAt: new Date(clock.now().getTime() + 30_000),
          messageId: knownEmail.messageId,
          recipient: C,
          source: "WEBHOOK",
          raw: {},
          processedAt: new Date(),
        },
      });
    });
    // A campaign created AFTER the restore that happens to have an old campaign's id is never matched: simulate by a
    // campaign launched after `restoredFrom` whose email Mailgun has but whose row is gone.
    const later = await launchTo(world, [D], { now: clock.now() });
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    const laterEmail = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: later.campaignId } });
    await dbWrite((c) => c.outboundEmail.delete({ where: { id: laterEmail.id } }));

    await setState("restore", {
      status: "pending",
      restoredFrom: restoredFrom.toISOString(),
      scanFrom: new Date(clock.now().getTime() - 60 * MIN).toISOString(),
      markerAt: clock.now().toISOString(),
      file: null,
      handledAt: null,
      report: null,
      acknowledgedAt: null,
      acknowledgedById: null,
    });
    const report = await restore.runRestoreScan({ now: clock.advance(5 * MIN), pass: 1, mailgun: world.mailgun });
    expect(report).toMatchObject({ acceptedEvents: 2, matchedByRecipient: 1, rowsCreated: 1, externalSends: 1 });

    const recreated = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: known.campaignId, step: 0 } });
    expect(recreated).toMatchObject({ status: "SENT", messageId: knownEmail.messageId, providerId: knownEmail.messageId, toNorm: C });
    expect(recreated.deliveredAt?.toISOString()).toBe(new Date(knownEmail.sentAt!.getTime() + 30_000).toISOString());
    expect((await db.mailEvent.findUniqueOrThrow({ where: { dedupeKey: "delivered-before-restore" } })).outboundEmailId).toBe(recreated.id);

    const external = await db.externalSend.findFirstOrThrow({ where: { toNorm: D } });
    expect(external).toMatchObject({ source: "RESTORE", providerMessageId: laterEmail.messageId, companyId: later.companyIds[0] });
    // Idempotent: a second pass adds nothing.
    const again = await restore.runRestoreScan({ now: clock.advance(MIN), pass: 2, mailgun: world.mailgun });
    expect(again).toMatchObject({ rowsCreated: 0, externalSends: 0 });
    expect(await db.externalSend.count({ where: { toNorm: D } })).toBe(1);
    expect(await db.outboundEmail.count({ where: { campaignId: known.campaignId } })).toBe(1);
  });

  it("an old backup: emails due before the restore become 'Not sure it was sent'", async () => {
    const clock = worldClock(world);
    const waiting = await launchTo(world, [E], { now: clock.now() });
    const markerAt = clock.advance(MIN);
    await setState("restore", {
      status: "pending",
      restoredFrom: new Date(markerAt.getTime() - 10 * 86_400_000).toISOString(),
      scanFrom: new Date(markerAt.getTime() - 10 * 86_400_000).toISOString(),
      markerAt: markerAt.toISOString(),
      file: null,
      handledAt: null,
      report: null,
      acknowledgedAt: null,
      acknowledgedById: null,
    });
    const report = await restore.runRestoreScan({ now: clock.advance(MIN), pass: 1, mailgun: world.mailgun });
    expect(report).toMatchObject({ olderThanRetention: true, madeUnconfirmed: 1 });
    expect(await db.outboundEmail.findFirstOrThrow({ where: { campaignId: waiting.campaignId } })).toMatchObject({
      status: "UNCONFIRMED",
      lastError: "Restored from an older backup: we can't check whether this email went out before the restore",
    });
  });

  it("without Mailgun the report says so; a failed check needs the Owner's confirmation to resume", async () => {
    const clock = worldClock(world);
    const file = writeMarker("RESTORED-7", { version: 3, restoredFrom: "2026-09-20T12:00:00.000Z", at: clock.now().toISOString(), file: null });
    await restore.handleRestoreMarker({ now: clock.now(), markerPath: file, logger: quiet });
    const report = await restore.runRestoreScan({
      now: clock.now(),
      pass: 1,
      mailgun: async () => ({ connected: false, reason: "no-key", text: "The Mailgun API key isn't saved yet. Open Settings › Sending & Mailgun." }),
    });
    expect(report.mailgunChecked).toBe(false);
    expect((await readTyped("restore", parseRestoreState)).value.status).toBe("done");
    expect(restore.restoreHoldActive((await readTyped("restore", parseRestoreState)).value)).toBe(true);

    const refused = await resumeSending({ actorId: world.owner.id, actorName: "Arslan", now: clock.now() });
    expect(refused.resumed).toBe(false);
    expect(refused.summary).toMatch(/^Tick the box to confirm that emails sent after .+ may go out a second time\.$/);
    const ok = await resumeSending({ actorId: world.owner.id, actorName: "Arslan", now: clock.now(), confirmRestoreRisk: true });
    expect(ok.resumed).toBe(true);
    const state = (await readTyped("restore", parseRestoreState)).value;
    expect(state.acknowledgedById).toBe(world.owner.id);
    expect(restore.restoreHoldActive(state)).toBe(false);
  });

  it("a check that fails for good holds Mailgun emails until the Owner resumes with the confirmation", async () => {
    const clock = worldClock(world);
    const file = writeMarker("RESTORED-8", { version: 3, restoredFrom: "2026-09-23T06:00:00.000Z", at: clock.now().toISOString(), file: null });
    await restore.handleRestoreMarker({ now: clock.now(), markerPath: file, logger: quiet });
    const notice = restoreScanJob.failureNotice!({ pass: 1 }, "Mailgun didn't answer.");
    expect(notice).toMatchObject({ type: "restore.checked", title: "The restore check with Mailgun failed", link: "/settings/sending" });
    expect(notice.body).toMatch(/^The app couldn't check Mailgun for emails sent after the backup: Mailgun didn't answer\. Open Settings/);
    await vi.waitFor(async () => expect((await readTyped("restore", parseRestoreState)).value.status).toBe("failed"));
    const failed = (await readTyped("restore", parseRestoreState)).value;
    expect(failed.report?.error).toBe("Mailgun didn't answer.");
    expect(restore.restoreHoldActive(failed)).toBe(true);
    // A failure after the check finished changes nothing.
    await setState("restore", { ...failed, status: "done", report: { ...failed.report!, mailgunChecked: true, error: null } });
    await restore.markRestoreScanFailed("late", clock.now());
    expect((await readTyped("restore", parseRestoreState)).value.status).toBe("done");
    await setState("restore", failed);

    expect((await resumeSending({ actorId: world.owner.id, actorName: "Arslan", now: clock.now() })).resumed).toBe(false);
    await launchTo(world, [A], { now: clock.now() });
    await clearPacer();
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ paused: true, sent: 0 });
    expect((await resumeSending({ actorId: world.owner.id, actorName: "Arslan", now: clock.now(), confirmRestoreRisk: true })).resumed).toBe(true);
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
  });
});

describe("a copied database", () => {
  it("pauses when the database opens from a new place without a restore marker; a restore just records it", async () => {
    const now = new Date();
    expect(await restore.checkDatabaseInstance({ now, markerSeen: false })).toEqual({ copied: false });
    expect((await getPauseState()).paused).toBe(false);
    // Same place again: nothing.
    expect(await restore.checkDatabaseInstance({ now, markerSeen: false })).toEqual({ copied: false });

    await setState("instance", { dbPath: "d:/somewhere/else/app.db", id: "abc", firstSeenAt: now.toISOString() });
    expect(await restore.checkDatabaseInstance({ now, markerSeen: true })).toEqual({ copied: false });
    expect((await getPauseState()).paused).toBe(false);

    await setState("instance", { dbPath: "d:/somewhere/else/app.db", id: "abc", firstSeenAt: now.toISOString() });
    expect(await restore.checkDatabaseInstance({ now, markerSeen: false })).toEqual({ copied: true });
    expect(await getPauseState()).toMatchObject({ paused: true, kind: "copied-database", reason: "this database was copied or moved" });
    const stored = (await db.systemState.findUniqueOrThrow({ where: { key: "instance" } })).value as { dbPath: string; id: string };
    expect(stored.id).toBe("abc");
    expect(stored.dbPath).not.toBe("d:/somewhere/else/app.db");
  });
});
