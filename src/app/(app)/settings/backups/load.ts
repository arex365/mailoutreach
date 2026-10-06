import "server-only";
import { formatDateTime, timeAgo } from "@/core/time/format";
import type { SessionUser } from "@/lib/auth/session";
import {
  DEFAULT_KEEP,
  MANUAL_BACKUP_KEEP,
  backupFolder,
  backupKindText,
  backupStatus,
  diskLowText,
  formatBytes,
  getPendingManualBackupJob,
  listBackups,
  normalizeKeep,
} from "@/server/services/backups";
import { lastRestoreView, type LastRestoreView } from "@/server/services/sending/restore";
import { getSettings } from "@/server/settings";

/**
 * Everything Settings › Backups (M6-DESIGN §3.4–§3.7) shows, already worded and formatted in the viewer's time zone:
 * the warning banner (no backup yet, or the newest older than 36 hours), the disk-space line, the last backup, the
 * "Last restore" card, the saved backups (the background sender's and the scripts'), and the second folder. Reads only.
 */

export type BackupRowView = {
  fileName: string;
  madeOn: string;
  ago: string;
  size: string;
  kind: string;
  /** "Copied" / "Not copied" for the background sender's backups, "—" for the scripts' (never copied). */
  secondCopy: string;
};

export type BackupsView = {
  /** The page description: what is kept. */
  description: string;
  /** Warning banner: title and the line under it; null when the newest backup is recent. */
  banner: { title: string; text: string } | null;
  /** The disk-space line, or null while there's enough room. */
  diskLow: string | null;
  /** The newest app backup, e.g. "27 Sep 2026, 22:14 · 7 hours ago · 12 MB · Daily backup"; null when there is none. */
  lastBackup: string | null;
  lastRestore: LastRestoreView | null;
  rows: BackupRowView[];
  /** Show the "Second copy" column (a second folder is set, or a backup was copied). */
  showCopyColumn: boolean;
  secondFolder: string | null;
  workerRunning: boolean;
  pendingJob: { id: number; status: string } | null;
  folder: string;
  isOwner: boolean;
  practiceCopy: boolean;
};

/** The banner's words (M6-DESIGN §3.6). */
export const BACKUP_BANNER_TEXTS = {
  staleTitle: "The last backup is more than 36 hours old.",
  staleRunning:
    "Click Back up now to make one. If automatic backups keep stopping, check free disk space on the office PC.",
  neverTitle: "No backup has been made yet.",
  neverRunning: "Click Back up now to make the first one.",
  workerDown:
    "The background sender isn't running, so no automatic backups are made. Double-click start.bat on the office PC.",
} as const;

export async function loadBackupsView(user: SessionUser, now: Date = new Date()): Promise<BackupsView> {
  const [backups, settings, pendingJob, lastRestore] = await Promise.all([
    listBackups(),
    getSettings(["backups.keep", "practice.copy"] as const),
    getPendingManualBackupJob(),
    lastRestoreView(user.timeZone, now),
  ]);
  const status = await backupStatus(now, { backups });
  const tz = user.timeZone;
  const keep = normalizeKeep(settings["backups.keep"] ?? DEFAULT_KEEP);

  const T = BACKUP_BANNER_TEXTS;
  const banner =
    status.age === "never"
      ? { title: T.neverTitle, text: status.workerRunning ? T.neverRunning : T.workerDown }
      : status.age === "stale"
        ? { title: T.staleTitle, text: status.workerRunning ? T.staleRunning : T.workerDown }
        : null;

  const newest = status.newest ? backups.find((b) => b.fileName === status.newest!.fileName) : undefined;
  const lastBackup = newest
    ? [formatDateTime(newest.createdAt, tz), timeAgo(newest.createdAt, now), formatBytes(newest.sizeBytes), backupKindText(newest.kind)].join(
        " · ",
      )
    : null;

  return {
    description: `The app saves a copy of all your data every day and keeps the newest ${keep} daily and ${MANUAL_BACKUP_KEEP} Back up now backups. Anyone can make one now.`,
    banner,
    diskLow: status.diskLow && status.freeBytes !== null ? diskLowText(status.freeBytes) : null,
    lastBackup,
    lastRestore,
    rows: backups.map((b) => ({
      fileName: b.fileName,
      madeOn: formatDateTime(b.createdAt, tz),
      ago: timeAgo(b.createdAt, now),
      size: formatBytes(b.sizeBytes),
      kind: backupKindText(b.kind),
      secondCopy: b.source === "script" ? "—" : b.copiedTo ? "Copied" : "Not copied",
    })),
    showCopyColumn: Boolean(status.secondFolder) || backups.some((b) => b.copiedTo),
    secondFolder: status.secondFolder,
    workerRunning: status.workerRunning,
    pendingJob,
    folder: backupFolder(),
    isOwner: user.role === "OWNER",
    practiceCopy: settings["practice.copy"] === true,
  };
}
