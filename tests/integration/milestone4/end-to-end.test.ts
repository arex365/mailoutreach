import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeUser, setSettingValue } from "../campaigns/seed";
import { eventData } from "../mail-events/seed";
import { postInbound, replyTo, vectorInput } from "../helpers/replies";
import { startFakeMailgun, type FakeMailgun } from "../../fake-mailgun/server";
import { FakeDns, goodZone } from "../../unit/checks/fake-dns";
import { A as VECTOR_THREAD_ID, vector } from "../../unit/replies-core/vectors";
import type { JobRegistry } from "../../../worker/jobs";

/**
 * Milestone 4 end to end (M4-DESIGN §11.3): follow-ups in the same thread with their stop rules, replies processed by the
 * worker's event lane, auto-replies, possible replies, the outage hold and exactly which user got which notification.
 * Nothing is mocked inside the app: Mailgun is the local fake server (tests/fake-mailgun), DNS a fake resolver table,
 * the app's public address is answered in-process, and the worker runs its real rounds (`runOnce`/`tickOnce`) on a
 * fixed clock that starts on Wednesday 23 Sep 2026 at 10:00 in Berlin. Nothing reaches the network.
 *
 *   Setup: Mailgun connected (the fake), sending addresses for Arslan (Owner) and Ali (Member).
 *   Part A (practice copy, fast follow-ups): a dry run by Ali to five companies with 2 follow-ups ("days as minutes"):
 *     a bounce and an unsubscribe through signed webhooks, follow-up 1 in the same thread, a signed reply that stops the
 *     company in every campaign and makes it Replied, a simulated out-of-office (nothing stops) and an unclear reply
 *     (held until "It was an auto-reply"), follow-up 2 only where allowed, Answered, the campaign finishes.
 *   Part B (real data, go-live off): Apply, the domain checklist, the test list, Live, the reply test; a live campaign
 *     to the 3 test mailboxes with a follow-up after 1 day: a reply cancels one follow-up, an out-of-office doesn't,
 *     the reply-test replies are test replies; the next day exactly 2 follow-ups reach the fake, in the same thread.
 *   Part C (the PC was off): a second live campaign by Ali; 7 days without a check with Mailgun; the check finds the
 *     gap and its onSuccess holds the follow-ups and tells Ali and the Owner; Ali checks the inbox and continues; the
 *     same gap found again holds nobody; the follow-ups go.
 */

// The worker's start-up reads <database folder>/RESTORED; data/test is shared by all test files, so use a folder of our own.
const created = await createTestDb("m4-end-to-end");
const dir = path.join(path.dirname(created.file), `m4-e2e-${process.pid}-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
const dbFile = path.join(dir, "m4-e2e.db");
fs.copyFileSync(created.file, dbFile);
created.cleanup();
process.env.DATABASE_URL = "file:" + dbFile.replace(/\\/g, "/");

const D = "send.example.com";
const PUB = "http://127.0.0.1:3100";
const EVENTS_URL = `${PUB}/api/webhooks/mailgun/events`;
const OUTLOOK = "t.outlook@outlook.com";
const GMAIL = "t.gmail@gmail.com";
const OTHER = "t.other@proton.me";
const MIN = 60_000;
/** Wednesday 23 Sep 2026, 10:00 in Berlin. */
const WEDNESDAY_10_BERLIN = new Date("2026-09-23T08:00:00.000Z");
/** Thursday 24 Sep 2026, 10:05 in Berlin. */
const THURSDAY_1005_BERLIN = new Date("2026-09-24T08:05:00.000Z");

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
const { getState } = await import("@/server/state");
const { setSetting } = await import("@/server/settings");
const { readTyped } = await import("@/server/state-typed");
const { parseOutageState } = await import("@/core/system-state-parse");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { enqueueJob } = await import("@/server/jobs");
const { GET: healthGET } = await import("@/app/api/health/route");
const { handleEventWebhook, handleInboundWebhook } = await import("@/server/services/mail-events/webhook");
const { connectMailgun } = await import("@/server/services/mailgun/connect");
const { runApplySettings, parseApplyPayload } = await import("@/server/services/mailgun/apply-settings");
const { runDomainCheck } = await import("@/server/services/checks/domain-check");
const { setSenderLocalPart } = await import("@/server/services/sender-addresses");
const replyTest = await import("@/server/services/reply-test");
const { sendReplyTestEmails, replyTestMessageId } = await import("@/server/services/test-send");
const { removeOwnSuppression } = await import("@/server/services/mailgun/suppressions");
const draft = await import("@/server/services/campaigns/draft");
const { setPersonTicked } = await import("@/server/services/campaigns/audience");
const { getCampaignOverview } = await import("@/server/services/campaigns/queries");
const { simulateReply } = await import("@/server/services/mail-events/simulate");
const { confirmReply, markReplyAnswered, listWaitingReplies } = await import("@/server/services/replies");
const { waitingReplyCount } = await import("@/server/notifications");
const { releaseOutageHold } = await import("@/server/services/sequences/holds");
const { MASTER_SEQUENCE } = await import("@/core/templates/defaults");
const { BackgroundWorker } = await import("../../../worker/main");
const { createJobRegistry } = await import("../../../worker/jobs");
const { recordTaskSuccess } = await import("../../../worker/periodic");
const { DOMAIN_CHECK_TASK, verifyFromPayload } = await import("../../../worker/jobs/mailgun-check-domain");

/** Fast retries and a short timeout against the fake. */
const mailgun = () => getMailgunContext({ retryDelayMs: () => 0, timeoutMs: 2_000 });

/**
 * The app's public address, answered in-process: GET /api/health by the health route, the events webhook by its
 * handler (the remote-access self-check during Apply). Anything else (cloudflared, the internet) is refused.
 */
const appFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === `${PUB}/api/health`) return healthGET();
  if (url === EVENTS_URL) return handleEventWebhook(new Request(url, init), { now: clock.now() });
  throw new TypeError(`fetch failed (no network in this test: ${url})`);
}) as typeof fetch;

/** Both public resolvers see Mailgun's records (the fake's own values). */
const dnsLookups = () => [new FakeDns(goodZone(D)), new FakeDns(goodZone(D))] as [FakeDns, FakeDns];

/** The worker's registry on the test clock; the domain check and Apply use the fake DNS and the in-process address. */
const registry: JobRegistry = (() => {
  const base = createJobRegistry({ mailgun, now: clock.now });
  return {
    ...base,
    "mailgun.checkDomain": {
      ...base["mailgun.checkDomain"]!,
      handler: async (payload: unknown) => {
        const state = await runDomainCheck({ verify: verifyFromPayload(payload), now: clock.now(), lookups: dnsLookups(), mailgun, fetchImpl: appFetch });
        await recordTaskSuccess(DOMAIN_CHECK_TASK, clock.now());
        return { summary: `${state.rows.filter((r) => r.status === "ok").length} rows done` };
      },
    },
    "mailgun.applySettings": {
      ...base["mailgun.applySettings"]!,
      handler: async (payload: unknown, ctx: { jobId: number; createdById: number | null }) => {
        const { step, attempt } = parseApplyPayload(payload);
        const state = await runApplySettings({ byUserId: ctx.createdById, jobId: ctx.jobId, step, attempt, mailgun, fetchImpl: appFetch, now: clock.now() });
        return { summary: `${state.steps.filter((s) => s.ok).length} steps done` };
      },
    },
  };
})();

const errors: string[] = [];
const quiet = { info: () => undefined, warn: () => undefined, error: (m: string, e?: unknown) => errors.push(`${m}${e ? `: ${String(e)}` : ""}`) };

function newWorker() {
  return new BackgroundWorker({ now: clock.now, mailgun, random: () => 0, fetchImpl: appFetch, logger: quiet, registry });
}
type Worker = ReturnType<typeof newWorker>;

type Actor = { id: number; name: string; role: "OWNER" | "MEMBER" };
let owner: Actor;
let ali: Actor;
let ownerAddress = "";
let aliAddress = "";

async function postEvent(data: Record<string, unknown>) {
  const res = await handleEventWebhook(fake.signedEventRequest(EVENTS_URL, data), { now: clock.now() });
  expect(res.status).toBe(200);
}

/** The fake's messages for one campaign (by v:campaign_id), optionally one step (v:step). */
function campaignMessages(campaignId: number, step?: number) {
  return fake.messages.filter(
    (m) => m.fields["v:campaign_id"]?.[0] === String(campaignId) && (step === undefined || m.fields["v:step"]?.[0] === String(step)),
  );
}

function bare(id: string | undefined): string {
  return (id ?? "").replace(/^<|>$/g, "").toLowerCase();
}

async function pacer() {
  return (await getState<{ nextSendAt: string | null; waiting: { reason: string; until: string | null } | null }>("sending.pacer"))?.value;
}

/**
 * Worker rounds until `done`, jumping the clock to the next moment something can go: the pacer's next slot or wait, or
 * the campaign's next due email (never backwards).
 */
async function tickUntil(worker: Worker, campaignId: number, done: () => boolean, rounds = 12): Promise<void> {
  for (let round = 0; round < rounds && !done(); round++) {
    const p = await pacer();
    const due = await db.outboundEmail.findFirst({ where: { campaignId, status: "QUEUED" }, orderBy: { dueAt: "asc" }, select: { dueAt: true } });
    const next = Math.max(Date.parse(p?.nextSendAt ?? "") || 0, Date.parse(p?.waiting?.until ?? "") || 0, due?.dueAt.getTime() ?? 0);
    if (next > clock.now().getTime()) clock.set(new Date(next + 1_000));
    expect(await worker.tickOnce()).toBe(0);
  }
}

/** Removes queued tasks (the practice copy never talks to Mailgun; Part B queues what it needs again). */
async function dropQueuedJobs() {
  await dbWrite((c) => c.job.deleteMany({ where: { status: "QUEUED" } }));
}

async function recipientOf(campaignId: number, personId: number) {
  return db.campaignRecipient.findUniqueOrThrow({ where: { campaignId_personId: { campaignId, personId } } });
}

async function notificationsOf(userId: number) {
  return db.notification.findMany({ where: { userId }, orderBy: { id: "asc" } });
}

beforeAll(async () => {
  const arslan = await makeUser("Arslan", { role: "OWNER", email: "arslan@polygonparadise.test", senderDisplayName: "Arslan from Polygon Paradise" });
  const aliUser = await makeUser("Ali Khan", { email: "ali.khan@polygonparadise.test", senderDisplayName: "Ali from Polygon Paradise" });
  await dbWrite(async (c) => {
    await c.user.update({ where: { id: arslan.id }, data: { replyInbox: "arslan.owner@gmail.com", signature: "Arslan\nPolygon Paradise" } });
    await c.user.update({ where: { id: aliUser.id }, data: { replyInbox: "ali.inbox@gmail.com", signature: "Ali Khan\nPolygon Paradise" } });
  });
  owner = { id: arslan.id, name: arslan.name, role: "OWNER" };
  ali = { id: aliUser.id, name: aliUser.name, role: "MEMBER" };
  await setSettingValue("practice.copy", false);
  // The daily backup and clean-up aren't part of this test.
  for (const name of ["backup.daily", "cleanup.daily"]) await recordTaskSuccess(name, clock.now());

  // Setup: Mailgun connected (the fake) and a sending address for each sender.
  expect(await connectMailgun(owner, { region: "EU", domain: D, apiKey: "key-fake-api" }, { retryDelayMs: () => 0 })).toMatchObject({ ok: true });
  fake.setDns("all");
  ownerAddress = (await setSenderLocalPart(owner, owner.id, "arslan")).address;
  aliAddress = (await setSenderLocalPart(owner, ali.id, "ali")).address;
  expect([ownerAddress, aliAddress]).toEqual([`arslan@${D}`, `ali@${D}`]);
  await dropQueuedJobs();
});

afterAll(async () => {
  if (previousEnv.base === undefined) delete process.env.OUTREACH_MAILGUN_BASE_URL;
  else process.env.OUTREACH_MAILGUN_BASE_URL = previousEnv.base;
  if (previousEnv.pub === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previousEnv.pub;
  await fake.close();
  await db.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ───────────────────────── Part A: the practice copy, fast follow-ups ─────────────────────────

describe("Part A: a practice-copy dry run with fast follow-ups, replies and an unclear reply", () => {
  const A = { campaignId: 0, companies: {} as Record<string, number>, people: {} as Record<string, number> };
  let workerA: Worker;
  let firstSubject: Record<string, string> = {};
  let annaReplyId = 0;
  let doraReplyId = 0;
  const followUp = async (email: string, step: number) =>
    db.outboundEmail.findFirstOrThrow({ where: { campaignId: A.campaignId, toNorm: email, step } });

  it("1–2. launches Ali's dry run to five companies (Anna and Ben at the same one) and sends the 6 first emails", async () => {
    await setSettingValue("practice.copy", true);
    await setSetting("sending.mode", "DRY_RUN", owner.id);
    const seeds: Array<[string, string, Array<[string, string]>]> = [
      ["Alpha Figures", "a.test", [["Anna Berg", "anna@a.test"], ["Ben Braun", "ben@a.test"]]],
      ["Bravo Prints", "b.test", [["Carl Nagel", "carl@b.test"]]],
      ["Charlie Models", "c.test", [["Dora Lind", "dora@c.test"]]],
      ["Delta Resin", "d.test", [["Dave Moss", "dave@d.test"]]],
      ["Echo Minis", "e.test", [["Eve Stone", "eve@e.test"]]],
    ];
    for (const [name, domain, people] of seeds) {
      const { company, people: ps } = await makeCompany({ name, domain, people: people.map(([n, email]) => ({ name: n, email })) });
      A.companies[name] = company.id;
      for (const p of ps) A.people[p.email!] = p.id;
    }
    const d = await draft.createDraft(ali, { companyIds: Object.values(A.companies), timeZone: "Europe/Berlin", now: clock.now() });
    A.campaignId = d.id;
    await draft.renameDraft(ali, d.id, "Practice with follow-ups");
    const [s0, s1, s2] = MASTER_SEQUENCE.steps;
    await draft.saveDraftSteps(ali, d.id, [
      { step: 0, enabled: true, subject: s0!.subject, body: s0!.body, delayDays: 0 },
      { step: 1, enabled: true, subject: null, body: s1!.body, delayDays: 1 },
      { step: 2, enabled: true, subject: null, body: s2!.body, delayDays: 2 },
    ]);
    await draft.setDraftSchedule(ali, d.id, { daysAsMinutes: true }, { now: clock.now() });
    // Tick every person, Ben too (the same company, the same campaign: the 30-day rule doesn't apply).
    for (const personId of Object.values(A.people)) await setPersonTicked(ali, d.id, personId, true);
    const launched = await draft.launchDraft(ali, d.id, { now: clock.now(), ignoreWindow: true });
    expect(launched).toMatchObject({ status: "RUNNING", mode: "DRY_RUN", queued: 6 });

    workerA = newWorker();
    expect(await workerA.tickOnce()).toBe(0);
    const firsts = await db.outboundEmail.findMany({ where: { campaignId: d.id, step: 0 }, orderBy: { id: "asc" } });
    expect(firsts.map((e) => e.status)).toEqual(Array(6).fill("SENT"));
    firstSubject = Object.fromEntries(firsts.map((e) => [e.toNorm, e.subject]));
    for (const e of firsts) {
      expect(e.subject).not.toBe("");
      expect(e.sentAt?.toISOString()).toBe(WEDNESDAY_10_BERLIN.toISOString());
      expect(e.fromAddress).toBe(`Ali from Polygon Paradise <${aliAddress}>`);
    }
    const recipients = await db.campaignRecipient.findMany({ where: { campaignId: d.id, included: true } });
    expect(recipients.map((r) => [r.state, r.currentStep])).toEqual(Array(6).fill(["WAITING", 1]));
    const f1 = await db.outboundEmail.findMany({ where: { campaignId: d.id, step: 1 } });
    // "Treat follow-up days as minutes": follow-up 1 is due one minute after its first email.
    expect(f1.map((e) => [e.status, e.dueAt.toISOString()])).toEqual(Array(6).fill(["QUEUED", new Date(WEDNESDAY_10_BERLIN.getTime() + MIN).toISOString()]));
    // Practice copy: a dry run is real contact.
    expect((await db.company.findUniqueOrThrow({ where: { id: A.companies["Bravo Prints"]! } })).status).toBe("CONTACTED");
  });

  it("3. a bounce and an unsubscribe through signed webhooks stop Dave's and Eve's follow-ups", async () => {
    const first = async (email: string) => db.outboundEmail.findFirstOrThrow({ where: { campaignId: A.campaignId, toNorm: email, step: 0 } });
    for (const [email, kind] of [
      ["dave@d.test", "bounce"],
      ["eve@e.test", "unsubscribe"],
    ] as const) {
      const row = await first(email);
      await postEvent(eventData({ messageId: row.messageId, toNorm: row.toNorm, sendId: row.sendId, campaignId: A.campaignId }, kind, { at: clock.now() }));
    }
    expect(await recipientOf(A.campaignId, A.people["dave@d.test"]!)).toMatchObject({ state: "STOPPED", stopReason: "bounced" });
    expect(await recipientOf(A.campaignId, A.people["eve@e.test"]!)).toMatchObject({ state: "STOPPED", stopReason: "unsubscribed" });
    expect((await followUp("dave@d.test", 1)).status).toBe("SKIPPED");
    expect((await followUp("eve@e.test", 1)).status).toBe("SKIPPED");
  });

  it("4. one minute later exactly 4 follow-ups go, in the same thread; follow-up 2 is due 2 minutes after", async () => {
    clock.advance(MIN);
    expect(await workerA.tickOnce()).toBe(0);
    const f1 = await db.outboundEmail.findMany({ where: { campaignId: A.campaignId, step: 1, status: "SENT" }, orderBy: { id: "asc" } });
    expect(f1.map((e) => e.toNorm).sort()).toEqual(["anna@a.test", "ben@a.test", "carl@b.test", "dora@c.test"]);
    for (const e of f1) {
      const first = await db.outboundEmail.findFirstOrThrow({ where: { recipientId: e.recipientId, step: 0 } });
      expect(e.inReplyTo).toBe(first.messageId);
      expect(e.references).toBe(first.messageId);
      expect(e.subject).toBe(`Re: ${firstSubject[e.toNorm]}`);
      const f2 = await followUp(e.toNorm, 2);
      expect(f2.status).toBe("QUEUED");
      expect(f2.dueAt.getTime() - e.sentAt!.getTime()).toBe(2 * MIN);
      expect(f2.inReplyTo).toBe(e.messageId);
      expect(f2.references).toBe(`${first.messageId} ${e.messageId}`);
    }
  });

  it("5. a signed reply from Anna to follow-up 1: Alpha Figures is Replied and stopped, Ali is told, it waits for an answer", async () => {
    const annaF1 = await followUp("anna@a.test", 1);
    const posted = await replyTo(fake, annaF1.id, { text: "Hi Ali,\n\nYes please, send me your prices for 10 busts.\n\nBest,\nAnna" });
    expect(posted.status).toBe(200);
    annaReplyId = posted.id!;
    expect(await workerA.tickOnce()).toBe(0);

    const reply = await db.inboundMessage.findUniqueOrThrow({ where: { id: annaReplyId } });
    expect(reply).toMatchObject({ kind: "REPLY", linkMethod: "headers", replyScope: "real", changesStatus: true, outboundEmailId: annaF1.id, assigneeId: ali.id });
    const company = await db.company.findUniqueOrThrow({ where: { id: A.companies["Alpha Figures"]! } });
    expect(company.status).toBe("REPLIED");
    expect(company.repliedAt?.toISOString()).toBe(clock.now().toISOString());
    expect((await db.person.findUniqueOrThrow({ where: { id: A.people["anna@a.test"]! } })).repliedAt).not.toBeNull();
    expect((await db.person.findUniqueOrThrow({ where: { id: A.people["ben@a.test"]! } })).repliedAt).toBeNull();
    expect(await recipientOf(A.campaignId, A.people["anna@a.test"]!)).toMatchObject({ state: "STOPPED", stopReason: "replied", stoppedByInboundId: annaReplyId });
    expect(await recipientOf(A.campaignId, A.people["ben@a.test"]!)).toMatchObject({ state: "STOPPED", stopReason: "company_replied", stoppedByInboundId: annaReplyId });
    expect(await followUp("anna@a.test", 2)).toMatchObject({ status: "SKIPPED", lastError: "Stopped: they replied" });
    expect(await followUp("ben@a.test", 2)).toMatchObject({ status: "SKIPPED", lastError: "Stopped: someone at the company replied" });

    // Ali (the sender) is told, without a "Dry run:" label: in the practice copy dry runs stand in for real sends.
    const notes = (await notificationsOf(ali.id)).filter((n) => n.type.startsWith("reply."));
    expect(notes.map((n) => [n.type, n.title, n.link])).toEqual([
      ["reply.received", "New reply from Alpha Figures", `/notifications?reply=${annaReplyId}#replies`],
    ]);
    const waiting = await listWaitingReplies({ id: ali.id, role: "MEMBER", timeZone: "Europe/Berlin" }, { scope: "mine", now: clock.now() });
    expect(waiting.rows.map((r) => [r.id, r.kind, r.label])).toEqual([[annaReplyId, "REPLY", ""]]);
    expect(await waitingReplyCount(ali.id)).toBe(1);
    const timeline = await db.activityLog.findFirstOrThrow({ where: { type: "reply.received", companyId: A.companies["Alpha Figures"]! } });
    expect(timeline).toMatchObject({ campaignId: A.campaignId, personId: A.people["anna@a.test"]!, actorId: null });
    expect((timeline.data as { snippet?: string }).snippet).toContain("Yes please, send me your prices for 10 busts.");
  });

  it("6. a simulated out-of-office from Carl is automatic: nothing stops and nobody is told", async () => {
    const before = (await notificationsOf(ali.id)).length;
    const carlF1 = await followUp("carl@b.test", 1);
    const res = await simulateReply(ali, carlF1.id, "out-of-office", { now: clock.now() });
    expect(res.message).toBe("Simulated an out-of-office reply from carl@b.test. It's logged as automatic, so follow-ups continue.");
    const reply = await db.inboundMessage.findFirstOrThrow({ where: { outboundEmailId: carlF1.id } });
    expect(reply).toMatchObject({ kind: "AUTO_REPLY", autoReason: "out-of-office", source: "SIMULATED" });
    expect(await recipientOf(A.campaignId, A.people["carl@b.test"]!)).toMatchObject({ state: "WAITING", currentStep: 2 });
    expect((await db.company.findUniqueOrThrow({ where: { id: A.companies["Bravo Prints"]! } })).status).toBe("CONTACTED");
    expect((await notificationsOf(ali.id)).length).toBe(before);
  });

  it("7. a simulated unclear reply from Dora is a possible reply: Charlie Models waits, Ali is asked", async () => {
    const doraF1 = await followUp("dora@c.test", 1);
    const res = await simulateReply(ali, doraF1.id, "unclear", { now: clock.now() });
    expect(res.message).toBe(
      "Simulated an unclear reply from dora@c.test. Follow-ups to Charlie Models wait until someone chooses Real reply or It was an auto-reply on the Notifications page.",
    );
    const reply = await db.inboundMessage.findFirstOrThrow({ where: { outboundEmailId: doraF1.id } });
    doraReplyId = reply.id;
    expect(reply).toMatchObject({ kind: "POSSIBLE_REPLY", replyScope: "real" });
    expect(await recipientOf(A.campaignId, A.people["dora@c.test"]!)).toMatchObject({ state: "HELD", holdReason: "possible-reply" });
    const possible = (await notificationsOf(ali.id)).filter((n) => n.type === "reply.possible");
    expect(possible.map((n) => [n.title, n.link])).toEqual([["Did Charlie Models really reply?", `/notifications?reply=${doraReplyId}#replies`]]);
  });

  it("8. two minutes later only Carl's follow-up 2 goes (Dora is on hold); the campaign keeps running", async () => {
    clock.advance(2 * MIN);
    expect(await workerA.tickOnce()).toBe(0);
    expect((await followUp("carl@b.test", 2)).status).toBe("SENT");
    expect((await followUp("dora@c.test", 2)).status).toBe("QUEUED");
    expect((await db.campaign.findUniqueOrThrow({ where: { id: A.campaignId } })).status).toBe("RUNNING");
  });

  it("9. 'It was an auto-reply' releases Dora; her follow-up 2 goes", async () => {
    const res = await confirmReply(ali, doraReplyId, false, { now: clock.now() });
    expect(res.message).toBe("Marked as automatic. Follow-ups to Charlie Models continue.");
    expect(await recipientOf(A.campaignId, A.people["dora@c.test"]!)).toMatchObject({ state: "WAITING", holdReason: null, heldAt: null });
    expect((await db.inboundMessage.findUniqueOrThrow({ where: { id: doraReplyId } })).kind).toBe("AUTO_REPLY");
    expect(await workerA.tickOnce()).toBe(0);
    expect((await followUp("dora@c.test", 2)).status).toBe("SENT");
  });

  it("10. Anna's reply is answered: nothing waits any more, and the campaign has finished", async () => {
    expect((await markReplyAnswered(ali, annaReplyId, { now: clock.now() })).message).toBe("Marked as answered.");
    const waiting = await listWaitingReplies({ id: ali.id, role: "MEMBER", timeZone: "Europe/Berlin" }, { scope: "everyone", now: clock.now() });
    expect(waiting.total).toBe(0);
    expect(await workerA.tickOnce()).toBe(0);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: A.campaignId } })).status).toBe("FINISHED");
  });

  it("11. who got which email and which notification, and the campaign's results", async () => {
    const sent = await db.outboundEmail.findMany({ where: { campaignId: A.campaignId, status: "SENT" } });
    const to = (step: number) => sent.filter((e) => e.step === step).map((e) => e.toNorm).sort();
    expect(to(0)).toEqual(["anna@a.test", "ben@a.test", "carl@b.test", "dave@d.test", "dora@c.test", "eve@e.test"]);
    expect(to(1)).toEqual(["anna@a.test", "ben@a.test", "carl@b.test", "dora@c.test"]);
    expect(to(2)).toEqual(["carl@b.test", "dora@c.test"]);
    // Nothing ever went to Dave or Eve after their first email.
    expect(sent.filter((e) => ["dave@d.test", "eve@e.test"].includes(e.toNorm) && e.step > 0)).toEqual([]);

    // Ali: one reply, one possible reply, the finished campaign. The Owner: none of the reply types.
    expect((await notificationsOf(ali.id)).map((n) => n.type).sort()).toEqual(["campaign.finished", "reply.possible", "reply.received"]);
    expect((await notificationsOf(owner.id)).filter((n) => n.type.startsWith("reply."))).toEqual([]);

    const overview = await getCampaignOverview(A.campaignId);
    expect(overview!.results).toMatchObject({ sent: 12, bounced: 1, replied: 1, unsubscribed: 1 });
    const statuses = await db.company.findMany({ where: { id: { in: Object.values(A.companies) } }, select: { name: true, status: true }, orderBy: { name: "asc" } });
    expect(statuses.map((c) => [c.name, c.status])).toEqual([
      ["Alpha Figures", "REPLIED"],
      ["Bravo Prints", "CONTACTED"],
      ["Charlie Models", "CONTACTED"],
      ["Delta Resin", "CONTACTED"],
      ["Echo Minis", "CONTACTED"],
    ]);
    expect(errors).toEqual([]);
  });
});

// ───────────────────────── Part B: a live campaign to the test list ─────────────────────────

describe("Part B: a live campaign to the test mailboxes: a reply cancels the follow-up, an out-of-office doesn't", () => {
  const B = { campaignId: 0, people: {} as Record<string, number>, companies: {} as Record<string, number> };
  let workerB: Worker;

  it("0. real data: Apply, the domain checklist, the test list, Live and the reply test (as in Milestone 3)", async () => {
    await setSettingValue("practice.copy", false);
    clock.set(new Date(WEDNESDAY_10_BERLIN.getTime() + 15 * MIN));
    const setup = await runApplySettings({ byUserId: owner.id, mailgun, fetchImpl: appFetch, now: clock.now() });
    expect(setup.steps.filter((s) => s.ok === false).map((s) => `${s.key}: ${s.text}`)).toEqual([]);
    // The reply routes of both senders (and what Apply queued), then "Check again" on the Domain checklist: Mailgun
    // re-checks the DNS records too.
    await enqueueJob({ type: "mailgun.syncRoutes", payload: {}, dedupeKey: "mailgun:routes", priority: 30, createdById: owner.id });
    expect(await newWorker().tickOnce()).toBe(0);
    for (const address of [ownerAddress, aliAddress]) {
      expect((await db.senderAddress.findUniqueOrThrow({ where: { address } })).routeStatus).toBe("ok");
    }
    await enqueueJob({ type: "mailgun.checkDomain", payload: { verify: true }, dedupeKey: "mailgun:domain-check", priority: 20, createdById: owner.id });
    expect(await newWorker().tickOnce()).toBe(0);

    expect(await replyTest.saveTestList(owner, [OUTLOOK, GMAIL, OTHER])).toMatchObject({ ok: true });
    expect(replyTest.modeBlockersFor("LIVE", await replyTest.loadGateInputs(clock.now()))).toEqual([]);
    await setSetting("sending.mode", "LIVE", owner.id);

    // The reply test: 3 emails, deliveries, a reply from each mailbox, one unsubscribe (put back), the answers.
    const jobId = 9101;
    expect(await sendReplyTestEmails(owner.id, { jobId, now: clock.now(), mailgun })).toMatchObject({ sent: 3, failed: 0 });
    const ids = new Map([OUTLOOK, GMAIL, OTHER].map((a) => [a, replyTestMessageId(jobId, a, D)]));
    clock.advance(2 * MIN);
    for (const a of [OUTLOOK, GMAIL, OTHER]) await postEvent(fake.deliver(ids.get(a)!));
    clock.advance(3 * MIN);
    for (const a of [OUTLOOK, GMAIL, OTHER]) {
      const { fields } = fake.receive({ from: a, to: ownerAddress, subject: "Re: Reply test from Polygon Paradise Outreach", text: "Got it", inReplyTo: ids.get(a)! });
      expect((await handleInboundWebhook(fake.signedInboundRequest(`${PUB}/api/webhooks/mailgun/inbound`, fields), { now: clock.now() })).status).toBe(200);
    }
    await postEvent(fake.unsubscribe(ids.get(GMAIL)!));
    expect(await removeOwnSuppression(owner, GMAIL, { mailgun })).toEqual({ removed: true, mailgunProblem: null });
    await replyTest.saveReplyTestAnswers(owner, {
      mailboxes: [
        { address: OUTLOOK, inboxOk: true, authOk: "pass" },
        { address: GMAIL, inboxOk: true, authOk: "pass" },
        { address: OTHER, inboxOk: true, authOk: "pass" },
      ],
      headersOk: true,
    });
    expect(await replyTest.decideReplyTest(owner, clock.now())).toEqual({ status: "passed", missing: [] });
    // The three answers are stored and wait for the event lane.
    expect(await db.inboundMessage.count({ where: { toAddress: ownerAddress, processedAt: null } })).toBe(3);
  });

  it("1. launches a live campaign with one follow-up after 1 day; the worker sends 3 first emails, paced", async () => {
    for (const [name, email] of [
      ["Test – Outlook", OUTLOOK],
      ["Test – Gmail", GMAIL],
      ["Test – Proton", OTHER],
    ] as const) {
      const { company, people } = await makeCompany({ name, domain: null, people: [{ name: `${name} inbox`, email }] });
      B.companies[email] = company.id;
      B.people[email] = people[0]!.id;
    }
    clock.set(new Date(WEDNESDAY_10_BERLIN.getTime() + 30 * MIN));
    const d = await draft.createDraft(owner, { companyIds: Object.values(B.companies), timeZone: "Europe/Berlin", now: clock.now() });
    B.campaignId = d.id;
    await draft.renameDraft(owner, d.id, "Live test with a follow-up");
    const [s0, s1] = MASTER_SEQUENCE.steps;
    await draft.saveDraftSteps(owner, d.id, [
      { step: 0, enabled: true, subject: s0!.subject, body: s0!.body, delayDays: 0 },
      { step: 1, enabled: true, subject: null, body: s1!.body, delayDays: 1 },
    ]);
    await draft.setDraftSender(owner, d.id, owner.id);
    expect(await draft.launchDraft(owner, d.id, { now: clock.now(), mailgun })).toMatchObject({ status: "RUNNING", mode: "LIVE", queued: 3 });

    // A fresh worker: start-up (the check with Mailgun first; the lane files the reply-test answers), then rounds.
    workerB = newWorker();
    expect(await workerB.runOnce()).toBe(0);
    await tickUntil(workerB, d.id, () => campaignMessages(d.id, 0).length >= 3);
    const messages = campaignMessages(d.id);
    expect(messages.map((m) => m.fields.to?.[0]).sort()).toEqual([GMAIL, OTHER, OUTLOOK].sort());
    const allIds = fake.messages.map((m) => bare(m.fields["h:Message-Id"]?.[0]));
    expect(new Set(allIds).size).toBe(allIds.length);
    // Every recipient waits for follow-up 1 a day after its own first email.
    const f1 = await db.outboundEmail.findMany({ where: { campaignId: d.id, step: 1 } });
    expect(f1.map((e) => e.status)).toEqual(["QUEUED", "QUEUED", "QUEUED"]);
  });

  it("2. a reply from the Gmail mailbox cancels its follow-up; before go-live the status stays; the Owner is told", async () => {
    const first = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: B.campaignId, toNorm: GMAIL, step: 0 } });
    const posted = await replyTo(fake, first.id, { text: "Thanks, this looks good. Can you send prices?" });
    expect(await workerB.tickOnce()).toBe(0);
    const reply = await db.inboundMessage.findUniqueOrThrow({ where: { id: posted.id! } });
    expect(reply).toMatchObject({ kind: "REPLY", linkMethod: "headers", replyScope: "real", changesStatus: false, assigneeId: owner.id });
    expect(await recipientOf(B.campaignId, B.people[GMAIL]!)).toMatchObject({ state: "STOPPED", stopReason: "replied" });
    expect(await db.outboundEmail.findFirstOrThrow({ where: { campaignId: B.campaignId, toNorm: GMAIL, step: 1 } })).toMatchObject({
      status: "SKIPPED",
      lastError: "Stopped: they replied",
    });
    expect(await db.company.findUniqueOrThrow({ where: { id: B.companies[GMAIL]! } })).toMatchObject({ status: "NOT_CONTACTED", repliedAt: null });
    const notes = (await notificationsOf(owner.id)).filter((n) => n.type.startsWith("reply."));
    expect(notes.map((n) => [n.type, n.title])).toEqual([["reply.received", "New reply from Test – Gmail"]]);
    expect(await waitingReplyCount(owner.id)).toBe(1);
  });

  it("3. an Outlook.com out-of-office (V03 shape) is automatic: the follow-up still waits, nobody is told", async () => {
    const first = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: B.campaignId, toNorm: OUTLOOK, step: 0 } });
    const input = vectorInput(vector("V03"), {
      to: ownerAddress,
      ids: { [VECTOR_THREAD_ID]: first.providerId ?? first.messageId },
      overrides: { from: OUTLOOK, subject: `Automatic reply: ${first.subject}`, at: clock.now() },
    });
    expect(input).toMatchObject({ envelopeSender: "", headers: expect.arrayContaining([["Auto-Submitted", "auto-generated"], ["X-Auto-Response-Suppress", "All"]]) });
    const before = (await notificationsOf(owner.id)).length;
    const posted = await postInbound(fake, input);
    expect(await workerB.tickOnce()).toBe(0);
    expect(await db.inboundMessage.findUniqueOrThrow({ where: { id: posted.id! } })).toMatchObject({ kind: "AUTO_REPLY", autoReason: "out-of-office", linkMethod: "headers" });
    expect(await recipientOf(B.campaignId, B.people[OUTLOOK]!)).toMatchObject({ state: "WAITING", currentStep: 1 });
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: B.campaignId, toNorm: OUTLOOK, step: 1 } })).status).toBe("QUEUED");
    expect((await notificationsOf(owner.id)).length).toBe(before);
  });

  it("4. the reply-test answers from before are test replies: nothing stopped, nobody told", async () => {
    const answers = await db.inboundMessage.findMany({ where: { subject: "Re: Reply test from Polygon Paradise Outreach" } });
    expect(answers.map((r) => [r.kind, r.replyScope, r.companyId])).toEqual(Array(3).fill(["TEST_REPLY", "none", null]));
    // The test companies' timelines have only the Gmail reply and the Outlook.com out-of-office.
    const timeline = await db.activityLog.findMany({ where: { type: { startsWith: "reply." }, companyId: { in: Object.values(B.companies) } } });
    expect(timeline.map((a) => a.type).sort()).toEqual(["reply.auto", "reply.received"]);
  });

  it("5. the next day exactly 2 follow-ups reach Mailgun (Outlook.com and the other mailbox), in the same thread", async () => {
    clock.set(THURSDAY_1005_BERLIN);
    await tickUntil(workerB, B.campaignId, () => campaignMessages(B.campaignId, 1).length >= 2);
    const followUps = campaignMessages(B.campaignId, 1);
    expect(followUps.map((m) => m.fields.to?.[0]).sort()).toEqual([OTHER, OUTLOOK].sort());
    for (const m of followUps) {
      const first = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: B.campaignId, toNorm: m.fields.to![0]!, step: 0 } });
      const received = first.providerId && first.providerId.includes("@") ? first.providerId : first.messageId;
      expect(m.fields["h:In-Reply-To"]).toEqual([`<${received}>`]);
      expect(m.fields["h:References"]?.[0]?.split(" ")).toContain(`<${first.messageId}>`);
      // "Re: " + the first email's subject exactly as this mailbox received it.
      expect(m.fields.subject).toEqual([`Re: ${first.subject}`]);
      expect(campaignMessages(B.campaignId, 0).find((x) => x.fields.to?.[0] === m.fields.to?.[0])?.fields.subject).toEqual([first.subject]);
      expect(m.fields["o:tag"]).toEqual(["outreach", "step-1"]);
    }
    // Still Thursday, inside the sending hours; never to Gmail.
    expect(clock.now().getTime()).toBeLessThan(new Date("2026-09-24T15:00:00.000Z").getTime());
    expect(campaignMessages(B.campaignId).filter((m) => m.fields.to?.[0] === GMAIL)).toHaveLength(1);
  });

  it("6. the campaign page: 5 sent, 1 replied; the campaign has finished", async () => {
    const overview = await getCampaignOverview(B.campaignId);
    expect(overview!.results).toMatchObject({ sent: 5, replied: 1 });
    expect(overview!.status).toBe("FINISHED");
    expect(errors).toEqual([]);
  });
});

// ───────────────────────── Part C: the PC was off too long ─────────────────────────

describe("Part C: after the PC was off too long, follow-ups wait until their sender has checked the inbox", () => {
  const C = { campaignId: 0 };
  let workerC: Worker;
  const logsCursor = `${D}:logs`;
  let cursorAt = "";

  async function setLogsCursor(iso: string) {
    await dbWrite((c) => c.syncCursor.upsert({ where: { key: logsCursor }, create: { key: logsCursor, value: iso }, update: { value: iso } }));
  }

  async function runCatchUp() {
    const job = registry["mailgun.catchUp"]!;
    const ctx = { jobId: 1, createdById: null, signal: new AbortController().signal, progress: async () => undefined };
    return (await job.handler({ reason: "hourly" }, ctx)) as { summary: string };
  }

  async function recipients() {
    return db.campaignRecipient.findMany({ where: { campaignId: C.campaignId, included: true }, orderBy: { id: "asc" } });
  }

  it("1. Ali sends a second live campaign with a 3-day follow-up to the Outlook.com and other mailboxes on Thursday", async () => {
    const companyIds = await db.company.findMany({ where: { name: { in: ["Test – Outlook", "Test – Proton"] } }, select: { id: true } });
    const d = await draft.createDraft(ali, { companyIds: companyIds.map((c) => c.id), timeZone: "Europe/Berlin", now: clock.now() });
    C.campaignId = d.id;
    await draft.renameDraft(ali, d.id, "Second live test");
    const [s0, s1] = MASTER_SEQUENCE.steps;
    await draft.saveDraftSteps(ali, d.id, [
      { step: 0, enabled: true, subject: s0!.subject, body: s0!.body, delayDays: 0 },
      { step: 1, enabled: true, subject: null, body: s1!.body, delayDays: 3 },
    ]);
    expect(await draft.launchDraft(ali, d.id, { now: clock.now(), mailgun })).toMatchObject({ status: "RUNNING", mode: "LIVE", queued: 2 });
    workerC = newWorker();
    expect(await workerC.runOnce()).toBe(0);
    await tickUntil(workerC, d.id, () => campaignMessages(d.id, 0).length >= 2);
    expect(campaignMessages(d.id, 0).map((m) => m.fields.from?.[0])).toEqual(Array(2).fill(`Ali from Polygon Paradise <${aliAddress}>`));
    const sent = await db.outboundEmail.findMany({ where: { campaignId: d.id, step: 0 } });
    for (const e of sent) expect(e.sentAt!.toISOString().slice(0, 10)).toBe("2026-09-24");
    expect((await recipients()).map((r) => r.state)).toEqual(["WAITING", "WAITING"]);
  });

  it("2. seven days later the check with Mailgun finds the gap: the follow-ups are held, Ali and the Owner are told", async () => {
    cursorAt = new Date("2026-09-24T10:00:00.000Z").toISOString();
    await setLogsCursor(cursorAt);
    clock.set(new Date("2026-10-01T08:00:00.000Z")); // Thursday 1 Oct, 10:00 in Berlin
    const res = await runCatchUp();
    expect(res.summary).toMatch(/^Checked with Mailgun/);

    const outage = (await readTyped("catchup.outage", parseOutageState)).value;
    expect(outage).toMatchObject({ from: cursorAt, beyondLogRetention: true, heldFor: cursorAt, heldCount: 2 });
    expect(outage.handledAt).not.toBeNull();
    expect((await recipients()).map((r) => [r.state, r.holdReason])).toEqual([
      ["HELD", "outage"],
      ["HELD", "outage"],
    ]);
    const held = await db.notification.findMany({ where: { type: "outage.hold" }, orderBy: { userId: "asc" } });
    expect(held.map((n) => [n.userId, n.link])).toEqual([
      [owner.id, "/settings/sending"],
      [ali.id, "/notifications#on-hold"],
    ]);
    // The dates are the unchecked window (the replies that may have been missed), not the PC's off-time (review SPEC-03).
    expect(held[0]!.title).toBe("Follow-ups are on hold: replies from 24 Sept to 26 Sept may have been missed");
    expect(held[1]!.body).toContain("Follow-ups of 2 people are waiting.");
    expect(await db.activityLog.count({ where: { type: "followups.held" } })).toBe(1);

    // The rounds send nothing to the held people, although their follow-ups are due.
    expect(await workerC.tickOnce()).toBe(0);
    clock.advance(10 * MIN);
    expect(await workerC.tickOnce()).toBe(0);
    expect(campaignMessages(C.campaignId, 1)).toHaveLength(0);
  });

  it("3–4. Ali continues the follow-ups; the same gap found again by a later check holds nobody and tells nobody", async () => {
    expect(await releaseOutageHold(ali, { senderId: ali.id, now: clock.now() })).toEqual({ released: 2, firstEmails: 0 });
    expect((await recipients()).map((r) => [r.state, r.holdReason, r.heldAt])).toEqual([
      ["WAITING", null, null],
      ["WAITING", null, null],
    ]);
    expect(await db.activityLog.count({ where: { type: "followups.released" } })).toBe(1);

    // An incomplete walk records the same gap again (the cursor back where it was): it is covered, nothing changes.
    await setLogsCursor(cursorAt);
    await runCatchUp();
    const outage = (await readTyped("catchup.outage", parseOutageState)).value;
    expect(outage).toMatchObject({ heldFor: cursorAt, heldCount: 2 });
    expect(outage.handledAt).not.toBeNull();
    expect((await recipients()).map((r) => r.state)).toEqual(["WAITING", "WAITING"]);
    expect(await db.notification.count({ where: { type: "outage.hold" } })).toBe(2);

    // Inside the sending hours the follow-ups go, in the same thread.
    await tickUntil(workerC, C.campaignId, () => campaignMessages(C.campaignId, 1).length >= 2);
    const followUps = campaignMessages(C.campaignId, 1);
    expect(followUps.map((m) => m.fields.to?.[0]).sort()).toEqual([OTHER, OUTLOOK].sort());
    for (const m of followUps) {
      const first = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: C.campaignId, toNorm: m.fields.to![0]!, step: 0 } });
      expect(m.fields["h:In-Reply-To"]).toEqual([`<${first.providerId ?? first.messageId}>`]);
    }
    expect((await db.campaign.findUniqueOrThrow({ where: { id: C.campaignId } })).status).toBe("FINISHED");
    expect(errors).toEqual([]);
  });
});
