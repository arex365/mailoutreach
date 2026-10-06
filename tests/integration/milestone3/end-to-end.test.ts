import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeUser, setSettingValue } from "../campaigns/seed";
import { startFakeMailgun, type FakeMailgun } from "../../fake-mailgun/server";
import { FakeDns, goodZone } from "../../unit/checks/fake-dns";
import type { JobRegistry } from "../../../worker/jobs";

/**
 * Milestone 3 end to end (M3-DESIGN §8 P6), on real data (not the practice copy), with the local fake Mailgun and a
 * fixed clock that starts on Wednesday 23 Sep 2026 at 10:00 in Berlin (inside the default sending hours). Nothing is
 * mocked inside the app: Mailgun is the fake server, DNS is a fake resolver table, and the app's public address is
 * answered in-process by its own health route and webhook handler. Nothing reaches the network.
 *
 *   1. connect → Apply recommended settings → a sending address → a test list of 3 → mode Live
 *   2. a live launch is refused until the reply test has passed
 *   3. the reply test: 3 emails (a rerun sends nothing), deliveries, replies and an unsubscribe through signed
 *      webhooks, the mailbox put back, the answers → passed
 *   4. a live campaign to the 3 test mailboxes (+1 real company, left out), sent by the worker with pacing; the event
 *      lane files the reply-test replies as test replies (Milestone 4), and each first email prepares its follow-up
 *   5. delivered / bounced / spam complaint through webhooks → event lane → counts, flags, suppressions, notices, and
 *      the bounced and complained addresses' follow-ups stop
 *   6. the check with Mailgun is idempotent, and its onSuccess evaluates the warm-up
 *   7. Setup B: live launches refused, queued live emails wait, nothing reaches Mailgun; back to Setup A
 *   8. a restart with an answer lost after Mailgun accepted the email: the reconciler records it sent, once
 *   9. Pause all sending: nothing goes out; Resume: it goes out
 */

// The worker's start-up reads <database folder>/RESTORED; data/test is shared by all test files, so use a folder of our own.
const created = await createTestDb("m3-end-to-end");
const dir = path.join(path.dirname(created.file), `m3-e2e-${process.pid}-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
const dbFile = path.join(dir, "m3-e2e.db");
fs.copyFileSync(created.file, dbFile);
created.cleanup();
process.env.DATABASE_URL = "file:" + dbFile.replace(/\\/g, "/");

const D = "send.example.com";
const PUB = "http://127.0.0.1:3100";
const EVENTS_URL = `${PUB}/api/webhooks/mailgun/events`;
const INBOUND_URL = `${PUB}/api/webhooks/mailgun/inbound`;
const OUTLOOK = "t.outlook@outlook.com";
const GMAIL = "t.gmail@gmail.com";
const OTHER = "t.other@proton.me";
const REAL = "anna@printwerk.de";
const WEDNESDAY_10_BERLIN = new Date("2026-09-23T08:00:00.000Z");
const THURSDAY_10_BERLIN = new Date("2026-09-24T08:00:00.000Z");
const MIN = 60_000;

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
const { getSetting, setSetting } = await import("@/server/settings");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { enqueueJob } = await import("@/server/jobs");
const { GET: healthGET } = await import("@/app/api/health/route");
const { POST: eventsRoutePOST } = await import("@/app/api/webhooks/mailgun/events/route");
const { handleEventWebhook, handleInboundWebhook } = await import("@/server/services/mail-events/webhook");
const { connectMailgun } = await import("@/server/services/mailgun/connect");
const { runApplySettings, parseApplyPayload } = await import("@/server/services/mailgun/apply-settings");
const { runDomainCheck } = await import("@/server/services/checks/domain-check");
const { setSenderLocalPart } = await import("@/server/services/sender-addresses");
const replyTest = await import("@/server/services/reply-test");
const { sendReplyTestEmails, replyTestMessageId } = await import("@/server/services/test-send");
const { removeOwnSuppression } = await import("@/server/services/mailgun/suppressions");
const draft = await import("@/server/services/campaigns/draft");
const { getCampaignOverview } = await import("@/server/services/campaigns/queries");
const { pauseSending, resumeSending } = await import("@/server/services/sending/pause");
const { SendingLoop } = await import("../../../worker/sending");
const { BackgroundWorker } = await import("../../../worker/main");
const { createJobRegistry } = await import("../../../worker/jobs");
const { recordTaskSuccess } = await import("../../../worker/periodic");
const { DOMAIN_CHECK_TASK, verifyFromPayload } = await import("../../../worker/jobs/mailgun-check-domain");
const { UNSUBSCRIBE_PLACEHOLDER } = await import("@/core/templates/html");

/** Fast retries and a short timeout against the fake. */
const mailgun = () => getMailgunContext({ retryDelayMs: () => 0, timeoutMs: 2_000 });

/**
 * The app's public address, answered in-process: GET /api/health by the health route, the webhook path by the webhook
 * handler (the remote-access self-check). Anything else (cloudflared's /ready on this PC, the internet) is refused.
 */
const appFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === `${PUB}/api/health`) return healthGET();
  if (url === EVENTS_URL) return handleEventWebhook(new Request(url, init), { now: clock.now() });
  throw new TypeError(`fetch failed (no network in this test: ${url})`);
}) as typeof fetch;

/** Both public resolvers see Mailgun's records (the fake's own values). */
const dnsLookups = () => [new FakeDns(goodZone(D)), new FakeDns(goodZone(D))] as [FakeDns, FakeDns];

/**
 * The worker's registry on the test clock, with the two jobs that would otherwise reach the network pointed at the
 * in-process public address and the fake DNS table; the daily backup and clean-up are done already.
 */
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

const quiet = { info: () => undefined, warn: () => undefined, error: (m: string, e?: unknown) => errors.push(`${m}${e ? `: ${String(e)}` : ""}`) };
const errors: string[] = [];

function newWorker() {
  return new BackgroundWorker({ now: clock.now, mailgun, random: () => 0, fetchImpl: appFetch, logger: quiet, registry });
}

type Owner = { id: number; name: string; role: "OWNER" };
let owner: Owner;
let ownerAddress = "";

async function postEvent(eventData: object, opts: { viaRoute?: boolean } = {}) {
  if (opts.viaRoute) {
    // Through the route file itself: its freshness check runs on the real clock, so sign with the real time.
    const res = await eventsRoutePOST(fake.signedEventRequest(EVENTS_URL, eventData, { timestamp: String(Math.floor(Date.now() / 1000)) }));
    expect(res.status).toBe(200);
    return;
  }
  const res = await handleEventWebhook(fake.signedEventRequest(EVENTS_URL, eventData), { now: clock.now() });
  expect(res.status).toBe(200);
}

async function postReply(from: string, inReplyTo: string) {
  const { fields } = fake.receive({ from, to: ownerAddress, subject: "Re: Reply test from Polygon Paradise Outreach", text: "Got it", inReplyTo });
  const res = await handleInboundWebhook(fake.signedInboundRequest(INBOUND_URL, fields), { now: clock.now() });
  expect(res.status).toBe(200);
}

/** The fake's messages for one campaign (by v:campaign_id). */
function campaignMessages(campaignId: number) {
  return fake.messages.filter((m) => m.fields["v:campaign_id"]?.[0] === String(campaignId));
}

function bare(id: string | undefined): string {
  return (id ?? "").replace(/^<|>$/g, "").toLowerCase();
}

async function pacer() {
  return (await getState<{ nextSendAt: string | null; waiting: { reason: string; until: string | null } | null }>("sending.pacer"))?.value;
}

async function pause() {
  return (await getState<{ paused: boolean; kind: string | null; reason: string }>("sending.pause"))?.value;
}

let firstCampaignId = 0;
let secondCampaignId = 0;
let outlookCompanyId = 0;
let testPeople: Record<string, number> = {};

beforeAll(async () => {
  const user = await makeUser("Arslan", { role: "OWNER", email: "arslan@polygonparadise.test", senderDisplayName: "Arslan from Polygon Paradise" });
  await dbWrite((c) => c.user.update({ where: { id: user.id }, data: { replyInbox: "arslan.owner@gmail.com", signature: "Arslan\nPolygon Paradise" } }));
  owner = { id: user.id, name: user.name, role: "OWNER" };
  await setSettingValue("practice.copy", false);
  // The daily backup and clean-up aren't part of this test.
  for (const name of ["backup.daily", "cleanup.daily"]) await recordTaskSuccess(name, clock.now());
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

describe("Milestone 3 end to end: Mailgun, from connecting to a live campaign to the test mailboxes", () => {
  it("1. connects, applies the recommended settings, sets up a sending address, a test list and Live mode", async () => {
    const connected = await connectMailgun(owner, { region: "EU", domain: D, apiKey: "key-fake-api" }, { retryDelayMs: () => 0 });
    expect(connected).toMatchObject({ ok: true });
    fake.setDns("all");

    const setup = await runApplySettings({ byUserId: owner.id, mailgun, fetchImpl: appFetch, now: clock.now() });
    expect(setup.steps.filter((s) => s.ok === false).map((s) => `${s.key}: ${s.text}`)).toEqual([]);
    const state = fake.state();
    expect(state.tracking).toMatchObject({ open: { active: false }, click: { active: false }, unsubscribe: { active: true } });
    // The webhooks were really registered with the fake, for the app's own events address.
    const hooks = Object.entries(state.webhooks);
    expect(hooks.map(([type]) => type).sort()).toEqual(["complained", "delivered", "permanent_fail", "temporary_fail", "unsubscribed"]);
    for (const [, urls] of hooks) expect(urls).toEqual([EVENTS_URL]);

    // The Owner's sending address; the route sync and the domain check run in the worker's next round.
    const address = await setSenderLocalPart(owner, owner.id, "arslan");
    ownerAddress = address.address;
    expect(ownerAddress).toBe(`arslan@${D}`);
    expect(await newWorker().tickOnce()).toBe(0);
    const sender = await db.senderAddress.findUniqueOrThrow({ where: { address: ownerAddress } });
    expect(sender).toMatchObject({ routeStatus: "ok", forwardTo: "arslan.owner@gmail.com" });
    const routes = fake.state().routes.map((r) => String(r.description)).sort();
    expect(routes).toEqual([`outreach-app:catchall:${D}`, `outreach-app:dmarc:${D}`, `outreach-app:sender:${sender.id}`]);

    // "Check again" on the Domain checklist: Mailgun re-checks the DNS records too, then the rows are read.
    await enqueueJob({ type: "mailgun.checkDomain", payload: { verify: true }, dedupeKey: "mailgun:domain-check", priority: 20, createdById: owner.id });
    expect(await newWorker().tickOnce()).toBe(0);

    // The domain checklist (the worker's check with the fake DNS): everything Live needs is done.
    const check = (await getState<{ domain: string; rows: Array<{ key: string; status: string; text: string }> }>("domain.check"))?.value;
    expect(check?.domain).toBe(D);
    const notOk = check!.rows.filter((r) => r.status !== "ok" && !["reply-test", "https-links", "monthly-limit", "postmaster", "domain-age"].includes(r.key));
    expect(notOk.map((r) => `${r.key}: ${r.status} ${r.text}`)).toEqual([]);

    const list = await replyTest.saveTestList(owner, [OUTLOOK, GMAIL, OTHER]);
    expect(list).toMatchObject({ ok: true, value: [OUTLOOK, GMAIL, OTHER] });

    const gate = await replyTest.loadGateInputs(clock.now());
    expect(replyTest.modeBlockersFor("LIVE", gate)).toEqual([]);
    await setSetting("sending.mode", "LIVE", owner.id);
  });

  it("2. refuses a live launch until the reply test has passed", async () => {
    const people: Record<string, number> = {};
    const companyIds: number[] = [];
    for (const [name, email] of [
      ["Test – Outlook", OUTLOOK],
      ["Test – Gmail", GMAIL],
      ["Test – Proton", OTHER],
      ["Printwerk", REAL],
    ] as const) {
      const { company, people: ps } = await makeCompany({ name, domain: name === "Printwerk" ? "printwerk.de" : null, people: [{ name: `${name} inbox`, email }] });
      companyIds.push(company.id);
      people[email] = ps[0]!.id;
      if (email === OUTLOOK) outlookCompanyId = company.id;
    }
    testPeople = people;
    const d = await draft.createDraft(owner, { companyIds, timeZone: "Europe/Berlin" });
    firstCampaignId = d.id;
    await draft.renameDraft(owner, d.id, "Live test to the test mailboxes");
    await draft.setDraftSender(owner, d.id, owner.id);
    await expect(draft.launchDraft(owner, d.id, { now: clock.now(), mailgun })).rejects.toMatchObject({
      message: "Live campaigns start once the reply test has passed (Settings › Domain checklist › Reply test).",
      code: "mode-not-ready",
    });
    expect((await db.campaign.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("DRAFT");
    expect(fake.messages).toHaveLength(0);
  });

  it("3. runs the reply test: emails, deliveries, replies, one unsubscribe (put back), the answers → passed", async () => {
    expect(replyTest.replyTestBlockersFor(await replyTest.loadGateInputs(clock.now()))).toEqual([]);
    const jobId = 9001;
    const first = await sendReplyTestEmails(owner.id, { jobId, now: clock.now(), mailgun });
    expect(first).toMatchObject({ sent: 3, failed: 0 });
    expect(fake.messages).toHaveLength(3);
    const ids = new Map<string, string>();
    for (const address of [OUTLOOK, GMAIL, OTHER]) {
      const id = replyTestMessageId(jobId, address, D);
      ids.set(address, id);
      const msg = fake.messages.find((m) => bare(m.fields["h:Message-Id"]?.[0]) === id);
      expect(msg?.fields.to).toEqual([address]);
      expect(msg?.fields.subject).toEqual(["Reply test from Polygon Paradise Outreach"]);
      expect(msg?.fields["o:testmode"]).toBeUndefined();
    }
    // A rerun of the same job never sends a mailbox twice.
    const again = await sendReplyTestEmails(owner.id, { jobId, now: clock.now(), mailgun });
    expect(again.sent).toBe(0);
    expect(fake.messages).toHaveLength(3);

    clock.advance(2 * MIN);
    for (const address of [OUTLOOK, GMAIL, OTHER]) await postEvent(fake.deliver(ids.get(address)!));
    clock.advance(5 * MIN);
    for (const address of [OUTLOOK, GMAIL, OTHER]) await postReply(address, ids.get(address)!);
    clock.advance(MIN);
    // One mailbox clicks the unsubscribe link: Mailgun reports it, the app puts the address on the do-not-email list…
    await postEvent(fake.unsubscribe(ids.get(GMAIL)!));
    expect(await db.suppression.findUnique({ where: { emailNorm: GMAIL } })).toMatchObject({ reason: "UNSUBSCRIBED" });
    // …and the Owner puts the test mailbox back (Settings › Deliverability › Remove).
    const removed = await removeOwnSuppression(owner, GMAIL, { mailgun });
    expect(removed).toEqual({ removed: true, mailgunProblem: null });
    expect(await db.suppression.findUnique({ where: { emailNorm: GMAIL } })).toBeNull();
    expect((await db.person.findUniqueOrThrow({ where: { id: testPeople[GMAIL]! } })).unsubscribedAt).toBeNull();
    expect(fake.state().suppressions.unsubscribes).toEqual([]);

    const data = await replyTest.loadReplyTest(clock.now());
    for (const address of [OUTLOOK, GMAIL, OTHER]) expect(data.facts.get(address)).toMatchObject({ delivered: true, replyStored: true });
    expect(data.unsubscribeSeen).toBe(true);

    const saved = await replyTest.saveReplyTestAnswers(owner, {
      mailboxes: [
        { address: OUTLOOK, inboxOk: true, authOk: "pass" },
        {
          address: GMAIL,
          inboxOk: true,
          authOk: "unsure",
          pastedHeaders: "Delivered-To: arslan.owner@gmail.com\nAuthentication-Results: mx.google.com;\n       dkim=pass header.i=@send.example.com header.s=pdk1\n",
        },
        { address: OTHER, inboxOk: true, authOk: "pass" },
      ],
      headersOk: true,
    });
    expect(saved.authFromHeaders).toEqual({ [GMAIL]: "pass" });
    expect(await replyTest.decideReplyTest(owner, clock.now())).toEqual({ status: "passed", missing: [] });
    expect(await getSetting("mailgun.unsubscribeTest")).toMatchObject({ status: "passed", domain: D, setup: "A" });
  });

  it("4. sends a live campaign to the 3 test mailboxes (the real company left out), paced; the follow-ups wait for their day", async () => {
    clock.set(new Date(WEDNESDAY_10_BERLIN.getTime() + 30 * MIN));
    const launched = await draft.launchDraft(owner, firstCampaignId, { now: clock.now(), mailgun });
    expect(launched).toMatchObject({ status: "RUNNING", mode: "LIVE", queued: 3 });
    const excluded = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: firstCampaignId, personId: testPeople[REAL]! } });
    expect(excluded).toMatchObject({ included: false, exclusionReason: expect.stringMatching(/^Not on the test list/) });
    // Milestone 4: a live launch keeps the draft's follow-ups (the A7 master sequence: +3 days, +4 days, the third off).
    const steps = await db.campaignStep.findMany({ where: { campaignId: firstCampaignId }, orderBy: { step: "asc" } });
    expect(steps.map((s) => [s.step, s.enabled, s.delayDays])).toEqual([
      [0, true, 0],
      [1, true, 3],
      [2, true, 4],
      [3, false, 7],
    ]);

    // The replies from step 3 are stored and still unprocessed until the worker's event lane runs.
    expect(await db.inboundMessage.count({ where: { processedAt: null, toAddress: ownerAddress } })).toBe(3);

    // A fresh worker: start-up (the check with Mailgun first), then rounds; the clock jumps to each pacing slot.
    const worker = newWorker();
    expect(await worker.runOnce()).toBe(0);
    const catchUp = (await getState<{ lastReason: string; lastSuccessAt: string }>("mailgun.catchUp"))?.value;
    expect(catchUp?.lastReason).toBe("startup");
    expect(Date.parse(catchUp!.lastSuccessAt)).toBeGreaterThanOrEqual(worker.startedAt.getTime());
    // Milestone 4: the event lane processed the three replies. They answer reply-test emails and come from the test
    // mailboxes, so they are test replies: nothing linked, stopped, notified or put on the waiting list.
    const testReplies = await db.inboundMessage.findMany({ where: { toAddress: ownerAddress }, orderBy: { id: "asc" } });
    expect(testReplies.map((r) => [r.kind, r.replyScope, r.companyId, r.processedAt !== null])).toEqual([
      ["TEST_REPLY", "none", null, true],
      ["TEST_REPLY", "none", null, true],
      ["TEST_REPLY", "none", null, true],
    ]);
    expect(await db.notification.count({ where: { type: { startsWith: "reply." } } })).toBe(0);
    expect(await db.activityLog.count({ where: { type: { startsWith: "reply." } } })).toBe(0);
    // The reply test's page still sees them ("Reply reached the app").
    const facts = (await replyTest.loadReplyTest(clock.now())).facts;
    for (const address of [OUTLOOK, GMAIL, OTHER]) expect(facts.get(address)).toMatchObject({ replyStored: true });
    for (let round = 0; round < 6 && campaignMessages(firstCampaignId).length < 3; round++) {
      const p = await pacer();
      const next = Math.max(Date.parse(p?.nextSendAt ?? "") || 0, Date.parse(p?.waiting?.until ?? "") || 0);
      if (next > clock.now().getTime()) clock.set(new Date(next + 1_000));
      expect(await worker.tickOnce()).toBe(0);
    }
    const messages = campaignMessages(firstCampaignId);
    expect(messages.map((m) => m.fields.to?.[0]).sort()).toEqual([GMAIL, OTHER, OUTLOOK].sort());
    // Still Wednesday, inside sending hours (the last one before 17:00 in Berlin).
    expect(clock.now().getTime()).toBeLessThan(new Date("2026-09-23T15:00:00.000Z").getTime());
    const rows = await db.outboundEmail.findMany({ where: { campaignId: firstCampaignId, step: 0 }, orderBy: { id: "asc" } });
    expect(rows.map((r) => [r.step, r.status, r.mode])).toEqual([
      [0, "SENT", "LIVE"],
      [0, "SENT", "LIVE"],
      [0, "SENT", "LIVE"],
    ]);
    const sentTimes = rows.map((r) => r.sentAt!.getTime()).sort((a, b) => a - b);
    expect(sentTimes[1]! - sentTimes[0]!).toBeGreaterThanOrEqual(20 * MIN); // spaced out, not in a burst
    for (const m of messages) {
      const row = rows.find((r) => r.toNorm === m.fields.to?.[0])!;
      expect(bare(m.fields["h:Message-Id"]?.[0])).toBe(row.messageId);
      expect(row.providerId).not.toBeNull();
      expect(m.fields["o:tag"]).toEqual(["outreach", "step-0"]);
      expect(m.fields["v:send_id"]).toEqual([row.sendId]);
      expect(m.fields["v:campaign_id"]).toEqual([String(firstCampaignId)]);
      expect(m.fields["v:step"]).toEqual(["0"]);
      expect(m.fields["o:tracking-opens"]).toEqual(["no"]);
      expect(m.fields["o:tracking-clicks"]).toEqual(["no"]);
      expect(m.fields["o:testmode"]).toBeUndefined();
      expect(m.fields.from).toEqual([`Arslan from Polygon Paradise <${ownerAddress}>`]);
      expect(m.fields.text?.[0]).toContain(UNSUBSCRIBE_PLACEHOLDER);
      expect(m.fields.html?.[0]).toContain(UNSUBSCRIBE_PLACEHOLDER);
    }
    // Each message went to Mailgun exactly once.
    const allIds = fake.messages.map((m) => bare(m.fields["h:Message-Id"]?.[0]));
    expect(new Set(allIds).size).toBe(allIds.length);
    // Milestone 4: each first email prepared follow-up 1 in the same thread. Sent on Wednesday + 3 calendar days is a
    // Saturday, so it waits for Monday's first sending hour in the recipient's zone (Berlin, the default).
    const followUps = await db.outboundEmail.findMany({ where: { campaignId: firstCampaignId, step: { gt: 0 } }, orderBy: { id: "asc" } });
    expect(followUps.map((r) => [r.step, r.status, r.mode, r.dueAt.toISOString()])).toEqual([
      [1, "QUEUED", "LIVE", "2026-09-28T07:00:00.000Z"],
      [1, "QUEUED", "LIVE", "2026-09-28T07:00:00.000Z"],
      [1, "QUEUED", "LIVE", "2026-09-28T07:00:00.000Z"],
    ]);
    for (const f of followUps) {
      const first = rows.find((r) => r.recipientId === f.recipientId)!;
      const received = first.providerId && first.providerId.includes("@") ? first.providerId : first.messageId;
      expect(f.inReplyTo).toBe(received);
      expect(f.references?.split(" ")).toContain(first.messageId);
      expect(f.fromAddress).toBe(first.fromAddress);
    }
    const recipients = await db.campaignRecipient.findMany({ where: { campaignId: firstCampaignId, included: true } });
    expect(recipients.map((r) => [r.state, r.currentStep])).toEqual([
      ["WAITING", 1],
      ["WAITING", 1],
      ["WAITING", 1],
    ]);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: firstCampaignId } })).status).toBe("RUNNING");
    // §1.7: before go-live, emails to the test mailboxes don't count as "emailed".
    const outlookCompany = await db.company.findUniqueOrThrow({ where: { id: outlookCompanyId } });
    expect(outlookCompany).toMatchObject({ status: "NOT_CONTACTED", lastEmailedAt: null });
    expect(errors).toEqual([]);
  });

  it("5. applies a delivery, a hard bounce and a spam complaint reported by Mailgun", async () => {
    const rows = await db.outboundEmail.findMany({ where: { campaignId: firstCampaignId, step: 0 } });
    const row = (to: string) => rows.find((r) => r.toNorm === to)!;
    clock.advance(10 * MIN);
    await postEvent(fake.deliver(row(OUTLOOK).messageId), { viaRoute: true });
    await postEvent(fake.bounce(row(OTHER).messageId, { reason: "bounce", code: 550 }));
    await postEvent(fake.complain(row(GMAIL).messageId));
    // The instant effects happen in the webhook's own transaction.
    expect(await db.suppression.findUnique({ where: { emailNorm: OTHER } })).toMatchObject({ reason: "BOUNCED", source: "webhook" });
    expect(await db.suppression.findUnique({ where: { emailNorm: GMAIL } })).toMatchObject({ reason: "COMPLAINED" });

    // The event lane (the worker's next round) writes the activity, notifies the Owner and runs the health check.
    expect(await newWorker().tickOnce()).toBe(0);
    const overview = await getCampaignOverview(firstCampaignId);
    expect(overview!.results).toMatchObject({ sent: 3, delivered: 1, bounced: 1, complained: 1 });
    expect((await db.person.findUniqueOrThrow({ where: { id: testPeople[OTHER]! } })).bouncedAt).not.toBeNull();
    expect((await db.person.findUniqueOrThrow({ where: { id: testPeople[GMAIL]! } })).complainedAt).not.toBeNull();
    // Milestone 4: their follow-ups stop; the Outlook.com mailbox's follow-up still waits for Monday.
    const recipients = await db.campaignRecipient.findMany({ where: { campaignId: firstCampaignId, included: true } });
    const stateOf = (to: string) => recipients.find((r) => r.emailNorm === to)!;
    expect([stateOf(OTHER).state, stateOf(OTHER).stopReason]).toEqual(["STOPPED", "bounced"]);
    expect([stateOf(GMAIL).state, stateOf(GMAIL).stopReason]).toEqual(["STOPPED", "complained"]);
    expect(stateOf(OUTLOOK).state).toBe("WAITING");
    const followUps = await db.outboundEmail.findMany({ where: { campaignId: firstCampaignId, step: 1 } });
    expect(Object.fromEntries(followUps.map((f) => [f.toNorm, f.status]))).toEqual({ [OUTLOOK]: "QUEUED", [OTHER]: "SKIPPED", [GMAIL]: "SKIPPED" });
    const activity = await db.activityLog.findMany({ where: { campaignId: firstCampaignId, type: { in: ["email.delivered", "email.bounced", "email.complained"] } } });
    expect(activity.map((a) => a.type).sort()).toEqual(["email.bounced", "email.complained", "email.delivered"]);
    expect(activity.find((a) => a.type === "email.delivered")?.summary).toBe(`Delivered to ${OUTLOOK}`);
    const complaintNote = await db.notification.findFirstOrThrow({ where: { type: "email.complained", userId: owner.id } });
    expect(complaintNote.title).toBe(`${GMAIL} marked an email as spam`);
    // 1 bounce and 1 complaint don't pause sending; the complaint is half the limit, so the Owner is warned.
    expect((await pause())?.paused ?? false).toBe(false);
    expect(await db.notification.count({ where: { type: "sending.warning" } })).toBe(1);

    // Neither address can be emailed again: a new campaign leaves both out.
    const next = await draft.createDraft(owner, { companyIds: [outlookCompanyId], timeZone: "Europe/Berlin" });
    expect(next.id).toBeGreaterThan(0);
    const { evaluateCompanies } = await import("@/server/services/eligibility");
    const bounced = await db.person.findUniqueOrThrow({ where: { id: testPeople[OTHER]! }, select: { companyId: true } });
    const complained = await db.person.findUniqueOrThrow({ where: { id: testPeople[GMAIL]! }, select: { companyId: true } });
    const verdicts = await evaluateCompanies([bounced.companyId, complained.companyId], { mode: "LIVE", now: clock.now() });
    for (const v of verdicts.values()) expect(JSON.stringify(v)).toMatch(/bounced|complained|suppressed/);
    await dbWrite((c) => c.campaign.delete({ where: { id: next.id } }));
  });

  it("6. the check with Mailgun changes nothing when run again, and its onSuccess evaluates the warm-up", async () => {
    const catchUp = registry["mailgun.catchUp"]!;
    const ctx = { jobId: 1, createdById: null, signal: new AbortController().signal, progress: async () => undefined };
    // First runs of the day pick up what only the Logs have (accepted events) and the lists after the push.
    clock.advance(30 * MIN);
    await catchUp.handler({ reason: "hourly" }, ctx);
    clock.advance(60 * MIN);
    await catchUp.handler({ reason: "hourly" }, ctx);
    const eventsBefore = await db.mailEvent.count();
    const suppressionsBefore = await db.suppression.count();

    // The next morning: nothing new, and the closed Wednesday is judged for the warm-up.
    clock.set(THURSDAY_10_BERLIN);
    const res = (await catchUp.handler({ reason: "hourly" }, ctx)) as { eventsApplied: number; suppressionsAdded: number };
    expect(res).toMatchObject({ eventsApplied: 0, suppressionsAdded: 0 });
    expect(await db.mailEvent.count()).toBe(eventsBefore);
    expect(await db.suppression.count()).toBe(suppressionsBefore);
    const warmup = (await getState<{ domain: string; step: number; history: Array<{ day: string; used: number; cap: number; result: string }> }>("warmup"))?.value;
    expect(warmup?.domain).toBe(D);
    const wednesday = warmup?.history.find((h) => h.day === "2026-09-23");
    // 3 live emails and 3 reply-test emails of a limit of 50: too little use to rise (and a complaint).
    expect(wednesday).toMatchObject({ cap: 50, used: 6 });
    expect(wednesday?.result).toMatch(/^hold-/);
    expect(warmup?.step).toBe(0);
  });

  it("7. Setup B: live launches are refused and queued live emails wait; nothing reaches Mailgun; back to Setup A", async () => {
    // A live campaign to the one test mailbox that is still clean, launched while Setup A has passed.
    const d = await draft.createDraft(owner, { companyIds: [outlookCompanyId], timeZone: "Europe/Berlin" });
    await draft.renameDraft(owner, d.id, "Second live test");
    await draft.setDraftSender(owner, d.id, owner.id);
    const launched = await draft.launchDraft(owner, d.id, { now: clock.now(), mailgun });
    expect(launched).toMatchObject({ status: "RUNNING", mode: "LIVE", queued: 1 });
    secondCampaignId = d.id;

    await replyTest.switchUnsubscribeSetup(owner, "B");
    const other = await draft.createDraft(owner, { companyIds: [outlookCompanyId], timeZone: "Europe/Berlin" });
    await draft.setDraftSender(owner, other.id, owner.id);
    await expect(draft.launchDraft(owner, other.id, { now: clock.now(), mailgun })).rejects.toMatchObject({ code: "mode-not-ready" });
    await dbWrite((c) => c.campaign.delete({ where: { id: other.id } }));

    const before = fake.messages.length;
    const loop = new SendingLoop({ ownsLease: async () => true, logger: quiet, now: clock.now, mailgun, random: () => 0, startedAt: WEDNESDAY_10_BERLIN });
    const tick = await loop.tick(new AbortController().signal);
    expect(tick?.waiting?.reason).toBe("live-not-ready");
    expect(fake.messages.length).toBe(before);
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: d.id } })).status).toBe("QUEUED");

    await replyTest.switchUnsubscribeSetup(owner, "A");
    expect((await getSetting("mailgun.unsubscribeTest")).setup).toBe("A");
  });

  it("8. after a restart, an email Mailgun accepted but whose answer was lost is recorded sent once, by the reconciler", async () => {
    clock.advance(5 * MIN);
    fake.failNext("POST /v3/:d/messages", { kind: "acceptThenDrop" });
    const worker = newWorker();
    // Start-up (the check with Mailgun), then the queued Apply for Setup A, then the send: the answer is lost.
    expect(await worker.runOnce()).toBe(0);
    const row = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: secondCampaignId } });
    expect(row.status).toBe("UNKNOWN");
    expect(fake.messages.filter((m) => bare(m.fields["h:Message-Id"]?.[0]) === row.messageId)).toHaveLength(1);

    // The next round: the reconciler finds it in Mailgun's logs and records it as sent; nothing is sent again.
    clock.advance(MIN);
    expect(await worker.tickOnce()).toBe(0);
    const after = await db.outboundEmail.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe("SENT");
    clock.advance(15 * MIN);
    expect(await worker.tickOnce()).toBe(0);
    expect(fake.messages.filter((m) => bare(m.fields["h:Message-Id"]?.[0]) === row.messageId)).toHaveLength(1);
    expect(await db.activityLog.count({ where: { type: "email.sent", campaignId: secondCampaignId } })).toBe(1);
  });

  it("9. Pause all sending stops everything, dry runs included; Resume lets it go", async () => {
    await setSetting("sending.mode", "DRY_RUN", owner.id);
    const d = await draft.createDraft(owner, { companyIds: [outlookCompanyId], timeZone: "Europe/Berlin" });
    await draft.setDraftSender(owner, d.id, owner.id);
    const launched = await draft.launchDraft(owner, d.id, { now: clock.now() });
    expect(launched).toMatchObject({ status: "RUNNING", mode: "DRY_RUN", queued: 1 });

    await pauseSending({ kind: "manual", reason: "by Arslan", fixText: "Click Resume sending in Settings › Sending & Mailgun when you're ready.", byUserId: owner.id, now: clock.now() });
    const worker = newWorker();
    expect(await worker.tickOnce()).toBe(0);
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: d.id } })).status).toBe("QUEUED");
    expect((await pacer())?.waiting?.reason).toBe("paused");

    const resumed = await resumeSending({ actorId: owner.id, actorName: owner.name, now: clock.now() });
    expect(resumed.resumed).toBe(true);
    expect(await worker.tickOnce()).toBe(0);
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: d.id } })).status).toBe("SENT");
    expect(errors).toEqual([]);
  });
});
