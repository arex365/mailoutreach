import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setSettingValue } from "../campaigns/seed";
import { createTestDb } from "../helpers/test-db";
import { resetSendingState, type M3World } from "../sending-m3/helpers";
import { OWN, setupOwnMailbox } from "./p1-setup";

/**
 * A restore in own-mailbox mode (review REPLIES-02). They replied lives only in the app's database (replies land in the
 * own mailbox, never in the app), so a restore undoes every They replied click made after the backup, and nothing brings
 * it back. And the restored backup holds the inbox check ("I've read contact@…") from before the backup, which says
 * nothing about the mail that came since. So when the restore marker is handled:
 *  - the inbox check is forgotten: live follow-ups wait until someone has read the mailbox again and clicked;
 *  - the restore pause's fix sentence (and the Owner's notification) says which clicks were undone and what to do;
 *  - Settings › Backups' Last restore card says so too, until someone clicks I've read after the restore.
 * App mode: the pause and the card are exactly as before.
 */

const t = await createTestDb("own-mailbox-restore");
const { db, dbWrite } = await import("@/server/db");
const { setState } = await import("@/server/state");
const { readTyped } = await import("@/server/state-typed");
const { parseInboxCheckState, parsePauseState } = await import("@/core/system-state-parse");
const { shortDateTime } = await import("@/core/sending/restore-report");
const restore = await import("@/server/services/sending/restore");
const { loadInboxCheck, markInboxChecked } = await import("@/server/services/sending/inbox-check");
const { inboxCheckHeldIds } = await import("@/server/services/sending/gates");

const ZONE = "Europe/Berlin";
const HOUR = 3_600_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-own-restore-"));
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
let world: M3World;
let markers = 0;

/** A restore marker as restore.bat writes it: the backup made at `restoredFrom`, restored at `at`. */
function writeMarker(restoredFrom: Date, at: Date): string {
  const file = path.join(dir, `RESTORED-${++markers}`);
  fs.writeFileSync(file, JSON.stringify({ version: 3, restoredFrom: restoredFrom.toISOString(), at: at.toISOString(), file: "backup.db" }));
  return file;
}

const inboxCheck = async () => (await readTyped("sending.inboxCheck", parseInboxCheckState)).value;
const pause = async () => (await readTyped("sending.pause", parsePauseState)).value;
/** A due LIVE follow-up, as the send gate sees it. */
const followUp = { id: 901, mode: "LIVE", step: 1, recipientId: 9_001 } as unknown as Parameters<typeof inboxCheckHeldIds>[0][number];

beforeAll(async () => {
  world = await setupOwnMailbox();
});

beforeEach(async () => {
  world.mg.fake.reset();
  await resetSendingState();
  await setSettingValue("mailgun.replies", "own-mailbox");
  await setSettingValue("mailgun.fromAddress", OWN);
  await dbWrite(async (c) => {
    await c.systemState.deleteMany({ where: { key: "sending.inboxCheck" } });
    await c.notification.deleteMany({});
    await c.job.deleteMany({});
  });
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a restore in own-mailbox mode", () => {
  it("forgets the same-day inbox check, says which clicks were undone, and the card says it until someone reads the mailbox again", async () => {
    // 09:00 the Owner read contact@ and clicked I've read; 11:00 the backup; 15:00 the restore of that backup.
    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);
    const readAt = new Date(today.getTime() - 3 * HOUR);
    const backupAt = new Date(today.getTime() - HOUR);
    const restoredAt = new Date(today.getTime() + 3 * HOUR);
    await setState("sending.inboxCheck", { at: readAt.toISOString(), byUserId: world.owner.id });
    expect(await inboxCheckHeldIds([followUp], readAt)).toEqual(new Set());

    await restore.handleRestoreMarker({ now: restoredAt, markerPath: writeMarker(backupAt, restoredAt), logger: quiet });

    // The inbox check from before the restore no longer counts: the follow-up waits, the card says nobody has read it.
    expect(await inboxCheck()).toEqual({ at: null, byUserId: null });
    expect(await inboxCheckHeldIds([followUp], restoredAt)).toEqual(new Set([followUp.id]));
    expect(await loadInboxCheck(restoredAt)).toMatchObject({ at: null, today: false });

    // The pause says what the restore undid, with the backup's time in the Owner's zone, and so does the notification.
    const ownerZone = (await db.user.findUniqueOrThrow({ where: { id: world.owner.id }, select: { timeZone: true } })).timeZone;
    const undone = restore.RESTORE_OWN_MAILBOX_TEXTS.undone(OWN, shortDateTime(backupAt, ownerZone, restoredAt));
    expect(undone).toBe(
      `They replied clicks made after the backup (${shortDateTime(backupAt, ownerZone, restoredAt)}) were undone by the restore. Read ${OWN} again from that time on: click They replied on every company that answered and Mark unsubscribed for removal requests, then click I've read ${OWN}. Live follow-ups wait until then.`,
    );
    expect(await pause()).toMatchObject({ paused: true, kind: "restore", fixText: `${restore.RESTORE_PAUSE.fixText} ${undone}` });
    const notice = await db.notification.findFirstOrThrow({ where: { type: "sending.paused", userId: world.owner.id } });
    expect(notice.body).toBe(`${restore.RESTORE_PAUSE.fixText} ${undone}`);

    // Settings › Backups' Last restore card: the same sentence after the line that names the backup.
    const card = await restore.lastRestoreView(ZONE, restoredAt);
    expect(card!.restoredLine).toMatch(/^Restored on .+ from the backup of .+\. They replied clicks made after the backup were undone by the restore\. /);
    expect(card!.restoredLine.endsWith(` ${restore.RESTORE_OWN_MAILBOX_TEXTS.undone(OWN, null)}`)).toBe(true);

    // Someone reads contact@ again and clicks I've read: the card's sentence goes, and follow-ups may go again.
    await markInboxChecked({ id: world.member.id, name: world.member.name }, new Date(restoredAt.getTime() + HOUR));
    const after = await restore.lastRestoreView(ZONE, new Date(restoredAt.getTime() + HOUR));
    expect(after!.restoredLine).toMatch(/^Restored on .+ from the backup of [^.]+\.$/);
    expect(await inboxCheckHeldIds([followUp], new Date(restoredAt.getTime() + HOUR))).toEqual(new Set());
  });

  it("the marker handled a second time (a restart) doesn't forget a check made after the restore", async () => {
    const now = new Date();
    const file = writeMarker(new Date(now.getTime() - 2 * HOUR), now);
    const copy = `${file}-again`;
    fs.copyFileSync(file, copy);
    await restore.handleRestoreMarker({ now, markerPath: file, logger: quiet });
    await markInboxChecked({ id: world.owner.id, name: world.owner.name }, new Date(now.getTime() + HOUR));
    // The same marker again (it couldn't be deleted, say): already handled, nothing is repeated.
    await restore.handleRestoreMarker({ now: new Date(now.getTime() + 2 * HOUR), markerPath: copy, logger: quiet });
    expect((await inboxCheck()).at).toBe(new Date(now.getTime() + HOUR).toISOString());
  });
});

describe("a restore in app mode", () => {
  it("pauses and words the card exactly as before", async () => {
    await setSettingValue("mailgun.replies", "app");
    const now = new Date();
    const backupAt = new Date(now.getTime() - 2 * HOUR);
    await restore.handleRestoreMarker({ now, markerPath: writeMarker(backupAt, now), logger: quiet });
    expect(await pause()).toMatchObject({ paused: true, kind: "restore", fixText: restore.RESTORE_PAUSE.fixText });
    const card = await restore.lastRestoreView(ZONE, now);
    expect(card!.restoredLine).toMatch(/^Restored on .+ from the backup of [^.]+\.$/);
    // App mode has no inbox check, and none is written.
    expect(await db.systemState.count({ where: { key: "sending.inboxCheck" } })).toBe(0);
  });
});
