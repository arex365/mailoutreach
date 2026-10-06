import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { connectFakeClaude, type FakeClaudeConnection } from "../helpers/claude";
import { replyTo } from "../helpers/replies";
import { setSettingValue } from "../campaigns/seed";
import { eventData } from "../mail-events/seed";

/**
 * Milestone 6 end to end, Part A (M6-DESIGN §9.3): SPEC's definition of done in dry-run mode, through the dashboard's
 * numbers. Nothing is mocked inside the app: Mailgun is the local fake server (tests/fake-mailgun, connected with the
 * M3 helper, which also saves its webhook signing key), Claude is the local fake Claude (tests/fake-claude), websites
 * are the saved fixture sites read by the real reader, and the background sender runs its real rounds on a fixed clock
 * that starts on Wednesday 23 Sep 2026 at 10:00 in Berlin. Nothing reaches the network.
 *
 *   1. Import m5-companies.csv (5 companies, each Not contacted; no company without an email).
 *   2. Draft personal lines with the fake Claude (steps 1–2 on real data, as M5 Part A): 3 lines, 1 parked site,
 *      Instagram skipped; approve, edit then approve, reject + undo + approve.
 *   3. (the practice copy, as M4 Part A) A dry run with 2 follow-ups through the draft services and the Review step's
 *      services: 3 emails per person, nothing missing, one email edited for Butikk AS only; launch.
 *   4. Send it: 5 first emails in the outbox with the approved lines after the greeting; the campaign list, today's
 *      limit and the pipeline.
 *   5. A signed bounce (Parked Co), a signed unsubscribe (Grid Shop) and a signed reply (Anna at Figuren Werkstatt).
 *   6. Both follow-ups go only to Butikk AS and Insta Creator; the campaign finishes.
 *   7. Statuses, stop rules, the exact notifications per user and the numbers behind every dashboard tile (pipeline,
 *      reply rate, sent today and the warm-up line, bounce and complaint numbers, team activity, dry-run numbers, the
 *      waiting replies); Ali clicks Answered.
 *
 * Before every read of those numbers the background sender's lease is held at the test clock and remote access is seeded
 * as working (`readyToRead`), so the dashboard never shows "worker-down" or "tunnel-down" for reasons outside the test.
 * Steps 1, 2 and 7 then read the dashboard itself (`loadDashboard`, the page's own loader) for Arslan and Ali: the same
 * numbers as its sources, and exactly the attention items this story produces (M6-DESIGN §9.3, the "P10" lines). The
 * machine-dependent "disk-low" item is left out of those checks.
 */

// The dashboard's page loader is marked server-only (a Next.js guard); under Vitest it is a plain module.
vi.mock("server-only", () => ({}));

// The worker's start-up reads <database folder>/RESTORED; data/test is shared by all test files, so use a folder of our own.
const created = await createTestDb("m6-spec-dry-run");
const dir = path.join(path.dirname(created.file), `m6-spec-${process.pid}-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
const dbFile = path.join(dir, `m6-spec-${process.pid}.db`);
fs.copyFileSync(created.file, dbFile);
created.cleanup();
process.env.DATABASE_URL = "file:" + dbFile.replace(/\\/g, "/");

const D = "send.example.com";
const PUB = "http://127.0.0.1:3100";
const EVENTS_URL = `${PUB}/api/webhooks/mailgun/events`;
const SITES = path.resolve("tests/fixtures/sites");
const TZ = "Europe/Berlin";
/** Every worker of this file uses the same id, so holding the lease for a read never blocks the next round. */
const WORKER_ID = "m6-spec-dry-run";
const MIN = 60_000;
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

const previousPub = process.env.APP_PUBLIC_URL;
process.env.APP_PUBLIC_URL = PUB;
// The M3 helper: the fake Mailgun on the test clock, its domain, key and webhook signing key saved in the app.
const mg: FakeConnection = await connectFakeMailgun({ domain: D, fake: { now: clock.now } });
const fake = mg.fake;

const { db, dbWrite } = await import("@/server/db");
const { setSetting } = await import("@/server/settings");
const { setState } = await import("@/server/state");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { enqueueJob } = await import("@/server/jobs");
const { getWorkerStatus } = await import("@/server/worker-status");
const { GET: healthGET } = await import("@/app/api/health/route");
const { handleEventWebhook } = await import("@/server/services/mail-events/webhook");
const { setSenderLocalPart } = await import("@/server/services/sender-addresses");
const draft = await import("@/server/services/campaigns/draft");
const { listCampaigns } = await import("@/server/services/campaigns/queries");
const { toCampaignListView } = await import("@/components/campaigns/format");
const { MASTER_SEQUENCE } = await import("@/core/templates/defaults");
const { parseUploadedFile } = await import("@/server/services/imports/parse-file");
const { createImportSession, loadStoredSession } = await import("@/server/services/imports/sessions");
const { analyzeImport, buildCheckView } = await import("@/server/services/imports/check");
const { suggestMapping } = await import("@/core/import/column-matching");
const { DEFAULT_IMPORT_OPTIONS } = await import("@/core/import/types");
const { getContactsSidebar } = await import("@/server/services/companies/query");
const { startDraftRun } = await import("@/server/services/ai/start");
const { approveDraft, rejectDraft, undoDraft } = await import("@/server/services/ai/review");
const { aiQueueCounts } = await import("@/server/services/ai/queue");
const { getTodayCap } = await import("@/server/services/sending/usage");
const { loadWarmupProgress, loadWarmupToday } = await import("@/server/services/sending/warmup-days");
const { warmupLine } = await import("@/core/sending/warmup-line");
const { loadHealthView } = await import("@/server/services/mail-events/deliverability");
const { loadPipeline } = await import("@/server/services/dashboard/pipeline");
const { replyRateText, replyRate30Text } = await import("@/core/dashboard/pipeline");
const { waitingReplyCountsByUser } = await import("@/server/services/dashboard/replies");
const { waitingRepliesLine } = await import("@/core/dashboard/replies");
const { loadDryRunSummary } = await import("@/server/services/dashboard/dry-run");
const { recentTeamActivity } = await import("@/server/services/dashboard/activity");
const { listWaitingReplies, markReplyAnswered } = await import("@/server/services/replies");
const { createReader, fixtureTransport, immediatePoliteness } = await import("@/server/web");
const { loadDashboard } = await import("@/app/(app)/dashboard/load");
const { DASHBOARD_TEXTS } = await import("@/components/dashboard/texts");
const { BackgroundWorker } = await import("../../../worker/main");
const { acquireLease } = await import("../../../worker/lease");
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
 * The background sender of Part A: its AI lane drafts with the fixture reader and (the saved key, the base URL
 * connectFakeClaude set) the fake Claude, its sending loop fills the dry-run outbox, its event lane files the signed
 * webhooks. Only rounds (`tickOnce`), no start-up, so nothing asks DNS.
 */
function newWorker() {
  return new BackgroundWorker({
    workerId: WORKER_ID,
    now: clock.now,
    mailgun,
    random: () => 0,
    fetchImpl: appFetch,
    logger: quiet,
    ai: { reader: fixtureReader() },
  });
}
type Worker = ReturnType<typeof newWorker>;

/** Remote access working, as the monitor records it after a passing check (cloudflared connected, every check ok). */
function workingRemoteAccess(at: Date) {
  const iso = at.toISOString();
  return {
    checkedAt: iso,
    state: "connected",
    readyConnections: 4,
    port: 20241,
    connectorId: "m6-e2e",
    version: "2026.9.0",
    versionWarning: null,
    downSince: null,
    notifiedAt: null,
    publicCheck: { at: iso, ok: true, status: 200, error: null },
    webhookPathCheck: { at: iso, ok: true, status: 401, error: null },
    appProtectedCheck: { at: iso, ok: true, status: 302, location: "https://polygonparadise.cloudflareaccess.com/cdn-cgi/access/login", error: null },
    selfCheckNonce: null,
  };
}

/**
 * Before reading what the dashboard shows (§9.3): the background sender's lease held at the test clock (a round
 * releases it) and remote access seeded as working (the monitor rewrites it every round).
 */
async function readyToRead(): Promise<void> {
  expect((await acquireLease(WORKER_ID, clock.now())).acquired).toBe(true);
  await setState("tunnel.status", workingRemoteAccess(clock.now()));
  expect((await getWorkerStatus(clock.now())).running).toBe(true);
}

async function postEvent(data: Record<string, unknown>) {
  const res = await handleEventWebhook(fake.signedEventRequest(EVENTS_URL, data), { now: clock.now() });
  expect(res.status).toBe(200);
}

type Viewer = Parameters<typeof loadDashboard>[0];
type DashboardView = Awaited<ReturnType<typeof loadDashboard>>;

/** The dashboard's attention keys in display order, without the machine-dependent "disk-low" (§9.3). */
function attentionKeys(view: DashboardView): string[] {
  return view.attention.map((i) => i.key).filter((k) => k !== "disk-low");
}

/** The dashboard as `viewer` sees it at the test clock; every source must load (no "[dashboard] <key>: …" line). */
async function dashboardFor(viewer: Viewer): Promise<DashboardView> {
  const logged = vi.spyOn(console, "error");
  try {
    const view = await loadDashboard(viewer, clock.now());
    expect(logged.mock.calls.map((c) => String(c[0])).filter((line) => line.startsWith("[dashboard]"))).toEqual([]);
    return view;
  } finally {
    logged.mockRestore();
  }
}

type Actor = { id: number; name: string; role: "OWNER" | "MEMBER" };
let owner: Actor;
let ali: Actor;
/** The signed-in Arslan and Ali, as the dashboard page gets them. */
let arslanSession: Viewer;
let aliSession: Viewer;
let claude: FakeClaudeConnection;

beforeAll(async () => {
  const arslan = await dbWrite((c) =>
    c.user.create({ data: { email: "arslan@polygonparadise.test", name: "Arslan", role: "OWNER", timeZone: TZ, senderDisplayName: "Arslan from Polygon Paradise" } }),
  );
  const aliUser = await dbWrite((c) =>
    c.user.create({ data: { email: "ali.khan@polygonparadise.test", name: "Ali", role: "MEMBER", timeZone: TZ, senderDisplayName: "Ali from Polygon Paradise" } }),
  );
  await dbWrite(async (c) => {
    await c.user.update({ where: { id: arslan.id }, data: { replyInbox: "arslan.owner@example.org", signature: "Arslan\nPolygon Paradise" } });
    await c.user.update({ where: { id: aliUser.id }, data: { replyInbox: "ali.inbox@example.org", signature: "Ali Khan\nPolygon Paradise" } });
  });
  owner = { id: arslan.id, name: arslan.name, role: "OWNER" };
  ali = { id: aliUser.id, name: aliUser.name, role: "MEMBER" };
  arslanSession = { id: arslan.id, email: arslan.email, name: arslan.name, role: "OWNER", timeZone: TZ, sessionId: 1 };
  aliSession = { id: aliUser.id, email: aliUser.email, name: aliUser.name, role: "MEMBER", timeZone: TZ, sessionId: 2 };
  await setSettingValue("practice.copy", false);
  // The daily backup and clean-up aren't part of this test (and no backup is made: the dashboard says "backup-never").
  for (const name of ["backup.daily", "cleanup.daily"]) await periodic.recordTaskSuccess(name, clock.now());

  // Sending addresses on the fake's domain (the dry run's From line, and where replies to it are addressed).
  fake.setDns("all");
  await setSenderLocalPart(owner, ali.id, "ali");
  await setSenderLocalPart(owner, owner.id, "arslan");
  await dbWrite((c) => c.job.deleteMany({ where: { status: "QUEUED" } }));
  claude = await connectFakeClaude();
});

afterAll(async () => {
  if (previousPub === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previousPub;
  await claude?.stop();
  await mg.stop();
  await db.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Part A: SPEC's definition of done in dry-run mode, with the dashboard's numbers", () => {
  const A = { companies: {} as Record<string, number>, people: {} as Record<string, number>, jobId: 0, drafts: {} as Record<string, number>, campaignId: 0 };
  const lines = {} as Record<string, string>;
  /** Butikk AS's own first email (Review › Edit this person's email). */
  const BUTIKK_SENTENCE = "Would it help if I sent two or three troll figures close to what you sell in Oslo?";
  const MASTER_SENTENCE = "Would it help if I sent two or three examples close to what you make?";
  let worker: Worker;
  let annaReplyId = 0;

  it("1. imports m5-companies.csv through the pipeline: 5 companies, each Not contacted, none without an email", async () => {
    const bytes = fs.readFileSync(path.resolve("tests/fixtures/import/m5-companies.csv"));
    const parsed = parseUploadedFile(new Uint8Array(bytes), "m5-companies.csv");
    const sessionId = await createImportSession({ userId: ali.id, fileName: "m5-companies.csv", parsed });
    const mapping = suggestMapping(parsed.table.headers, parsed.table.rows.map((r) => r.cells)).map((s) => s.mapping);
    expect(mapping.map((m) => m.target)).toEqual(["company", "website", "country", "instagram", "name", "email", "role"]);
    await dbWrite((c) => c.importSession.update({ where: { id: sessionId }, data: { mapping, options: DEFAULT_IMPORT_OPTIONS, status: "MAPPED" } }));
    const session = (await loadStoredSession(sessionId))!;
    const view = buildCheckView(await analyzeImport(sessionId, session.mapping!, session.options, { fresh: true }), session.options, false);
    expect(view.summary).toMatchObject({ newCompanies: 5, problemRows: 0 });

    // "Import 5 companies": the commit task runs in the background sender's main lane.
    await enqueueJob({ type: "import.commit", payload: { sessionId }, dedupeKey: `import:${sessionId}`, createdById: ali.id, maxAttempts: 3 });
    worker = newWorker();
    expect(await worker.tickOnce()).toBe(0);
    expect((await db.importSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe("DONE");
    const companies = await db.company.findMany({ where: { deletedAt: null }, include: { people: true }, orderBy: { id: "asc" } });
    expect(companies.map((c) => [c.name, c.status, c.people.map((p) => p.emailNorm)])).toEqual([
      ["Figuren Werkstatt", "NOT_CONTACTED", ["anna@figuren-werkstatt.example"]],
      ["Butikk AS", "NOT_CONTACTED", ["ola@butikk.example"]],
      ["Grid Shop", "NOT_CONTACTED", ["info@gridshop.example"]],
      ["Parked Co", "NOT_CONTACTED", ["pat@parked-domain.example"]],
      ["Insta Creator", "NOT_CONTACTED", ["ivy@insta-creator.example"]],
    ]);
    for (const c of companies) {
      A.companies[c.name] = c.id;
      A.people[c.name] = c.people[0]!.id;
    }

    // The Companies tile's sources.
    await readyToRead();
    const now = clock.now();
    const pipeline = await loadPipeline(now);
    expect(pipeline.counts.all).toBe(5);
    expect(pipeline.counts.byStatus).toEqual({ NOT_CONTACTED: 5, CONTACTED: 0, REPLIED: 0, CLIENT: 0, NOT_INTERESTED: 0, DO_NOT_CONTACT: 0 });
    expect(replyRateText(pipeline.replyRate)).toBe("No companies emailed yet.");
    expect(replyRate30Text(pipeline.replyRate)).toBeNull();
    // "Missing email": every company has an address.
    expect((await getContactsSidebar()).missingEmailCount).toBe(0);

    // The dashboard itself: no "missing-emails" item, and the Companies tile shows the same numbers.
    const dashboard = await dashboardFor(arslanSession);
    expect(attentionKeys(dashboard)).not.toContain("missing-emails");
    expect(dashboard.pipeline).toEqual(pipeline);
  });

  it("2. Ali's drafting run for all five: 3 lines ready, 1 parked site, Instagram skipped; reviewed down to nothing waiting", async () => {
    const all = Object.values(A.companies);
    const started = await startDraftRun(ali, { companyIds: all }, { redraft: false, source: "contacts", now: clock.now() });
    expect(started.count).toBe(4);
    A.jobId = started.jobId;
    // The AI lane runs until done (each round runs every lane until it is idle).
    for (let i = 0; i < 5 && (await db.job.findUniqueOrThrow({ where: { id: A.jobId } })).status !== "DONE"; i++) {
      expect(await worker.tickOnce()).toBe(0);
    }
    expect((await db.job.findUniqueOrThrow({ where: { id: A.jobId } })).status).toBe("DONE");

    const drafts = await db.aiDraft.findMany({ where: { jobId: A.jobId }, orderBy: { id: "asc" } });
    const byCompany = new Map(drafts.map((d) => [d.companyId, d]));
    for (const name of ["Figuren Werkstatt", "Butikk AS", "Grid Shop"]) {
      const d = byCompany.get(A.companies[name]!)!;
      expect(d.status).toBe("READY");
      A.drafts[name] = d.id;
      lines[name] = d.line!;
    }
    expect(byCompany.get(A.companies["Parked Co"]!)).toMatchObject({ status: "NO_LINE", reasonIfNull: "parked", calls: 0 });
    expect(byCompany.has(A.companies["Insta Creator"]!)).toBe(false);
    expect(claude.fake.requests.filter((r) => r.path === "/v1/messages")).toHaveLength(3);

    // "3 AI lines to review" (the ai-lines item, for both users).
    await readyToRead();
    expect(await aiQueueCounts()).toEqual({ waiting: 3 });
    for (const viewer of [arslanSession, aliSession]) {
      const item = (await dashboardFor(viewer)).attention.find((i) => i.key === "ai-lines");
      expect(item, viewer.name).toMatchObject({ text: "3 AI lines to review", link: { href: "/ai-lines", label: "Review" } });
    }

    // Approve Figuren's, edit then approve Butikk's, reject Grid's + undo within 60 s + approve.
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
    // The item is gone.
    await readyToRead();
    expect(await aiQueueCounts()).toEqual({ waiting: 0 });
    for (const viewer of [arslanSession, aliSession]) {
      expect(attentionKeys(await dashboardFor(viewer)), viewer.name).not.toContain("ai-lines");
    }
  });

  it("3. (practice copy) Ali's dry run with 2 follow-ups: 3 emails each in Review, nothing missing, one email edited for Butikk AS; launched", async () => {
    await setSettingValue("practice.copy", true);
    await setSetting("sending.mode", "DRY_RUN", owner.id);
    const d = await draft.createDraft(ali, { companyIds: Object.values(A.companies), timeZone: TZ, now: clock.now() });
    A.campaignId = d.id;
    await draft.renameDraft(ali, d.id, "Figures with AI lines");
    const [s0, s1, s2] = MASTER_SEQUENCE.steps;
    await draft.saveDraftSteps(ali, d.id, [
      { step: 0, enabled: true, subject: s0!.subject, body: s0!.body, delayDays: 0 },
      { step: 1, enabled: true, subject: null, body: s1!.body, delayDays: 1 },
      { step: 2, enabled: true, subject: null, body: s2!.body, delayDays: 2 },
    ]);
    // Schedule: "Treat follow-up days as minutes" (the dry-run helper); sending hours are ignored at launch.
    await draft.setDraftSchedule(ali, d.id, { daysAsMinutes: true }, { now: clock.now() });

    // Review: everyone gets the first email and both follow-ups, and no email is missing details
    // ("No emails are missing details. You can go on to Schedule.").
    const review = await draft.loadReviewPage(d.id, { now: clock.now() });
    expect(review.steps).toEqual([0, 1, 2]);
    expect(review.counts).toMatchObject({ all: 5, missing: 0, edited: 0, excluded: 0 });
    expect(review.missingEmails).toBe(0);
    expect((await draft.loadReviewPage(d.id, { filter: "missing", now: clock.now() })).items).toEqual([]);
    for (const name of Object.keys(A.people)) {
      const detail = await draft.loadReviewDetail(d.id, A.people[name]!);
      expect(detail.renderError, name).toBeNull();
      expect(detail.emails.map((e) => e.step), name).toEqual([0, 1, 2]);
    }

    // Edit Butikk AS's first email for that person only.
    const butikk = review.items.find((i) => i.companyName === "Butikk AS")!;
    expect(s0!.body).toContain(MASTER_SENTENCE);
    const edited = await draft.editDraftRecipientEmail(ali, d.id, butikk.recipientId!, 0, { body: s0!.body.replace(MASTER_SENTENCE, BUTIKK_SENTENCE) });
    expect(edited.edited).toBe(true);
    const editedPage = await draft.loadReviewPage(d.id, { filter: "edited", now: clock.now() });
    expect(editedPage.counts.edited).toBe(1);
    expect(editedPage.items.map((i) => i.companyName)).toEqual(["Butikk AS"]);

    const launched = await draft.launchDraft(ali, d.id, { now: clock.now(), ignoreWindow: true });
    expect(launched).toMatchObject({ status: "RUNNING", mode: "DRY_RUN", queued: 5 });
  });

  it("4. one round sends the 5 first emails to the outbox: the approved lines follow the greeting, Butikk's own text; the numbers", async () => {
    expect(await worker.tickOnce()).toBe(0);
    const firsts = await db.outboundEmail.findMany({ where: { campaignId: A.campaignId, step: 0 }, orderBy: { id: "asc" } });
    expect(firsts.map((e) => [e.status, e.mode])).toEqual(Array(5).fill(["SENT", "DRY_RUN"]));
    const textOf = (name: string) => firsts.find((e) => e.companyId === A.companies[name])!.text.split("\n");
    for (const name of ["Figuren Werkstatt", "Butikk AS", "Grid Shop"]) {
      const text = textOf(name);
      expect(text[0], name).toMatch(/^(Hi|Hello) \S.*,$/);
      expect(text.slice(1, 4), name).toEqual(["", lines[name], ""]);
      expect(text[4], name).toMatch(/^I'm Ali from Polygon Paradise\./);
    }
    // No empty line where Parked's and Insta's line would be.
    for (const name of ["Parked Co", "Insta Creator"]) {
      const text = textOf(name);
      expect(text[0], name).toMatch(/^(Hi|Hello) \S.*,$/);
      expect(text[1], name).toBe("");
      expect(text[2], name).toMatch(/^I'm Ali from Polygon Paradise\./);
    }
    // Butikk AS got its own version; everyone else the campaign's.
    expect(textOf("Butikk AS")).toContain(BUTIKK_SENTENCE);
    expect(textOf("Butikk AS")).not.toContain(MASTER_SENTENCE);
    for (const name of ["Figuren Werkstatt", "Grid Shop", "Parked Co", "Insta Creator"]) expect(textOf(name), name).toContain(MASTER_SENTENCE);

    await readyToRead();
    const now = clock.now();
    // Active campaigns: the progress line of the Campaigns list.
    const running = await listCampaigns("running");
    const item = running.items.find((c) => c.id === A.campaignId)!;
    expect(toCampaignListView(item, TZ, now).progressText).toBe("First email 5 of 5 sent · 2 follow-ups");
    // Today: the practice copy's dry runs count toward the limit.
    const cap = await getTodayCap(now, { practiceCopy: true });
    expect(cap.testSends).toBe(0);
    expect(cap.used).toBe(5 + cap.testSends);
    // Companies: a practice-copy dry run is real contact.
    const pipeline = await loadPipeline(now);
    expect(pipeline.counts.byStatus).toMatchObject({ NOT_CONTACTED: 0, CONTACTED: 5 });
    expect(replyRateText(pipeline.replyRate)).toBe("Reply rate: 0% (0 of 5 companies you emailed replied)");
  });

  it("5. a signed bounce (Parked Co), a signed unsubscribe (Grid Shop) and a signed reply from Anna are filed by the event lane", async () => {
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
    annaReplyId = posted.id!;
    // The event lane: Mailgun's events, then the stored reply (processPendingInbound).
    expect(await worker.tickOnce()).toBe(0);

    const recipient = (name: string) => db.campaignRecipient.findFirstOrThrow({ where: { campaignId: A.campaignId, companyId: A.companies[name]! } });
    expect(await recipient("Parked Co")).toMatchObject({ state: "STOPPED", stopReason: "bounced" });
    expect(await recipient("Grid Shop")).toMatchObject({ state: "STOPPED", stopReason: "unsubscribed" });
    expect(await recipient("Figuren Werkstatt")).toMatchObject({ state: "STOPPED", stopReason: "replied" });
    expect(await db.inboundMessage.findUniqueOrThrow({ where: { id: annaReplyId } })).toMatchObject({ kind: "REPLY", assigneeId: ali.id, changesStatus: true });
  });

  it("6. both follow-ups go only to Butikk AS and Insta Creator (2 + 2), and the campaign finishes", async () => {
    // "Days as minutes": follow-up 1 a minute after the first email, follow-up 2 two minutes after that.
    clock.advance(MIN);
    expect(await worker.tickOnce()).toBe(0);
    clock.advance(2 * MIN);
    expect(await worker.tickOnce()).toBe(0);
    const sent = await db.outboundEmail.findMany({ where: { campaignId: A.campaignId, status: "SENT" } });
    const to = (step: number) => sent.filter((e) => e.step === step).map((e) => e.toNorm).sort();
    expect(to(0)).toHaveLength(5);
    expect(to(1)).toEqual(["ivy@insta-creator.example", "ola@butikk.example"]);
    expect(to(2)).toEqual(["ivy@insta-creator.example", "ola@butikk.example"]);
    // The finish check ran in the round.
    expect((await db.campaign.findUniqueOrThrow({ where: { id: A.campaignId } })).status).toBe("FINISHED");
  });

  it("7. statuses, stop rules, the notifications each user got, and every dashboard number; Answered clears the reply", async () => {
    // Companies and people.
    const statuses = await db.company.findMany({ where: { id: { in: Object.values(A.companies) } }, orderBy: { id: "asc" }, select: { name: true, status: true } });
    expect(statuses.map((c) => [c.name, c.status])).toEqual([
      ["Figuren Werkstatt", "REPLIED"],
      ["Butikk AS", "CONTACTED"],
      ["Grid Shop", "CONTACTED"],
      ["Parked Co", "CONTACTED"],
      ["Insta Creator", "CONTACTED"],
    ]);
    const person = (name: string) => db.person.findUniqueOrThrow({ where: { id: A.people[name]! } });
    expect((await person("Parked Co")).bouncedAt).not.toBeNull();
    expect((await person("Grid Shop")).unsubscribedAt).not.toBeNull();
    expect((await person("Figuren Werkstatt")).repliedAt).not.toBeNull();
    for (const name of ["Butikk AS", "Insta Creator"]) {
      expect(await person(name), name).toMatchObject({ bouncedAt: null, unsubscribedAt: null, repliedAt: null });
    }
    // The do-not-email list has the bounce and the unsubscribe (and nothing for the reply).
    const sups = await db.suppression.findMany({ orderBy: { emailNorm: "asc" }, select: { emailNorm: true, reason: true } });
    expect(sups.map((s) => [s.emailNorm, s.reason])).toEqual([
      ["info@gridshop.example", "UNSUBSCRIBED"],
      ["pat@parked-domain.example", "BOUNCED"],
    ]);

    // Recipients and the outbox: 9 emails (5 + 2 + 2), nothing after the first email to pat, info or anna.
    const recipients = await db.campaignRecipient.findMany({ where: { campaignId: A.campaignId }, orderBy: { id: "asc" } });
    expect(recipients.map((r) => [r.emailNorm, r.state, r.stopReason])).toEqual([
      ["anna@figuren-werkstatt.example", "STOPPED", "replied"],
      ["ola@butikk.example", "FINISHED", null],
      ["info@gridshop.example", "STOPPED", "unsubscribed"],
      ["pat@parked-domain.example", "STOPPED", "bounced"],
      ["ivy@insta-creator.example", "FINISHED", null],
    ]);
    const outbox = await db.outboundEmail.findMany({ where: { campaignId: A.campaignId, status: "SENT" } });
    expect(outbox).toHaveLength(9);
    expect(outbox.every((e) => e.mode === "DRY_RUN")).toBe(true);
    const stopped = ["pat@parked-domain.example", "info@gridshop.example", "anna@figuren-werkstatt.example"];
    expect(outbox.filter((e) => stopped.includes(e.toNorm) && e.step > 0)).toEqual([]);

    // Notifications, the exact multiset per user (M4-DESIGN §5.1, M5-DESIGN §3.10): the sender hears, the Owner doesn't.
    const notes = async (userId: number) => (await db.notification.findMany({ where: { userId }, select: { type: true } })).map((n) => n.type).sort();
    expect(await notes(ali.id)).toEqual(["ai.draftsReady", "campaign.finished", "reply.received"]);
    expect(await notes(owner.id)).toEqual([]);

    // The dashboard's tiles, from their sources.
    await readyToRead();
    const now = clock.now();
    const pipeline = await loadPipeline(now);
    expect(pipeline.counts).toEqual({ all: 5, byStatus: { NOT_CONTACTED: 0, CONTACTED: 4, REPLIED: 1, CLIENT: 0, NOT_INTERESTED: 0, DO_NOT_CONTACT: 0 } });
    expect(replyRateText(pipeline.replyRate)).toBe("Reply rate: 20% (1 of 5 companies you emailed replied)");
    expect(replyRate30Text(pipeline.replyRate)).toBe("Last 30 days: 20% (1 of 5)");

    // Today: 9 counted sends of 50; the practice copy's ramp at its first step (9 of 50 is below half).
    const cap = await getTodayCap(now, { practiceCopy: true });
    expect(cap.used).toBe(9 + cap.testSends);
    expect(cap.cap).toBe(50);
    const progress = await loadWarmupProgress(now);
    expect(progress.step).toBe(0);
    const today = await loadWarmupToday(now);
    expect(today).toMatchObject({ used: 9 + cap.testSends, cap: 50 });
    expect(warmupLine(0, progress.table, today)).toBe(
      "Warm-up step 1 of 20: 50 a day. It goes up to 59 after a weekday with at least half the limit used and healthy numbers.",
    );

    // Domain health: 1 bounce and no complaint in a sample of 9.
    const health = await loadHealthView(TZ, now);
    expect(health.counts).toMatchObject({ bounces: 1, bounceSample: 9, complaints: 0, complaintSample: 9 });

    // No campaign running or scheduled any more.
    expect((await listCampaigns("running")).total).toBe(0);
    expect((await listCampaigns("scheduled")).total).toBe(0);

    // Recent team activity: the finished campaign is there, no per-email row.
    const activity = await recentTeamActivity(now, 8);
    expect(activity.length).toBeGreaterThan(0);
    expect(activity.length).toBeLessThanOrEqual(8);
    expect(activity.some((a) => a.summary.startsWith("Figures with AI lines finished"))).toBe(true);
    const types = await db.activityLog.findMany({ where: { id: { in: activity.map((a) => a.id) } }, select: { type: true } });
    expect(types.map((r) => r.type)).toContain("campaign.finished");
    expect(types.filter((r) => r.type.startsWith("email."))).toEqual([]);

    // Dry runs and test mode: hidden in the practice copy (its dry runs are the real thing).
    expect(await loadDryRunSummary(now)).toBeNull();

    // Replies waiting for an answer: Ali's one, the same line for both viewers' points of view.
    const byUser = await waitingReplyCountsByUser();
    expect(waitingRepliesLine(byUser, owner.id)).toBe("Replies waiting for an answer: Ali 1");
    expect(waitingRepliesLine(byUser, ali.id)).toBe("Replies waiting for an answer: You 1");
    const aliViewer = { id: ali.id, role: "MEMBER" as const, timeZone: TZ };
    const aliList = await listWaitingReplies(aliViewer, { scope: "mine", take: 5, now });
    expect(aliList.rows.map((r) => r.id)).toEqual([annaReplyId]);
    expect(aliList.total).toBe(1);
    expect((await listWaitingReplies({ id: owner.id, role: "OWNER", timeZone: TZ }, { scope: "mine", take: 5, now })).total).toBe(0);

    // The same numbers through the dashboard, for Arslan and for Ali; the attention list has the waiting reply and the
    // missing backup (none was made in this story), nothing else.
    expect(DASHBOARD_TEXTS.campaigns.empty).toBe("No campaigns are sending right now.");
    for (const viewer of [arslanSession, aliSession]) {
      const view = await dashboardFor(viewer);
      expect(view.practiceCopy, viewer.name).toBe(true);
      expect(view.pipeline, viewer.name).toEqual(pipeline);
      expect(view.today, viewer.name).toEqual({
        used: 9 + cap.testSends,
        cap: 50,
        percent: 18,
        lines: [warmupLine(0, progress.table, today)],
        notConfigured: null,
      });
      expect(view.health, viewer.name).toMatchObject({ empty: null, bounce: { count: 1 }, complaint: { count: 0 } });
      expect(view.campaigns, viewer.name).toEqual({ items: [], more: 0, moreHref: "/campaigns" });
      expect(view.dryRun, viewer.name).toBeNull();
      const mine = viewer.id === ali.id;
      expect(view.replies, viewer.name).toMatchObject({ total: mine ? 1 : 0 });
      expect(view.replies!.rows.map((r) => r.id), viewer.name).toEqual(mine ? [annaReplyId] : []);
      expect(attentionKeys(view), viewer.name).toEqual(["replies-waiting", "backup-never"]);
      expect(view.attention[0]!.text, viewer.name).toBe(waitingRepliesLine(byUser, viewer.id));
    }

    // Ali clicks Answered on Anna's reply: nothing waits any more.
    expect((await markReplyAnswered(ali, annaReplyId, { now })).message).toBe("Marked as answered.");
    await readyToRead();
    expect(waitingRepliesLine(await waitingReplyCountsByUser(), ali.id)).toBeNull();
    expect(waitingRepliesLine(await waitingReplyCountsByUser(), owner.id)).toBeNull();
    const after = await listWaitingReplies(aliViewer, { scope: "mine", take: 5, now: clock.now() });
    expect(after.rows).toEqual([]);
    expect(after.total).toBe(0);
    for (const viewer of [arslanSession, aliSession]) {
      const view = await dashboardFor(viewer);
      expect(attentionKeys(view), viewer.name).toEqual(["backup-never"]);
      expect(view.replies, viewer.name).toEqual({ rows: [], total: 0 });
    }
    expect(errors).toEqual([]);
  });
});
