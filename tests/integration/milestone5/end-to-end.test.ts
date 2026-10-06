import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeClaude, type FakeClaudeConnection } from "../helpers/claude";
import { replyTo } from "../helpers/replies";
import { makeCompany, setSettingValue } from "../campaigns/seed";
import { eventData } from "../mail-events/seed";
import { checklistRows } from "../sending-m3/helpers";
import { startFakeMailgun, type FakeMailgun } from "../../fake-mailgun/server";
import type { JobRegistry } from "../../../worker/jobs";

/**
 * Milestone 5 end to end (M5-DESIGN §9.3): address checks, AI personal lines and the missing-emails round trip, with
 * nothing mocked inside the app. Mailgun is the local fake server (tests/fake-mailgun, its validate route answering by
 * the address rules of §7.1), Claude is the local fake Claude server (tests/fake-claude, answering each fixture site's
 * claude.json), websites are the saved fixture sites (tests/fixtures/sites, `.example` origins) read by the real
 * reader, and the worker runs its real lanes on a fixed clock that starts on Wednesday 23 Sep 2026 at 10:00 in Berlin.
 * Nothing reaches the network.
 *
 *   Part A (SPEC definition of done with AI): import five companies; draft personal lines through the worker's `ai`
 *     lane (the fixture reader and the fake Claude injected with WorkerOptions.ai): 3 lines, 1 parked site without a
 *     Claude call, Instagram skipped; approve, edit then approve, reject + undo + approve; then (practice copy, as
 *     M4 Part A) a dry run with 2 follow-ups shows the approved lines after the greeting; a bounce, an unsubscribe and
 *     a reply stop the right people.
 *   Part B (address checks, live after go-live): 13 people on the fake's validate domains; the Verify step's count and
 *     cost; the wizard's check run with a 500 retried in the pass and 10 minutes later; the results, suppressions and
 *     notification; the launch (scheduled, RECHECK, left out); 6 sends; 24 hours later the re-check sweep releases one
 *     and leaves one out, and the sender hears.
 *   Part C (the missing-emails round trip): Export for Claude → Claude's CSV → Import adds people by company_id only.
 */

// The worker's start-up reads <database folder>/RESTORED; data/test is shared by all test files, so use a folder of our own.
const created = await createTestDb("m5-end-to-end");
const dir = path.join(path.dirname(created.file), `m5-e2e-${process.pid}-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
const dbFile = path.join(dir, "m5-e2e.db");
fs.copyFileSync(created.file, dbFile);
created.cleanup();
process.env.DATABASE_URL = "file:" + dbFile.replace(/\\/g, "/");

const D = "send.example.com";
const PUB = "http://127.0.0.1:3100";
const EVENTS_URL = `${PUB}/api/webhooks/mailgun/events`;
const SITES = path.resolve("tests/fixtures/sites");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Wednesday 23 Sep 2026, 10:00 in Berlin. */
const WEDNESDAY_10_BERLIN = new Date("2026-09-23T08:00:00.000Z");

let t = WEDNESDAY_10_BERLIN.getTime();
const clock = {
  now: () => new Date(t),
  set: (d: Date) => {
    t = d.getTime();
  },
  advance: (ms: number) => {
    t += ms;
    return new Date(t);
  },
};

const previousEnv = { base: process.env.OUTREACH_MAILGUN_BASE_URL, pub: process.env.APP_PUBLIC_URL };
const fake: FakeMailgun = await startFakeMailgun({ domain: D, region: "EU", apiKey: "key-fake-api", signingKey: "key-fake-signing", now: clock.now });
process.env.OUTREACH_MAILGUN_BASE_URL = fake.origin;
process.env.APP_PUBLIC_URL = PUB;

const { db, dbWrite } = await import("@/server/db");
const { setSetting } = await import("@/server/settings");
const { setState } = await import("@/server/state");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { enqueueJob } = await import("@/server/jobs");
const { GET: healthGET } = await import("@/app/api/health/route");
const { handleEventWebhook } = await import("@/server/services/mail-events/webhook");
const { connectMailgun } = await import("@/server/services/mailgun/connect");
const { setSenderLocalPart } = await import("@/server/services/sender-addresses");
const draft = await import("@/server/services/campaigns/draft");
const audience = await import("@/server/services/campaigns/audience");
const { MASTER_SEQUENCE } = await import("@/core/templates/defaults");
const { toCsv } = await import("@/core/csv");
const { parseUploadedFile, parseDelimitedText } = await import("@/server/services/imports/parse-file");
const { createImportSession, loadStoredSession } = await import("@/server/services/imports/sessions");
const { analyzeImport, buildCheckView } = await import("@/server/services/imports/check");
const { buildProblemRowsCsv } = await import("@/server/services/imports/problems");
const { suggestMapping } = await import("@/core/import/column-matching");
const { DEFAULT_IMPORT_OPTIONS } = await import("@/core/import/types");
const { exportMissingEmails } = await import("@/server/services/export");
const { parseCompanyFilters } = await import("@/server/services/companies/filters");
const { getContactsSidebar } = await import("@/server/services/companies/query");
const { selectForDrafting } = await import("@/server/services/ai/select");
const { startDraftRun } = await import("@/server/services/ai/start");
const { approveDraft, rejectDraft, undoDraft } = await import("@/server/services/ai/review");
const { campaignCheckView } = await import("@/server/services/verification/select");
const { startCheckRun } = await import("@/server/services/verification/start");
const { checkCostLine, checkRunSummary } = await import("@/core/verification/words");
const { getVerifier } = await import("@/server/verification");
const { createReader, fixtureTransport, immediatePoliteness } = await import("@/server/web");
const { BackgroundWorker } = await import("../../../worker/main");
const { createJobRegistry } = await import("../../../worker/jobs");
const { createVerifyAddressesJob } = await import("../../../worker/jobs/verify-addresses");
const { claimNextJob, runClaimedJob, WORKER_LANES } = await import("../../../worker/runner");
const periodic = await import("../../../worker/periodic");

/** Fast retries and a short timeout against the fake. */
const mailgun = () => getMailgunContext({ retryDelayMs: () => 0, timeoutMs: 2_000 });

/** The app's public address, answered in-process (the monitor's remote-access check). Anything else is refused. */
const appFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === `${PUB}/api/health`) return healthGET();
  if (url === EVENTS_URL) return handleEventWebhook(new Request(url, init), { now: clock.now() });
  throw new TypeError(`fetch failed (no network in this test: ${url})`);
}) as typeof fetch;

const errors: string[] = [];
const quiet = { info: () => undefined, warn: () => undefined, error: (m: string, e?: unknown) => errors.push(`${m}${e ? `: ${String(e)}` : ""}`) };

/** The fixture reader, with no waiting between requests (a fixed clock would never end the 2-second host gap). */
const fixtureReader = () => createReader({ transport: fixtureTransport(SITES), politeness: immediatePoliteness });

/**
 * A worker whose AI lane drafts with the fixture reader and (the saved key, the base URL connectFakeClaude set) the
 * fake Claude: the `ai` option of M5-DESIGN §9.3 Part A. Only rounds (`tickOnce`), no start-up, so nothing asks DNS.
 */
function aiWorker() {
  return new BackgroundWorker({ now: clock.now, mailgun, random: () => 0, fetchImpl: appFetch, logger: quiet, ai: { reader: fixtureReader() } });
}

/**
 * The worker for the sending parts: the real registry on the test clock, except the domain check (it would ask DNS),
 * which just records itself as done here.
 */
const registry: JobRegistry = (() => {
  const base = createJobRegistry({ mailgun, now: clock.now, logger: quiet });
  return {
    ...base,
    "mailgun.checkDomain": {
      ...base["mailgun.checkDomain"]!,
      handler: async () => {
        await periodic.recordTaskSuccess(periodic.DOMAIN_CHECK_6H_TASK, clock.now());
        return { summary: "skipped in this test (no DNS)" };
      },
    },
  };
})();
function sendingWorker() {
  return new BackgroundWorker({ now: clock.now, mailgun, random: () => 0, fetchImpl: appFetch, logger: quiet, registry });
}
type Worker = ReturnType<typeof sendingWorker>;

/**
 * Runs every due job of the `checks` lane at the test clock through the real runner, with the check job's waits on a
 * fake elapsed-time clock (its 2-second retry and back-offs take no real time). Returns the outcomes.
 */
let elapsedMs = 0;
async function runChecksLane(): Promise<string[]> {
  const verify = createVerifyAddressesJob({
    now: clock.now,
    clockMs: () => elapsedMs,
    sleep: async (ms) => {
      elapsedMs += ms;
    },
    random: () => 0.5,
    logger: quiet,
    verifier: () => getVerifier({ timeoutMs: 2_000 }),
  });
  const outcomes: string[] = [];
  for (let i = 0; i < 10; i++) {
    const job = await claimNextJob("m5-checks", clock.now(), WORKER_LANES.checks);
    if (!job) break;
    const res = await runClaimedJob(job, {
      workerId: "m5-checks",
      registry: { "verify.addresses": verify },
      signal: new AbortController().signal,
      logger: quiet,
      lane: WORKER_LANES.checks,
      now: clock.now,
    });
    outcomes.push(res.deferReason ? `${res.outcome}:${res.deferReason}` : res.outcome);
  }
  return outcomes;
}

async function pacer() {
  const row = await db.systemState.findUnique({ where: { key: "sending.pacer" } });
  return row?.value as { nextSendAt?: string | null; waiting?: { until: string | null } | null } | undefined;
}

/** Worker rounds until `done`, jumping the clock to the pacer's next slot or the next due email (never backwards). */
async function tickUntil(worker: Worker, campaignId: number, done: () => boolean, rounds = 20): Promise<void> {
  for (let round = 0; round < rounds && !done(); round++) {
    const p = await pacer();
    const due = await db.outboundEmail.findFirst({ where: { campaignId, status: "QUEUED" }, orderBy: { dueAt: "asc" }, select: { dueAt: true } });
    const next = Math.max(Date.parse(p?.nextSendAt ?? "") || 0, Date.parse(p?.waiting?.until ?? "") || 0, due?.dueAt.getTime() ?? 0);
    if (next > clock.now().getTime()) clock.set(new Date(next + 1_000));
    expect(await worker.tickOnce()).toBe(0);
  }
}

/** The fake's messages for one campaign (by v:campaign_id). */
function campaignMessages(campaignId: number) {
  return fake.messages.filter((m) => m.fields["v:campaign_id"]?.[0] === String(campaignId));
}

async function postEvent(data: Record<string, unknown>) {
  const res = await handleEventWebhook(fake.signedEventRequest(EVENTS_URL, data), { now: clock.now() });
  expect(res.status).toBe(200);
}

type Actor = { id: number; name: string; role: "OWNER" | "MEMBER" };
let owner: Actor;
let ali: Actor;
let aliAddress = "";
let claude: FakeClaudeConnection;

beforeAll(async () => {
  const arslan = await dbWrite((c) =>
    c.user.create({ data: { email: "arslan@polygonparadise.test", name: "Arslan", role: "OWNER", timeZone: "Europe/Berlin", senderDisplayName: "Arslan from Polygon Paradise" } }),
  );
  const aliUser = await dbWrite((c) =>
    c.user.create({ data: { email: "ali.khan@polygonparadise.test", name: "Ali", role: "MEMBER", timeZone: "Europe/Berlin", senderDisplayName: "Ali from Polygon Paradise" } }),
  );
  await dbWrite(async (c) => {
    await c.user.update({ where: { id: arslan.id }, data: { replyInbox: "arslan.owner@example.org", signature: "Arslan\nPolygon Paradise" } });
    await c.user.update({ where: { id: aliUser.id }, data: { replyInbox: "ali.inbox@example.org", signature: "Ali Khan\nPolygon Paradise" } });
  });
  owner = { id: arslan.id, name: arslan.name, role: "OWNER" };
  ali = { id: aliUser.id, name: aliUser.name, role: "MEMBER" };
  await setSettingValue("practice.copy", false);
  // The daily backup and clean-up aren't part of this test.
  for (const name of ["backup.daily", "cleanup.daily"]) await periodic.recordTaskSuccess(name, clock.now());

  // Mailgun connected (the fake) and a sending address for Ali; the fake Claude with its test key.
  expect(await connectMailgun(owner, { region: "EU", domain: D, apiKey: "key-fake-api" }, { retryDelayMs: () => 0 })).toMatchObject({ ok: true });
  fake.setDns("all");
  aliAddress = (await setSenderLocalPart(owner, ali.id, "ali")).address;
  await setSenderLocalPart(owner, owner.id, "arslan");
  await dbWrite((c) => c.job.deleteMany({ where: { status: "QUEUED" } }));
  claude = await connectFakeClaude();
});

afterAll(async () => {
  if (previousEnv.base === undefined) delete process.env.OUTREACH_MAILGUN_BASE_URL;
  else process.env.OUTREACH_MAILGUN_BASE_URL = previousEnv.base;
  if (previousEnv.pub === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previousEnv.pub;
  await claude.stop();
  await fake.close();
  await db.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ───────────────────────── Part A: AI personal lines ─────────────────────────

describe("Part A: import, draft personal lines with Claude, review them, and use them in a campaign", () => {
  const A = { companies: {} as Record<string, number>, people: {} as Record<string, number>, jobId: 0, drafts: {} as Record<string, number>, campaignId: 0 };
  const lines = {} as Record<string, string>;
  let worker: ReturnType<typeof aiWorker>;

  it("1. imports the five companies of m5-companies.csv through the import pipeline and its commit task", async () => {
    const bytes = fs.readFileSync(path.resolve("tests/fixtures/import/m5-companies.csv"));
    const parsed = parseUploadedFile(new Uint8Array(bytes), "m5-companies.csv");
    const sessionId = await createImportSession({ userId: ali.id, fileName: "m5-companies.csv", parsed });
    const mapping = suggestMapping(parsed.table.headers, parsed.table.rows.map((r) => r.cells)).map((s) => s.mapping);
    expect(mapping.map((m) => m.target)).toEqual(["company", "website", "country", "instagram", "name", "email", "role"]);
    await dbWrite((c) => c.importSession.update({ where: { id: sessionId }, data: { mapping, options: DEFAULT_IMPORT_OPTIONS, status: "MAPPED" } }));
    const session = (await loadStoredSession(sessionId))!;
    const view = buildCheckView(await analyzeImport(sessionId, session.mapping!, session.options, { fresh: true }), session.options, false);
    expect(view.roundTrip).toBe(false);
    expect(view.summary).toMatchObject({ newCompanies: 5, problemRows: 0 });

    // "Import 5 companies": the commit task runs in the worker's main lane.
    await enqueueJob({ type: "import.commit", payload: { sessionId }, dedupeKey: `import:${sessionId}`, createdById: ali.id, maxAttempts: 3 });
    worker = aiWorker();
    expect(await worker.tickOnce()).toBe(0);
    expect((await db.importSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe("DONE");
    const companies = await db.company.findMany({ where: { deletedAt: null }, include: { people: true }, orderBy: { id: "asc" } });
    expect(companies.map((c) => [c.name, c.website, c.instagram, c.people.map((p) => p.emailNorm)])).toEqual([
      ["Figuren Werkstatt", "https://www.figuren-werkstatt.example", null, ["anna@figuren-werkstatt.example"]],
      ["Butikk AS", "https://butikk.example", null, ["ola@butikk.example"]],
      ["Grid Shop", "https://www.gridshop.example", null, ["info@gridshop.example"]],
      ["Parked Co", "https://parked-domain.example", null, ["pat@parked-domain.example"]],
      ["Insta Creator", null, "insta.creator", ["ivy@insta-creator.example"]],
    ]);
    for (const c of companies) {
      A.companies[c.name] = c.id;
      A.people[c.name] = c.people[0]!.id;
    }
  });

  it("2. drafts lines for all five: Insta is skipped, 3 lines and 1 parked site; the fake Claude gets 3 requests", async () => {
    const all = Object.values(A.companies);
    const selection = await selectForDrafting({ companyIds: all }, { redraft: false });
    expect(selection.skipped).toMatchObject({ socialOnly: 1, noWebsite: 0, hasLine: 0 });
    expect(selection.toDraft).toEqual(all.slice(0, 4));

    const started = await startDraftRun(ali, { companyIds: all }, { redraft: false, source: "contacts", now: clock.now() });
    expect(started.count).toBe(4);
    A.jobId = started.jobId;
    // The AI lane runs until done (each round runs every lane until it is idle).
    for (let i = 0; i < 5 && (await db.job.findUniqueOrThrow({ where: { id: A.jobId } })).status !== "DONE"; i++) {
      expect(await worker.tickOnce()).toBe(0);
    }
    const job = await db.job.findUniqueOrThrow({ where: { id: A.jobId } });
    expect(job.status).toBe("DONE");

    const drafts = await db.aiDraft.findMany({ where: { jobId: A.jobId }, orderBy: { id: "asc" } });
    const byCompany = new Map(drafts.map((d) => [d.companyId, d]));
    for (const name of ["Figuren Werkstatt", "Butikk AS", "Grid Shop"]) {
      const d = byCompany.get(A.companies[name]!)!;
      expect(d).toMatchObject({ status: "READY", calls: 1, inputTokens: 3_000, outputTokens: 120, costUsd: 0.0036 });
      // The quote is in the snapshot the draft names, and the evidence URL is that page.
      const snapshotId = d.evidenceSource === "second_page" ? d.pageSnapshotId : d.homeSnapshotId;
      const snap = await db.websiteSnapshot.findUniqueOrThrow({ where: { id: snapshotId! } });
      expect(d.evidenceUrl).toBe(snap.finalUrl ?? snap.url);
      expect(`${snap.title ?? ""}\n${snap.text}`.replace(/\s+/g, " ")).toContain(d.evidenceQuote!.replace(/\s+/g, " "));
      A.drafts[name] = d.id;
      lines[name] = d.line!;
    }
    // The parked site gets "No line" without asking Claude: no call, no cost.
    expect(byCompany.get(A.companies["Parked Co"]!)).toMatchObject({ status: "NO_LINE", reasonIfNull: "parked", calls: 0, costUsd: null });
    expect(byCompany.has(A.companies["Insta Creator"]!)).toBe(false);
    expect(lines["Figuren Werkstatt"]).toBe(JSON.parse(fs.readFileSync(path.join(SITES, "de-figuren", "claude.json"), "utf8")).line);

    // Exactly 3 messages requests (Haiku, no parked site), and Ali hears.
    const messages = claude.fake.requests.filter((r) => r.path === "/v1/messages");
    expect(messages).toHaveLength(3);
    expect(messages.every((r) => r.body.model === "claude-haiku-4-5-20251001" && r.body.max_tokens === 600)).toBe(true);
    const ready = await db.notification.findFirstOrThrow({ where: { userId: ali.id, type: "ai.draftsReady" } });
    expect(ready).toMatchObject({ title: "AI lines ready to review", body: "3 lines are waiting for you. 1 company got no line. Cost $0.01.", link: "/ai-lines" });
  });

  it("3. approve, edit then approve, reject and undo within 60 s then approve: three companies have an AI line", async () => {
    const at = clock.now();
    await approveDraft(ali, A.drafts["Figuren Werkstatt"]!, { now: at });
    lines["Butikk AS"] = lines["Butikk AS"]!.replace(/\.$/, " for collectors.");
    await approveDraft(ali, A.drafts["Butikk AS"]!, { line: lines["Butikk AS"], now: at });
    await rejectDraft(ali, A.drafts["Grid Shop"]!, { now: at });
    await undoDraft(ali, A.drafts["Grid Shop"]!, { now: new Date(at.getTime() + 30_000) });
    await approveDraft(ali, A.drafts["Grid Shop"]!, { now: new Date(at.getTime() + 40_000) });

    const companies = await db.company.findMany({ where: { id: { in: Object.values(A.companies) } }, orderBy: { id: "asc" } });
    expect(companies.map((c) => [c.name, c.personalLine, c.personalLineSource])).toEqual([
      ["Figuren Werkstatt", lines["Figuren Werkstatt"], "ai"],
      ["Butikk AS", lines["Butikk AS"], "ai"],
      ["Grid Shop", lines["Grid Shop"], "ai"],
      ["Parked Co", null, null],
      ["Insta Creator", null, null],
    ]);
    const reviewed = await db.aiDraft.findMany({ where: { id: { in: Object.values(A.drafts) } }, orderBy: { id: "asc" } });
    expect(reviewed.map((d) => [d.status, d.reviewAction])).toEqual([
      ["APPROVED", "approved"],
      ["APPROVED", "edited"],
      ["APPROVED", "approved"],
    ]);
    expect(await db.activityLog.count({ where: { type: "company.personalLine" } })).toBe(3);
    expect(await db.activityLog.count({ where: { type: "ai.rejected" } })).toBe(1);
  });

  it("4. (practice copy) a dry run to all five: the approved lines come right after the greeting, no empty line elsewhere", async () => {
    await setSettingValue("practice.copy", true);
    await setSetting("sending.mode", "DRY_RUN", owner.id);
    const d = await draft.createDraft(ali, { companyIds: Object.values(A.companies), timeZone: "Europe/Berlin", now: clock.now() });
    A.campaignId = d.id;
    await draft.renameDraft(ali, d.id, "Practice with AI lines");
    const [s0, s1, s2] = MASTER_SEQUENCE.steps;
    await draft.saveDraftSteps(ali, d.id, [
      { step: 0, enabled: true, subject: s0!.subject, body: s0!.body, delayDays: 0 },
      { step: 1, enabled: true, subject: null, body: s1!.body, delayDays: 1 },
      { step: 2, enabled: true, subject: null, body: s2!.body, delayDays: 2 },
    ]);
    await draft.setDraftSchedule(ali, d.id, { daysAsMinutes: true }, { now: clock.now() });
    const launched = await draft.launchDraft(ali, d.id, { now: clock.now(), ignoreWindow: true });
    expect(launched).toMatchObject({ status: "RUNNING", mode: "DRY_RUN", queued: 5 });
    expect(await worker.tickOnce()).toBe(0);

    const firsts = await db.outboundEmail.findMany({ where: { campaignId: d.id, step: 0 }, orderBy: { id: "asc" } });
    expect(firsts.map((e) => e.status)).toEqual(Array(5).fill("SENT"));
    const textOf = (name: string) => firsts.find((e) => e.companyId === A.companies[name])!.text.split("\n");
    for (const name of ["Figuren Werkstatt", "Butikk AS", "Grid Shop"]) {
      const text = textOf(name);
      expect(text[0]).toMatch(/^(Hi|Hello) \S.*,$/);
      expect(text.slice(1, 4)).toEqual(["", lines[name], ""]);
      expect(text[4]).toMatch(/^I'm Ali from Polygon Paradise\./);
    }
    for (const name of ["Parked Co", "Insta Creator"]) {
      const text = textOf(name);
      expect(text[0]).toMatch(/^(Hi|Hello) \S.*,$/);
      expect(text[1]).toBe("");
      expect(text[2]).toMatch(/^I'm Ali from Polygon Paradise\./);
    }
    expect(textOf("Grid Shop")[0]).toMatch(/^(Hi|Hello) there,$/);
  });

  it("5. a bounce (Parked Co), an unsubscribe (Grid Shop) and a reply from Anna: follow-ups only to Butikk and Insta Creator", async () => {
    const first = (name: string) => db.outboundEmail.findFirstOrThrow({ where: { campaignId: A.campaignId, companyId: A.companies[name]!, step: 0 } });
    for (const [name, kind] of [
      ["Parked Co", "bounce"],
      ["Grid Shop", "unsubscribe"],
    ] as const) {
      const row = await first(name);
      await postEvent(eventData({ messageId: row.messageId, toNorm: row.toNorm, sendId: row.sendId, campaignId: A.campaignId }, kind, { at: clock.now() }));
    }
    const posted = await replyTo(fake, (await first("Figuren Werkstatt")).id, { text: "Hi Ali,\n\nYes, please send a few examples of dragons.\n\nAnna" });
    expect(posted.status).toBe(200);
    expect(await worker.tickOnce()).toBe(0);

    const recipient = (name: string) => db.campaignRecipient.findFirstOrThrow({ where: { campaignId: A.campaignId, companyId: A.companies[name]! } });
    expect(await recipient("Parked Co")).toMatchObject({ state: "STOPPED", stopReason: "bounced" });
    expect(await recipient("Grid Shop")).toMatchObject({ state: "STOPPED", stopReason: "unsubscribed" });
    expect(await recipient("Figuren Werkstatt")).toMatchObject({ state: "STOPPED", stopReason: "replied" });

    // Follow-up 1 a minute later, follow-up 2 two minutes after that ("days as minutes").
    clock.advance(MIN);
    expect(await worker.tickOnce()).toBe(0);
    clock.advance(2 * MIN);
    expect(await worker.tickOnce()).toBe(0);
    const sent = await db.outboundEmail.findMany({ where: { campaignId: A.campaignId, status: "SENT" } });
    const to = (step: number) => sent.filter((e) => e.step === step).map((e) => e.toNorm).sort();
    expect(to(0)).toHaveLength(5);
    expect(to(1)).toEqual(["ivy@insta-creator.example", "ola@butikk.example"]);
    expect(to(2)).toEqual(["ivy@insta-creator.example", "ola@butikk.example"]);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: A.campaignId } })).status).toBe("FINISHED");

    const statuses = await db.company.findMany({ where: { id: { in: Object.values(A.companies) } }, orderBy: { id: "asc" }, select: { name: true, status: true } });
    expect(statuses.map((c) => [c.name, c.status])).toEqual([
      ["Figuren Werkstatt", "REPLIED"],
      ["Butikk AS", "CONTACTED"],
      ["Grid Shop", "CONTACTED"],
      ["Parked Co", "CONTACTED"],
      ["Insta Creator", "CONTACTED"],
    ]);
    const aliNotes = await db.notification.findMany({ where: { userId: ali.id }, orderBy: { id: "asc" } });
    expect(aliNotes.map((n) => n.type).sort()).toEqual(["ai.draftsReady", "campaign.finished", "reply.received"]);
    expect(errors).toEqual([]);
  });
});

// ───────────────────────── Part B: address checks, live after go-live ─────────────────────────

describe("Part B: address checks for a live campaign, the launch, and the 24-hour re-check", () => {
  const ADDRESSES = [
    "anna@valid.test",
    "medium1@valid.test",
    "risky1@valid.test",
    "ok@catchall-low.test",
    "ok@catchall-medium.test",
    "temp1@valid.test",
    "bad1@valid.test",
    "x@disposable.test",
    "g@greylist.test",
    "t@timeout.test",
    "info@role.test",
    "flaky2@valid.test",
  ];
  const B = { campaignId: 0, jobId: 0, people: {} as Record<string, number>, companies: [] as number[] };
  let worker: Worker;
  /** When the first pass checked g and t ("no answer"): their re-check is due 24 hours later. */
  let firstPassAt = new Date(0);

  it("0. real data, live after go-live: the reply test passed, the sender's route works, the domain checklist is green", async () => {
    await setSettingValue("practice.copy", false);
    clock.set(new Date(WEDNESDAY_10_BERLIN.getTime() + 30 * MIN));
    await dbWrite((c) => c.senderAddress.updateMany({ data: { routeStatus: "ok" } }));
    await setState("domain.check", { domain: D, region: "EU", checkedAt: clock.now().toISOString(), lastVerifyAt: null, rows: checklistRows(), error: null });
    await setSettingValue("mailgun.unsubscribeTest", {
      setup: "A",
      status: "passed",
      domain: D,
      mailboxes: [],
      headersOk: true,
      decidedAt: clock.now().toISOString(),
      decidedById: owner.id,
      note: null,
    });
    await setSettingValue("sending.testList", ["inbox@polygonparadise.test"]);
    await setSetting("sending.mode", "LIVE", owner.id);
    await setSettingValue("sending.goLive", true);
  });

  it("1–2. a draft to 13 people: 12 notes 'Address not checked yet'; the Verify step counts 12 and says what it costs", async () => {
    for (const [i, email] of [...ADDRESSES, "f@fresh.test"].entries()) {
      const { company, people } = await makeCompany({ name: `Check ${String.fromCharCode(65 + i)} Studio`, people: [{ name: `Person ${i + 1}`, email }] });
      B.companies.push(company.id);
      B.people[email] = people[0]!.id;
    }
    // f@fresh.test was checked 10 days ago by the fake Mailgun (real in fake mode): no call.
    await dbWrite((c) =>
      c.person.update({
        where: { id: B.people["f@fresh.test"]! },
        data: { verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: new Date(clock.now().getTime() - 10 * DAY), verificationProvider: "mailgun-fake" },
      }),
    );
    fake.setValidation("flaky2@valid.test", { status: 500, times: 2 });

    const d = await draft.createDraft(ali, { companyIds: B.companies, timeZone: "Europe/Berlin", now: clock.now() });
    B.campaignId = d.id;
    await draft.renameDraft(ali, d.id, "Germany Q4");
    const [s0] = MASTER_SEQUENCE.steps;
    await draft.saveDraftSteps(ali, d.id, [{ step: 0, enabled: true, subject: s0!.subject, body: s0!.body, delayDays: 0 }]);

    const snap = await audience.loadAudienceSnapshot(d.id, { now: clock.now() });
    const people = snap.companies.flatMap((c) => c.people);
    expect(people.filter((p) => p.ticked && p.willGet)).toHaveLength(13);
    expect(people.filter((p) => p.notes.includes("Address not checked yet"))).toHaveLength(12);

    const view = await campaignCheckView(d.id, clock.now());
    expect(view.need).toMatchObject({ total: 12, notChecked: 12 });
    expect(view.fine).toBe(1);
    expect(view.estimate).toMatchObject({ count: 12, aboutUsd: 0.144, recheckExtraUsd: 0.012 });
    expect(checkCostLine(view.estimate)).toBe("Cost: about $0.14 (12 checks × $0.012). Up to $0.01 more if some need a second check tomorrow.");
  });

  it("3. the wizard's run: flaky2's 500 is retried in the pass, then 10 minutes later; each address is billed once, 2 at a time", async () => {
    const started = await startCheckRun(ali, { source: "wizard", campaignId: B.campaignId, confirmedCount: 12 }, { now: clock.now() });
    expect(started.count).toBe(12);
    B.jobId = started.jobId;

    expect(await runChecksLane()).toEqual(["deferred:retry-later"]);
    firstPassAt = clock.now();
    const waiting = await db.job.findUniqueOrThrow({ where: { id: B.jobId } });
    expect(waiting).toMatchObject({ status: "QUEUED", runAt: new Date(clock.now().getTime() + 10 * MIN) });
    expect(fake.validations.filter((v) => v.address === "flaky2@valid.test").map((v) => v.status)).toEqual([500, 500]);
    // Nothing is due before the 10 minutes are over.
    expect(await runChecksLane()).toEqual([]);
    clock.advance(10 * MIN);
    expect(await runChecksLane()).toEqual(["done"]);
    expect(await db.person.findUniqueOrThrow({ where: { id: B.people["g@greylist.test"]! } })).toMatchObject({
      verificationStatus: "UNKNOWN",
      verificationUnknowns: 1,
      verifiedAt: firstPassAt,
    });

    const byAddress = fake.state().validations.byAddress;
    for (const a of ADDRESSES) expect(byAddress[a], a).toBe(1);
    expect(byAddress["f@fresh.test"]).toBeUndefined();
    expect(fake.state().validations.peakInFlight).toBeLessThanOrEqual(2);
    expect(fake.requests.some((r) => r.path.startsWith("/v3/address"))).toBe(false);
  });

  it("4. the results: two addresses on the do-not-email list (never Mailgun's), the requester's notification, the activity", async () => {
    const sups = await db.suppression.findMany({ where: { emailNorm: { in: ["bad1@valid.test", "x@disposable.test"] } }, orderBy: { emailNorm: "asc" } });
    expect(sups.map((s) => [s.emailNorm, s.reason, s.source, s.pushedToMailgunAt !== null])).toEqual([
      ["bad1@valid.test", "INVALID", "verification", true],
      ["x@disposable.test", "INVALID", "verification", true],
    ]);
    const counts = {
      checked: 12,
      canEmail: 5,
      lowRiskCatchAll: 1,
      invalid: 1,
      doNotSend: 1,
      risky: 1,
      catchAllBlocked: 1,
      disposable: 1,
      unknown: 2,
      refused: 0,
      notReached: 0,
      mayBeCharged: 0,
      skipped: { fresh: 0, suppressed: 0, noEmail: 0, neverEmailed: 0 },
      costUsd: 0.144,
    };
    const body =
      "12 addresses checked: 5 can be emailed, 1 doesn't exist, 1 shouldn't be emailed, 1 is rated high risk, 1 can't be confirmed, 1 is a throwaway address, 2 got no answer. Cost $0.14.";
    expect(checkRunSummary(counts)).toBe(body);
    expect(((await db.job.findUniqueOrThrow({ where: { id: B.jobId } })).result as { counts: unknown }).counts).toEqual(counts);
    expect(await db.notification.findFirstOrThrow({ where: { type: "verify.finished", userId: ali.id } })).toMatchObject({
      title: "Address checks finished for Germany Q4",
      body,
      link: `/campaigns/${B.campaignId}/setup/verify`,
    });
    expect(await db.activityLog.findFirstOrThrow({ where: { type: "verify.run" } })).toMatchObject({
      actorId: ali.id,
      campaignId: B.campaignId,
      summary: "Ali checked 12 addresses for Germany Q4: 5 can be emailed, 1 doesn't exist, 1 shouldn't be emailed.",
    });
  });

  it("5. the launch: 6 scheduled, 2 wait for their re-check, 5 left out; 6 messages reach the fake, none to g or t", async () => {
    const launched = await draft.launchDraft(ali, B.campaignId, { now: clock.now(), mailgun });
    expect(launched).toMatchObject({ status: "RUNNING", mode: "LIVE", rechecking: 2 });
    const recipients = await db.campaignRecipient.findMany({ where: { campaignId: B.campaignId }, orderBy: { id: "asc" } });
    const byEmail = new Map(recipients.map((r) => [r.emailNorm, r]));
    const state = (e: string) => byEmail.get(e)!.state;
    expect(["anna@valid.test", "medium1@valid.test", "ok@catchall-low.test", "info@role.test", "f@fresh.test", "flaky2@valid.test"].map(state)).toEqual(
      Array(6).fill("SCHEDULED"),
    );
    for (const e of ["g@greylist.test", "t@timeout.test"]) {
      expect(byEmail.get(e)).toMatchObject({ state: "RECHECK", included: true, recheckAt: new Date(firstPassAt.getTime() + DAY) });
      expect(await db.outboundEmail.findFirstOrThrow({ where: { recipientId: byEmail.get(e)!.id } })).toMatchObject({ step: 0, status: "QUEUED" });
    }
    const leftOut = ["risky1@valid.test", "ok@catchall-medium.test", "temp1@valid.test", "bad1@valid.test", "x@disposable.test"];
    for (const e of leftOut) expect(byEmail.get(e), e).toMatchObject({ state: "EXCLUDED", included: false });
    expect(Object.fromEntries(leftOut.map((e) => [e, byEmail.get(e)!.exclusionReason]))).toEqual({
      "risky1@valid.test": "The address check rated this address high risk; your check settings skip these",
      "ok@catchall-medium.test": "Can't confirm this address (medium risk); your check settings skip these",
      "temp1@valid.test": "A throwaway address; your check settings skip these",
      "bad1@valid.test": "The address check said this address doesn't exist",
      "x@disposable.test": "The address check said not to email this address",
    });
    // The RECHECK people's companies are reserved like the scheduled ones.
    expect(await db.companyReservation.count({ where: { campaignId: B.campaignId, releasedAt: null } })).toBe(8);

    // A fresh worker: start-up (the check with Mailgun first), then rounds until the 6 first emails are out.
    worker = sendingWorker();
    expect(await worker.runOnce()).toBe(0);
    await tickUntil(worker, B.campaignId, () => campaignMessages(B.campaignId).length >= 6);
    const to = campaignMessages(B.campaignId).map((m) => m.fields.to?.[0]).sort();
    expect(to).toEqual(["anna@valid.test", "f@fresh.test", "flaky2@valid.test", "info@role.test", "medium1@valid.test", "ok@catchall-low.test"]);
    expect(campaignMessages(B.campaignId).map((m) => m.fields.from?.[0])).toEqual(Array(6).fill(`Ali from Polygon Paradise <${aliAddress}>`));
    // The catch-up pushed the app's own suppressions: the INVALID ones never reach Mailgun's unsubscribes.
    const unsubscribes = fake.state().suppressions.unsubscribes.map((s) => s.address);
    expect(unsubscribes).not.toContain("bad1@valid.test");
    expect(unsubscribes).not.toContain("x@disposable.test");
  });

  it("6. 24 hours later the sweep re-checks g and t: g passes and is sent, t is left out; Ali hears; the campaign finishes", async () => {
    // Nothing is due before the 24 hours are over.
    const recheckTask = periodic.PERIODIC_TASKS.filter((task) => task.name === "verify.recheck");
    await periodic.checkPeriodicTasks(clock.now(), recheckTask, quiet);
    expect(await db.job.count({ where: { type: "verify.addresses", status: "QUEUED" } })).toBe(0);

    clock.set(new Date(firstPassAt.getTime() + DAY + MIN));
    expect(await periodic.checkPeriodicTasks(clock.now(), recheckTask, quiet)).toEqual(["verify.recheck"]);
    expect(await db.job.findFirstOrThrow({ where: { type: "verify.addresses", status: "QUEUED" } })).toMatchObject({
      activeDedupeKey: "verify:recheck",
      priority: 30,
      createdById: null,
    });
    expect(await runChecksLane()).toEqual(["done"]);

    const recipient = (e: string) => db.campaignRecipient.findFirstOrThrow({ where: { campaignId: B.campaignId, emailNorm: e } });
    expect(await recipient("g@greylist.test")).toMatchObject({ state: "SCHEDULED" });
    expect(await recipient("t@timeout.test")).toMatchObject({ state: "EXCLUDED", included: false, exclusionReason: "Address couldn't be checked" });
    expect(await db.notification.findFirstOrThrow({ where: { type: "verify.finished", title: "Left out after a second address check" } })).toMatchObject({
      userId: ali.id,
      body: "1 person in Germany Q4 was left out: their address couldn't be checked. 1 other passed and gets their first email.",
      link: `/campaigns/${B.campaignId}`,
    });
    const byAddress = fake.state().validations.byAddress;
    expect([byAddress["g@greylist.test"], byAddress["t@timeout.test"]]).toEqual([2, 2]);

    await tickUntil(worker, B.campaignId, () => campaignMessages(B.campaignId).length >= 7);
    const to = campaignMessages(B.campaignId).map((m) => m.fields.to?.[0]);
    expect(to).toContain("g@greylist.test");
    expect(to).not.toContain("t@timeout.test");
    expect(to).toHaveLength(7);
    expect(await worker.tickOnce()).toBe(0);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: B.campaignId } })).status).toBe("FINISHED");
    expect(errors).toEqual([]);
  });
});

// ───────────────────────── Part C: the missing-emails round trip ─────────────────────────

describe("Part C: Export for Claude → Claude's CSV → Import adds people by company_id", () => {
  it("adds two people to one company, lists three problems, and never creates or changes a company", async () => {
    const mk = (name: string, email?: string) =>
      makeCompany({ name, domain: null, people: email ? [{ name: "Dave", email }] : [] }).then((r) => r.company);
    const a = await mk("Round A");
    const b = await mk("Round B");
    const c = await mk("Round C");
    const d = await mk("Round D", "dave@d.test");

    // 1. The export has exactly the companies without an email, with their codes.
    const file = await exportMissingEmails({ filters: parseCompanyFilters(new URLSearchParams()), format: "csv", timeZone: "UTC", now: clock.now() });
    const exported = parseDelimitedText(file.body as string);
    expect(exported.rows.map((r) => r.cells[0])).toEqual([`C-${a.id}`, `C-${b.id}`, `C-${c.id}`]);

    // 2. What Claude sends back.
    const columns = ["company_id", "company", "email", "contact_name", "role", "source_url", "note"];
    const csv = toCsv(
      [
        [`C-${a.id}`, "Round A", "anna@a.test", "Anna Berg", "Buyer", "https://a.test/team", "Named on the team page"],
        [`C-${a.id}`, "Round A", "info@a.test", "", "", "", ""],
        [`C-${b.id}`, "Round B", "dave@d.test", "Dave", "", "", ""],
        ["C-99999", "Nobody", "x@nobody.test", "", "", "", ""],
        [`C-${c.id}`, "Round C", "", "", "", "", "Only a contact form"],
        ["Foo", "Foo Ltd", "foo@foo.test", "", "", "", ""],
      ],
      columns,
    );
    const parsed = parseUploadedFile(new TextEncoder().encode(csv), "claude.csv");
    const sessionId = await createImportSession({ userId: ali.id, fileName: "claude.csv", parsed });

    // 3. The suggested mapping is a round trip, with the person's notes.
    const mapping = suggestMapping(parsed.table.headers, parsed.table.rows.map((r) => r.cells)).map((s) => s.mapping);
    expect(mapping.map((m) => m.target)).toEqual(["company_id", "company", "email", "name", "role", "person_notes", "person_notes"]);
    await dbWrite((x) => x.importSession.update({ where: { id: sessionId }, data: { mapping, options: DEFAULT_IMPORT_OPTIONS, status: "MAPPED" } }));
    const analysis = await analyzeImport(sessionId, mapping, DEFAULT_IMPORT_OPTIONS, { fresh: true });
    expect(analysis.roundTrip).toBe(true);
    const view = buildCheckView(analysis, DEFAULT_IMPORT_OPTIONS, false);
    expect(view.summary).toMatchObject({ peopleToAdd: 2, updateCompanies: 1, newCompanies: 0, problemRows: 3, noEmailRows: 1 });
    expect(view.rowIssues.map((r) => r.message)).toEqual([
      `dave@d.test already belongs to C-${d.id} Round D, so it wasn't added here.`,
      "C-99999 isn't a company in the app.",
      "No email found. Claude's note: “Only a contact form”",
      "“Foo” isn't a company ID like C-1042.",
    ]);

    // 4. The commit task (the worker's main lane).
    const companiesBefore = await db.company.count();
    const missingBefore = (await getContactsSidebar()).missingEmailCount;
    await enqueueJob({ type: "import.commit", payload: { sessionId }, dedupeKey: `import:${sessionId}`, createdById: ali.id, maxAttempts: 3 });
    expect(await sendingWorker().tickOnce()).toBe(0);
    expect((await db.importSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe("DONE");
    expect(await db.company.count()).toBe(companiesBefore);
    expect((await getContactsSidebar()).missingEmailCount).toBe(missingBefore - 1);
    const people = await db.person.findMany({ where: { companyId: a.id }, orderBy: { id: "asc" } });
    expect(people.map((p) => [p.name, p.emailNorm, p.isGeneric, p.notes])).toEqual([
      ["Anna Berg", "anna@a.test", false, "https://a.test/team · Named on the team page"],
      ["General inbox", "info@a.test", true, ""],
    ]);
    expect(await db.person.findUniqueOrThrow({ where: { emailNorm: "dave@d.test" } })).toMatchObject({ companyId: d.id });
    expect((await buildProblemRowsCsv(sessionId))?.count).toBe(3);
    expect((await db.activityLog.findFirstOrThrow({ where: { type: "import.done" }, orderBy: { id: "desc" } })).summary).toBe(
      "Ali imported claude.csv: 2 people added to 1 company, 1 row without an email, 3 rows need a look.",
    );
    expect(errors).toEqual([]);
  });
});
