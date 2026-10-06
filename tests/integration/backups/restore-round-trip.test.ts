import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startFakeMailgun, type FakeMailgun } from "../../fake-mailgun/server";
import { createTestDb } from "../helpers/test-db";
import { makeClock, WEDNESDAY_10_BERLIN } from "../sending-m3/helpers";

/**
 * The tested restore (M6-DESIGN §3.8, PLAN A8 "a backup and a restore", B12 "the restore scenario (no second send)"):
 * a backup made by the background sender's own code, restored by the real restore.mjs, then the background sender's
 * start-up on the restored data, the check with Mailgun, the report, the Owner's Resume and more rounds, in which
 * nothing is sent twice.
 *
 * Steps 1–3 run in a child process (round-trip-seed.ts: seed, one email, Back up now, two more emails), so this process
 * never holds the database open while restore.mjs replaces it. Everything runs on a fixed clock starting Wednesday
 * 23 Sep 2026 10:00 in Berlin, against the local fake Mailgun (one for the whole file) and on a database in a folder of
 * its own (so RESTORED is this test's). Nothing reaches the network.
 */

type TestUser = { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number };
const auth = vi.hoisted(() => ({ user: null as TestUser | null }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/dal", () => {
  class AuthError extends Error {
    constructor(
      message: string,
      readonly status: 401 | 403,
    ) {
      super(message);
      this.name = "AuthError";
    }
  }
  const requireUserAction = async () => {
    if (!auth.user) throw new AuthError("Your session has ended. Please sign in again.", 401);
    return auth.user;
  };
  return {
    AuthError,
    getUserOrNull: async () => auth.user,
    requireUserAction,
    requireOwnerAction: async () => {
      const user = await requireUserAction();
      if (user.role !== "OWNER") throw new AuthError("Only the Owner can do this.", 403);
      return user;
    },
  };
});

// A folder of our own: the worker's start-up reads <database folder>/RESTORED.
const created = await createTestDb("round-trip");
const dir = path.join(path.dirname(created.file), `round-trip-${process.pid}-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
const dbName = `round-trip-${process.pid}`;
const dbFile = path.join(dir, `${dbName}.db`);
fs.copyFileSync(created.file, dbFile);
created.cleanup();
const DATABASE_URL = "file:" + dbFile.replace(/\\/g, "/");
process.env.DATABASE_URL = DATABASE_URL;
/** Where the background sender's backups of this database go (backupFolderFor: backups\<database name>). */
const backupsDir = path.join(process.cwd(), "backups", dbName);

const ROOT = process.cwd();
const PUB = "http://127.0.0.1:3100";
const previousEnv = { base: process.env.OUTREACH_MAILGUN_BASE_URL, pub: process.env.APP_PUBLIC_URL };
const clock = makeClock(WEDNESDAY_10_BERLIN);
const MIN = 60_000;
const ZONE = "Europe/Berlin";

type SeedResult = {
  backupFile: string;
  backupFileName: string;
  campaignId: number;
  ownerId: number;
  emails: Array<{ id: number; status: string; toNorm: string }>;
  clock: string;
};

/** Runs a node child process to its end, while this process keeps serving the fake Mailgun. */
function runNode(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out }));
  });
}

let fake: FakeMailgun;
let seed: SeedResult;

beforeAll(async () => {
  fake = await startFakeMailgun({ domain: "send.example.com", region: "EU", apiKey: "key-fake-api", signingKey: "key-fake-signing" });
  fake.setNow(clock.now);
  fake.setDns("all");
  process.env.OUTREACH_MAILGUN_BASE_URL = fake.origin;
  process.env.APP_PUBLIC_URL = PUB;
});

afterAll(async () => {
  if (previousEnv.base === undefined) delete process.env.OUTREACH_MAILGUN_BASE_URL;
  else process.env.OUTREACH_MAILGUN_BASE_URL = previousEnv.base;
  if (previousEnv.pub === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previousEnv.pub;
  await fake?.close();
  try {
    const { db } = await import("@/server/db");
    await db.$disconnect();
  } catch {
    /* never connected */
  }
  for (const folder of [dir, backupsDir]) {
    try {
      fs.rmSync(folder, { recursive: true, force: true });
    } catch {
      /* an open handle on Windows: data/test and backups/<test> are ignored anyway */
    }
  }
});

describe("a backup, a restore and the check after it: nothing is sent twice", () => {
  it("1–3. (child process) one email, Back up now, two more emails", { timeout: 180_000 }, async () => {
    const r = await runNode(["--import", "tsx", path.join("tests", "integration", "backups", "round-trip-seed.ts")], {
      ...process.env,
      DATABASE_URL,
      OUTREACH_MAILGUN_BASE_URL: fake.origin,
      OUTREACH_TEST_RUN: "1",
      RT_START: clock.now().toISOString(),
      DOTENV_CONFIG_QUIET: "true",
    });
    const line = r.out.split(/\r?\n/).find((l) => l.startsWith("RT_RESULT "));
    expect(r.code, r.out).toBe(0);
    seed = JSON.parse(line!.slice("RT_RESULT ".length)) as SeedResult;
    expect(seed.emails.map((e) => e.status)).toEqual(["SENT", "SENT", "SENT"]);
    expect(fake.messages).toHaveLength(3);
    expect(path.dirname(seed.backupFile)).toBe(backupsDir);
    expect(fs.existsSync(seed.backupFile)).toBe(true);
  });

  it("4. restore.mjs puts the backup in place (a test database: nothing stopped, no administrator rights needed)", { timeout: 180_000 }, async () => {
    const r = await runNode([path.join("scripts", "restore.mjs"), seed.backupFile, "--yes", "--db", dbFile, "--backups-dir", backupsDir], {
      ...process.env,
      NO_COLOR: "1",
    });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("That isn't the app's own database, so the app wasn't stopped or started.");
    const marker = JSON.parse(fs.readFileSync(path.join(dir, "RESTORED"), "utf8")) as { version: number; at: string; db: string; file: string };
    expect(marker).toMatchObject({ version: 3, db: path.basename(dbFile), file: seed.backupFileName });
    expect(fs.readdirSync(backupsDir).filter((f) => /^app-prerestore-.+\.db$/.test(f))).toHaveLength(1);
    // restore.mjs stamps the marker with the PC's real time; this test runs on its fixed clock, so move it there.
    clock.set(new Date(Date.parse(seed.clock) + 5 * MIN));
    fs.writeFileSync(path.join(dir, "RESTORED"), JSON.stringify({ ...marker, at: clock.now().toISOString() }, null, 2));
  });

  it("5–10. the restored data, the start-up, the check with Mailgun, the report, Resume, and no second send", { timeout: 120_000 }, async () => {
    const { db } = await import("@/server/db");
    const { getMailgunContext } = await import("@/server/mailgun/context");
    const { readTyped } = await import("@/server/state-typed");
    const { parseRestoreState } = await import("@/core/system-state-parse");
    const { getPauseState } = await import("@/server/services/sending/pause");
    const { lastRestoreView } = await import("@/server/services/sending/restore");
    const { handleEventWebhook } = await import("@/server/services/mail-events/webhook");
    const { GET: healthGET } = await import("@/app/api/health/route");
    const { resumeSendingAction } = await import("@/app/(app)/settings/sending/actions");
    const { formatShortDate, formatTime } = await import("@/core/time/format");
    const { BackgroundWorker } = await import("../../../worker/main");
    const { createJobRegistry } = await import("../../../worker/jobs");
    const { claimNextJob, runClaimedJob, WORKER_LANES } = await import("../../../worker/runner");
    const periodic = await import("../../../worker/periodic");

    const mailgun = () => getMailgunContext({ retryDelayMs: () => 0, timeoutMs: 2_000 });
    const appFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `${PUB}/api/health`) return healthGET();
      if (url === `${PUB}/api/webhooks/mailgun/events`) return handleEventWebhook(new Request(url, init), { now: clock.now() });
      throw new TypeError(`fetch failed (no network in this test: ${url})`);
    }) as typeof fetch;
    const errors: string[] = [];
    const logger = { info: () => undefined, warn: () => undefined, error: (m: string, e?: unknown) => void errors.push(`${m}${e ? `: ${String(e)}` : ""}`) };
    const base = createJobRegistry({ mailgun, now: clock.now, logger });
    const registry = {
      ...base,
      // The Domain checklist would ask DNS.
      "mailgun.checkDomain": {
        ...base["mailgun.checkDomain"]!,
        handler: async () => {
          await periodic.recordTaskSuccess(periodic.DOMAIN_CHECK_6H_TASK, clock.now());
          return { summary: "skipped in this test (no DNS)" };
        },
      },
    };
    const restoreState = async () => (await readTyped("restore", parseRestoreState)).value;
    const emails = () => db.outboundEmail.findMany({ where: { campaignId: seed.campaignId }, orderBy: { id: "asc" } });

    // 5. The restored database is the backup's: A sent, B and C still waiting.
    expect((await emails()).map((e) => e.status)).toEqual(["SENT", "QUEUED", "QUEUED"]);

    // 6. The background sender's start-up: not a copy (the restore marker is seen), the restore pause, the check queued.
    const worker = new BackgroundWorker({ now: clock.now, mailgun, random: () => 0.5, fetchImpl: appFetch, logger, registry });
    await (worker as unknown as { startup(): Promise<void> }).startup();
    const pause = await getPauseState();
    expect(pause).toMatchObject({ paused: true, kind: "restore", reason: "restored from a backup" });
    expect(pause.also.map((a) => a.kind)).not.toContain("copied-database");
    expect(await restoreState()).toMatchObject({ status: "pending", file: seed.backupFileName });
    expect(fs.existsSync(path.join(dir, "RESTORED"))).toBe(false);

    // 7. The check with Mailgun, pass 1: B and C are found in Mailgun's logs and recorded as sent (never sent again).
    // The queued tasks run one by one through the real runner (highest priority first: the start-up check with
    // Mailgun, then the restore check) until pass 1 has run; pass 2 waits for its own round.
    clock.advance(MIN);
    for (let i = 0; i < 10; i++) {
      const job = await claimNextJob("round-trip", new Date(), WORKER_LANES.main);
      if (!job) break;
      await runClaimedJob(job, { workerId: "round-trip", registry, signal: new AbortController().signal, logger, lane: WORKER_LANES.main, now: clock.now });
      if (job.type === "mailgun.restoreScan") break;
    }
    const pass1 = await restoreState();
    expect(pass1.status).toBe("scanning");
    expect(pass1.report).toMatchObject({ mailgunChecked: true, passes: 1, rowsCreated: 0, externalSends: 0, madeUnconfirmed: 0 });
    expect(pass1.report!.matchedByMessageId + pass1.report!.matchedBySendId).toBe(3); // A (already sent), B and C
    expect((await emails()).map((e) => e.status)).toEqual(["SENT", "SENT", "SENT"]);
    // Pass 2, 35 minutes after the restore.
    clock.advance(35 * MIN);
    expect(await worker.tickOnce()).toBe(0);
    const pass2 = await restoreState();
    expect(pass2).toMatchObject({ status: "done", report: { passes: 2, mailgunChecked: true } });
    expect(await db.notification.count({ where: { type: "restore.checked", userId: seed.ownerId } })).toBe(1);

    // 8. The app answers on the restored data.
    const health = await healthGET();
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, database: "ok" });

    // 9. The "Last restore" card: paused until the Owner resumes; Resume as the Owner (on the test clock).
    const SEP = formatShortDate(clock.now(), ZONE, clock.now()).replace(/^\d+ /, "");
    const before = await lastRestoreView(ZONE, clock.now());
    expect(before!.restoredLine).toMatch(new RegExp(`^Restored on 23 ${SEP} at \\d{2}:\\d{2} from the backup of 23 ${SEP}, 10:01\\.$`));
    expect(before!.resumeLine).toBe("Sending stays paused until the Owner reads this and clicks Resume in Settings › Sending & Mailgun.");
    auth.user = { id: seed.ownerId, email: "arslan@polygonparadise.test", name: "Arslan", role: "OWNER", timeZone: ZONE, sessionId: 1 };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(clock.now());
    try {
      expect(await resumeSendingAction({})).toMatchObject({ ok: true, message: "Sending is resumed." });
    } finally {
      vi.useRealTimers();
    }
    expect(await restoreState()).toMatchObject({ resumedById: seed.ownerId, resumedAt: clock.now().toISOString() });
    expect((await getPauseState()).paused).toBe(false);
    expect((await lastRestoreView(ZONE, clock.now()))!.resumeLine).toBe(
      `Sending was resumed by Arslan on ${formatShortDate(clock.now(), ZONE, clock.now())} at ${formatTime(clock.now(), ZONE)}.`,
    );

    // 10. Rounds through the sending window: nothing is sent a second time, and the campaign finishes.
    for (let i = 0; i < 3; i++) {
      clock.advance(10 * MIN);
      expect(await worker.tickOnce()).toBe(0);
    }
    expect(fake.messages).toHaveLength(3);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: seed.campaignId } })).status).toBe("FINISHED");
    expect(errors).toEqual([]);
  });
});
