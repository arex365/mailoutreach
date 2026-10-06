import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { stubClaudeApi } from "../helpers/claude";
import { ECHO_LINE } from "../../fake-claude/answers";
import { fixtureReader, makeCompany as makeSiteCompany, ORIGIN, seedUsers } from "../ai-drafting/harness";
import { makeCompany, makeDraft, makeUser } from "../campaigns/seed";

/**
 * Milestone 5 worker wiring (M5-DESIGN §8 P11): the job registry runs the address checks (`verify.addresses`, the
 * `checks` lane) and AI drafting (`ai.draftLines`, the `ai` lane) with the worker's clock, logger and `ai` option;
 * the two periodic tasks (`verify.recheck` every 15 minutes, `ai.orphans` every 30) look, act, and record their own
 * success. Mailgun is the local fake, websites are the fixture sites, Claude is an in-process stub: nothing reaches
 * the network.
 */

const t = await createTestDb("worker-m5-wiring");
const mg = await connectFakeMailgun({ domain: "send.example.com" });
const { db, dbWrite } = await import("@/server/db");
const { enqueueJob } = await import("@/server/jobs");
const { setSecret } = await import("@/server/secrets");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { startDraftRun } = await import("@/server/services/ai/start");
const { ORPHAN_TEXT } = await import("@/server/services/ai/drafts");
const { JOB_REGISTRY, JOB_PRIORITIES, createJobRegistry, workerAiLogger } = await import("../../../worker/jobs");
const { WORKER_LANES } = await import("../../../worker/runner");
const periodic = await import("../../../worker/periodic");
const { BackgroundWorker } = await import("../../../worker/main");

const mailgun = () => getMailgunContext({ retryDelayMs: () => 0, timeoutMs: 2_000 });
/** No network in this file: cloudflared's /ready and anything else is refused like a closed port. */
const noNetwork = (async () => {
  throw new TypeError("fetch failed (no network in this test)");
}) as typeof fetch;

type Line = { level: "info" | "warn" | "error"; message: string };
function recordingLogger() {
  const lines: Line[] = [];
  return {
    lines,
    logger: {
      info: (message: string) => void lines.push({ level: "info", message }),
      warn: (message: string) => void lines.push({ level: "warn", message }),
      error: (message: string, err?: unknown) => void lines.push({ level: "error", message: `${message}${err === undefined ? "" : `: ${String(err)}`}` }),
    },
  };
}

const M5_TASKS = periodic.PERIODIC_TASKS.filter((task) => task.name === "verify.recheck" || task.name === "ai.orphans");
const MIN = 60_000;

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

beforeEach(async () => {
  await dbWrite(async (c) => {
    await c.job.deleteMany({});
    await c.systemState.deleteMany({ where: { key: { startsWith: "task." } } });
  });
});

describe("the job registry (Milestone 5)", () => {
  it("registers the address checks and AI drafting, each in its own lane, with default priorities", () => {
    expect(JOB_PRIORITIES).toMatchObject({ "verify.addresses": 20, "ai.draftLines": 10 });
    expect(JOB_REGISTRY["verify.addresses"]).toMatchObject({
      label: "The address checks",
      whatToDo: "Open the campaign's Verify step or Contacts and start the checks again.",
    });
    expect(JOB_REGISTRY["ai.draftLines"]).toMatchObject({ label: "AI drafting", whatToDo: "Open AI lines and start the drafting again.", link: "/ai-lines" });
    expect(WORKER_LANES.checks.include).toEqual(["verify.addresses"]);
    expect(WORKER_LANES.ai.include).toEqual(["ai.draftLines"]);
    expect(WORKER_LANES.main.exclude).toEqual(["verify.addresses", "ai.draftLines"]);
    // A worker given an `ai` option builds a registry of its own (the default one stays as it is).
    const w = new BackgroundWorker({ ai: { claude: stubClaudeApi() }, fetchImpl: noNetwork, logger: recordingLogger().logger });
    const registry = (w as unknown as { registry: typeof JOB_REGISTRY }).registry;
    expect(registry).not.toBe(JOB_REGISTRY);
    expect(registry["ai.draftLines"]).not.toBe(JOB_REGISTRY["ai.draftLines"]);
    expect(Object.keys(createJobRegistry({})).sort()).toEqual(Object.keys(JOB_REGISTRY).sort());
  });

  it("the AI logger marks lines [ai] and hides anything shaped like a key in an error", () => {
    const rec = recordingLogger();
    const logger = workerAiLogger(rec.logger);
    logger.info("AI drafting run #3 now drafts with Claude Sonnet 5");
    logger.warn("Couldn't measure the prompt's size");
    logger.error("Drafting the line of draft #4 hit a problem", new Error("401 invalid x-api-key sk-ant-api03-abcdefghijklmnopqrstuvwxyz"));
    logger.error("No error object");
    expect(rec.lines).toEqual([
      { level: "info", message: "[ai] AI drafting run #3 now drafts with Claude Sonnet 5" },
      { level: "warn", message: "[ai] Couldn't measure the prompt's size" },
      { level: "error", message: expect.stringMatching(/^\[ai\] Drafting the line of draft #4 hit a problem: 401 invalid x-api-key /) },
      { level: "error", message: "[ai] No error object" },
    ]);
    expect(rec.lines[2]!.message).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
  });
});

describe("the lanes run the Milestone 5 jobs through the worker", () => {
  it("the checks lane runs a Settings test check against the fake Mailgun; nothing is stored on a person", async () => {
    mg.fake.reset();
    const job = await enqueueJob({ type: "verify.addresses", payload: { source: "settings", address: "anna@valid.test" }, priority: 25, maxAttempts: 1 });
    const rec = recordingLogger();
    const worker = new BackgroundWorker({ mailgun, fetchImpl: noNetwork, logger: rec.logger, random: () => 0.5 });
    expect(await worker.tickOnce()).toBe(0);
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "DONE" });
    const rows = await db.verificationCheck.findMany({ where: { jobId: job.id } });
    expect(rows.map((r) => [r.emailNorm, r.source, r.provider, r.personId, r.status])).toEqual([["anna@valid.test", "settings", "mailgun-fake", null, "VALID"]]);
    expect(mg.fake.validations.map((v) => v.address)).toEqual(["anna@valid.test"]);
    expect(rec.lines.some((l) => l.message === `Task #${job.id} (verify.addresses) started, try 1 of 1`)).toBe(true);
    expect(rec.lines.filter((l) => l.level === "error")).toEqual([]);
  });

  it("the ai lane drafts with the worker's `ai` option (a fixture reader, a stubbed Claude) and the worker's clock", async () => {
    const { owner } = await seedUsers();
    await setSecret("anthropic.apiKey", "sk-ant-fake-key", owner.id);
    const companyId = await makeSiteCompany({ name: "Figuren Werkstatt", website: ORIGIN.deFiguren, country: "DE" });
    const { jobId } = await startDraftRun(owner, { companyIds: [companyId] }, { redraft: false, source: "contacts" });
    const claude = stubClaudeApi();
    const { reader, transport } = await fixtureReader();
    const fixed = new Date("2026-09-23T08:00:00.000Z");
    const rec = recordingLogger();
    const worker = new BackgroundWorker({ mailgun, fetchImpl: noNetwork, logger: rec.logger, random: () => 0.5, now: () => fixed, ai: { reader, claude } });
    expect(await worker.tickOnce()).toBe(0);

    expect(await db.job.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "DONE" });
    const draft = await db.aiDraft.findFirstOrThrow({ where: { jobId } });
    expect(draft).toMatchObject({ status: "READY", companyId, calls: 1 });
    // The stub's echo line (it passes every check; the old "Your homepage describes…" now fails the banned wording).
    expect(draft.line).toBe(ECHO_LINE);
    // The worker's clock reached the job: the call is dated by it.
    expect(draft.draftedAt?.toISOString()).toBe(fixed.toISOString());
    expect(claude.calls).toHaveLength(1);
    expect(transport.calls.some((c) => c.url.startsWith(`${ORIGIN.deFiguren}/`))).toBe(true);
    expect(rec.lines.filter((l) => l.level === "error")).toEqual([]);
  });
});

describe("the periodic tasks of Milestone 5", () => {
  it("are verify.recheck every 15 minutes and ai.orphans every 30, and record their own success when idle", async () => {
    expect(M5_TASKS.map((task) => [task.name, task.intervalMs / MIN, task.retryAfterMs / MIN])).toEqual([
      ["verify.recheck", 15, 15],
      ["ai.orphans", 30, 30],
    ]);
    expect(periodic.RECHECK_TASK).toBe("verify.recheck");
    expect(periodic.AI_ORPHANS_TASK).toBe("ai.orphans");
    const quiet = recordingLogger();
    const now = new Date("2026-09-23T08:00:00.000Z");
    expect(await periodic.checkPeriodicTasks(now, M5_TASKS, quiet.logger)).toEqual(["verify.recheck", "ai.orphans"]);
    // Nothing was due: no run was queued, and both looked.
    expect(await db.job.count()).toBe(0);
    for (const name of ["verify.recheck", "ai.orphans"]) {
      expect((await periodic.readTaskState(name)).lastSuccessAt?.toISOString()).toBe(now.toISOString());
    }
    // The 10-minute check after: neither; 20 minutes: the sweep; 40 minutes: both.
    expect(await periodic.checkPeriodicTasks(new Date(now.getTime() + 10 * MIN), M5_TASKS, quiet.logger)).toEqual([]);
    expect(await periodic.checkPeriodicTasks(new Date(now.getTime() + 20 * MIN), M5_TASKS, quiet.logger)).toEqual(["verify.recheck"]);
    expect(await periodic.checkPeriodicTasks(new Date(now.getTime() + 40 * MIN), M5_TASKS, quiet.logger)).toEqual(["verify.recheck", "ai.orphans"]);
    expect(quiet.lines.filter((l) => l.level === "error")).toEqual([]);
  });

  it("verify.recheck queues the recheck run once a waiting person's 24 hours are over", async () => {
    const owner = await makeUser("Rita", { role: "OWNER", email: "rita@polygonparadise.test" });
    const { company, people } = await makeCompany({ name: "Greylist Co", people: [{ name: "Greta", email: "g@greylist.test" }] });
    const draft = await makeDraft({ name: "Recheck wiring", createdById: owner.id, recipients: [{ companyId: company.id, personId: people[0]!.id }] });
    const now = new Date("2026-09-24T08:01:00.000Z");
    await dbWrite(async (c) => {
      await c.campaign.update({ where: { id: draft.id }, data: { status: "RUNNING", mode: "LIVE", launchedAt: new Date(now.getTime() - 24 * 60 * MIN) } });
      await c.campaignRecipient.updateMany({ where: { campaignId: draft.id }, data: { state: "RECHECK", recheckAt: new Date(now.getTime() - MIN) } });
    });
    const recheckOnly = M5_TASKS.filter((task) => task.name === "verify.recheck");
    expect(await periodic.checkPeriodicTasks(now, recheckOnly, recordingLogger().logger)).toEqual(["verify.recheck"]);
    const jobs = await db.job.findMany();
    expect(jobs.map((j) => [j.type, j.payload, j.activeDedupeKey, j.priority, j.createdById, j.runAt.toISOString()])).toEqual([
      ["verify.addresses", { source: "recheck" }, "verify:recheck", 30, null, now.toISOString()],
    ]);
    expect((await periodic.readTaskState("verify.recheck")).lastSuccessAt?.toISOString()).toBe(now.toISOString());
    // The campaign is done with; nothing is due any more.
    await dbWrite((c) => c.campaign.update({ where: { id: draft.id }, data: { status: "CANCELLED" } }));
  });

  it("ai.orphans fails the drafts of a run that ended for good, and leaves a waiting run's drafts alone", async () => {
    const company = await makeSiteCompany({ name: "Orphan Co", website: ORIGIN.noButikk });
    const failed = await dbWrite((c) => c.job.create({ data: { type: "ai.draftLines", status: "FAILED", finishedAt: new Date() } }));
    const waiting = await dbWrite((c) => c.job.create({ data: { type: "ai.draftLines", status: "QUEUED" } }));
    const orphan = await dbWrite((c) => c.aiDraft.create({ data: { companyId: company, jobId: failed.id, model: "claude-haiku-4-5-20251001", promptVersion: "pl-2026-09-26", status: "QUEUED", calls: 1 } }));
    const kept = await dbWrite((c) => c.aiDraft.create({ data: { companyId: company, jobId: waiting.id, model: "claude-haiku-4-5-20251001", promptVersion: "pl-2026-09-26", status: "QUEUED" } }));
    const orphansOnly = M5_TASKS.filter((task) => task.name === "ai.orphans");
    const now = new Date();
    expect(await periodic.checkPeriodicTasks(now, orphansOnly, recordingLogger().logger)).toEqual(["ai.orphans"]);
    expect(await db.aiDraft.findUniqueOrThrow({ where: { id: orphan.id } })).toMatchObject({ status: "FAILED", error: ORPHAN_TEXT });
    expect(await db.aiDraft.findUniqueOrThrow({ where: { id: kept.id } })).toMatchObject({ status: "QUEUED" });
    expect(await db.job.count({ where: { type: "ai.draftLines", status: "QUEUED" } })).toBe(1);
  });
});
