import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailgunContextResult } from "@/server/mailgun/context";
import { acceptedEvent, toLogItem } from "../../fake-mailgun/events";
import { makeUser } from "../campaigns/seed";
import { createTestDb } from "../helpers/test-db";

/**
 * Review fixes to the restore flow (M6 review, the background sender's side):
 *  - BACKUPS-4: a RESTORED marker counts as a restore at start-up only while it isn't handled yet, so a handled one that
 *    couldn't be deleted never turns off the copied-database check; it is deleted by a later try, not only at start-up.
 *  - BACKUPS-5: the backup and restore-check jobs a restored backup still holds are cancelled when the marker is handled
 *    (and at start-up before the orphaned jobs are reset), before the new check is queued.
 *  - BACKUPS-7: the check also walks the sending domains the replaced database had (the marker's `domainsBefore`); when
 *    they couldn't be read, the check isn't complete and resuming needs the Owner's confirmation; an older marker
 *    without the field works as before.
 * Mailgun is a stand-in context whose log walk answers per domain (nothing leaves this process).
 */

const t = await createTestDb("backups-restore-review");
const { db, dbWrite } = await import("@/server/db");
const restore = await import("@/server/services/sending/restore");
const { getPauseState, resumeSending } = await import("@/server/services/sending/pause");
const { readTyped } = await import("@/server/state-typed");
const { parseRestoreState } = await import("@/core/system-state-parse");
const { resetOrphanedJobs } = await import("../../../worker/runner");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-restore-review-"));
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const MIN = 60_000;
let ownerId = 0;

beforeAll(async () => {
  ownerId = (await makeUser("Arslan", { role: "OWNER" })).id;
});

beforeEach(async () => {
  await dbWrite(async (c) => {
    await c.job.deleteMany({});
    await c.notification.deleteMany({});
    await c.externalSend.deleteMany({});
    await c.sendingDomain.deleteMany({});
    await c.systemState.deleteMany({ where: { key: { in: ["restore", "sending.pause", "instance"] } } });
  });
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

let markers = 0;
/** A RESTORED marker as restore.bat writes it, restored at `at` from a backup made a day before. */
function writeMarker(at: Date, extra: Record<string, unknown> = {}, file = path.join(dir, `RESTORED-${++markers}`)): string {
  const restoredFrom = new Date(at.getTime() - 24 * 60 * MIN).toISOString();
  fs.writeFileSync(file, JSON.stringify({ version: 3, restoredFrom, at: at.toISOString(), file: "backup.db", ...extra }));
  return file;
}

const restoreState = async () => (await readTyped("restore", parseRestoreState)).value;
const owner = () => ({ actorId: ownerId, actorName: "Arslan" });

/** unlinkSync fails like an antivirus lock while `run` runs. */
async function withLockedMarker<T>(run: () => Promise<T>): Promise<T> {
  const locked = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
    throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
  });
  try {
    return await run();
  } finally {
    locked.mockRestore();
  }
}

describe("a handled marker that couldn't be deleted (BACKUPS-4)", () => {
  it("no longer counts as a restore at start-up: the whole app folder copied to another PC still pauses", async () => {
    const note = path.join(dir, "app-copy.db.instance");
    const check = async (host: string, markerSeen: boolean) =>
      restore.checkDatabaseInstance({ now: new Date(), markerSeen, notePath: note, hostName: host, logger: quiet });
    expect(await check("PC-A", false)).toEqual({ copied: false });

    // A restore on PC-A; deleting the marker fails.
    const markerAt = new Date(Date.now() - MIN);
    const file = writeMarker(markerAt);
    expect(await restore.restoreMarkerSeen(file)).toBe(true); // waiting to be handled
    await withLockedMarker(() => restore.handleRestoreMarker({ now: markerAt, markerPath: file, logger: quiet }));
    expect(fs.existsSync(file)).toBe(true);
    expect(await restore.restoreMarkerSeen(file)).toBe(false); // handled: not a restore any more

    // The whole folder (the note and the stale marker with it) copied to PC-B and started there: paused as a copy.
    await dbWrite((c) => c.systemState.deleteMany({ where: { key: "sending.pause" } }));
    expect(await check("PC-B", await restore.restoreMarkerSeen(file))).toEqual({ copied: true });
    expect(await getPauseState()).toMatchObject({ paused: true, kind: "copied-database", reason: "this database last ran on another computer" });
  });

  it("is deleted by a later try; one still waiting, or another database's, never is", async () => {
    const markerAt = new Date(Date.now() - MIN);
    const file = writeMarker(markerAt);
    expect(await restore.deleteHandledRestoreMarker({ markerPath: file })).toBe(false);
    expect(fs.existsSync(file)).toBe(true); // not handled yet: the start-up does that

    await withLockedMarker(() => restore.handleRestoreMarker({ now: markerAt, markerPath: file, logger: quiet }));
    const warnings: string[] = [];
    const stillLocked = await withLockedMarker(() =>
      restore.deleteHandledRestoreMarker({ markerPath: file, logger: { ...quiet, warn: (m: string) => void warnings.push(m) } }),
    );
    expect(stillLocked).toBe(false);
    expect(warnings).toEqual(["Couldn't delete the restore marker (EBUSY); it's handled already, and it is tried again later."]);
    expect(await restore.deleteHandledRestoreMarker({ markerPath: file })).toBe(true);
    expect(fs.existsSync(file)).toBe(false);

    // The practice copy's marker in the same folder names its own database: left for it.
    const other = writeMarker(markerAt, { db: "demo.db" });
    expect(await restore.restoreMarkerSeen(other)).toBe(false);
    expect(await restore.deleteHandledRestoreMarker({ markerPath: other })).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
  });

  it("the restore check's passes try again too (the marker next to this database)", async () => {
    const file = restore.restoreMarkerPath();
    const markerAt = new Date(Date.now() - MIN);
    try {
      writeMarker(markerAt, { db: path.basename(t.file) }, file);
      await withLockedMarker(() => restore.handleRestoreMarker({ now: markerAt, logger: quiet }));
      expect(fs.existsSync(file)).toBe(true);
      const { mailgun } = stubMailgun({});
      await restore.runRestoreScan({ now: new Date(), pass: 1, mailgun });
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

describe("jobs the restored backup still held (BACKUPS-5)", () => {
  async function seedCapturedJobs(markerAt: Date) {
    const before = new Date(markerAt.getTime() - 60 * MIN);
    const after = new Date(markerAt.getTime() + MIN);
    return dbWrite(async (c) => ({
      // The backup's own job, RUNNING while its snapshot was taken.
      ownBackup: await c.job.create({
        data: { type: "backup.run", payload: { kind: "MANUAL" }, status: "RUNNING", attempts: 1, activeDedupeKey: "backup:manual", createdById: ownerId, createdAt: before, lockedAt: before, lockedBy: "old" },
      }),
      // An earlier restore's second pass, queued with its time long past.
      oldPass2: await c.job.create({
        data: { type: "mailgun.restoreScan", payload: { pass: 2 }, runAt: before, priority: 40, activeDedupeKey: restore.RESTORE_SCAN_SECOND_DEDUPE, createdAt: before },
      }),
      // Queued after the restore (Back up now clicked meanwhile): a real request, kept.
      later: await c.job.create({ data: { type: "backup.run", payload: { kind: "AUTO" }, activeDedupeKey: "backup:auto", createdAt: after } }),
      // Another kind of task: not this fix's business.
      cleanup: await c.job.create({ data: { type: "system.cleanup", activeDedupeKey: "cleanup", createdAt: before } }),
    }));
  }

  it("are cancelled when the marker is handled, before the new check is queued", async () => {
    const markerAt = new Date(Date.now() - MIN);
    const seeded = await seedCapturedJobs(markerAt);
    await restore.handleRestoreMarker({ now: markerAt, markerPath: writeMarker(markerAt), logger: quiet });
    const byId = async (id: number) => db.job.findUniqueOrThrow({ where: { id } });
    for (const job of [seeded.ownBackup, seeded.oldPass2]) {
      expect(await byId(job.id)).toMatchObject({ status: "CANCELLED", activeDedupeKey: null, lockedBy: null });
    }
    expect(await byId(seeded.later.id)).toMatchObject({ status: "QUEUED", activeDedupeKey: "backup:auto" });
    expect(await byId(seeded.cleanup.id)).toMatchObject({ status: "QUEUED" });
    // The new check's first pass is a new task (not the old one's place taken through the dedupe key).
    const scans = await db.job.findMany({ where: { type: "mailgun.restoreScan", status: "QUEUED" } });
    expect(scans).toHaveLength(1);
    expect(scans[0]).toMatchObject({ payload: { pass: 1 }, activeDedupeKey: restore.RESTORE_SCAN_DEDUPE });
    expect(scans[0]!.id).toBeGreaterThan(seeded.cleanup.id);
    expect(await restoreState()).toMatchObject({ status: "pending" });
  });

  it("at start-up, before the orphaned jobs are reset: a backup job on its last try isn't given up with a false notice", async () => {
    const markerAt = new Date(Date.now() - MIN);
    const lastTry = await dbWrite((c) =>
      c.job.create({
        data: { type: "backup.run", payload: { kind: "MANUAL" }, status: "RUNNING", attempts: 3, maxAttempts: 3, activeDedupeKey: "backup:manual", createdAt: new Date(markerAt.getTime() - 60 * MIN) },
      }),
    );
    const file = writeMarker(markerAt);
    expect(await restore.cancelJobsCapturedInBackup({ markerPath: file, logger: quiet })).toBe(1);
    expect(await resetOrphanedJobs(quiet)).toEqual({ requeued: [], failed: [] });
    expect((await db.job.findUniqueOrThrow({ where: { id: lastTry.id } })).status).toBe("CANCELLED");
    expect(await db.notification.count({ where: { type: "backup.failed" } })).toBe(0);
    // Once the marker is handled, nothing more is cancelled for it.
    await restore.handleRestoreMarker({ now: markerAt, markerPath: file, logger: quiet });
    expect(await restore.cancelJobsCapturedInBackup({ markerPath: writeMarker(markerAt), logger: quiet })).toBe(0);
  });
});

/** A connected Mailgun stand-in: the log walk answers from `eventsByDomain` and records which domains it walked. */
function stubMailgun(eventsByDomain: Record<string, unknown[]>) {
  const walked: string[] = [];
  const client = {
    forRegion: () => client,
    walkLogs: async (q: { filters: Array<{ attribute: string; value: string }> }, onPage: (items: unknown[]) => Promise<void>) => {
      const domain = q.filters.find((f) => f.attribute === "domain")?.value ?? "";
      walked.push(domain);
      const items = eventsByDomain[domain] ?? [];
      if (items.length > 0) await onPage(items);
      return { complete: true, pages: 1, items: items.length, stoppedBecause: items.length > 0 ? "no-next" : "empty" };
    },
  };
  const ctx = { connected: true, domain: "mg.restored.example", region: "EU", domainId: 1, client, sendClient: client, fakeMode: true };
  return { walked, mailgun: async () => ctx as unknown as MailgunContextResult };
}

/** Mailgun's log item for an email accepted on `domain`. */
function accepted(domain: string, to: string, at: Date) {
  return toLogItem(
    acceptedEvent(
      { messageId: `${to.replace("@", ".")}.${at.getTime()}@${domain}`, domain, recipient: to, from: `Arslan <arslan@${domain}>`, to, subject: "Hello", tags: ["outreach"], userVariables: {}, testMode: false },
      at,
    ),
  );
}

describe("the sending domains from before the restore (BACKUPS-7)", () => {
  beforeEach(async () => {
    // The restored backup knows only its own domain.
    await dbWrite((c) => c.sendingDomain.create({ data: { name: "mg.restored.example", region: "EU", active: true } }));
  });

  it("are walked too: a send through a domain connected after the backup is recorded for the 30-day rule", async () => {
    const markerAt = new Date(Date.now() - 5 * MIN);
    const domainsBefore = [
      { name: "mg.restored.example", region: "EU" },
      { name: "mg.newer.example", region: "US" },
    ];
    await restore.handleRestoreMarker({ now: markerAt, markerPath: writeMarker(markerAt, { domainsBefore }), logger: quiet });
    expect((await restoreState()).domainsBefore).toEqual(domainsBefore);

    const { walked, mailgun } = stubMailgun({ "mg.newer.example": [accepted("mg.newer.example", "buyer@studio-one.example", new Date(markerAt.getTime() - 60 * MIN))] });
    const report = await restore.runRestoreScan({ now: new Date(), pass: 1, mailgun });
    expect(walked).toEqual(["mg.restored.example", "mg.newer.example"]); // each once
    expect(report).toMatchObject({ mailgunChecked: true, acceptedEvents: 1, externalSends: 1, error: null });
    expect(await db.externalSend.findFirstOrThrow({ where: { toNorm: "buyer@studio-one.example" } })).toMatchObject({ source: "RESTORE" });
  });

  it("couldn't be read: the check isn't complete, pauses again and needs the Owner's confirmation to resume", async () => {
    const markerAt = new Date(Date.now() - 5 * MIN);
    await restore.handleRestoreMarker({ now: markerAt, markerPath: writeMarker(markerAt, { domainsBefore: null }), logger: quiet });
    expect((await restoreState()).domainsBefore).toBeNull();
    // The Owner resumes while the check still runs.
    expect((await resumeSending({ ...owner(), now: new Date() })).resumed).toBe(true);

    const { walked, mailgun } = stubMailgun({});
    const pass1 = await restore.runRestoreScan({ now: new Date(), pass: 1, mailgun });
    expect(walked).toEqual(["mg.restored.example"]);
    expect(pass1).toMatchObject({ mailgunChecked: false, error: restore.RESTORE_DOMAINS_UNKNOWN });
    expect((await restoreState()).status).toBe("scanning");
    const pass2 = await restore.runRestoreScan({ now: new Date(), pass: 2, mailgun });
    expect(pass2.mailgunChecked).toBe(false);
    const state = await restoreState();
    expect(state.status).toBe("done");
    expect(restore.restoreNeedsAcknowledgement(state)).toBe(true);
    expect(await getPauseState()).toMatchObject({ paused: true, kind: "restore" });
    const view = await restore.lastRestoreView("Asia/Karachi", new Date());
    expect(view!.report.risk).toBe(true);
    expect(view!.report.text).toMatch(/^Checked Mailgun for sends after the backup \(.+\), but not through every sending domain: 0 confirmed as sent/);
    expect(view!.report.details).toEqual([`Why: ${restore.RESTORE_DOMAINS_UNKNOWN}`]);

    expect((await resumeSending({ ...owner(), now: new Date() })).resumed).toBe(false);
    expect((await resumeSending({ ...owner(), now: new Date(), confirmRestoreRisk: true })).resumed).toBe(true);
  });

  it("an older marker without the field works as before: only the restored database's domains, a complete check", async () => {
    const markerAt = new Date(Date.now() - 5 * MIN);
    await restore.handleRestoreMarker({ now: markerAt, markerPath: writeMarker(markerAt), logger: quiet });
    expect("domainsBefore" in (await restoreState())).toBe(false);
    const { walked, mailgun } = stubMailgun({});
    const report = await restore.runRestoreScan({ now: new Date(), pass: 1, mailgun });
    expect(walked).toEqual(["mg.restored.example"]);
    expect(report).toMatchObject({ mailgunChecked: true, error: null });
  });
});
