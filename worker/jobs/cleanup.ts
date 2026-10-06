import fsp from "node:fs/promises";
import path from "node:path";
import { plural } from "@/core/text";
import { db, dbWrite } from "@/server/db";
import { databaseFilePath } from "@/server/env";
import type { JobHandler } from "@/server/jobs";
import { clearOldReplyTexts } from "@/server/services/replies/retention";
import { recordTaskSuccess } from "../periodic";
import type { JobDefinition } from "./types";

/**
 * Daily clean-up (PLAN.md B8): old sign-in data, finished tasks, read notifications and old files, and (Milestone 4,
 * M4-DESIGN §3.2, D26) the texts of replies processed more than 30 days ago: `bodyText` and `strippedText` are cleared,
 * the first lines (`snippet`), the classifier's signals and every decision stay, so the app never becomes an inbox.
 * Milestone 5 (M5-DESIGN §3.4.9, D17): saved website pages older than 60 days that no waiting or in-progress AI draft
 * points at, and saved robots.txt files older than 7 days.
 * Each kind is handled in small chunks, each chunk in its own short write.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CHUNK = 500;

export const CLEANUP_RULES = {
  loginAttemptsDays: 7,
  webhookTokensHours: 48,
  accessLinksExpiredDays: 30,
  finishedJobsDays: 30,
  readNotificationsDays: 90,
  /** Reply texts are cleared this many days after the reply was processed (M4-DESIGN §3.2). */
  replyTextsDays: 30,
  /** Saved website pages (WebsiteSnapshot) older than this go, unless a waiting or in-progress draft uses them (M5). */
  snapshotDays: 60,
  /** Saved robots.txt files (RobotsCache) older than this go (M5). */
  robotsDays: 7,
  logFilesDays: 14,
  testFilesDays: 1,
} as const;

/**
 * The only files the clean-up deletes in data\test (M6-DESIGN §3.9, L15): the throw-away databases the tests make
 * (tests/integration/helpers/test-db.ts createTestDb: "<name>-<pid>-<ms>-<rand>.db") and build-worker's self-test
 * database ("build-worker-<pid>-<ms>.db"), with their -wal, -shm and -journal files. Never an ".instance" note, never
 * a database put there by hand (manual checks belong in data\manual-check), never the live database.
 */
export const TEST_FILE_PATTERNS: readonly RegExp[] = [
  /^[A-Za-z0-9._-]+-\d+-\d{10,}-\d+\.db(?:-wal|-shm|-journal)?$/,
  /^build-worker-\d+-\d{10,}\.db(?:-wal|-shm|-journal)?$/,
];

/** True for a name the clean-up may delete in data\test (when it is older than a day). */
export function isThrowAwayTestFile(name: string): boolean {
  return TEST_FILE_PATTERNS.some((re) => re.test(name));
}

export type CleanupCounts = {
  sessions: number;
  loginAttempts: number;
  webhookTokens: number;
  accessLinks: number;
  jobs: number;
  notifications: number;
  /** Replies whose texts were cleared (processed more than 30 days ago). */
  replyTexts: number;
  /** Saved website pages deleted (older than 60 days, used by no waiting or in-progress draft). */
  snapshots: number;
  /** Saved robots.txt files deleted (older than 7 days). */
  robots: number;
  logFiles: number;
  testFiles: number;
};

/** Drafts that still need their saved pages: waiting for review (the card shows the quote in context) or in progress. */
const DRAFT_STATUSES_USING_SNAPSHOTS = ["QUEUED", "FETCHING", "DRAFTING", "READY"] as const;

/**
 * Deletes saved website pages fetched before `before` that no waiting or in-progress draft points at
 * (`homeSnapshotId` / `pageSnapshotId`), in chunks of 500 walked by id, each delete its own short write. A review card
 * whose page is gone says so; approved, rejected and failed drafts don't need theirs.
 */
async function deleteOldSnapshots(before: Date, signal?: AbortSignal): Promise<number> {
  let deleted = 0;
  let lastId = 0;
  for (;;) {
    throwIfAborted(signal);
    const ids = (
      await db.websiteSnapshot.findMany({
        where: { fetchedAt: { lt: before }, id: { gt: lastId } },
        select: { id: true },
        orderBy: { id: "asc" },
        take: CHUNK,
      })
    ).map((r) => r.id);
    if (ids.length === 0) break;
    lastId = ids[ids.length - 1]!;
    const used = new Set<number>();
    for (const d of await db.aiDraft.findMany({
      where: { status: { in: [...DRAFT_STATUSES_USING_SNAPSHOTS] }, OR: [{ homeSnapshotId: { in: ids } }, { pageSnapshotId: { in: ids } }] },
      select: { homeSnapshotId: true, pageSnapshotId: true },
    })) {
      if (d.homeSnapshotId !== null) used.add(d.homeSnapshotId);
      if (d.pageSnapshotId !== null) used.add(d.pageSnapshotId);
    }
    const free = ids.filter((id) => !used.has(id));
    if (free.length > 0) {
      deleted += await dbWrite((c) => c.websiteSnapshot.deleteMany({ where: { id: { in: free }, fetchedAt: { lt: before } } })).then((r) => r.count);
    }
    if (ids.length < CHUNK) break;
  }
  return deleted;
}

export type CleanupOptions = {
  now?: Date;
  /** Folder with NSSM's *.log files. Default: <project>\logs. */
  logsDir?: string;
  /** Folder with temporary test databases. Default: <project>\data\test. Only TEST_FILE_PATTERNS names go. */
  testDataDir?: string;
  signal?: AbortSignal;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Stopped");
}

/** Repeatedly finds up to 500 ids and deletes them, until none are left. */
async function deleteInChunks<T>(
  find: () => Promise<T[]>,
  remove: (ids: T[]) => Promise<number>,
  signal?: AbortSignal,
): Promise<number> {
  let total = 0;
  for (;;) {
    throwIfAborted(signal);
    const ids = await find();
    if (ids.length === 0) break;
    const removed = await remove(ids);
    total += removed;
    if (removed === 0 || ids.length < CHUNK) break;
  }
  return total;
}

function sameFile(a: string, b: string): boolean {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** Deletes files (not folders) in `dir` whose last change is older than `maxAgeMs`. Files in use are skipped. */
async function deleteOldFiles(
  dir: string,
  maxAgeMs: number,
  now: Date,
  accept: (name: string) => boolean,
  keep: (fullPath: string) => boolean = () => false,
): Promise<number> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // folder doesn't exist yet
  }
  let deleted = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !accept(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (keep(full)) continue;
    try {
      const st = await fsp.stat(full);
      if (now.getTime() - st.mtimeMs <= maxAgeMs) continue;
      await fsp.unlink(full);
      deleted += 1;
    } catch {
      /* in use (e.g. the log NSSM is writing) or already gone: try again tomorrow */
    }
  }
  return deleted;
}

export async function runCleanup(options: CleanupOptions = {}): Promise<CleanupCounts> {
  const now = options.now ?? new Date();
  const signal = options.signal;
  const cwd = /*turbopackIgnore: true*/ process.cwd();
  const logsDir = options.logsDir ?? path.join(cwd, "logs");
  const testDataDir = options.testDataDir ?? path.join(cwd, "data", "test");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  const sessions = await deleteInChunks(
    () => db.session.findMany({ where: { expiresAt: { lt: now } }, select: { id: true }, take: CHUNK }).then((r) => r.map((x) => x.id)),
    (ids) => dbWrite((c) => c.session.deleteMany({ where: { id: { in: ids } } })).then((r) => r.count),
    signal,
  );

  const loginAttempts = await deleteInChunks(
    () =>
      db.loginAttempt
        .findMany({ where: { at: { lt: ago(CLEANUP_RULES.loginAttemptsDays * DAY) } }, select: { id: true }, take: CHUNK })
        .then((r) => r.map((x) => x.id)),
    (ids) => dbWrite((c) => c.loginAttempt.deleteMany({ where: { id: { in: ids } } })).then((r) => r.count),
    signal,
  );

  const webhookTokens = await deleteInChunks(
    () =>
      db.webhookToken
        .findMany({ where: { receivedAt: { lt: ago(CLEANUP_RULES.webhookTokensHours * HOUR) } }, select: { token: true }, take: CHUNK })
        .then((r) => r.map((x) => x.token)),
    (ids) => dbWrite((c) => c.webhookToken.deleteMany({ where: { token: { in: ids } } })).then((r) => r.count),
    signal,
  );

  const accessLinks = await deleteInChunks(
    () =>
      db.accessLink
        .findMany({ where: { expiresAt: { lt: ago(CLEANUP_RULES.accessLinksExpiredDays * DAY) } }, select: { id: true }, take: CHUNK })
        .then((r) => r.map((x) => x.id)),
    (ids) => dbWrite((c) => c.accessLink.deleteMany({ where: { id: { in: ids } } })).then((r) => r.count),
    signal,
  );

  const jobs = await deleteInChunks(
    () =>
      db.job
        .findMany({
          where: {
            status: { in: ["DONE", "FAILED", "CANCELLED"] },
            finishedAt: { lt: ago(CLEANUP_RULES.finishedJobsDays * DAY) },
          },
          select: { id: true },
          take: CHUNK,
        })
        .then((r) => r.map((x) => x.id)),
    (ids) =>
      dbWrite((c) =>
        // Re-check the status: never delete a task that was re-queued in the meantime.
        c.job.deleteMany({ where: { id: { in: ids }, status: { in: ["DONE", "FAILED", "CANCELLED"] } } }),
      ).then((r) => r.count),
    signal,
  );

  const notifications = await deleteInChunks(
    () =>
      db.notification
        .findMany({ where: { readAt: { lt: ago(CLEANUP_RULES.readNotificationsDays * DAY) } }, select: { id: true }, take: CHUNK })
        .then((r) => r.map((x) => x.id)),
    (ids) => dbWrite((c) => c.notification.deleteMany({ where: { id: { in: ids } } })).then((r) => r.count),
    signal,
  );

  throwIfAborted(signal);
  // In writes of at most 500 rows; unprocessed replies keep their text (the event lane still needs it).
  const replyTexts = await clearOldReplyTexts({ now, days: CLEANUP_RULES.replyTextsDays, chunk: CHUNK });

  const snapshots = await deleteOldSnapshots(ago(CLEANUP_RULES.snapshotDays * DAY), signal);

  const robots = await deleteInChunks(
    () =>
      db.robotsCache
        .findMany({ where: { fetchedAt: { lt: ago(CLEANUP_RULES.robotsDays * DAY) } }, select: { host: true }, take: CHUNK })
        .then((r) => r.map((x) => x.host)),
    (hosts) =>
      dbWrite((c) =>
        // Re-check the age: a robots.txt read again meanwhile stays.
        c.robotsCache.deleteMany({ where: { host: { in: hosts }, fetchedAt: { lt: ago(CLEANUP_RULES.robotsDays * DAY) } } }),
      ).then((r) => r.count),
    signal,
  );

  throwIfAborted(signal);
  const logFiles = await deleteOldFiles(logsDir, CLEANUP_RULES.logFilesDays * DAY, now, (name) => /\.log$/i.test(name));

  const liveDb = databaseFilePath();
  const testFiles = await deleteOldFiles(
    testDataDir,
    CLEANUP_RULES.testFilesDays * DAY,
    now,
    isThrowAwayTestFile,
    (full) => ["", "-wal", "-shm", "-journal"].some((suffix) => sameFile(full, liveDb + suffix)),
  );

  return { sessions, loginAttempts, webhookTokens, accessLinks, jobs, notifications, replyTexts, snapshots, robots, logFiles, testFiles };
}

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * "Removed 3 expired sign-ins, 120 old sign-in attempts, the text of 12 replies older than 30 days, 40 saved website
 * pages older than 60 days and 2 old log files."
 */
export function cleanupSummary(c: CleanupCounts): string {
  const parts = [
    c.sessions ? plural(c.sessions, "expired sign-in", "expired sign-ins") : "",
    c.loginAttempts ? plural(c.loginAttempts, "old sign-in attempt", "old sign-in attempts") : "",
    c.webhookTokens ? plural(c.webhookTokens, "old webhook token", "old webhook tokens") : "",
    c.accessLinks ? plural(c.accessLinks, "expired invite or reset link", "expired invite or reset links") : "",
    c.jobs ? `${plural(c.jobs, "finished task", "finished tasks")} older than 30 days` : "",
    c.notifications ? `${plural(c.notifications, "read notification", "read notifications")} older than 90 days` : "",
    c.replyTexts ? `the text of ${plural(c.replyTexts, "reply", "replies")} older than ${CLEANUP_RULES.replyTextsDays} days` : "",
    c.snapshots
      ? `${plural(c.snapshots, "saved website page", "saved website pages")} older than ${CLEANUP_RULES.snapshotDays} days`
      : "",
    c.robots ? `${plural(c.robots, "saved robots.txt file", "saved robots.txt files")} older than ${CLEANUP_RULES.robotsDays} days` : "",
    c.logFiles ? plural(c.logFiles, "old log file", "old log files") : "",
    c.testFiles ? plural(c.testFiles, "old test file", "old test files") : "",
  ].filter(Boolean);
  return parts.length === 0 ? "Nothing needed cleaning up." : `Removed ${joinList(parts)}.`;
}

export const runCleanupJob: JobHandler = async (_payload, ctx) => {
  const counts = await runCleanup({ signal: ctx.signal });
  await recordTaskSuccess("cleanup.daily");
  return { summary: cleanupSummary(counts), ...counts };
};

export const cleanupJob: JobDefinition = {
  handler: runCleanupJob,
  label: "The daily clean-up",
  whatToDo: "Nothing is lost: it tries again tomorrow. If this message keeps coming back, restart the office PC.",
  link: null,
};
