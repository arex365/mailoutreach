import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { makeCompany, setSettingValue } from "../campaigns/seed";
import { checklistRows } from "../sending-m3/helpers";
import type { JobRegistry } from "../../../worker/jobs";

/**
 * Milestone 6 end to end, Part B (M6-DESIGN §9.3): going live against the fake Mailgun, on real-data settings, with
 * nothing mocked inside the app but the signed-in user of the server actions. Mailgun is the local fake server
 * (tests/fake-mailgun, on the test clock), the app's public address is answered in-process, and the background sender
 * runs its real rounds on a fixed clock that starts on Wednesday 23 Sep 2026 at 10:00 in Berlin. Nothing reaches the
 * network.
 *
 *   Set-up: Mailgun connected (send.example.com), the Domain checklist green and checked at 10:00, the reply test
 *     passed with Setup A, Arslan's sending address with a working route, the test list with Tess ("Test mailboxes"),
 *     prospects Firma GmbH (Anna) and Studio Nord (Ola) checked by the fake 10 days ago, Ali and a switched-off Bo, and
 *     a backup made first. In Dry run mode: the dry run "Rehearsal" (2 outbox emails) and the draft "Made early".
 *   1. Before go-live the only blocker is the live test; the Owner's switch is refused with it.
 *   2. Mailgun's test mode, then a live campaign to the test list ("Test run", launched before go-live): two messages
 *      to Tess, the company isn't emailed; a delivered event clears the last blocker.
 *   3. A live draft made before go-live leaves Anna out; the Mailgun client's guard refuses her too.
 *   4. Go live at 10:30 (a Member is refused): the settings, the activity, everyone's notification, the warm-up, the
 *      label; a second click changes nothing.
 *   5. The old draft, confirmed, emails Anna for real: Firma is Contacted and reserved, and the 30-day rule holds.
 *   6. The day's numbers: today's limit and the warm-up line, the pipeline, the backup, health counted from go-live.
 *   7. A day later "Test run" still only reaches Tess and stays not "emailed"; "Rehearsal" stays in the outbox.
 *   8. Test mode stays test-list only after go-live.
 *   9. The draft made before go-live needs the tick (G11).
 *  10. Tess taken off the test list: "Test run" (launched before go-live) skips her.
 *  11. Across the flip no dry run ever reached Mailgun, and every test-mode message stayed in test mode.
 *
 * Every server action runs with `Date` faked to the test clock (`atClock`), because the actions read `new Date()`
 * while the lease, the checklist's check time and the expected `goLiveAt` follow the fixed clock. Before every read of
 * the dashboard's numbers and before going live the background sender's lease is held at the test clock and remote
 * access is seeded as working (`readyToRead`). Step 6 also reads the dashboard itself (`loadDashboard`, the page's own
 * loader) for Arslan and Ali (M6-DESIGN §9.3, the "P10" lines), leaving out the machine-dependent "disk-low" item.
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

// The worker's start-up reads <database folder>/RESTORED; data/test is shared by all test files, so use a folder of our own.
const created = await createTestDb("m6-go-live");
const dir = path.join(path.dirname(created.file), `m6-go-live-${process.pid}-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
/** Also the name of this database's backups subfolder (backups\<name>), which afterAll removes. */
const dbName = `m6-go-live-${process.pid}`;
const dbFile = path.join(dir, `${dbName}.db`);
fs.copyFileSync(created.file, dbFile);
created.cleanup();
process.env.DATABASE_URL = "file:" + dbFile.replace(/\\/g, "/");

const D = "send.example.com";
const PUB = "http://127.0.0.1:3100";
const EVENTS_URL = `${PUB}/api/webhooks/mailgun/events`;
const TZ = "Europe/Berlin";
const TESS = "tess@test-mailbox.example";
const ANNA = "anna@firma.example";
const OLA = "ola@nord.example";
/** Every worker of this file uses the same id, so holding the lease for a read never blocks the next round. */
const WORKER_ID = "m6-go-live";
const SECOND = 1_000;
const DAY = 86_400_000;
/** Wednesday 23 Sep 2026, 10:00 in Berlin. */
const WEDNESDAY_10_BERLIN = new Date("2026-09-23T08:00:00.000Z");
/** Wednesday 23 Sep 2026, 10:30 in Berlin: the moment of going live. */
const WEDNESDAY_1030_BERLIN = new Date("2026-09-23T08:30:00.000Z");

const SENTENCES = {
  liveTestNone: "Send one live campaign to your test list first, and check that it arrived (Going-live guide, step 3).",
  liveTestSent: "The live test email hasn't been confirmed as delivered yet. Wait a few minutes, then open this page again.",
  notOnTestListLive: "Not on the test list (until you go live, only test-list addresses get real email)",
  notOnTestListTest: "Not on the test list (Test mode only emails your test list)",
  wentLive: "You're live. New campaigns now email everyone eligible, and warm-up has started.",
  alreadyLive: "You're already live.",
  ownerOnly: "Only the Owner can do this.",
  madeBeforeGoLive: "Tick the box to confirm that this draft now sends real email.",
  firstLine: "Warm-up step 1 of 20: 50 a day. It goes up to 59 after a weekday with at least half the limit used and healthy numbers.",
} as const;

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
const { getSetting, getSettings } = await import("@/server/settings");
const { setState } = await import("@/server/state");
const { readTyped } = await import("@/server/state-typed");
const { parsePauseState, parseWarmupState } = await import("@/core/system-state-parse");
const { STATE_KEYS } = await import("@/core/system-state");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { getWorkerStatus } = await import("@/server/worker-status");
const { getSendingLabel } = await import("@/server/sending-state");
const { sendingLabel } = await import("@/core/sending/label");
const { checkSendGuard } = await import("@/server/mailgun/send-guard");
const { GET: healthGET } = await import("@/app/api/health/route");
const { handleEventWebhook } = await import("@/server/services/mail-events/webhook");
const { setSenderLocalPart } = await import("@/server/services/sender-addresses");
const { saveTestList } = await import("@/server/services/reply-test");
const { loadGoLiveView } = await import("@/server/services/go-live");
const draft = await import("@/server/services/campaigns/draft");
const { loadAudienceSnapshot, setPersonTicked } = await import("@/server/services/campaigns/audience");
const { companySequences } = await import("@/server/services/campaigns/queries");
const { CampaignError } = await import("@/server/services/campaigns/errors");
const { companySequenceLabel } = await import("@/components/campaigns/format");
const { MASTER_SEQUENCE } = await import("@/core/templates/defaults");
const { getTodayCap } = await import("@/server/services/sending/usage");
const { loadWarmupProgress, loadWarmupToday } = await import("@/server/services/sending/warmup-days");
const { warmupLine } = await import("@/core/sending/warmup-line");
const { loadHealthView } = await import("@/server/services/mail-events/deliverability");
const { loadPipeline } = await import("@/server/services/dashboard/pipeline");
const { replyRateText } = await import("@/core/dashboard/pipeline");
const { backupFolder, backupStatus, runBackup } = await import("@/server/services/backups");
const { goLiveAction, setSendingModeAction } = await import("@/app/(app)/settings/sending/actions");
const { loadDashboard } = await import("@/app/(app)/dashboard/load");
const { ATTENTION_TEXTS } = await import("@/core/dashboard/attention");
const { BackgroundWorker } = await import("../../../worker/main");
const { createJobRegistry } = await import("../../../worker/jobs");
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

/**
 * The real registry on the test clock, except the Domain checklist's check (it would ask DNS), which just records
 * itself as done: the checklist rows of this test are the ones seeded at 10:00.
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
const worker = new BackgroundWorker({ workerId: WORKER_ID, now: clock.now, mailgun, random: () => 0, fetchImpl: appFetch, logger: quiet, registry });

/** Runs a server action with `Date` faked to the test clock (the actions read `new Date()`). */
async function atClock<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock.now());
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

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
 * Before going live and before reading what the dashboard shows (§9.3): the background sender's lease held at the test
 * clock (a round releases it; the go-live switch needs a running background sender) and remote access seeded as
 * working (the monitor rewrites it every round).
 */
async function readyToRead(): Promise<void> {
  expect((await acquireLease(WORKER_ID, clock.now())).acquired).toBe(true);
  await setState(STATE_KEYS.tunnel, workingRemoteAccess(clock.now()));
  expect((await getWorkerStatus(clock.now())).running).toBe(true);
}

async function pacer() {
  const row = await db.systemState.findUnique({ where: { key: STATE_KEYS.pacer } });
  return row?.value as { nextSendAt?: string | null; waiting?: { until: string | null } | null } | undefined;
}

/**
 * Worker rounds until `done`, jumping the clock to the next moment something can go: the pacer's next slot or wait,
 * or the next due email of `campaignIds` (never backwards).
 */
async function tickUntil(campaignIds: number[], done: () => boolean | Promise<boolean>, rounds = 20): Promise<void> {
  for (let round = 0; round < rounds && !(await done()); round++) {
    const p = await pacer();
    const due = await db.outboundEmail.findFirst({
      where: { campaignId: { in: campaignIds }, status: "QUEUED" },
      orderBy: { dueAt: "asc" },
      select: { dueAt: true },
    });
    const next = Math.max(Date.parse(p?.nextSendAt ?? "") || 0, Date.parse(p?.waiting?.until ?? "") || 0, due?.dueAt.getTime() ?? 0);
    if (next > clock.now().getTime()) clock.set(new Date(next + SECOND));
    expect(await worker.tickOnce()).toBe(0);
  }
  expect(await done()).toBe(true);
}

/** The fake's messages for one campaign (by v:campaign_id). */
function campaignMessages(campaignId: number) {
  return fake.messages.filter((m) => m.fields["v:campaign_id"]?.[0] === String(campaignId));
}

function messagesTo(address: string) {
  return fake.messages.filter((m) => m.fields.to?.[0] === address);
}

async function postEvent(data: Record<string, unknown>) {
  const res = await handleEventWebhook(fake.signedEventRequest(EVENTS_URL, data), { now: clock.now() });
  expect(res.status).toBe(200);
}

/** The first email step of the master sequence, and follow-ups after `delays` days each (days after the step before). */
function stepsWith(delays: number[]) {
  const [s0, ...rest] = MASTER_SEQUENCE.steps;
  return [
    { step: 0, enabled: true, subject: s0!.subject, body: s0!.body, delayDays: 0 },
    ...delays.map((delayDays, i) => ({ step: i + 1, enabled: true, subject: null, body: rest[i]!.body, delayDays })),
  ];
}

/** A draft by `actor` with these companies (created at the test clock), in today's sending mode. */
async function newDraft(actor: Actor, name: string, companyIds: number[], delays: number[] = []): Promise<number> {
  const d = await draft.createDraft(actor, { companyIds, name, timeZone: TZ, now: clock.now() });
  await draft.saveDraftSteps(actor, d.id, stepsWith(delays));
  return d.id;
}

/** One person of a draft's audience as the Audience step shows them. */
async function audiencePerson(campaignId: number, companyId: number) {
  const snap = await loadAudienceSnapshot(campaignId, { now: clock.now() });
  const company = snap.companies.find((c) => c.companyId === companyId)!;
  return { company, person: company.people[0]! };
}

async function activities(type: string) {
  return db.activityLog.findMany({ where: { type }, orderBy: { id: "asc" } });
}

type DashboardView = Awaited<ReturnType<typeof loadDashboard>>;

/** The dashboard's attention keys in display order, without the machine-dependent "disk-low" (§9.3). */
function attentionKeys(view: DashboardView): string[] {
  return view.attention.map((i) => i.key).filter((k) => k !== "disk-low");
}

/** The dashboard as `viewer` sees it at the test clock; every source must load (no "[dashboard] <key>: …" line). */
async function dashboardFor(viewer: TestUser): Promise<DashboardView> {
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
let bo: Actor;
let ownerUser: TestUser;
let aliUser: TestUser;
let backupDir = "";
const B = {
  testMailboxes: 0,
  tess: 0,
  firma: 0,
  anna: 0,
  nord: 0,
  ola: 0,
  rehearsal: 0,
  madeEarly: 0,
  mailgunTest: 0,
  testRun: 0,
  tooEarly: 0,
};

beforeAll(async () => {
  const users = await dbWrite(async (c) => [
    await c.user.create({
      data: { email: "arslan@polygonparadise.test", name: "Arslan", role: "OWNER", timeZone: TZ, senderDisplayName: "Arslan from Polygon Paradise" },
    }),
    await c.user.create({ data: { email: "ali.khan@polygonparadise.test", name: "Ali", role: "MEMBER", timeZone: TZ, senderDisplayName: "Ali from Polygon Paradise" } }),
    await c.user.create({ data: { email: "bo@polygonparadise.test", name: "Bo", role: "MEMBER", timeZone: TZ, active: false } }),
  ]);
  const [arslan, aliRow, boRow] = users;
  await dbWrite((c) => c.user.update({ where: { id: arslan!.id }, data: { replyInbox: "arslan.owner@example.org", signature: "Arslan\nPolygon Paradise" } }));
  owner = { id: arslan!.id, name: "Arslan", role: "OWNER" };
  ali = { id: aliRow!.id, name: "Ali", role: "MEMBER" };
  bo = { id: boRow!.id, name: "Bo", role: "MEMBER" };
  ownerUser = { id: owner.id, email: "arslan@polygonparadise.test", name: "Arslan", role: "OWNER", timeZone: TZ, sessionId: 1 };
  aliUser = { id: ali.id, email: "ali.khan@polygonparadise.test", name: "Ali", role: "MEMBER", timeZone: TZ, sessionId: 2 };
  auth.user = ownerUser;
  await setSettingValue("practice.copy", false);
  // The daily backup and clean-up aren't part of this test (the backup below is made by hand, first).
  for (const name of ["backup.daily", "cleanup.daily"]) await periodic.recordTaskSuccess(name, clock.now());

  // Arslan's sending address with a working reply route; the Domain checklist green, checked now; Setup A passed.
  fake.setDns("all");
  await setSenderLocalPart(owner, owner.id, "arslan");
  await dbWrite((c) => c.senderAddress.updateMany({ data: { routeStatus: "ok" } }));
  await setState(STATE_KEYS.domainCheck, { domain: D, region: "EU", checkedAt: clock.now().toISOString(), lastVerifyAt: null, rows: checklistRows(), error: null });
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
  await setState(STATE_KEYS.tunnel, workingRemoteAccess(clock.now()));

  // The test list with Tess ("Test mailboxes"); two prospects in Germany whose addresses the fake checked 10 days ago.
  expect(await saveTestList(owner, [TESS])).toMatchObject({ ok: true, value: [TESS] });
  const tess = await makeCompany({ name: "Test mailboxes", domain: "test-mailbox.example", people: [{ name: "Tess", email: TESS }] });
  const firma = await makeCompany({ name: "Firma GmbH", domain: "firma.example", people: [{ name: "Anna Berg", email: ANNA }] });
  const nord = await makeCompany({ name: "Studio Nord", domain: "nord.example", people: [{ name: "Ola Nordmann", email: OLA }] });
  Object.assign(B, {
    testMailboxes: tess.company.id,
    tess: tess.people[0]!.id,
    firma: firma.company.id,
    anna: firma.people[0]!.id,
    nord: nord.company.id,
    ola: nord.people[0]!.id,
  });
  await dbWrite(async (c) => {
    await c.company.updateMany({ where: { id: { in: [B.firma, B.nord] } }, data: { country: "DE", timeZone: TZ } });
    await c.person.updateMany({
      where: { id: { in: [B.anna, B.ola] } },
      data: { verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: new Date(clock.now().getTime() - 10 * DAY), verificationProvider: "mailgun-fake" },
    });
  });
  await dbWrite((c) => c.job.deleteMany({ where: { status: "QUEUED" } }));

  // A backup first ("Back up now"), in this database's own subfolder of backups.
  backupDir = backupFolder();
  expect(path.basename(backupDir)).toBe(dbName);
  expect(path.dirname(backupDir)).toBe(path.join(process.cwd(), "backups"));
  expect(await runBackup({ kind: "MANUAL", userId: owner.id, now: clock.now() })).toMatchObject({ kind: "MANUAL", copiedTo: null });
});

afterAll(async () => {
  vi.useRealTimers();
  if (previousPub === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previousPub;
  await mg.stop();
  await db.$disconnect();
  // Only this database's own backups subfolder (backups\m6-go-live-<pid>), never anything else in backups.
  if (backupDir && path.basename(backupDir) === dbName) fs.rmSync(backupDir, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Part B: go live against the fake Mailgun", () => {
  it("0. before go-live, in Dry run mode: the dry run 'Rehearsal' puts 2 emails in the outbox; the draft 'Made early' waits", async () => {
    expect(await getSetting("sending.mode")).toBe("DRY_RUN");
    B.rehearsal = await newDraft(owner, "Rehearsal", [B.firma, B.nord], [1, 1]);
    // Real data: a dry run ignores sending hours unless told otherwise.
    expect(await draft.launchDraft(owner, B.rehearsal, { now: clock.now(), mailgun })).toMatchObject({ status: "RUNNING", mode: "DRY_RUN", queued: 2 });
    // The background sender's start-up (the check with Mailgun) and one round.
    expect(await worker.runOnce()).toBe(0);
    const outbox = await db.outboundEmail.findMany({ where: { campaignId: B.rehearsal, step: 0 } });
    expect(outbox.map((e) => [e.status, e.mode])).toEqual([
      ["SENT", "DRY_RUN"],
      ["SENT", "DRY_RUN"],
    ]);
    expect(fake.messages).toEqual([]);

    B.madeEarly = await newDraft(owner, "Made early", [B.nord], [3]);
    const { person } = await audiencePerson(B.madeEarly, B.nord);
    expect(person).toMatchObject({ ticked: true, eligible: true });
  });

  it("1. before go-live the only blocker is the live test; the Owner's switch is refused with it and nothing is written", async () => {
    await readyToRead();
    const view = await loadGoLiveView(clock.now());
    expect(view).toMatchObject({ practiceCopy: false, live: false, domain: D, endedOnDomain: null });
    expect(view.blockers).toEqual([SENTENCES.liveTestNone]);

    expect(await atClock(() => goLiveAction({ confirm: true }))).toEqual({ ok: false, error: SENTENCES.liveTestNone });
    expect(await getSetting("sending.goLive")).toBe(false);
    expect(await getSetting("sending.goLiveAt")).toBeNull();
    expect(await activities("sending.goLive")).toEqual([]);
  });

  it("2. Mailgun's test mode, then a live campaign to the test list: two messages to Tess; delivered, nothing blocks any more", async () => {
    expect(await atClock(() => setSendingModeAction({ mode: "TEST" }))).toMatchObject({ ok: true });
    B.mailgunTest = await newDraft(owner, "Mailgun test", [B.testMailboxes]);
    expect(await draft.launchDraft(owner, B.mailgunTest, { now: clock.now(), mailgun })).toMatchObject({ status: "RUNNING", mode: "TEST", queued: 1 });
    expect(await atClock(() => setSendingModeAction({ mode: "LIVE" }))).toMatchObject({ ok: true });
    // "Test run": a first email and follow-ups 1 and 2 days after it.
    B.testRun = await newDraft(owner, "Test run", [B.testMailboxes], [1, 1]);
    expect(await draft.launchDraft(owner, B.testRun, { now: clock.now(), mailgun })).toMatchObject({ status: "RUNNING", mode: "LIVE", queued: 1 });
    expect((await db.campaign.findUniqueOrThrow({ where: { id: B.testRun } })).launchedGoLive).toBe(false);

    // Inside Berlin's window, paced.
    await tickUntil([B.mailgunTest, B.testRun], () => messagesTo(TESS).length >= 2);
    expect(messagesTo(TESS)).toHaveLength(2);
    expect(campaignMessages(B.mailgunTest).map((m) => m.fields["o:testmode"])).toEqual([["yes"]]);
    expect(campaignMessages(B.testRun).map((m) => m.fields["o:testmode"])).toEqual([undefined]);
    expect(campaignMessages(B.rehearsal)).toEqual([]);
    // Test-list sends before go-live are counted, never "emailed": no status, no date, no reservation.
    expect(await db.company.findUniqueOrThrow({ where: { id: B.testMailboxes } })).toMatchObject({ status: "NOT_CONTACTED", lastEmailedAt: null });
    expect(await db.companyReservation.count({ where: { companyId: B.testMailboxes } })).toBe(0);

    await readyToRead();
    expect((await loadGoLiveView(clock.now())).blockers).toEqual([SENTENCES.liveTestSent]);

    // Mailgun says the live email reached Tess (a signed webhook); the event lane files it.
    const live = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: B.testRun, step: 0 } });
    expect(live).toMatchObject({ status: "SENT", mode: "LIVE", toNorm: TESS });
    await postEvent(fake.deliver(live.providerId ?? live.messageId));
    expect(await worker.tickOnce()).toBe(0);

    await readyToRead();
    const view = await loadGoLiveView(clock.now());
    expect(view.blockers).toEqual([]);
    // The dialog's line about old drafts: "Made early" would email Ola for real.
    expect(view.drafts).toEqual({ items: [{ id: B.madeEarly, name: "Made early", people: 1 }], more: 0 });
  });

  it("3. a live draft made before go-live leaves Anna out, and the Mailgun client's guard would refuse her", async () => {
    B.tooEarly = await newDraft(owner, "Too early", [B.firma], [3]);
    const { company, person } = await audiencePerson(B.tooEarly, B.firma);
    expect(company.blockedReason).toBeNull();
    expect(person).toMatchObject({ eligible: false, ticked: false, reason: SENTENCES.notOnTestListLive });
    expect(() => checkSendGuard({ to: ANNA, purpose: "campaign", guard: { goLive: false, testList: new Set([TESS]) } })).toThrow(
      `Stopped by the test-list guard: ${ANNA} isn't on your test list.`,
    );
  });

  it("4. going live at 10:30: a Member is refused; the Owner switches it on once, for everyone", async () => {
    clock.set(WEDNESDAY_1030_BERLIN);
    await readyToRead();

    auth.user = aliUser;
    expect(await atClock(() => goLiveAction({ confirm: true }))).toEqual({ ok: false, error: SENTENCES.ownerOnly });
    expect(await getSetting("sending.goLive")).toBe(false);
    expect(await activities("sending.goLive")).toEqual([]);
    expect(await db.notification.count({ where: { type: "sending.wentLive" } })).toBe(0);

    auth.user = ownerUser;
    const res = await atClock(() => goLiveAction({ confirm: true }));
    expect(res).toEqual({ ok: true, data: { at: WEDNESDAY_1030_BERLIN.toISOString(), alreadyLive: false }, message: SENTENCES.wentLive });

    expect(await getSettings(["sending.goLive", "sending.goLiveAt", "sending.goLiveDomain", "sending.mode"] as const)).toEqual({
      "sending.goLive": true,
      "sending.goLiveAt": WEDNESDAY_1030_BERLIN.toISOString(),
      "sending.goLiveDomain": D,
      "sending.mode": "LIVE",
    });
    const logged = await activities("sending.goLive");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ actorId: owner.id, summary: "Arslan went live on send.example.com" });
    // Everyone active hears; Bo is switched off.
    const told = await db.notification.findMany({ where: { type: "sending.wentLive" }, orderBy: { userId: "asc" } });
    expect(told.map((n) => n.userId)).toEqual([owner.id, ali.id]);
    expect(told.some((n) => n.userId === bo.id)).toBe(false);
    // The warm-up starts today at its first step.
    expect((await readTyped(STATE_KEYS.warmup, parseWarmupState)).value).toEqual({
      domain: D,
      step: 0,
      startedCapDay: "2026-09-23",
      lastEvaluatedCapDay: "2026-09-22",
      history: [],
      startedForGoLiveAt: WEDNESDAY_1030_BERLIN.toISOString(),
    });
    expect((await getSendingLabel()).label.text).toBe("Sending live");

    // A second click changes nothing.
    expect(await atClock(() => goLiveAction({ confirm: true }))).toEqual({
      ok: true,
      data: { at: WEDNESDAY_1030_BERLIN.toISOString(), alreadyLive: true },
      message: SENTENCES.alreadyLive,
    });
    expect(await activities("sending.goLive")).toHaveLength(1);
    expect(await db.notification.count({ where: { type: "sending.wentLive" } })).toBe(2);
  });

  it("5. the old draft, confirmed, emails Anna for real: Firma is Contacted, reserved, and a new draft leaves it out", async () => {
    // Anna can be emailed now; the Owner ticks her in the Audience step.
    expect((await audiencePerson(B.tooEarly, B.firma)).person).toMatchObject({ eligible: true, ticked: false, reason: null });
    await setPersonTicked(owner, B.tooEarly, B.anna, true);
    const summary = await draft.loadLaunchSummary(B.tooEarly, { now: clock.now(), mailgun });
    expect(summary).toMatchObject({ mode: "LIVE", goLive: true, madeBeforeGoLive: true, people: 1, modeBlockers: [] });
    // Made before go-live: the Schedule step's tick is passed on to the launch.
    expect(await draft.launchDraft(owner, B.tooEarly, { now: clock.now(), mailgun, confirmMadeBeforeGoLive: true })).toMatchObject({
      status: "RUNNING",
      mode: "LIVE",
      queued: 1,
    });
    expect((await db.campaign.findUniqueOrThrow({ where: { id: B.tooEarly } })).launchedGoLive).toBe(true);

    await tickUntil([B.tooEarly], () => fake.messages.length >= 3);
    expect(fake.messages).toHaveLength(3);
    const newest = fake.messages[2]!;
    expect(newest.fields.to).toEqual([ANNA]);
    expect(newest.fields["o:testmode"]).toBeUndefined();

    const firma = await db.company.findUniqueOrThrow({ where: { id: B.firma } });
    expect(firma).toMatchObject({ status: "CONTACTED", firstContactedById: owner.id, lastEmailedById: owner.id, lastEmailedCampaignId: B.tooEarly });
    expect(firma.lastEmailedAt).not.toBeNull();
    expect(await db.companyReservation.count({ where: { companyId: B.firma, campaignId: B.tooEarly, releasedAt: null } })).toBe(1);

    // The 30-day rule: a new draft with Firma leaves it out, whoever starts it.
    const again = await newDraft(owner, "Firma again", [B.firma]);
    const { company } = await audiencePerson(again, B.firma);
    expect(company.section).toBe("excluded");
    expect(company.blockedReason).toMatch(/^Emailed by Arslan .+ \(Too early, first email\)$/);
    await draft.deleteDraft(owner, again);
  });

  it("6. the day's numbers: today's limit and warm-up, the pipeline, the backup, and health counted from go-live", async () => {
    await readyToRead();
    const now = clock.now();
    // Today: Tess's live email and Anna's (Mailgun's test mode isn't counted).
    const cap = await getTodayCap(now);
    expect(cap.testSends).toBe(0);
    expect(cap.used).toBe(2 + cap.testSends);
    expect(cap.cap).toBe(50);
    const progress = await loadWarmupProgress(now);
    expect(progress.step).toBe(0);
    expect(warmupLine(0, progress.table, await loadWarmupToday(now))).toBe(SENTENCES.firstLine);

    const pipeline = await loadPipeline(now);
    expect(pipeline.counts).toEqual({ all: 3, byStatus: { NOT_CONTACTED: 2, CONTACTED: 1, REPLIED: 0, CLIENT: 0, NOT_INTERESTED: 0, DO_NOT_CONTACT: 0 } });
    expect(replyRateText(pipeline.replyRate)).toBe("Reply rate: 0% (0 of 1 company you emailed replied)");

    expect((await backupStatus(now)).age).toBe("ok");

    // Health counts from go-live (G12): Tess's live test before it isn't in the sample.
    const health = await loadHealthView(TZ, now);
    expect(health.counts).toMatchObject({ bounces: 0, bounceSample: 1, complaints: 0, complaintSample: 1 });
    expect(health.sinceNote).toMatch(/^Counting since you went live on 23 Sept?\.$/);

    // The dashboard itself shows the same numbers. Live, so no "Get started"; the Owner's only item is the second-folder
    // nudge (this test sets no second folder), and Ali has nothing to attend to.
    const arslanView = await dashboardFor(ownerUser);
    expect(arslanView.goLive).toEqual({ live: true, at: WEDNESDAY_1030_BERLIN.toISOString(), domain: D, endedOnDomain: null });
    expect(arslanView.getStarted).toBeNull();
    expect(arslanView.today).toEqual({ used: 2 + cap.testSends, cap: 50, percent: 4, lines: [SENTENCES.firstLine], notConfigured: null });
    expect(arslanView.pipeline).toEqual(pipeline);
    expect(arslanView.health).toMatchObject({ empty: null, bounce: { count: 0 }, complaint: { count: 0 }, sinceNote: health.sinceNote });
    expect(arslanView.dryRun).toMatchObject({ today: { dryRun: 2, testMode: 1 } });
    expect(attentionKeys(arslanView)).toEqual(["second-folder-missing"]);
    expect(arslanView.attention[0]).toMatchObject({
      text: "No second backup folder yet. Choose one in Settings › Backups so a copy survives if this PC's disk fails.",
      link: { href: "/settings/backups" },
    });

    const aliView = await dashboardFor(aliUser);
    expect(aliView.getStarted).toBeNull();
    expect(aliView.pipeline).toEqual(pipeline);
    expect(attentionKeys(aliView)).toEqual([]);
    expect(ATTENTION_TEXTS.empty).toBe("Nothing needs your attention right now.");
  });

  it("7. a day later 'Test run' still only reaches Tess and isn't 'emailed'; 'Rehearsal' stays in the outbox", async () => {
    const f1 = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: B.testRun, step: 1 } });
    expect(f1.status).toBe("QUEUED");
    clock.set(new Date(Math.max(f1.dueAt.getTime(), clock.now().getTime()) + SECOND));
    expect(clock.now().toISOString().slice(0, 10)).toBe("2026-09-24");
    const rehearsalDue = async () => (await db.outboundEmail.count({ where: { campaignId: B.rehearsal, step: 1, status: "QUEUED" } })) === 0;
    await tickUntil([B.testRun, B.rehearsal], async () => messagesTo(TESS).length >= 3 && (await rehearsalDue()));

    // The follow-up went to Tess through Mailgun, in real (not test) mode.
    const followUps = campaignMessages(B.testRun).filter((m) => m.fields["v:step"]?.[0] === "1");
    expect(followUps.map((m) => [m.fields.to?.[0], m.fields["o:testmode"]])).toEqual([[TESS, undefined]]);
    // "Rehearsal": its follow-ups went only to the outbox (Ola's), or were stopped (Anna's: Firma was emailed for real by
    // "Too early" since, so the 30-day rule stops the dry run too); Mailgun never got one.
    expect(campaignMessages(B.rehearsal)).toEqual([]);
    const rehearsal = await db.outboundEmail.findMany({ where: { campaignId: B.rehearsal, step: 1 }, orderBy: { id: "asc" } });
    expect(rehearsal.map((e) => [e.toNorm, e.mode, e.status])).toEqual([
      [ANNA, "DRY_RUN", "SKIPPED"],
      [OLA, "DRY_RUN", "SENT"],
    ]);
    expect(rehearsal[0]!.lastError).toMatch(/^Emailed by Arslan .+ \(Too early, first email\)$/);
    expect(await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: B.rehearsal, personId: B.anna } })).toMatchObject({ state: "STOPPED" });

    // Test mailboxes: the live test after go-live is still a test-list send.
    expect(await db.company.findUniqueOrThrow({ where: { id: B.testMailboxes } })).toMatchObject({ status: "NOT_CONTACTED", lastEmailedAt: null });
    const sequences = (await companySequences([B.testMailboxes])).get(B.testMailboxes)!;
    expect(companySequenceLabel(sequences, TZ, clock.now())?.text).toMatch(/ \(test list\)$/);
    // A new live draft with Test mailboxes: no 30-day rule; after go-live the test list no longer counts as checked.
    const again = await newDraft(owner, "Test mailboxes again", [B.testMailboxes]);
    const { company, person } = await audiencePerson(again, B.testMailboxes);
    expect(company).toMatchObject({ section: "included", blockedReason: null });
    expect(person).toMatchObject({ eligible: true, reason: null });
    expect(person.notes).toContain("Address not checked yet");
    await draft.deleteDraft(owner, again);
  });

  it("8. Test mode stays test-list only after go-live", async () => {
    expect(await atClock(() => setSendingModeAction({ mode: "TEST" }))).toMatchObject({ ok: true });
    // The label never says less than what goes out (G6): "Too early" (launched after go-live) still sends real email,
    // "Test run" (launched before) real email to the test list only (review GOLIVE-03). With no live campaign left, the
    // same setting reads "Test list only" (Mailgun's test mode only ever emails the test list, G3).
    const label = await getSendingLabel();
    expect(label.activeRealCampaigns).toEqual({ live: 2, test: 0, liveAfterGoLive: 1 });
    expect(label.label).toMatchObject({
      text: "Sending live",
      title: "New campaigns use test mode; 1 live campaign still sends real email (and 1 more to your test list only). Pause them, or use Pause all sending.",
    });
    const pause = (await readTyped(STATE_KEYS.pause, parsePauseState)).value;
    expect(sendingLabel({ pause, mode: "TEST", goLive: true, activeRealCampaigns: { live: 0, test: 0 } }).text).toBe("Test list only");

    // A test-mode draft with Studio Nord leaves Ola out, and the client's guard refuses her in test mode.
    const check = await newDraft(owner, "Test mode check", [B.nord]);
    expect((await audiencePerson(check, B.nord)).person).toMatchObject({ eligible: false, reason: SENTENCES.notOnTestListTest });
    await draft.deleteDraft(owner, check);
    expect(() => checkSendGuard({ to: OLA, purpose: "campaign", testMode: true, guard: { goLive: true, testList: new Set([TESS]) } })).toThrow(
      `Stopped by the test-list guard: ${OLA} isn't on your test list.`,
    );
    expect(await atClock(() => setSendingModeAction({ mode: "LIVE" }))).toMatchObject({ ok: true });
  });

  it("9. the draft made before go-live needs the tick: refused without it, nothing launched", async () => {
    const summary = await draft.loadLaunchSummary(B.madeEarly, { now: clock.now(), mailgun });
    expect(summary).toMatchObject({ mode: "LIVE", madeBeforeGoLive: true, people: 1 });
    const err = await draft.launchDraft(owner, B.madeEarly, { now: clock.now(), mailgun }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CampaignError);
    expect(err).toMatchObject({ code: "made-before-go-live", message: SENTENCES.madeBeforeGoLive });
    expect(await db.campaign.findUniqueOrThrow({ where: { id: B.madeEarly } })).toMatchObject({ status: "DRAFT", launchedAt: null, launchedGoLive: null });
    expect(await db.outboundEmail.count({ where: { campaignId: B.madeEarly } })).toBe(0);
    expect(await db.companyReservation.count({ where: { campaignId: B.madeEarly } })).toBe(0);
  });

  it("10. Tess taken off the test list: 'Test run', launched before go-live, skips her second follow-up", async () => {
    expect(await saveTestList(owner, [])).toMatchObject({ ok: true, value: [] });
    const before = messagesTo(TESS).length;
    const f2 = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: B.testRun, step: 2 } });
    expect(f2.status).toBe("QUEUED");
    clock.set(new Date(Math.max(f2.dueAt.getTime(), clock.now().getTime()) + SECOND));
    expect(clock.now().toISOString().slice(0, 10)).toBe("2026-09-25");
    await tickUntil([B.testRun], async () => (await db.outboundEmail.findUniqueOrThrow({ where: { id: f2.id } })).status !== "QUEUED");

    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: f2.id } })).toMatchObject({
      status: "SKIPPED",
      lastError: SENTENCES.notOnTestListLive,
      providerId: null,
    });
    expect(messagesTo(TESS)).toHaveLength(before);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: B.testRun } })).status).toBe("FINISHED");
  });

  it("11. across the flip: Mailgun never got a dry-run email, and every test-mode email stayed in test mode", async () => {
    for (let day = 0; day < 2; day++) {
      clock.advance(DAY);
      expect(await worker.tickOnce()).toBe(0);
      expect(await worker.tickOnce()).toBe(0);
    }
    expect(campaignMessages(B.rehearsal)).toEqual([]);
    const rehearsal = await db.outboundEmail.findMany({ where: { campaignId: B.rehearsal } });
    expect(rehearsal.length).toBeGreaterThan(0);
    expect(rehearsal.every((e) => e.mode === "DRY_RUN" && e.status !== "QUEUED")).toBe(true);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: B.rehearsal } })).status).toBe("FINISHED");

    const testMode = campaignMessages(B.mailgunTest);
    expect(testMode).toHaveLength(1);
    expect(testMode.every((m) => m.fields["o:testmode"]?.[0] === "yes")).toBe(true);
    expect(errors).toEqual([]);
  });
});
