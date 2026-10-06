import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";

const t = await createTestDb("worker-periodic");
const { db, dbWrite } = await import("@/server/db");
const { setSetting } = await import("@/server/settings");
const { PERIODIC_TASKS, checkPeriodicTasks, readTaskState, recordTaskSuccess, taskStateKey } = await import("../../../worker/periodic");
const { runCleanup, cleanupSummary } = await import("../../../worker/jobs/cleanup");

const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const tempDirs: string[] = [];
/** The Milestone 1 tasks; the Mailgun and warm-up tasks have their own tests (tests/integration/worker/m3-wiring.test.ts). */
const DAILY_TASKS = PERIODIC_TASKS.filter((task) => task.name === "backup.daily" || task.name === "cleanup.daily");

afterAll(async () => {
  await db.$disconnect();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  t.cleanup();
});

describe("periodic tasks", () => {
  beforeEach(async () => {
    await dbWrite((c) => c.job.deleteMany({}));
    await dbWrite((c) => c.systemState.deleteMany({ where: { key: { startsWith: "task." } } }));
    await setSetting("sending.capDayTimeZone", "Asia/Karachi", null);
  });

  it("checks the daily tasks, the Mailgun tasks, the warm-up and the Milestone 5 sweeps; queues what is due on a fresh database, once", async () => {
    expect(PERIODIC_TASKS.map((task) => task.name)).toEqual([
      "backup.daily",
      "cleanup.daily",
      "mailgun.catchUp.hourly",
      "mailgun.domainCheck.6h",
      "warmup.hourly",
      "verify.recheck",
      "ai.orphans",
    ]);
    const now = new Date("2026-09-23T05:00:00Z"); // 10:00 in Pakistan
    // Mailgun isn't connected in this database: its two tasks are skipped, the warm-up check still runs. The two
    // Milestone 5 sweeps look (nothing to re-check, no orphaned drafts) and record that they did.
    expect(await checkPeriodicTasks(now, undefined, quiet)).toEqual(["backup.daily", "cleanup.daily", "warmup.hourly", "verify.recheck", "ai.orphans"]);
    expect((await db.job.findMany({ where: { type: "warmup.evaluate" } })).map((j) => [j.activeDedupeKey, j.priority])).toEqual([
      ["warmup", 20],
    ]);
    await dbWrite((c) => c.job.deleteMany({ where: { type: "warmup.evaluate" } }));
  });

  it("queues the daily backup and clean-up on a fresh database, once", async () => {
    const now = new Date("2026-09-23T05:00:00Z"); // 10:00 in Pakistan
    expect(await checkPeriodicTasks(now, DAILY_TASKS, quiet)).toEqual(["backup.daily", "cleanup.daily"]);
    const jobs = await db.job.findMany({ orderBy: { id: "asc" } });
    expect(jobs.map((j) => [j.type, j.activeDedupeKey, j.payload])).toEqual([
      ["backup.run", "backup:auto", { kind: "AUTO" }],
      ["system.cleanup", "cleanup", null],
    ]);

    // The next check (10 minutes later) doesn't queue them again.
    expect(await checkPeriodicTasks(new Date(now.getTime() + 10 * 60_000), DAILY_TASKS, quiet)).toEqual([]);
    expect(await db.job.count()).toBe(2);
  });

  it("24–30 hours after the last backup, waits for a quiet time: no emails due with their window open (M6-DESIGN §3.5)", async () => {
    const lastBackup = new Date("2026-09-22T10:00:00Z"); // 15:00 in Pakistan
    await recordTaskSuccess("backup.daily", lastBackup);
    await recordTaskSuccess("cleanup.daily", new Date("2026-09-23T04:00:00Z"));
    const asked: string[] = [];
    const quietNow = (answer: boolean | null) => async (now: Date) => (asked.push(now.toISOString()), answer);

    const dayTime = new Date(lastBackup.getTime() + 26 * HOUR); // 17:00 in Pakistan, emails due
    expect(await checkPeriodicTasks(dayTime, DAILY_TASKS, quiet, { quietNow: quietNow(false) })).toEqual([]);
    expect(asked).toEqual([dayTime.toISOString()]); // asked once per check

    // Quiet time unknown: the fixed 22:00–08:00 window decides, and 18:00 isn't in it.
    const unknown = new Date(lastBackup.getTime() + 27 * HOUR);
    expect(await checkPeriodicTasks(unknown, DAILY_TASKS, quiet, { quietNow: quietNow(null) })).toEqual([]);

    const quietTime = new Date(lastBackup.getTime() + 28 * HOUR); // 19:00 in Pakistan, nothing due right now
    expect(await checkPeriodicTasks(quietTime, DAILY_TASKS, quiet, { quietNow: quietNow(true) })).toEqual(["backup.daily"]);
  });

  it("a day without a backup gets one once no quiet slot is left that day (22:00), even with emails due (review BACKUPS-8)", async () => {
    await recordTaskSuccess("backup.daily", new Date("2026-09-22T18:00:00Z")); // 23:00 in Pakistan
    await recordTaskSuccess("cleanup.daily", new Date("2026-09-23T04:00:00Z"));
    const busy = async () => false;
    expect(await checkPeriodicTasks(new Date("2026-09-23T15:00:00Z"), DAILY_TASKS, quiet, { quietNow: busy })).toEqual([]); // 20:00
    expect(await checkPeriodicTasks(new Date("2026-09-23T16:50:00Z"), DAILY_TASKS, quiet, { quietNow: busy })).toEqual([]); // 21:50
    expect(await checkPeriodicTasks(new Date("2026-09-23T17:00:00Z"), DAILY_TASKS, quiet, { quietNow: busy })).toEqual(["backup.daily"]);
  });

  it("a failing quiet-time answer never stops the check", async () => {
    const now = new Date("2026-09-23T05:00:00Z");
    const broken = async (): Promise<boolean | null> => {
      throw new Error("the database is busy");
    };
    expect(await checkPeriodicTasks(now, DAILY_TASKS, quiet, { quietNow: broken })).toEqual(["backup.daily", "cleanup.daily"]);
  });

  it("keeps the last success and the last enqueue time side by side", async () => {
    const now = new Date("2026-09-23T18:00:00Z");
    await checkPeriodicTasks(now, DAILY_TASKS, quiet);
    await recordTaskSuccess("backup.daily", new Date(now.getTime() + 60_000));
    const state = await readTaskState("backup.daily");
    expect(state.lastEnqueuedAt?.toISOString()).toBe(now.toISOString());
    expect(state.lastSuccessAt?.toISOString()).toBe(new Date(now.getTime() + 60_000).toISOString());
    const row = await db.systemState.findUniqueOrThrow({ where: { key: taskStateKey("backup.daily") } });
    expect(row.value).toMatchObject({ lastSuccessAt: expect.any(String), lastEnqueuedAt: expect.any(String) });
  });

  it("tries a failed task again after an hour, not at every check", async () => {
    const now = new Date("2026-09-23T18:00:00Z");
    await checkPeriodicTasks(now, DAILY_TASKS, quiet);
    // The queued jobs failed for good: their dedupe keys are gone.
    await dbWrite((c) => c.job.updateMany({ data: { status: "FAILED", activeDedupeKey: null, finishedAt: now } }));
    expect(await checkPeriodicTasks(new Date(now.getTime() + 20 * 60_000), DAILY_TASKS, quiet)).toEqual([]);
    expect(await checkPeriodicTasks(new Date(now.getTime() + HOUR), DAILY_TASKS, quiet)).toEqual([
      "backup.daily",
      "cleanup.daily",
    ]);
    expect(await db.job.count({ where: { status: "QUEUED" } })).toBe(2);
  });

  it("keeps going when one task's check fails", async () => {
    const tasks = [
      { name: "broken", intervalMs: DAY, retryAfterMs: HOUR, enqueue: async () => Promise.reject(new Error("nope")) },
      { name: "fine", intervalMs: DAY, retryAfterMs: HOUR, enqueue: async () => undefined },
    ];
    expect(await checkPeriodicTasks(new Date(), tasks, quiet)).toEqual(["fine"]);
    expect(quiet.error).toHaveBeenCalled();
  });
});

describe("daily clean-up", () => {
  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-cleanup-test-"));
    tempDirs.push(dir);
    return dir;
  }
  function file(dir: string, name: string, ageMs: number, now: Date) {
    const full = path.join(dir, name);
    fs.writeFileSync(full, "x");
    const time = new Date(now.getTime() - ageMs);
    fs.utimesSync(full, time, time);
    return full;
  }

  it("removes only what is old enough, and says what it removed", async () => {
    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const user = await dbWrite((c) => c.user.create({ data: { email: "ali@example.com", name: "Ali" } }));
    await dbWrite(async (c) => {
      await c.session.create({ data: { tokenHash: "expired", userId: user.id, expiresAt: ago(1_000) } });
      await c.session.create({ data: { tokenHash: "live", userId: user.id, expiresAt: new Date(now.getTime() + DAY) } });
      await c.loginAttempt.createMany({
        data: [
          { emailNorm: "a@x.com", sourceKey: "lan:1", success: false, at: ago(8 * DAY) },
          { emailNorm: "a@x.com", sourceKey: "lan:1", success: false, at: ago(6 * DAY) },
        ],
      });
      await c.webhookToken.createMany({
        data: [
          { token: "old", receivedAt: ago(49 * HOUR) },
          { token: "new", receivedAt: ago(47 * HOUR) },
        ],
      });
      await c.accessLink.createMany({
        data: [
          { userId: user.id, purpose: "INVITE", tokenHash: "old-link", expiresAt: ago(31 * DAY) },
          { userId: user.id, purpose: "RESET", tokenHash: "recent-link", expiresAt: ago(29 * DAY) },
        ],
      });
      await c.job.createMany({
        data: [
          { type: "backup.run", status: "DONE", finishedAt: ago(31 * DAY) },
          { type: "backup.run", status: "FAILED", finishedAt: ago(40 * DAY) },
          { type: "backup.run", status: "DONE", finishedAt: ago(29 * DAY) },
          { type: "backup.run", status: "QUEUED", finishedAt: ago(90 * DAY) },
        ],
      });
      await c.notification.createMany({
        data: [
          { userId: user.id, type: "x", title: "old read", readAt: ago(91 * DAY) },
          { userId: user.id, type: "x", title: "recent read", readAt: ago(10 * DAY) },
          { userId: user.id, type: "x", title: "unread", createdAt: ago(200 * DAY) },
        ],
      });
      // Milestone 4: reply texts go 30 days after processing; the first lines, the kind and the decision stay.
      const reply = (subject: string, receivedAt: Date, processedAt: Date | null) => ({
        receivedAt,
        processedAt,
        toAddress: "ali@send.example.com",
        fromEmail: "anna@firma.de",
        subject,
        snippet: "Thanks, this sounds interesting.",
        strippedText: "Thanks, this sounds interesting.\nCould you send your prices?",
        bodyText: "Thanks, this sounds interesting.\nCould you send your prices?\n\n> On Monday Ali wrote:",
        kind: processedAt ? ("REPLY" as const) : null,
        answeredAt: processedAt,
        answerOutcome: processedAt ? "answered" : null,
        source: "NOTIFY" as const,
      });
      await c.inboundMessage.createMany({
        data: [
          reply("processed 31 days ago", ago(32 * DAY), ago(31 * DAY)),
          { ...reply("only the stripped text left", ago(45 * DAY), ago(40 * DAY)), bodyText: null },
          reply("processed 29 days ago", ago(29 * DAY), ago(29 * DAY)),
          reply("never processed", ago(60 * DAY), null),
        ],
      });
    });

    const logsDir = tempDir();
    file(logsDir, "worker-old.log", 15 * DAY, now);
    file(logsDir, "worker.log", 1 * DAY, now);
    file(logsDir, "notes-old.txt", 30 * DAY, now);
    // data\test (M6-DESIGN §3.9, L15): only the tests' throw-away databases and build-worker's go, a day after.
    const testDataDir = tempDir();
    file(testDataDir, "worker-backups-1234-1727000000000-123456.db", 2 * DAY, now);
    file(testDataDir, "worker-backups-1234-1727000000000-123456.db-wal", 2 * DAY, now);
    file(testDataDir, "build-worker-1234-1727000000000.db", 2 * DAY, now);
    file(testDataDir, "worker-backups-1234-1727000000001-9.db", HOUR, now); // too new
    file(testDataDir, "worker-backups-1234-1727000000000-123456.db.instance", 2 * DAY, now); // a note, never
    file(testDataDir, "m4-browser.db", 2 * DAY, now); // a database put there by hand, never
    file(testDataDir, "t-old.db", 2 * DAY, now);
    // The live database never goes, whatever its name.
    const live = file(testDataDir, "live-1234-1727000000000-5.db", 2 * DAY, now);

    const previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "file:" + live.replace(/\\/g, "/");
    let counts: Awaited<ReturnType<typeof runCleanup>>;
    try {
      counts = await runCleanup({ now, logsDir, testDataDir });
    } finally {
      process.env.DATABASE_URL = previousUrl;
    }
    expect(counts).toEqual({
      sessions: 1,
      loginAttempts: 1,
      webhookTokens: 1,
      accessLinks: 1,
      jobs: 2,
      notifications: 1,
      replyTexts: 2,
      snapshots: 0,
      robots: 0,
      logFiles: 1,
      testFiles: 3,
    });
    expect(await db.session.findMany({ select: { tokenHash: true } })).toEqual([{ tokenHash: "live" }]);
    expect(await db.job.count()).toBe(2);
    expect((await db.notification.findMany({ select: { title: true }, orderBy: { id: "asc" } })).map((n) => n.title)).toEqual([
      "recent read",
      "unread",
    ]);
    const replies = await db.inboundMessage.findMany({ orderBy: { id: "asc" } });
    expect(replies.map((r) => [r.subject, r.bodyText !== null, r.strippedText !== null, r.snippet, r.kind, r.answerOutcome])).toEqual([
      ["processed 31 days ago", false, false, "Thanks, this sounds interesting.", "REPLY", "answered"],
      ["only the stripped text left", false, false, "Thanks, this sounds interesting.", "REPLY", "answered"],
      ["processed 29 days ago", true, true, "Thanks, this sounds interesting.", "REPLY", "answered"],
      ["never processed", true, true, "Thanks, this sounds interesting.", null, null],
    ]);
    expect(fs.readdirSync(logsDir).sort()).toEqual(["notes-old.txt", "worker.log"]);
    expect(fs.readdirSync(testDataDir).sort()).toEqual([
      "live-1234-1727000000000-5.db",
      "m4-browser.db",
      "t-old.db",
      "worker-backups-1234-1727000000000-123456.db.instance",
      "worker-backups-1234-1727000000001-9.db",
    ]);

    expect(cleanupSummary(counts)).toBe(
      "Removed 1 expired sign-in, 1 old sign-in attempt, 1 old webhook token, 1 expired invite or reset link, " +
        "2 finished tasks older than 30 days, 1 read notification older than 90 days, the text of 2 replies older than 30 days, " +
        "1 old log file and 3 old test files.",
    );
    expect(cleanupSummary({ ...counts, sessions: 0, loginAttempts: 0, webhookTokens: 0, accessLinks: 0, jobs: 0, notifications: 0, logFiles: 0, testFiles: 0, replyTexts: 1 })).toBe(
      "Removed the text of 1 reply older than 30 days.",
    );

    // A second run finds nothing (the stand-in live database is gone first: it is an ordinary old test file now).
    fs.rmSync(live);
    const again = await runCleanup({ now, logsDir, testDataDir });
    expect(cleanupSummary(again)).toBe("Nothing needed cleaning up.");
  });

  it("stops between steps when asked to", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopping"));
    await expect(runCleanup({ signal: controller.signal, logsDir: tempDir(), testDataDir: tempDir() })).rejects.toThrow(
      "stopping",
    );
  });
});
