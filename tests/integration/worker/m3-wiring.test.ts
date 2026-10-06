import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobType } from "@/server/jobs";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";

/**
 * Milestone 3 worker wiring (M3-DESIGN §4.6): the job registry, the periodic tasks, the one-off repair for old restore
 * markers, the start-up order (copied database → restore marker → Mailgun target → start-up catch-up → health check)
 * and the loops' injection points. Everything Mailgun goes to the local fake; DNS is never asked.
 */

// The start-up reads <database folder>/RESTORED, and data/test is shared by every test file running in parallel, so
// this file's database lives in a folder of its own.
const created = await createTestDb("worker-m3-wiring");
const dir = path.join(path.dirname(created.file), `m3-wiring-${process.pid}-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
const dbFile = path.join(dir, "wiring.db");
fs.copyFileSync(created.file, dbFile);
created.cleanup();
process.env.DATABASE_URL = "file:" + dbFile.replace(/\\/g, "/");

vi.mock("@/server/services/sending/health-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/sending/health-check")>();
  return { ...actual, runHealthCheck: vi.fn(actual.runHealthCheck) };
});

const mg = await connectFakeMailgun({ domain: "send.example.com" });
const { db, dbWrite } = await import("@/server/db");
const { getState, setState } = await import("@/server/state");
const { getSetting, setSetting } = await import("@/server/settings");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { runHealthCheck } = await import("@/server/services/sending/health-check");
const { JOB_REGISTRY, JOB_PRIORITIES, createJobRegistry } = await import("../../../worker/jobs");
const { CATCH_UP_TASK } = await import("../../../worker/jobs/mailgun-catch-up");
const { DOMAIN_CHECK_TASK } = await import("../../../worker/jobs/mailgun-check-domain");
const { WARMUP_TASK_NAME } = await import("../../../worker/jobs/warmup-evaluate");
const periodic = await import("../../../worker/periodic");
const { PRE_M3_MARKER_SUFFIX, renameOldRestoreMarker } = await import("../../../worker/repairs");
const { BackgroundWorker } = await import("../../../worker/main");
const { notifyOwner } = await import("../../../worker/notify");

const mailgun = () => getMailgunContext({ retryDelayMs: () => 0, timeoutMs: 2_000 });
/** No network in this file: cloudflared's /ready and anything else is refused like a closed port. */
const noNetwork = (async (input: RequestInfo | URL) => {
  throw new TypeError(`fetch failed (the test refused ${typeof input === "string" ? input : input instanceof URL ? input.href : input.url})`);
}) as typeof fetch;

type Line = { level: "info" | "warn" | "error"; message: string };
function recordingLogger() {
  const lines: Line[] = [];
  return {
    lines,
    logger: {
      info: (message: string) => void lines.push({ level: "info", message }),
      warn: (message: string) => void lines.push({ level: "warn", message }),
      error: (message: string, err?: unknown) => void lines.push({ level: "error", message: `${message}${err ? `: ${String(err)}` : ""}` }),
    },
  };
}

/** The real registry, except the jobs that would reach DNS or write backups: nothing in this file may do that. */
function safeRegistry() {
  const ok = { handler: async () => ({ summary: "skipped in this test" }), label: "Skipped", whatToDo: "Nothing." };
  return { ...createJobRegistry({ mailgun }), "mailgun.checkDomain": ok, "backup.run": ok, "system.cleanup": ok };
}

function worker(logger = recordingLogger().logger) {
  return new BackgroundWorker({ logger, mailgun, registry: safeRegistry(), fetchImpl: noNetwork, random: () => 0.5 });
}

async function pauseState() {
  return (await getState<{ paused: boolean; kind: string | null; reason: string; also: Array<{ kind: string }> }>("sending.pause"))?.value;
}

const markerFile = path.join(dir, "RESTORED");

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.mocked(runHealthCheck).mockClear();
  await dbWrite((c) => c.job.deleteMany({}));
});

describe("the job registry", () => {
  it("runs every job type of Milestones 1–5; campaign.finishCheck stays unregistered", () => {
    // A type added to JobType without a registry entry fails to compile here.
    const expected: Record<Exclude<JobType, "campaign.finishCheck">, true> = {
      "import.commit": true,
      "backup.run": true,
      "system.cleanup": true,
      "mailgun.catchUp": true,
      "mailgun.syncSuppressions": true,
      "mailgun.applySettings": true,
      "mailgun.syncRoutes": true,
      "send.testEmail": true,
      "mailgun.checkDomain": true,
      "mailgun.restoreScan": true,
      "warmup.evaluate": true,
      // Milestone 5 (their own lanes; tests/integration/worker/m5-wiring.test.ts).
      "verify.addresses": true,
      "ai.draftLines": true,
    };
    expect(Object.keys(JOB_REGISTRY).sort()).toEqual(Object.keys(expected).sort());
    expect(JOB_REGISTRY["campaign.finishCheck"]).toBeUndefined();
    for (const def of Object.values(JOB_REGISTRY)) {
      expect(def.label).toMatch(/^[A-Z]/);
      expect(def.whatToDo).toMatch(/\.$/);
    }
    expect(JOB_REGISTRY["mailgun.catchUp"]).toMatchObject({ label: "The Mailgun check", link: "/settings/sending" });
    expect(JOB_PRIORITIES).toMatchObject({
      "send.testEmail": 60,
      "mailgun.catchUp": 50,
      "mailgun.restoreScan": 40,
      "mailgun.applySettings": 30,
      "mailgun.syncRoutes": 30,
      "mailgun.checkDomain": 20,
      "warmup.evaluate": 20,
      "mailgun.syncSuppressions": 10,
    });
  });

  it("evaluates the warm-up and checks health after every complete check with Mailgun (onSuccess)", async () => {
    await dbWrite((c) => c.systemState.deleteMany({ where: { key: { in: ["warmup", "mailgun.catchUp"] } } }));
    const now = new Date("2026-09-23T08:00:00.000Z");
    mg.fake.setNow(() => now);
    try {
      const job = createJobRegistry({ mailgun, now: () => now })["mailgun.catchUp"]!;
      const res = await job.handler({ reason: "manual" }, { jobId: 1, createdById: null, signal: new AbortController().signal, progress: async () => undefined });
      expect((res as { summary: string }).summary).toMatch(/^Checked with Mailgun \(send\.example\.com\): /);
      const catchUp = (await getState<{ lastSuccessAt: string | null; lastReason: string }>("mailgun.catchUp"))?.value;
      expect(catchUp).toMatchObject({ lastSuccessAt: now.toISOString(), lastReason: "manual" });
      // onSuccess ran: the warm-up state now belongs to this domain, and the health check ran once.
      const warmup = (await getState<{ domain: string | null; lastEvaluatedCapDay: string | null }>("warmup"))?.value;
      expect(warmup).toMatchObject({ domain: "send.example.com", lastEvaluatedCapDay: "2026-09-22" });
      expect(runHealthCheck).toHaveBeenCalledTimes(1);
      expect((await periodic.readTaskState(CATCH_UP_TASK)).lastSuccessAt?.toISOString()).toBe(now.toISOString());
    } finally {
      mg.fake.setNow(() => new Date());
    }
  });
});

describe("the periodic tasks of Milestone 3", () => {
  // The Milestone 1 daily tasks (periodic-cleanup.test.ts) and the Milestone 5 ones (m5-wiring.test.ts) have their own tests.
  const M3_TASKS = new Set(["mailgun.catchUp.hourly", "mailgun.domainCheck.6h", "warmup.hourly"]);
  const TASKS = periodic.PERIODIC_TASKS.filter((t) => M3_TASKS.has(t.name));

  beforeEach(async () => {
    await dbWrite((c) => c.systemState.deleteMany({ where: { key: { startsWith: "task." } } }));
  });

  it("use the names the jobs record", () => {
    expect(periodic.CATCH_UP_HOURLY_TASK).toBe(CATCH_UP_TASK);
    expect(periodic.DOMAIN_CHECK_6H_TASK).toBe(DOMAIN_CHECK_TASK);
    expect(periodic.WARMUP_HOURLY_TASK).toBe(WARMUP_TASK_NAME);
    expect(TASKS.map((t) => [t.name, t.intervalMs / 60_000, t.retryAfterMs / 60_000])).toEqual([
      ["mailgun.catchUp.hourly", 60, 20],
      ["mailgun.domainCheck.6h", 360, 60],
      ["warmup.hourly", 60, 20],
    ]);
  });

  it("queue the hourly catch-up, the 6-hour domain check and the warm-up check while Mailgun is connected", async () => {
    const now = new Date("2026-09-23T08:00:00.000Z");
    expect(await periodic.checkPeriodicTasks(now, TASKS, recordingLogger().logger)).toEqual([
      "mailgun.catchUp.hourly",
      "mailgun.domainCheck.6h",
      "warmup.hourly",
    ]);
    const jobs = await db.job.findMany({ orderBy: { id: "asc" } });
    expect(jobs.map((j) => [j.type, j.payload, j.activeDedupeKey, j.priority])).toEqual([
      ["mailgun.catchUp", { reason: "hourly" }, "mailgun:catchup", 50],
      ["mailgun.checkDomain", {}, "mailgun:domain-check", 20],
      ["warmup.evaluate", null, "warmup", 20],
    ]);
    // All three ran; an hour later the hourly ones are due again, the domain check only after 6 hours.
    for (const t of TASKS) await periodic.recordTaskSuccess(t.name, new Date(now.getTime() + 60_000));
    await dbWrite((c) => c.job.deleteMany({}));
    const later = new Date(now.getTime() + 61 * 60_000);
    expect(await periodic.checkPeriodicTasks(later, TASKS, recordingLogger().logger)).toEqual(["mailgun.catchUp.hourly", "warmup.hourly"]);
  });

  it("skip the Mailgun tasks while Mailgun isn't connected (the practice copy here), never the warm-up", async () => {
    await setSetting("practice.copy", true, null);
    try {
      expect(await periodic.mailgunConnected()).toBe(false);
      expect(await periodic.checkPeriodicTasks(new Date("2026-09-23T08:00:00.000Z"), TASKS, recordingLogger().logger)).toEqual([
        "warmup.hourly",
      ]);
      // Skipped tasks aren't recorded as enqueued, so they go as soon as Mailgun is connected.
      expect((await periodic.readTaskState("mailgun.catchUp.hourly")).lastEnqueuedAt).toBeNull();
    } finally {
      await setSetting("practice.copy", false, null);
    }
    expect(await periodic.mailgunConnected(mailgun)).toBe(true);
    // A loader that throws (a test run without the fake) counts as not connected.
    expect(await periodic.mailgunConnected(async () => Promise.reject(new Error("Test runs must use the fake Mailgun server")))).toBe(false);
  });

  it("treat a last success in the future (the PC's clock went back) as due", async () => {
    const now = new Date("2026-09-23T08:00:00.000Z");
    await periodic.recordTaskSuccess("warmup.hourly", new Date(now.getTime() + 3 * 60 * 60_000));
    const warmupOnly = TASKS.filter((t) => t.name === "warmup.hourly");
    expect(await periodic.checkPeriodicTasks(now, warmupOnly, recordingLogger().logger)).toEqual(["warmup.hourly"]);
  });
});

describe("the one-off repair m3.oldRestoreMarker", () => {
  const scratch = path.join(dir, "markers");

  beforeEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(scratch, { recursive: true });
  });

  it("renames a marker without a version (a Milestone 1–2 restore) and keeps its content", () => {
    const file = path.join(scratch, "RESTORED");
    const content = JSON.stringify({ restoredFrom: "2026-09-01T10:00:00.000Z", at: "2026-09-02T10:00:00.000Z", file: "app-auto.db" });
    fs.writeFileSync(file, content);
    expect(renameOldRestoreMarker(file)).toMatch(/^renamed an older restore marker to RESTORED\.pre-m3/);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(file + PRE_M3_MARKER_SUFFIX, "utf8")).toBe(content);
  });

  it("never touches a versioned marker or one it can't read, and is fine without a marker", () => {
    const file = path.join(scratch, "RESTORED");
    fs.writeFileSync(file, JSON.stringify({ version: 3, restoredFrom: null, at: "2026-09-23T08:00:00.000Z", file: null }));
    expect(renameOldRestoreMarker(file)).toMatch(/comes from this version/);
    expect(fs.existsSync(file)).toBe(true);
    fs.writeFileSync(file, "not json");
    expect(renameOldRestoreMarker(file)).toMatch(/isn't readable/);
    expect(fs.existsSync(file)).toBe(true);
    fs.rmSync(file);
    expect(renameOldRestoreMarker(file)).toBe("no restore marker");
  });
});

describe("start-up (runOnce) and the loops", () => {
  beforeEach(async () => {
    // The daily tasks were just done; the Mailgun ones run through safeRegistry().
    for (const name of ["backup.daily", "cleanup.daily"]) await periodic.recordTaskSuccess(name, new Date());
    fs.rmSync(markerFile, { force: true });
    fs.rmSync(markerFile + PRE_M3_MARKER_SUFFIX, { force: true });
  });

  it("first Milestone 3 start: renames an old marker, records the database, logs the target, catches up, checks health", async () => {
    fs.writeFileSync(markerFile, JSON.stringify({ restoredFrom: "2026-09-01T10:00:00.000Z", at: "2026-09-02T10:00:00.000Z", file: "old.db" }));
    const rec = recordingLogger();
    expect(await worker(rec.logger).runOnce()).toBe(0);

    // m3.oldRestoreMarker ran before the restore check: nothing was paused for the old restore.
    expect(fs.existsSync(markerFile)).toBe(false);
    expect(fs.existsSync(markerFile + PRE_M3_MARKER_SUFFIX)).toBe(true);
    expect((await pauseState())?.paused ?? false).toBe(false);
    expect(await getState("repair.m3.oldRestoreMarker")).not.toBeNull();
    // The database's place is recorded (a later copy is recognised).
    const instance = (await getState<{ dbPath: string }>("instance"))?.value;
    expect(instance?.dbPath).toBe(path.resolve(dbFile).replace(/\\/g, "/").toLowerCase());
    // Where Mailgun calls go is logged loudly.
    expect(rec.lines).toContainEqual({ level: "info", message: `Mailgun: Test server ${mg.fake.origin}: nothing reaches the real Mailgun` });
    // The start-up catch-up was queued (dedupe, priority 50) and ran in the same round.
    const catchUpJob = await db.job.findFirstOrThrow({ where: { type: "mailgun.catchUp" } });
    expect(catchUpJob).toMatchObject({ status: "DONE", payload: { reason: "startup" }, priority: 50 });
    const catchUp = (await getState<{ lastSuccessAt: string | null; lastReason: string }>("mailgun.catchUp"))?.value;
    expect(catchUp?.lastReason).toBe("startup");
    expect(catchUp?.lastSuccessAt).not.toBeNull();
    // The health check ran at start-up and again after the catch-up (onSuccess).
    expect(runHealthCheck).toHaveBeenCalledTimes(2);
    // The monitor ran its first checks: cloudflared isn't running here (every fetch is refused).
    expect((await getState<{ state: string }>("tunnel.status"))?.value.state).toBe("not-running");
    expect(rec.lines.filter((l) => l.level === "error")).toEqual([]);
  });

  it("leaves a marker written for the other database in the same folder (the practice copy next to the real one)", async () => {
    const marker = JSON.stringify({ version: 3, restoredFrom: "2026-09-20T12:00:00.000Z", at: new Date().toISOString(), file: "app-auto.db", db: "app.db" });
    fs.writeFileSync(markerFile, marker);
    expect(await worker().runOnce()).toBe(0);
    expect(fs.readFileSync(markerFile, "utf8")).toBe(marker);
    expect((await pauseState())?.paused ?? false).toBe(false);
    expect(await db.job.count({ where: { type: "mailgun.restoreScan" } })).toBe(0);
    fs.rmSync(markerFile);
  });

  it("a restore marker from this version pauses sending and queues the check with Mailgun", async () => {
    fs.writeFileSync(
      markerFile,
      JSON.stringify({ version: 3, restoredFrom: "2026-09-20T12:00:00.000Z", at: new Date().toISOString(), file: "app-auto.db", db: path.basename(dbFile) }),
    );
    expect(await worker().runOnce()).toBe(0);
    expect(fs.existsSync(markerFile)).toBe(false);
    expect(await pauseState()).toMatchObject({ paused: true, kind: "restore", reason: "restored from a backup" });
    const restore = (await getState<{ status: string; restoredFrom: string | null }>("restore"))?.value;
    expect(restore?.restoredFrom).toBe("2026-09-20T12:00:00.000Z");
    // Pass 1 ran in this round (Mailgun had nothing); pass 2 waits for 35 minutes after the restore.
    expect(await db.job.findFirstOrThrow({ where: { type: "mailgun.restoreScan", payload: { equals: { pass: 1 } } } })).toMatchObject({ status: "DONE", priority: 40 });
    expect(restore?.status).toBe("scanning");
    expect(await db.job.findFirstOrThrow({ where: { type: "mailgun.restoreScan", payload: { equals: { pass: 2 } } } })).toMatchObject({ status: "QUEUED" });
    await dbWrite((c) => c.systemState.deleteMany({ where: { key: { in: ["sending.pause", "restore"] } } }));
  });

  it("a database opened from another place without a marker is a copy: sending pauses", async () => {
    await setState("instance", { dbPath: "c:/somewhere/else/app.db", id: "abc123", firstSeenAt: "2026-09-01T00:00:00.000Z" });
    const rec = recordingLogger();
    expect(await worker(rec.logger).runOnce()).toBe(0);
    expect(await pauseState()).toMatchObject({ paused: true, kind: "copied-database", reason: "this database was copied or moved" });
    expect(rec.lines.some((l) => l.level === "warn" && /opens from a different place/.test(l.message))).toBe(true);
    await dbWrite((c) => c.systemState.deleteMany({ where: { key: "sending.pause" } }));
  });

  it("the app folder copied to another computer (same place): the note next to the database says so and sending pauses", async () => {
    // Every start writes <database>.instance; a restart here changes nothing.
    const note = dbFile + ".instance";
    expect(await worker().runOnce()).toBe(0);
    const written = JSON.parse(fs.readFileSync(note, "utf8")) as { id: string; host: string };
    expect(written.host).toBe(os.hostname());
    expect((await pauseState())?.paused ?? false).toBe(false);
    // The same folder, copied from another computer where it last ran.
    fs.writeFileSync(note, JSON.stringify({ version: 1, id: written.id, host: "OLD-OFFICE-PC" }));
    const rec = recordingLogger();
    expect(await worker(rec.logger).runOnce()).toBe(0);
    expect(await pauseState()).toMatchObject({ paused: true, kind: "copied-database", reason: "this database last ran on another computer" });
    // The worker's log names the real cause, not "a different place".
    expect(rec.lines.some((l) => l.level === "warn" && /last ran on another computer \(OLD-OFFICE-PC\)/.test(l.message))).toBe(true);
    expect(rec.lines.some((l) => /opens from a different place/.test(l.message))).toBe(false);
    expect(JSON.parse(fs.readFileSync(note, "utf8")).host).toBe(os.hostname());
    await dbWrite((c) => c.systemState.deleteMany({ where: { key: "sending.pause" } }));
  });

  it("a restore check left 'running' with no task to finish it fails at start-up, and sending pauses for the confirmation", async () => {
    await setState("restore", {
      status: "scanning",
      restoredFrom: "2026-09-20T12:00:00.000Z",
      scanFrom: "2026-09-20T11:00:00.000Z",
      markerAt: "2026-09-23T08:00:00.000Z",
      file: "app-auto.db",
      handledAt: "2026-09-23T08:00:00.000Z",
      report: null,
      acknowledgedAt: null,
      acknowledgedById: null,
    });
    expect(await worker().runOnce()).toBe(0);
    const restore = (await getState<{ status: string; report: { error: string | null } | null }>("restore"))?.value;
    expect(restore).toMatchObject({ status: "failed", report: { error: "The restore check stopped before it finished." } });
    expect(await pauseState()).toMatchObject({ paused: true, kind: "restore" });
    await dbWrite((c) => c.systemState.deleteMany({ where: { key: { in: ["sending.pause", "restore"] } } }));
  });

  it("no start-up catch-up while Mailgun isn't connected", async () => {
    await setSetting("practice.copy", true, null);
    try {
      expect(await worker().runOnce()).toBe(0);
      expect(await db.job.count({ where: { type: "mailgun.catchUp" } })).toBe(0);
    } finally {
      await setSetting("practice.copy", false, null);
    }
  });

  it("wires the loops: the reconciler skips what the sending loop has in flight; new problems run the health check", async () => {
    const w = worker();
    const loops = w as unknown as {
      sending: { inFlight: ReadonlySet<number> };
      reconciler: { opts: { inFlight?: ReadonlySet<number>; mailgun?: unknown } };
      eventLane: { opts: { onProblems?: (p: { bounces: number; complaints: number }) => Promise<void> } };
      monitor: { opts: { fetchImpl?: typeof fetch } };
    };
    expect(loops.reconciler.opts.inFlight).toBe(loops.sending.inFlight);
    expect(loops.reconciler.opts.mailgun).toBe(mailgun);
    expect(loops.monitor.opts.fetchImpl).toBe(noNetwork);
    await loops.eventLane.opts.onProblems?.({ bounces: 1, complaints: 0 });
    expect(runHealthCheck).toHaveBeenCalledTimes(1);
    // tickOnce: one round without the start-up steps.
    vi.mocked(runHealthCheck).mockClear();
    expect(await w.tickOnce()).toBe(0);
    expect(runHealthCheck).not.toHaveBeenCalled();
    expect(await db.job.count({ where: { type: "mailgun.catchUp" } })).toBe(0);
  });
});

describe("worker notifications", () => {
  it("go through the shared notifications module: only same-app links", async () => {
    await dbWrite((c) => c.user.create({ data: { email: "owner@polygonparadise.test", name: "Arslan", role: "OWNER" } }));
    expect(await notifyOwner({ type: "task.failed", title: "A task failed", body: "Try again.", link: "https://example.com/elsewhere" })).toBe(true);
    const n = await db.notification.findFirstOrThrow({ where: { type: "task.failed" }, orderBy: { id: "desc" } });
    expect(n).toMatchObject({ title: "A task failed", body: "Try again.", link: null });
    expect(await getSetting("practice.copy")).toBe(false);
  });
});
