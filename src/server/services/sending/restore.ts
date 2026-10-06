import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SendStatus } from "@/generated/prisma/client";
import { eventEffect, normalizeLogItem, type NormalizedEvent } from "@/core/mailgun/events";
import { effectiveLogRetentionDays } from "@/core/mailgun/plan";
import { safeZone } from "@/core/sending/capday";
import { threadHeaders } from "@/core/sending/follow-up";
import { restoreReportLines, shortDateTime, type RestoreReportLines } from "@/core/sending/restore-report";
import { formatShortDate, formatTime } from "@/core/time/format";
import { usableEmailDomain } from "@/core/shared-domains";
import { parseInboxCheckState, parseInstanceState, parsePauseState, parseRestoreDomains, parseRestoreState } from "@/core/system-state-parse";
import { STATE_KEYS, type InstanceState, type RestoreDomain, type RestoreReport, type RestoreState } from "@/core/system-state";
import { db, dbTx, dbWrite } from "@/server/db";
import { databaseFilePath } from "@/server/env";
import { enqueueJob } from "@/server/jobs";
import { notifyOwner } from "@/server/notifications";
import { getSettings } from "@/server/settings";
import { readTyped, updateTyped } from "@/server/state-typed";
import { clientFor, domainsToSync, getMailgunContext, type MailgunContextResult } from "@/server/mailgun/context";
import { loadPlanLimits } from "@/server/services/mailgun/plan";
import { loadTeamFrom } from "@/server/services/mailgun/team-from";
import { formatFromHeader, newSendId } from "./addresses";
import { markSent } from "./mark-sent";
import { getPauseState, pauseSending } from "./pause";

/**
 * After a restore, and when the database was copied (PLAN B6.7 "restore flow", M3-DESIGN §4.3.7):
 * a restored backup doesn't know about emails sent after it was made, so it could send them again.
 *
 *  - handleRestoreMarker (worker start-up): the RESTORED marker written by scripts/restore.mjs pauses
 *    all sending, queues the Mailgun check and records the restore; every step is idempotent, so a
 *    crash anywhere just repeats the steps at the next start and still ends paused. It then settles a
 *    check left behind (settleRestoreCheck): one still "running" with no job left to finish it failed.
 *  - the send gate (restoreHoldActive): while the check runs, or when it failed or couldn't reach
 *    Mailgun and nobody acknowledged that, every TEST/LIVE email waits, whatever the pause says.
 *    A check that ends like that pauses sending again (kind "restore") until the Owner resumes with
 *    the confirmation, also when the Owner resumed while it was still running.
 *  - runRestoreScan (job "mailgun.restoreScan"): walks Mailgun's logs for accepted emails since the
 *    backup, twice (right after start-up, and 35 minutes after the restore, because Mailgun's logs
 *    can be up to 30 minutes behind), and records every one as sent. Emails the backup never knew
 *    become ExternalSend rows, so the 30-day rule still sees them.
 *  - checkDatabaseInstance (start-up): a database opened from another place, from another computer
 *    or swapped for another database at the same place, without a restore marker, is a copy, and
 *    pauses sending until the Owner confirms.
 */

export const RESTORE_MARKER_VERSION = 3;
export const RESTORE_SECOND_PASS_MS = 35 * 60_000;
export const RESTORE_SCAN_DEDUPE = "mailgun:restore-scan";
export const RESTORE_SCAN_SECOND_DEDUPE = "mailgun:restore-scan-2";
export const RESTORE_SCAN_PRIORITY = 40;

export const RESTORE_PAUSE = {
  kind: "restore" as const,
  reason: "restored from a backup",
  fixText: "Check the restore report in Settings › Sending & Mailgun, then click Resume.",
};

/**
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O17, O33; review REPLIES-02): replies land only in the own mailbox and They
 * replied lives only in the app's database, so a restore undoes every They replied click made after the backup, and
 * nothing brings it back (app mode's replies come back through the catch-up; a Mark unsubscribed that reached Mailgun's
 * list comes back through the pull). The restore pause, its notification and the Last restore card say so, and the
 * inbox check from before the restore is forgotten, so live follow-ups wait until someone has read the mailbox again.
 */
export const RESTORE_OWN_MAILBOX_TEXTS = {
  /** `backup`: the backup's time ("26 Sep 22:14"), or null when the sentence before it names the backup already. */
  undone: (from: string, backup: string | null): string => {
    const when = backup ? ` (${backup})` : "";
    // The owner's docs quote this sentence (tests/unit/docs/labels.test.ts fills it in from here).
    return `They replied clicks made after the backup${when} were undone by the restore. Read ${from} again from that time on: click They replied on every company that answered and Mark unsubscribed for removal requests, then click I've read ${from}. Live follow-ups wait until then.`;
  },
} as const;

/** The mailbox They replied is about in own-mailbox mode (the own From, else what is saved), or null in app mode. */
async function ownMailboxOf(): Promise<string | null> {
  const team = await loadTeamFrom();
  if (team.replies !== "own-mailbox") return null;
  return team.ownFrom ?? team.saved ?? "your own mailbox";
}

/** The Owner's time zone for a sentence the background sender writes (Setting "sending.capDayTimeZone" without one). */
async function ownerZone(): Promise<string> {
  const owner = await db.user.findFirst({ where: { role: "OWNER", active: true }, orderBy: { id: "asc" }, select: { timeZone: true } });
  if (owner?.timeZone) return safeZone(owner.timeZone);
  const s = await getSettings(["sending.capDayTimeZone"] as const);
  return safeZone(typeof s["sending.capDayTimeZone"] === "string" ? s["sending.capDayTimeZone"] : null);
}

/**
 * The restore pause (RESTORE_PAUSE); in own-mailbox mode its fix sentence (also the Owner's notification) adds which
 * clicks the restore undid and what to do about them (review REPLIES-02). App mode: RESTORE_PAUSE as it is.
 */
async function restorePauseFor(restoredFrom: string | null, now: Date): Promise<typeof RESTORE_PAUSE> {
  const from = await ownMailboxOf();
  if (!from) return RESTORE_PAUSE;
  const backup = restoredFrom ? shortDateTime(restoredFrom, await ownerZone(), now) : null;
  return { ...RESTORE_PAUSE, fixText: `${RESTORE_PAUSE.fixText} ${RESTORE_OWN_MAILBOX_TEXTS.undone(from, backup)}` };
}

/**
 * The inbox check ("I've read contact@…", SystemState "sending.inboxCheck") the restored backup holds was made before the
 * backup, so it says nothing about the mail that came since: a restore forgets it (back to "nobody has read it"), and live
 * follow-ups wait until someone has read the mailbox again and clicked (review REPLIES-02). The one write of that key
 * outside `markInboxChecked`, and only ever this reset. Nothing is written when there is no check (app mode never has
 * one).
 */
async function forgetInboxCheck(): Promise<void> {
  await updateTyped(STATE_KEYS.inboxCheck, parseInboxCheckState, (cur) =>
    cur.at === null && cur.byUserId === null ? null : { at: null, byUserId: null },
  );
}

export const COPIED_DATABASE_PAUSE = {
  kind: "copied-database" as const,
  reason: "this database was copied or moved",
  fixText:
    "The app's database now opens from a different place. If this is a copy of the real database, don't resume: it would send the same emails again. If you moved the app on purpose, click Resume.",
};

/** The same place, but the database last ran on another computer (the app folder was copied there, or here). */
export function otherComputerPause(lastComputer: string) {
  return {
    kind: "copied-database" as const,
    reason: "this database last ran on another computer",
    fixText: `The app's database last ran on another computer (${lastComputer}). If the app still runs there, don't resume: both computers would send the same emails. If you moved the app to this computer on purpose, click Resume.`,
  };
}

/** The same place and computer, but another database than the one that ran here last. */
export const REPLACED_DATABASE_PAUSE = {
  kind: "copied-database" as const,
  reason: "the database file was replaced",
  fixText:
    "The app's database file was swapped for another database. If that database still runs on another computer, don't resume: both would send the same emails. If you replaced it on purpose, click Resume. To go back to a backup, use restore.bat instead: it checks Mailgun for emails sent since then.",
};

/** Stored on rows that were due before an old backup's restore and can't be checked with Mailgun. */
export const RESTORED_UNCHECKABLE_MESSAGE =
  "Restored from an older backup: we can't check whether this email went out before the restore";

/** The error a check gets when the worker finds it "running" at start-up with no job left to finish it. */
export const RESTORE_CHECK_STOPPED = "The restore check stopped before it finished.";

type Logger = { info?: (message: string) => void; warn: (message: string) => void; error: (message: string, err?: unknown) => void };

const consoleLogger: Logger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m, err) => console.error(m, err ?? ""),
};

/** `<database folder>/RESTORED`, written by scripts/restore.mjs. */
export function restoreMarkerPath(): string {
  return path.join(path.dirname(databaseFilePath()), "RESTORED");
}

/**
 * The send gate (pure): TEST/LIVE emails wait while a restore is being checked (pending or
 * scanning), or when the check failed or couldn't reach Mailgun and nobody acknowledged it.
 */
export function restoreHoldActive(state: RestoreState): boolean {
  if (state.status === "pending" || state.status === "scanning") return true;
  return restoreNeedsAcknowledgement(state);
}

/**
 * The check is over but didn't cover Mailgun (it failed, or couldn't reach Mailgun) and nobody acknowledged that:
 * TEST/LIVE emails wait until the Owner resumes with the "may go out a second time" confirmation.
 */
export function restoreNeedsAcknowledgement(state: RestoreState): boolean {
  if (state.acknowledgedAt) return false;
  return state.status === "failed" || (state.status === "done" && state.report?.mailgunChecked === false);
}

/**
 * A check that ended without covering Mailgun must be acknowledged, and the only place to do that is the pause card's
 * confirmation (resumeSending records it only while a pause of kind "restore" is on). The Owner may have resumed while
 * the check was still running, so the restore pause comes back (pauseSending is idempotent: nothing changes while it
 * is still on). Otherwise every TEST/LIVE email would wait for ever with nothing on screen to end it.
 */
async function pauseUntilAcknowledged(now: Date): Promise<void> {
  const state = (await readTyped(STATE_KEYS.restore, parseRestoreState)).value;
  if (restoreNeedsAcknowledgement(state)) await pauseSending({ ...RESTORE_PAUSE, now });
}

type Marker = {
  version: number | null;
  restoredFrom: string | null;
  at: string;
  file: string | null;
  /** The database file the backup was restored into ("app.db"); null in markers older than this field. */
  db: string | null;
  /**
   * The Mailgun sending domains of the database that was replaced (review BACKUPS-7): null when restore.bat couldn't
   * read them, undefined in markers older than this field.
   */
  domainsBefore: RestoreDomain[] | null | undefined;
};

function isoOrNull(v: unknown): string | null {
  return typeof v === "string" && v && !Number.isNaN(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null;
}

/**
 * The real database and the practice copy share a folder (data\app.db, data\demo.db), so they share the RESTORED
 * marker's place. A marker that names another database file (its `db` field) belongs to that database: this one
 * leaves it alone. A marker without the field counts for any database (the safe side: it pauses).
 */
function markerIsForThisDatabase(marker: Pick<Marker, "db">): boolean {
  return !marker.db || marker.db.toLowerCase() === path.basename(databaseFilePath()).toLowerCase();
}

/** This marker was handled already: the restore state records its `at` and when it was handled. */
function markerHandled(marker: Pick<Marker, "at">, state: RestoreState): boolean {
  return state.markerAt === marker.at && state.handledAt !== null;
}

/**
 * Whether a restore marker for THIS database is waiting to be handled (worker start-up: checkDatabaseInstance's
 * `markerSeen`). An unreadable marker counts; one written for the other database in the same folder doesn't, and
 * neither does one that was handled already but couldn't be deleted (review BACKUPS-4: a stale marker must never turn
 * off the copied-database check, e.g. when the whole app folder is copied to another PC with it).
 */
export async function restoreMarkerSeen(markerPath: string = restoreMarkerPath()): Promise<boolean> {
  let marker: Marker | null;
  try {
    marker = readMarker(markerPath);
  } catch {
    return fs.existsSync(markerPath);
  }
  if (!marker || !markerIsForThisDatabase(marker)) return false;
  const state = (await readTyped(STATE_KEYS.restore, parseRestoreState)).value;
  return !markerHandled(marker, state);
}

/**
 * Deletes the restore marker when it is this database's and was handled already, but couldn't be deleted then (an
 * antivirus or OneDrive lock). Tried at start-up (handleRestoreMarker), by both passes of the restore check and after
 * every backup, so it doesn't wait for the next restart (review BACKUPS-4). A marker still waiting to be handled, or
 * another database's, is never touched. True when it deleted one.
 */
export async function deleteHandledRestoreMarker(
  opts: { markerPath?: string; logger?: Logger } = {},
): Promise<boolean> {
  const file = opts.markerPath ?? restoreMarkerPath();
  let marker: Marker | null;
  try {
    marker = readMarker(file);
  } catch {
    return false;
  }
  if (!marker || !markerIsForThisDatabase(marker)) return false;
  const state = (await readTyped(STATE_KEYS.restore, parseRestoreState)).value;
  if (!markerHandled(marker, state)) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    opts.logger?.warn(`Couldn't delete the restore marker (${(err as NodeJS.ErrnoException).code ?? "error"}); it's handled already, and it is tried again later.`);
    return false;
  }
}

/** The job types a backup can hold that must not run again after it is restored (review BACKUPS-5). */
const CAPTURED_JOB_TYPES = ["backup.run", "mailgun.restoreScan"];

/**
 * A backup holds the Job table as it was: its own "backup.run" (RUNNING while the snapshot was taken) and any restore
 * check still queued then. After restoring it they would run again: a Back up now nobody clicked (in the clicker's
 * name), an early prune, or an old restore check's second pass claimed before the new first one ("Restore check
 * finished" too early). So every such job created before the marker is cancelled when the marker is handled, before
 * the new check is queued. Returns how many.
 */
async function cancelJobsFromBeforeRestore(markerAt: string, now: Date): Promise<number> {
  const before = new Date(Date.parse(markerAt));
  if (Number.isNaN(before.getTime())) return 0;
  const res = await dbWrite((c) =>
    c.job.updateMany({
      where: { type: { in: CAPTURED_JOB_TYPES }, status: { in: ["QUEUED", "RUNNING"] }, createdAt: { lt: before } },
      data: { status: "CANCELLED", activeDedupeKey: null, lockedAt: null, lockedBy: null, finishedAt: now },
    }),
  );
  return res.count;
}

/**
 * Worker start-up, before the orphaned jobs are reset: when a restore marker for this database is waiting, the jobs the
 * restored backup holds are cancelled first (cancelJobsFromBeforeRestore), so a backup job captured on its last try isn't
 * given up with a false "The backup failed" notice either. handleRestoreMarker does the same again (harmless).
 */
export async function cancelJobsCapturedInBackup(
  opts: { now?: Date; markerPath?: string; logger?: Logger } = {},
): Promise<number> {
  const file = opts.markerPath ?? restoreMarkerPath();
  let marker: Marker | null;
  try {
    marker = readMarker(file);
  } catch {
    return 0; // handleRestoreMarker reports an unreadable marker
  }
  if (!marker || !markerIsForThisDatabase(marker)) return 0;
  const state = (await readTyped(STATE_KEYS.restore, parseRestoreState)).value;
  if (markerHandled(marker, state)) return 0;
  const n = await cancelJobsFromBeforeRestore(marker.at, opts.now ?? new Date());
  if (n > 0) opts.logger?.info?.(`Cancelled ${n} task${n === 1 ? "" : "s"} the restored backup still held (a backup or an old restore check).`);
  return n;
}

/** Reads the marker; an unreadable one still means "a restore happened" (its file time stands in for `at`). */
function readMarker(file: string): Marker | null {
  let text: string;
  let mtime: Date;
  try {
    text = fs.readFileSync(file, "utf8");
    mtime = fs.statSync(file).mtime;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    raw = {};
  }
  return {
    version: typeof raw.version === "number" ? raw.version : null,
    restoredFrom: isoOrNull(raw.restoredFrom),
    at: isoOrNull(raw.at) ?? mtime.toISOString(),
    file: typeof raw.file === "string" ? raw.file : null,
    db: typeof raw.db === "string" && raw.db.trim() ? raw.db.trim() : null,
    domainsBefore: Object.hasOwn(raw, "domainsBefore") ? parseRestoreDomains(raw.domainsBefore) : undefined,
  };
}

/**
 * min(restoredFrom, newest ActivityLog.at in the restored database) − 1 h: a backup touched later can't start the scan
 * too late. Only activity from before the restore counts (not the web app's since, nor the "sending.paused" this
 * restore just logged; skipping an older pause only starts the scan earlier, which is safe).
 */
async function scanFromFor(restoredFrom: string | null, markerAt: string, now: Date): Promise<string> {
  const newest = await db.activityLog.findFirst({
    where: { at: { lte: new Date(Date.parse(markerAt)) }, type: { not: "sending.paused" } },
    orderBy: [{ at: "desc" }, { id: "desc" }],
    select: { at: true },
  });
  const times = [restoredFrom ? Date.parse(restoredFrom) : Number.NaN, newest ? newest.at.getTime() : Number.NaN].filter((t) =>
    Number.isFinite(t),
  );
  const base = times.length ? Math.min(...times) : now.getTime();
  return new Date(base - 3_600_000).toISOString();
}

/**
 * Worker start-up (before sending starts): acts on the RESTORED marker, in this order, each step
 * idempotent (a crash anywhere repeats them at the next start and always ends paused):
 *  1. pause all sending (kind "restore"; in own-mailbox mode the fix sentence says which clicks the restore undid), and
 *     forget the restored inbox check (review REPLIES-02);
 *  2. cancel the backup and restore-check jobs the restored backup still held (created before the marker);
 *  3. queue the Mailgun check (job "mailgun.restoreScan", pass 1);
 *  4. record the restore as "pending" (the send gate holds every TEST/LIVE email from now on), with the sending
 *     domains the replaced database had (the marker's `domainsBefore`);
 *  5. delete the marker (an error, e.g. an antivirus lock, is logged; deleteHandledRestoreMarker tries again later).
 * A marker already handled (same `at`, and the check done or failed, or the restore pause still on)
 * is only deleted. A marker written for the other database in the same folder (its `db` field names
 * another file, e.g. data\app.db while this is the practice copy) is left for that database.
 * With or without a marker, it then settles a check left behind (settleRestoreCheck).
 */
export async function handleRestoreMarker(
  opts: { now?: Date; markerPath?: string; logger?: Logger } = {},
): Promise<{ handled: boolean }> {
  const now = opts.now ?? new Date();
  const logger = opts.logger ?? consoleLogger;
  const res = await actOnMarker(now, logger, opts.markerPath ?? restoreMarkerPath());
  await settleRestoreCheck({ now, logger });
  return res;
}

async function actOnMarker(now: Date, logger: Logger, file: string): Promise<{ handled: boolean }> {
  const marker = readMarker(file);
  if (!marker) return { handled: false };
  // The other database in the same folder was restored (e.g. data\app.db while this is the practice copy).
  if (!markerIsForThisDatabase(marker)) return { handled: false };

  const state = (await readTyped(STATE_KEYS.restore, parseRestoreState)).value;
  const pause = (await readTyped(STATE_KEYS.pause, parsePauseState)).value;
  const restorePaused = pause.paused && (pause.kind === "restore" || pause.also.some((a) => a.kind === "restore"));
  const already = state.markerAt === marker.at && (state.status === "done" || state.status === "failed" || restorePaused);

  if (!already) {
    await pauseSending({ ...(await restorePauseFor(marker.restoredFrom, now)), now });
    // The restored backup's inbox check predates every reply since the backup (review REPLIES-02).
    await forgetInboxCheck();
    // The backup's own backup job and any restore check it still held never run again (review BACKUPS-5); this must
    // come before the new check is queued (the old one would take its place through the same dedupe key).
    const cancelled = await cancelJobsFromBeforeRestore(marker.at, now);
    if (cancelled > 0) logger.info?.(`Cancelled ${cancelled} task${cancelled === 1 ? "" : "s"} the restored backup still held (a backup or an old restore check).`);
    await enqueueJob({
      type: "mailgun.restoreScan",
      payload: { pass: 1 },
      dedupeKey: RESTORE_SCAN_DEDUPE,
      priority: RESTORE_SCAN_PRIORITY,
    });
    const scanFrom = await scanFromFor(marker.restoredFrom, marker.at, now);
    await updateTyped(STATE_KEYS.restore, parseRestoreState, (): RestoreState => ({
      status: "pending",
      restoredFrom: marker.restoredFrom,
      scanFrom,
      markerAt: marker.at,
      file: marker.file,
      handledAt: now.toISOString(),
      report: null,
      acknowledgedAt: null,
      acknowledgedById: null,
      ...(marker.domainsBefore !== undefined ? { domainsBefore: marker.domainsBefore } : {}),
    }));
    logger.warn(
      `Restored from a backup${marker.restoredFrom ? ` made ${marker.restoredFrom}` : ""}: sending is paused until the check with Mailgun is done and the Owner resumes.`,
    );
  }
  try {
    fs.unlinkSync(file);
  } catch (err) {
    // Handled: it no longer counts as a restore at start-up (restoreMarkerSeen), and deleteHandledRestoreMarker tries again.
    logger.warn(`Couldn't delete the restore marker (${(err as NodeJS.ErrnoException).code ?? "error"}); it's handled already, and it is tried again later.`);
  }
  return { handled: true };
}

/**
 * Worker start-up (inside handleRestoreMarker, after the orphaned jobs were reset): a restore check can't be left
 * holding TEST/LIVE emails with nothing to end it.
 *  - Still "pending" or "scanning", but no "mailgun.restoreScan" job is queued or running (it was given up while the
 *    worker kept stopping, or its failure couldn't be recorded): the check failed ("The restore check stopped before
 *    it finished.").
 *  - Failed or unchecked and not acknowledged: the restore pause is on (again), so the Owner sees the report and the
 *    confirmation (a pause that couldn't be written when the check ended is written now).
 */
export async function settleRestoreCheck(opts: { now?: Date; logger?: Logger } = {}): Promise<void> {
  const now = opts.now ?? new Date();
  const logger = opts.logger ?? consoleLogger;
  const state = (await readTyped(STATE_KEYS.restore, parseRestoreState)).value;
  if (state.status === "pending" || state.status === "scanning") {
    const active = await db.job.count({ where: { type: "mailgun.restoreScan", status: { in: ["QUEUED", "RUNNING"] } } });
    if (active > 0) return;
    logger.warn("The restore check with Mailgun stopped before it finished: sending stays paused until the Owner resumes and confirms.");
    await markRestoreScanFailed(RESTORE_CHECK_STOPPED, now);
    return;
  }
  await pauseUntilAcknowledged(now);
}

// ───────────────────────── the scan ─────────────────────────

type ScanCounts = Pick<
  RestoreReport,
  "acceptedEvents" | "matchedByMessageId" | "matchedBySendId" | "matchedByRecipient" | "rowsCreated" | "externalSends" | "madeUnconfirmed"
>;

const NOT_SENT: SendStatus[] = ["QUEUED", "SENDING", "UNKNOWN", "UNCONFIRMED", "FAILED", "SKIPPED", "CANCELLED"];

/** Records a row Mailgun accepted as sent (providerId first, then markSent). DRY_RUN rows are never touched. */
async function proveSent(row: { id: number; status: SendStatus; mode: string; providerId: string | null }, ev: NormalizedEvent): Promise<void> {
  if (row.mode === "DRY_RUN" || row.status === "SENT") return;
  const providerId = ev.messageId;
  if (!row.providerId && providerId) {
    await dbWrite((c) => c.outboundEmail.updateMany({ where: { id: row.id, providerId: null }, data: { providerId } }));
  }
  await markSent(row.id, ev.occurredAt, { providerId: row.providerId ?? providerId });
}

const rowSelect = { id: true, status: true, mode: true, providerId: true } as const;

/** A MailEvent row as an event, enough for eventEffect's date field. */
function storedEventEffect(e: { type: string; severity: string | null; reason: string | null; isTestMode: boolean }) {
  const ev: NormalizedEvent = {
    dedupeKey: "",
    providerEventId: "",
    type: (["accepted", "delivered", "failed", "complained", "unsubscribed"].includes(e.type) ? e.type : "other") as NormalizedEvent["type"],
    severity: e.severity === "permanent" || e.severity === "temporary" ? e.severity : null,
    reason: e.reason,
    occurredAt: new Date(0),
    messageId: null,
    recipient: null,
    userVariables: {},
    tags: [],
    isTestMode: e.isTestMode,
    domain: null,
    deliveryStatus: null,
    raw: null,
  };
  return eventEffect(ev);
}

/** Events already stored for this Message-ID with no email row are linked to the row, and their dates applied (earliest wins). */
async function relinkEvents(emailId: number, messageId: string): Promise<void> {
  const events = await db.mailEvent.findMany({
    where: { messageId, outboundEmailId: null },
    select: { id: true, type: true, severity: true, reason: true, isTestMode: true, occurredAt: true },
  });
  if (events.length === 0) return;
  await dbTx(async (tx) => {
    await tx.mailEvent.updateMany({ where: { id: { in: events.map((e) => e.id) }, outboundEmailId: null }, data: { outboundEmailId: emailId } });
    for (const e of events) {
      const field = storedEventEffect(e).dateField;
      if (!field) continue;
      await tx.outboundEmail.updateMany({
        where: { id: emailId, OR: [{ [field]: null }, { [field]: { gt: e.occurredAt } }] },
        data: { [field]: e.occurredAt },
      });
    }
  });
}

/**
 * Match 3 (§4.3.7): the event's (campaign, step, recipient), only for a campaign the backup knew
 * (launched before the backup was made) and an event not older than that launch: SQLite hands out
 * ids again after a restore, so a campaign created later may carry an old campaign's id.
 */
async function matchByRecipient(ev: NormalizedEvent, restoredFrom: Date | null): Promise<"matched" | "created" | null> {
  const campaignId = Number(ev.userVariables.campaign_id);
  const step = Number(ev.userVariables.step);
  const to = ev.recipient?.toLowerCase() ?? "";
  if (!restoredFrom || !Number.isInteger(campaignId) || campaignId <= 0 || !Number.isInteger(step) || step < 0 || !to.includes("@")) {
    return null;
  }
  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, launchedAt: true, mode: true, senderId: true, fromName: true, fromAddress: true, replyTo: true },
  });
  if (!campaign?.launchedAt || campaign.launchedAt.getTime() >= restoredFrom.getTime()) return null;
  if (ev.occurredAt.getTime() < campaign.launchedAt.getTime()) return null;
  const recipient = await db.campaignRecipient.findFirst({
    where: { campaignId, emailNorm: to },
    select: { id: true, personId: true, companyId: true, person: { select: { email: true } }, company: { select: { name: true, domain: true } } },
  });
  if (!recipient) return null;
  const messageId = ev.messageId;
  if (!messageId) return null;
  const sendId = ev.userVariables.send_id || null;

  const existing = await db.outboundEmail.findFirst({ where: { campaignId, step, toNorm: to }, select: { ...rowSelect, messageId: true } });
  if (existing) {
    if (existing.status !== "SENT") {
      await dbWrite((c) =>
        c.outboundEmail.updateMany({
          where: { id: existing.id, status: { in: NOT_SENT } },
          data: { messageId, ...(sendId ? { sendId } : {}), providerId: existing.providerId ?? messageId },
        }),
      );
      await relinkEvents(existing.id, messageId);
      await proveSent({ ...existing, providerId: existing.providerId ?? messageId }, ev);
    }
    return "matched";
  }

  // The thread: the newest email already sent to this person at a lower step (a switched-off step leaves a gap, so
  // never simply step − 1; M4-DESIGN §2.11), as the person received it (threadHeaders, §2.2).
  const prev =
    step > 0
      ? await db.outboundEmail.findFirst({
          where: { campaignId, recipientId: recipient.id, step: { lt: step }, status: "SENT" },
          orderBy: [{ step: "desc" }, { id: "desc" }],
          select: { messageId: true, providerId: true, references: true, mode: true },
        })
      : null;
  const thread = prev ? threadHeaders(prev) : null;
  const created = await dbWrite((c) =>
    c.outboundEmail.create({
      data: {
        campaignId,
        recipientId: recipient.id,
        personId: recipient.personId,
        companyId: recipient.companyId,
        senderId: campaign.senderId,
        step,
        mode: campaign.mode ?? "LIVE",
        toEmail: recipient.person.email ?? to,
        toNorm: to,
        companyDomain: recipient.company.domain,
        companyName: recipient.company.name,
        // The campaign's launch snapshot: its From line and, in shared-From mode, its Reply-To (SHARED-FROM-DESIGN §2.3),
        // so this email's follow-ups keep sending replies to the app.
        fromAddress: formatFromHeader(campaign.fromName ?? "", campaign.fromAddress ?? ""),
        replyTo: campaign.replyTo,
        subject: "",
        text: "",
        html: "",
        messageId,
        sendId: sendId ?? newSendId(),
        inReplyTo: thread?.inReplyTo ?? null,
        references: thread?.references ?? null,
        dueAt: ev.occurredAt,
        // Not QUEUED even for a moment: nothing may pick it up before it's recorded as sent.
        status: "UNKNOWN",
        claimedAt: ev.occurredAt,
        providerId: messageId,
      },
      select: rowSelect,
    }),
  );
  await relinkEvents(created.id, messageId);
  await proveSent(created, ev);
  return "created";
}

/** An accepted email the database has no row for: the 30-day rule must still see it. Skipped when already recorded. */
async function recordExternalSend(ev: NormalizedEvent): Promise<boolean> {
  const to = ev.recipient?.toLowerCase() ?? "";
  if (!to.includes("@")) return false;
  if (ev.messageId) {
    const known = await db.externalSend.findFirst({ where: { providerMessageId: ev.messageId }, select: { id: true } });
    if (known) return false;
  }
  const person = await db.person.findUnique({
    where: { emailNorm: to },
    select: { companyId: true, company: { select: { domain: true } } },
  });
  const emailDomain = to.slice(to.lastIndexOf("@") + 1);
  await dbWrite((c) =>
    c.externalSend.create({
      data: {
        toNorm: to,
        companyDomain: person ? person.company.domain : usableEmailDomain(emailDomain),
        companyId: person?.companyId ?? null,
        sentAt: ev.occurredAt,
        providerMessageId: ev.messageId,
        source: "RESTORE",
      },
    }),
  );
  return true;
}

/** Matches one accepted event (§4.3.7 steps 1–4) and counts what happened. */
async function matchAccepted(ev: NormalizedEvent, restoredFrom: Date | null, counts: ScanCounts): Promise<void> {
  counts.acceptedEvents += 1;
  if (ev.messageId) {
    const row =
      (await db.outboundEmail.findUnique({ where: { messageId: ev.messageId }, select: rowSelect })) ??
      (await db.outboundEmail.findFirst({ where: { providerId: ev.messageId }, select: rowSelect }));
    if (row) {
      await proveSent(row, ev);
      counts.matchedByMessageId += 1;
      return;
    }
    // Test emails ("Send me a test", the reply test) are no campaign's business here.
    const test = await db.testSend.findFirst({
      where: { OR: [{ messageId: ev.messageId }, { providerId: ev.messageId }] },
      select: { id: true },
    });
    if (test) return;
  }
  const sendId = ev.userVariables.send_id;
  if (sendId) {
    const row = await db.outboundEmail.findUnique({ where: { sendId }, select: rowSelect });
    if (row) {
      await proveSent(row, ev);
      counts.matchedBySendId += 1;
      return;
    }
  }
  const byRecipient = await matchByRecipient(ev, restoredFrom);
  if (byRecipient) {
    counts.matchedByRecipient += 1;
    if (byRecipient === "created") counts.rowsCreated += 1;
    return;
  }
  if (await recordExternalSend(ev)) counts.externalSends += 1;
}

const UNCONFIRM_CHUNK = 400;

/** An old backup: emails due before the restore can't be checked with Mailgun, so a person decides (Retry or Skip). */
async function unconfirmOldDueRows(markerAt: Date): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = await db.outboundEmail.findMany({
      where: { status: "QUEUED", mode: { in: ["TEST", "LIVE"] }, dueAt: { lt: markerAt } },
      select: { id: true },
      take: UNCONFIRM_CHUNK,
    });
    if (rows.length === 0) return total;
    const res = await dbWrite((c) =>
      c.outboundEmail.updateMany({
        where: { id: { in: rows.map((r) => r.id) }, status: "QUEUED" },
        data: { status: "UNCONFIRMED", lastError: RESTORED_UNCHECKABLE_MESSAGE },
      }),
    );
    total += res.count;
    if (res.count === 0 || rows.length < UNCONFIRM_CHUNK) return total;
  }
}

function emptyReport(now: Date, passes: number): RestoreReport {
  return {
    finishedAt: now.toISOString(),
    mailgunChecked: false,
    passes,
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

async function notifyChecked(): Promise<void> {
  try {
    await notifyOwner({
      type: "restore.checked",
      title: "Restore check finished",
      body: "Open Settings › Sending & Mailgun to read the report, then click Resume.",
      link: "/settings/sending",
    });
  } catch (err) {
    console.error("[restore] couldn't notify the Owner", err);
  }
}

/**
 * The restore check (B6.7), job "mailgun.restoreScan" `{pass: 1 | 2}`:
 *  - pass 1 (right after start-up): status "scanning"; without Mailgun the report says Mailgun wasn't
 *    checked and the status is "done" (resuming then needs the Owner's acknowledgement); otherwise
 *    the walk below, the report (passes 1), and pass 2 queued for 35 minutes after the restore;
 *  - pass 2: the same walk again (everything it does is idempotent), then "done" and the Owner's
 *    notification "Restore check finished".
 * The walk: Mailgun's accepted events with the tag "outreach" on every synced domain and every sending domain the
 * replaced database had (RestoreState.domainsBefore), from the scan start (clipped to Mailgun's log retention) to now;
 * each is matched by Message-ID, then by send id, then by (campaign, step, recipient), else recorded as an
 * ExternalSend. When the backup is older than the retention, TEST/LIVE emails due before the restore become "Not sure
 * it was sent". When the replaced database's domains couldn't be read (domainsBefore null), the report says Mailgun
 * wasn't checked completely (`mailgunChecked: false`), so resuming needs the Owner's acknowledgement.
 */
export async function runRestoreScan(
  opts: {
    now?: Date;
    pass?: 1 | 2;
    mailgun?: () => Promise<MailgunContextResult>;
    signal?: AbortSignal;
    progress?: (done: number, total: number) => Promise<void>;
  } = {},
): Promise<RestoreReport> {
  const now = opts.now ?? new Date();
  const pass = opts.pass ?? 1;
  const initial = (await readTyped(STATE_KEYS.restore, parseRestoreState)).value;
  if (initial.status === "none") {
    return { ...emptyReport(now, 0), error: "No restore to check." };
  }
  // A handled marker that couldn't be deleted at start-up gets another try (review BACKUPS-4).
  await deleteHandledRestoreMarker().catch(() => false);
  if (pass === 1) {
    await updateTyped(STATE_KEYS.restore, parseRestoreState, (cur): RestoreState | null =>
      cur.status === "scanning" ? null : { ...cur, status: "scanning" },
    );
  }

  let ctx: MailgunContextResult;
  try {
    ctx = await (opts.mailgun ?? (() => getMailgunContext()))();
  } catch (err) {
    ctx = { connected: false, reason: "no-key", text: err instanceof Error ? err.message : String(err) };
  }
  if (!ctx.connected) {
    const report: RestoreReport = { ...emptyReport(now, pass), error: ctx.text || null };
    await updateTyped(STATE_KEYS.restore, parseRestoreState, (cur): RestoreState => ({ ...cur, status: "done", report }));
    // Unchecked: the Owner must confirm the risk, also after resuming while the check was still running.
    await pauseUntilAcknowledged(now);
    await notifyChecked();
    return report;
  }

  const s = await getSettings(["mailgun.logRetentionDays"] as const);
  // MAIN-DOMAIN-DESIGN O26: never more days than the Mailgun plan keeps (today's reading of the setting first, so app
  // mode without a plan is unchanged).
  const retentionDays = effectiveLogRetentionDays(Math.max(1, Math.floor(Number(s["mailgun.logRetentionDays"]) || 5)), await loadPlanLimits());
  const scanFrom = initial.scanFrom ? new Date(Date.parse(initial.scanFrom)) : new Date(now.getTime() - retentionDays * 86_400_000);
  const earliest = new Date(now.getTime() - retentionDays * 86_400_000 + 3_600_000);
  const olderThanRetention = scanFrom.getTime() < earliest.getTime();
  const start = olderThanRetention ? earliest : scanFrom;
  const restoredFrom = initial.restoredFrom ? new Date(Date.parse(initial.restoredFrom)) : null;
  const counts: ScanCounts = {
    acceptedEvents: 0,
    matchedByMessageId: 0,
    matchedBySendId: 0,
    matchedByRecipient: 0,
    rowsCreated: 0,
    externalSends: 0,
    madeUnconfirmed: 0,
  };

  // The restored database's domains, plus the ones the replaced database used (review BACKUPS-7): a domain connected
  // after the backup is unknown to it, and its sends must still count for the 30-day rule.
  const synced = await domainsToSync(now);
  const known = new Set(synced.map((d) => d.name.toLowerCase()));
  const domains = [...synced, ...(initial.domainsBefore ?? []).filter((d) => !known.has(d.name))];
  const domainsUnknown = initial.domainsBefore === null;

  for (const d of domains) {
    const client = clientFor(ctx, d.region);
    const walk = await client.walkLogs(
      {
        start,
        end: now,
        events: ["accepted"],
        filters: [
          { attribute: "domain", comparator: "=", value: d.name },
          { attribute: "tag", comparator: "=", value: "outreach" },
        ],
      },
      async (items) => {
        for (const item of items) {
          const ev = normalizeLogItem(item);
          if (!ev || ev.type !== "accepted") continue;
          await matchAccepted(ev, restoredFrom, counts);
        }
        await opts.progress?.(counts.acceptedEvents, counts.acceptedEvents);
      },
      { signal: opts.signal },
    );
    if (!walk.complete) {
      throw new Error(
        walk.stoppedBecause === "aborted"
          ? "The restore check was stopped before it finished."
          : "Mailgun's logs had more pages than the app reads in one go.",
      );
    }
  }
  const markerAt = initial.markerAt ? new Date(Date.parse(initial.markerAt)) : now;
  if (olderThanRetention) counts.madeUnconfirmed = await unconfirmOldDueRows(markerAt);

  const report: RestoreReport = {
    ...emptyReport(now, pass),
    ...counts,
    // Without the replaced database's domains, a domain only it knew can't have been walked: not a complete check.
    mailgunChecked: !domainsUnknown,
    error: domainsUnknown ? RESTORE_DOMAINS_UNKNOWN : null,
    windowFrom: start.toISOString(),
    windowTo: now.toISOString(),
    olderThanRetention,
  };
  if (pass === 1) {
    await updateTyped(STATE_KEYS.restore, parseRestoreState, (cur): RestoreState => ({ ...cur, status: "scanning", report }));
    await enqueueJob({
      type: "mailgun.restoreScan",
      payload: { pass: 2 },
      runAt: new Date(markerAt.getTime() + RESTORE_SECOND_PASS_MS),
      dedupeKey: RESTORE_SCAN_SECOND_DEDUPE,
      priority: RESTORE_SCAN_PRIORITY,
    });
  } else {
    await updateTyped(STATE_KEYS.restore, parseRestoreState, (cur): RestoreState => ({ ...cur, status: "done", report }));
    // Not complete: the Owner must confirm the risk, also after resuming while the check was still running.
    if (domainsUnknown) await pauseUntilAcknowledged(now);
    await notifyChecked();
  }
  return report;
}

/** The report's reason when the replaced database's sending domains couldn't be read (review BACKUPS-7). */
export const RESTORE_DOMAINS_UNKNOWN =
  "The app couldn't read which Mailgun domains were in use just before the restore, so emails sent through another sending domain may not have been found.";

/**
 * The job failed for good (or was found stopped at start-up): the check is "failed", so TEST/LIVE emails stay held
 * until the Owner resumes with the "may go out a second time" confirmation, and the restore pause is on again for
 * that (the Owner may have resumed while the check was still running). A check already done or failed keeps its
 * report (the first reason stays).
 */
export async function markRestoreScanFailed(error: string, now: Date = new Date()): Promise<void> {
  await updateTyped(STATE_KEYS.restore, parseRestoreState, (cur): RestoreState | null =>
    cur.status === "done" || cur.status === "failed" || cur.status === "none"
      ? null
      : {
          ...cur,
          status: "failed",
          report: { ...(cur.report ?? emptyReport(now, 0)), finishedAt: now.toISOString(), error },
        },
  );
  await pauseUntilAcknowledged(now);
}

// ───────────────────────── the "Last restore" card (M6-DESIGN §3.7) ─────────────────────────

export type LastRestoreView = {
  /**
   * "Restored on 27 Sep at 14:05 from the backup of 26 Sep, 22:14." In own-mailbox mode, until someone clicks I've read
   * after the restore, followed by RESTORE_OWN_MAILBOX_TEXTS.undone (review REPLIES-02).
   */
  restoredLine: string;
  /** What the check with Mailgun found (or is doing): restoreReportLines(), the pause card's own words. */
  report: RestoreReportLines;
  /** Whether sending was resumed after it, and by whom; or that it stays paused, or resumed while the check runs. */
  resumeLine: string;
};

/** The sentences of the "Last restore" card (M6-DESIGN §3.7). */
export const LAST_RESTORE_TEXTS = {
  staysPaused: "Sending stays paused until the Owner reads this and clicks Resume in Settings › Sending & Mailgun.",
  resumedWhileRunning: "Sending was resumed while the check is still running; emails through Mailgun wait until it finishes.",
  resumed: "Sending was resumed.",
} as const;

/** "27 Sep at 14:05" (the year added when it isn't this year) in `zone`. */
function onAt(d: string, zone: string, now: Date): string {
  return `${formatShortDate(d, zone, now)} at ${formatTime(d, zone)}`;
}

/**
 * Own-mailbox mode: RESTORE_OWN_MAILBOX_TEXTS.undone (the card's first sentence names the backup already) while nobody
 * has clicked I've read since the restore was handled; null in app mode, and once someone has (review REPLIES-02).
 */
async function undoneRepliesLine(restore: RestoreState): Promise<string | null> {
  const from = await ownMailboxOf();
  if (!from) return null;
  const restoredAt = Date.parse(restore.handledAt ?? restore.markerAt ?? "");
  const check = (await readTyped(STATE_KEYS.inboxCheck, parseInboxCheckState)).value;
  const checkedAt = check.at ? Date.parse(check.at) : Number.NaN;
  if (Number.isFinite(checkedAt) && (!Number.isFinite(restoredAt) || checkedAt > restoredAt)) return null;
  return RESTORE_OWN_MAILBOX_TEXTS.undone(from, null);
}

/**
 * Settings › Backups' "Last restore" card (M6-DESIGN §3.7, D18), kept after Resume: when the restore happened and from
 * which backup, the restore report, and who resumed sending after it (`resumedAt/resumedById`, written by
 * resumeSending; else the acknowledgement of a check that didn't cover Mailgun). While the restore pause is on, it says
 * sending stays paused. In own-mailbox mode, until someone has clicked I've read after the restore, the first line also
 * says that They replied clicks made after the backup were undone (review REPLIES-02). Null when there was never a
 * restore. Dates in `zone` (the viewer's). Reads only.
 */
export async function lastRestoreView(zone: string, now: Date): Promise<LastRestoreView | null> {
  const restore = (await readTyped(STATE_KEYS.restore, parseRestoreState)).value;
  if (restore.status === "none") return null;
  const pause = await getPauseState();

  const at = restore.markerAt ?? restore.handledAt;
  const when = at ? `Restored on ${onAt(at, zone, now)}` : "Restored";
  const from = restore.restoredFrom
    ? ` from the backup of ${formatShortDate(restore.restoredFrom, zone, now)}, ${formatTime(restore.restoredFrom, zone)}`
    : " from a backup";
  const undone = await undoneRepliesLine(restore);
  const restoredLine = `${when}${from}.${undone ? ` ${undone}` : ""}`;

  const restorePaused = pause.paused && (pause.kind === "restore" || pause.also.some((a) => a.kind === "restore"));
  const running = restore.status === "pending" || restore.status === "scanning";
  let resumeLine: string;
  if (restorePaused) {
    resumeLine = LAST_RESTORE_TEXTS.staysPaused;
  } else if (running) {
    resumeLine = LAST_RESTORE_TEXTS.resumedWhileRunning;
  } else {
    const resumedAt = restore.resumedAt ?? restore.acknowledgedAt;
    const byId = restore.resumedAt ? (restore.resumedById ?? null) : restore.acknowledgedById;
    const who = byId ? (await db.user.findUnique({ where: { id: byId }, select: { name: true } }))?.name : null;
    resumeLine = resumedAt
      ? `Sending was resumed${who ? ` by ${who}` : ""} on ${onAt(resumedAt, zone, now)}.`
      : LAST_RESTORE_TEXTS.resumed;
  }
  return { restoredLine, report: restoreReportLines(restore, zone, now), resumeLine };
}

// ───────────────────────── copied database ─────────────────────────

function currentDbPath(): string {
  return path.resolve(databaseFilePath()).replace(/\\/g, "/").toLowerCase();
}

/**
 * `<database file>.instance` (data\app.db.instance): a small note NEXT TO the database saying which database last ran
 * at this place and on which computer. It travels with a copy of the whole app folder but not with the database file
 * alone, and backups never contain it, so together with SystemState "instance" (inside the database) it tells a copy
 * at the same place from a normal restart.
 */
export function instanceNotePath(): string {
  return path.resolve(databaseFilePath()) + ".instance";
}

export const INSTANCE_NOTE_VERSION = 1;

export type InstanceNote = { id: string; host: string };

/** The note, or null when it is missing or unreadable (it is written again). */
function readInstanceNote(file: string): InstanceNote | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    const host = typeof o.host === "string" ? o.host.trim() : "";
    return id && host ? { id, host } : null;
  } catch {
    return null;
  }
}

/** Through a temporary name and a rename, so a crash never leaves half a note. */
function writeInstanceNote(file: string, note: Record<string, unknown>): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(note, null, 2) + "\n", "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Why this database looks like a copy: another place, another computer, or another database at this place. */
export type CopyCause = "moved" | "other-computer" | "replaced";

/**
 * Pure: compares the database's own record (SystemState "instance") and the note next to it with where and on which
 * computer it opens now. No record yet (the first start, or a database from before Milestone 3) is never a copy: there
 * is nothing to compare. Without the note (the database file alone was copied, or the first start since the note
 * exists), the computer the record names decides (M6, L8): another computer is a copy; a record without a computer
 * (written before M6) isn't. Computer names are compared without regard to case.
 */
export function copyCause(current: InstanceState | null, note: InstanceNote | null, dbPath: string, host: string): CopyCause | null {
  if (!current) return null;
  if (current.dbPath !== dbPath) return "moved";
  if (!note) return current.host && current.host.toLowerCase() !== host.toLowerCase() ? "other-computer" : null;
  if (note.host.toLowerCase() !== host.toLowerCase()) return "other-computer";
  if (note.id !== current.id) return "replaced";
  return null;
}

/**
 * Start-up, before handleRestoreMarker: is this database a copy that could send the same emails again?
 *  - SystemState "instance" (inside the database) remembers where the database file lives, a random id and (M6, L8)
 *    the computer it last started on;
 *  - the note next to the file (instanceNotePath) remembers which database (that id) last ran here, on which computer.
 * Without a RESTORED marker for this database, sending pauses ("copied-database") when the file opens from a different
 * place (moved or copied), when the note names another computer (the whole app folder was copied to this computer, or
 * from it), when there is no note but the database itself names another computer (the database file alone was copied
 * to the same place on a new PC; a renamed PC costs one Resume too), or when the note names another database (the file
 * was swapped by hand). Then the new place, computer and id are recorded, so the next start is normal again once the
 * Owner has resumed. With a marker (a restore) they are just recorded. Normal restarts, updates and restores never
 * pause here.
 * A note that can't be written is logged and doesn't stop the start-up (the next start writes it again).
 */
export async function checkDatabaseInstance(opts: {
  now?: Date;
  markerSeen: boolean;
  /** Tests: where the note lives (default instanceNotePath()). */
  notePath?: string;
  /** Tests: this computer's name (default os.hostname()). */
  hostName?: string;
  logger?: Logger;
}): Promise<{ copied: boolean }> {
  const now = opts.now ?? new Date();
  const logger = opts.logger ?? consoleLogger;
  const dbPath = currentDbPath();
  const host = (opts.hostName ?? os.hostname()).trim() || "this computer";
  const noteFile = opts.notePath ?? instanceNotePath();
  const current = parseInstanceState((await readTyped(STATE_KEYS.instance, (v) => v)).value);
  const note = readInstanceNote(noteFile);
  const cause = copyCause(current, note, dbPath, host);
  const copied = cause !== null && !opts.markerSeen;
  if (copied) {
    const lastComputer = note?.host ?? current?.host ?? "unknown";
    const pause =
      cause === "moved" ? COPIED_DATABASE_PAUSE : cause === "other-computer" ? otherComputerPause(lastComputer) : REPLACED_DATABASE_PAUSE;
    await pauseSending({ ...pause, now });
    const what =
      cause === "moved"
        ? "This database opens from a different place than before"
        : cause === "other-computer"
          ? `This database last ran on another computer (${lastComputer})`
          : "The database file was replaced by another database";
    logger.warn(`${what} and there is no restore marker: sending is paused until the Owner resumes it.`);
  }

  let id = current?.id ?? null;
  if (!current || current.dbPath !== dbPath || current.host !== host) {
    const res = await updateTyped(STATE_KEYS.instance, (v) => parseInstanceState(v), (cur) => ({
      dbPath,
      id: cur?.id ?? crypto.randomBytes(8).toString("hex"),
      firstSeenAt: cur?.firstSeenAt ?? now.toISOString(),
      host,
    }));
    id = res.value?.id ?? id;
  }
  if (id && (!note || note.id !== id || note.host !== host)) {
    try {
      writeInstanceNote(noteFile, { version: INSTANCE_NOTE_VERSION, id, host, dbPath, at: now.toISOString() });
    } catch (err) {
      logger.warn(
        `Couldn't write ${path.basename(noteFile)} next to the database (${(err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err))}); the next start tries again.`,
      );
    }
  }
  // Which cause it was is in the pause's reason (the card and the top bar show it).
  return { copied };
}
