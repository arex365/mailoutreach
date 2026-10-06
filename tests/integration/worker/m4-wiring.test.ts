import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { replyTo } from "../helpers/replies";
import { DAY, enroll, makeCampaign, makeCompany, makePerson, makeUser, readOutage, recipient, setOutage } from "../stops-holds/world";

/**
 * Milestone 4 worker wiring (M4-DESIGN §3.9, §2.8.3, §10 P6): the event lane processes stored replies with the
 * worker's own back-off map and goes again at once after a full batch; after every complete check with Mailgun the
 * outage hold runs first, then the warm-up evaluation, then the health check, each failure logged without stopping the
 * next; the start-up applies an outage hold that was found but not applied; the 5-minute sending maintenance reports a
 * failed hold step through the worker's logger. Everything Mailgun goes to the local fake; nothing reaches the network.
 */

// The start-up reads <database folder>/RESTORED, and data/test is shared by every test file running in parallel, so
// this file's database lives in a folder of its own.
const created = await createTestDb("worker-m4-wiring");
const dir = path.join(path.dirname(created.file), `m4-wiring-${process.pid}-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
const dbFile = path.join(dir, "wiring.db");
fs.copyFileSync(created.file, dbFile);
created.cleanup();
process.env.DATABASE_URL = "file:" + dbFile.replace(/\\/g, "/");

vi.mock("@/server/services/sending/health-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/sending/health-check")>();
  return { ...actual, runHealthCheck: vi.fn(actual.runHealthCheck) };
});
vi.mock("@/server/services/sending/warmup-days", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/sending/warmup-days")>();
  return { ...actual, evaluateWarmupDays: vi.fn(actual.evaluateWarmupDays) };
});
vi.mock("@/server/services/sequences/holds", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/sequences/holds")>();
  return {
    ...actual,
    applyOutageHold: vi.fn(actual.applyOutageHold),
    applyPendingPossibleReplyHolds: vi.fn(actual.applyPendingPossibleReplyHolds),
  };
});
vi.mock("@/server/services/replies/process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/replies/process")>();
  return { ...actual, processPendingInbound: vi.fn(actual.processPendingInbound) };
});

const mg = await connectFakeMailgun({ domain: "send.example.com" });
const { db, dbWrite } = await import("@/server/db");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { runHealthCheck } = await import("@/server/services/sending/health-check");
const { evaluateWarmupDays } = await import("@/server/services/sending/warmup-days");
const { applyOutageHold, applyPendingPossibleReplyHolds } = await import("@/server/services/sequences/holds");
const { processPendingInbound, INBOUND_BATCH } = await import("@/server/services/replies/process");
const { createJobRegistry } = await import("../../../worker/jobs");
const periodic = await import("../../../worker/periodic");
const { BackgroundWorker } = await import("../../../worker/main");
const { EventLane, laneHasMore } = await import("../../../worker/event-lane");
const { SendingLoop } = await import("../../../worker/sending");
const { EVENT_BATCH } = await import("@/server/services/mail-events/process");

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

const skipped = { handler: async () => ({ summary: "skipped in this test" }), label: "Skipped", whatToDo: "Nothing." };

/** The real registry, except the jobs that would reach DNS or write backups, and (optionally) a do-nothing catch-up. */
function safeRegistry(opts: { catchUp?: boolean } = {}) {
  return {
    ...createJobRegistry({ mailgun }),
    "mailgun.checkDomain": skipped,
    "backup.run": skipped,
    "system.cleanup": skipped,
    ...(opts.catchUp === false ? { "mailgun.catchUp": skipped } : {}),
  };
}

function worker(logger = recordingLogger().logger, opts: { catchUp?: boolean } = {}) {
  return new BackgroundWorker({ logger, mailgun, registry: safeRegistry(opts), fetchImpl: noNetwork, random: () => 0.5 });
}

const owner = await makeUser("Arslan", { role: "OWNER", email: "arslan@polygonparadise.test" });
const ali = await makeUser("Ali", { email: "ali.khan@polygonparadise.test", timeZone: "America/New_York" });

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.mocked(runHealthCheck).mockClear();
  vi.mocked(evaluateWarmupDays).mockClear();
  vi.mocked(applyOutageHold).mockClear();
  vi.mocked(applyPendingPossibleReplyHolds).mockClear();
  vi.mocked(processPendingInbound).mockClear();
  await dbWrite((c) => c.job.deleteMany({}));
  // The daily tasks were just done; the Mailgun ones run through safeRegistry().
  for (const name of ["backup.daily", "cleanup.daily"]) await periodic.recordTaskSuccess(name, new Date());
});

/** A LIVE campaign sent by Ali with one person whose first email went out `sentDaysAgo` days ago and whose follow-up waits. */
async function waitingFollowUp(name: string, sentDaysAgo: number) {
  const company = await makeCompany(name, { domain: `${name.toLowerCase()}.de` });
  const person = await makePerson(company.id, `anna@${name.toLowerCase()}.de`, "Anna Berg");
  const campaign = await makeCampaign({ createdById: owner.id, senderId: ali.id, mode: "LIVE" });
  const enrolled = await enroll(campaign, person, { sent: [{ step: 0, sentAt: new Date(Date.now() - sentDaysAgo * DAY) }] });
  return { company, person, campaign, ...enrolled };
}

describe("the event lane processes stored replies (M4-DESIGN §3.9)", () => {
  it("files a reply in the worker's round: the company stops and the sender is told", async () => {
    const w = await waitingFollowUp("Firma", 1);
    const posted = await replyTo(mg.fake, w.sentIds[0]!);
    expect(posted.status).toBe(200);
    expect(await db.inboundMessage.findUniqueOrThrow({ where: { id: posted.id! } })).toMatchObject({ processedAt: null, kind: null });

    const rec = recordingLogger();
    expect(await worker(rec.logger).tickOnce()).toBe(0);

    expect(await db.inboundMessage.findUniqueOrThrow({ where: { id: posted.id! } })).toMatchObject({
      kind: "REPLY",
      linkMethod: "headers",
      replyScope: "real",
      companyId: w.company.id,
      campaignId: w.campaign.id,
      assigneeId: ali.id,
    });
    expect(await recipient(w.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "replied", stoppedByInboundId: posted.id });
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: w.queuedId! } })).status).toBe("SKIPPED");
    const notes = await db.notification.findMany({ where: { type: "reply.received", userId: ali.id } });
    expect(notes.map((n) => n.title)).toEqual(["New reply from Firma"]);
    expect(rec.lines.filter((l) => l.level === "error")).toEqual([]);

    // The lane called it with a batch of 20 and the worker's own back-off map (the same map every round).
    const calls = vi.mocked(processPendingInbound).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({ limit: INBOUND_BATCH, failures: expect.any(Map) });
  });

  it("keeps one back-off map per worker across rounds", async () => {
    const w = worker();
    expect(await w.tickOnce()).toBe(0);
    expect(await w.tickOnce()).toBe(0);
    const calls = vi.mocked(processPendingInbound).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0].failures).toBe(calls[1]![0].failures);
    expect(calls[0]![0].failures).toBe((w as unknown as { inboundFailures: unknown }).inboundFailures);
  });

  it("goes again at once after a full batch of replies (or events), else pauses a second", async () => {
    expect(INBOUND_BATCH).toBe(20);
    expect(laneHasMore(null)).toBe(false);
    expect(laneHasMore({ processed: 0, inbound: 19 })).toBe(false);
    expect(laneHasMore({ processed: 0, inbound: INBOUND_BATCH })).toBe(true);
    expect(laneHasMore({ processed: EVENT_BATCH, inbound: 0 })).toBe(true);

    const handled = [INBOUND_BATCH, INBOUND_BATCH, 3];
    const seen: Array<{ at: number; limit: number }> = [];
    const stop = new AbortController();
    const lane = new EventLane({
      ownsLease: async () => true,
      logger: recordingLogger().logger,
      processInbound: async ({ limit }) => {
        seen.push({ at: Date.now(), limit });
        const n = handled.shift() ?? 0;
        if (handled.length === 0) setTimeout(() => stop.abort(), 50);
        return n;
      },
    });
    const started = Date.now();
    await lane.run(stop.signal);
    expect(seen.map((s) => s.limit)).toEqual([INBOUND_BATCH, INBOUND_BATCH, INBOUND_BATCH]);
    // Three rounds without the 1-second pause in between (two full batches), then the pause (cut short by the abort).
    expect(seen[2]!.at - started).toBeLessThan(900);
  });

  it("a problem with the replies is logged (throttled) and the events still run", async () => {
    const rec = recordingLogger();
    const lane = new EventLane({
      ownsLease: async () => true,
      logger: rec.logger,
      processInbound: async () => {
        throw new Error("replies broke");
      },
    });
    expect(await lane.tick()).toMatchObject({ processed: 0, inbound: 0 });
    expect(await lane.tick()).toMatchObject({ processed: 0, inbound: 0 });
    expect(rec.lines.filter((l) => l.level === "error").map((l) => l.message)).toEqual(["Processing replies hit a problem: Error: replies broke"]);
  });
});

describe("after every complete check with Mailgun (the catch-up's onSuccess)", () => {
  it("applies the outage hold first, then evaluates the warm-up, then checks health", async () => {
    const w = await waitingFollowUp("Holzwerk", 8);
    const now = new Date();
    await setOutage({
      detectedAt: now.toISOString(),
      from: new Date(now.getTime() - 10 * DAY).toISOString(),
      to: new Date(now.getTime() - 5 * DAY).toISOString(),
      beyondLogRetention: true,
      beyondMessageRetention: false,
      handledAt: null,
      heldFor: null,
      heldTo: null,
      heldCount: 0,
    });
    const rec = recordingLogger();
    const job = createJobRegistry({ mailgun, logger: rec.logger })["mailgun.catchUp"]!;
    const res = await job.handler({ reason: "manual" }, { jobId: 1, createdById: null, signal: new AbortController().signal, progress: async () => undefined });
    expect((res as { summary: string }).summary).toMatch(/^Checked with Mailgun \(send\.example\.com\): /);

    // The follow-up whose email went out before the end of the unchecked window is on hold, and everyone was told.
    expect(await recipient(w.recipientId)).toMatchObject({ state: "HELD", holdReason: "outage" });
    const outage = await readOutage();
    expect(outage.handledAt).not.toBeNull();
    expect(outage.heldCount).toBe(1);
    const notes = await db.notification.findMany({ where: { type: "outage.hold" }, orderBy: { userId: "asc" } });
    expect(notes.map((n) => [n.userId, n.link])).toEqual([
      [owner.id, "/settings/sending"],
      [ali.id, "/notifications#on-hold"],
    ]);
    expect(rec.lines).toContainEqual({
      level: "info",
      message: "The PC was off too long to check every reply: put 1 person on hold until their senders have checked their inbox",
    });

    const order = (fn: unknown) => (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0]!;
    expect(order(applyOutageHold)).toBeLessThan(order(evaluateWarmupDays));
    expect(order(evaluateWarmupDays)).toBeLessThan(order(runHealthCheck));
    expect(rec.lines.filter((l) => l.level === "error")).toEqual([]);
  });

  it("a step that fails is logged and never stops the next steps or the check", async () => {
    vi.mocked(applyOutageHold).mockRejectedValueOnce(new Error("hold broke"));
    vi.mocked(evaluateWarmupDays).mockRejectedValueOnce(new Error("warm-up broke"));
    const rec = recordingLogger();
    const job = createJobRegistry({ mailgun, logger: rec.logger })["mailgun.catchUp"]!;
    const res = await job.handler({ reason: "manual" }, { jobId: 2, createdById: null, signal: new AbortController().signal, progress: async () => undefined });
    expect((res as { summary: string }).summary).toMatch(/^Checked with Mailgun/);
    expect(runHealthCheck).toHaveBeenCalledTimes(1);
    expect(rec.lines.filter((l) => l.level === "error").map((l) => l.message)).toEqual([
      "Couldn't put follow-ups on hold after the PC was off; the sending maintenance tries again in 5 minutes: Error: hold broke",
      "The warm-up evaluation after the check with Mailgun hit a problem; the hourly check tries again: Error: warm-up broke",
    ]);
  });
});

describe("start-up (runOnce)", () => {
  it("applies an outage hold that was found but not applied, before the loops run", async () => {
    const w = await waitingFollowUp("Resinhaus", 15);
    const now = new Date();
    await setOutage({
      detectedAt: now.toISOString(),
      from: new Date(now.getTime() - 20 * DAY).toISOString(),
      to: new Date(now.getTime() - 12 * DAY).toISOString(),
      beyondLogRetention: true,
      beyondMessageRetention: false,
      handledAt: null,
      heldFor: null,
      heldTo: null,
      heldCount: 0,
    });
    const rec = recordingLogger();
    // The catch-up job does nothing here, so only the start-up step can apply the hold.
    expect(await worker(rec.logger, { catchUp: false }).runOnce()).toBe(0);
    expect(applyOutageHold).toHaveBeenCalledTimes(1);
    expect(await recipient(w.recipientId)).toMatchObject({ state: "HELD", holdReason: "outage" });
    expect((await readOutage()).handledAt).not.toBeNull();
    expect(rec.lines).toContainEqual({
      level: "info",
      message: "The PC was off too long to check every reply: put 1 person on hold until their senders have checked their inbox",
    });
    // Nothing went out to the held person in the same round.
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: w.queuedId! } })).status).toBe("QUEUED");

    // Handled: the next start leaves it alone.
    vi.mocked(applyOutageHold).mockClear();
    expect(await worker(recordingLogger().logger, { catchUp: false }).runOnce()).toBe(0);
    expect(applyOutageHold).not.toHaveBeenCalled();
  });

  it("a failed hold at start-up is logged and the worker carries on", async () => {
    const now = new Date();
    await setOutage({
      detectedAt: now.toISOString(),
      from: new Date(now.getTime() - 30 * DAY).toISOString(),
      to: new Date(now.getTime() - 25 * DAY).toISOString(),
      beyondLogRetention: true,
      beyondMessageRetention: false,
      handledAt: null,
      heldFor: null,
      heldTo: null,
      heldCount: 0,
    });
    vi.mocked(applyOutageHold).mockRejectedValueOnce(new Error("database busy"));
    const rec = recordingLogger();
    expect(await worker(rec.logger, { catchUp: false }).runOnce()).toBe(0);
    expect(rec.lines).toContainEqual({
      level: "error",
      message: "Couldn't put follow-ups on hold after the PC was off; the next check with Mailgun tries again: Error: database busy",
    });
    // The 5-minute sending maintenance of the same round retried it (the sending gate held follow-ups meanwhile).
    expect(vi.mocked(applyOutageHold).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect((await readOutage()).handledAt).not.toBeNull();
  });
});

describe("the 5-minute sending maintenance", () => {
  it("reports a failed hold step through the worker's logger and still runs the rest", async () => {
    vi.mocked(applyPendingPossibleReplyHolds).mockRejectedValueOnce(new Error("holds broke"));
    const rec = recordingLogger();
    const loop = new SendingLoop({ ownsLease: async () => true, logger: rec.logger, mailgun, random: () => 0.5 });
    expect(await loop.tick(new AbortController().signal)).not.toBeNull();
    expect(applyPendingPossibleReplyHolds).toHaveBeenCalledTimes(1);
    expect(rec.lines.filter((l) => l.level === "error").map((l) => l.message)).toEqual([
      "Couldn't hold follow-ups for possible replies: Error: holds broke",
    ]);
  });
});
