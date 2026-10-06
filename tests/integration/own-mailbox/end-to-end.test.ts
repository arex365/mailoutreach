import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany } from "../campaigns/seed";
import { startFakeMailgun, type FakeMailgun } from "../../fake-mailgun/server";
import type { FakeMailgunOptions } from "../../fake-mailgun/state";
import { FakeDns, type FakeZone } from "../../unit/checks/fake-dns";
import { testOriginal } from "../../unit/setup-core/originals";

/**
 * The owner's own-mailbox shape end to end (docs/dev/MAIN-DOMAIN-DESIGN.md §9.3): the app sends through example.com
 * itself (standing for polygonparadise.com) on Mailgun's Free plan, every email From "Arslan from Polygon Paradise
 * <contact@example.com>" with no Reply-To, and replies land in the mail provider's inbox, never in the app. Nothing inside
 * the app is mocked but the signed-in user of the server actions: Mailgun is the local fake (US, plan free,
 * `receivesMail: false`, and it also answers send.example.com for step 11), DNS the §9.3 table (both resolvers), there is
 * no public address (APP_PUBLIC_URL empty, like the owner's PC) and the clock is the test's own (Date only, from
 * Wednesday 23 Sep 2026, 10:00 in Berlin, moved on by hand). Nothing reaches the network.
 *
 *   1. Connect (connectMailgunAction, "From example.com itself") and save the From address: plan Free with 1/1 days, no
 *      sending address, no route sync, the own From; neither the public address nor a reply route is asked for.
 *   2. The Domain checklist: the own-mailbox rows (SPF through GoDaddy's _spfm includes "5 of 10", from-mx, DMARC, the
 *      info rows without a public address), the last good MX; the MX pointed at Mailgun: red with the fix that names the
 *      last good MX and never Mailgun's, blocking Live, the reply test and going live, told once; a vanished _spfm
 *      include: red without an SPF value; no _dmarc: the reply test waits for it.
 *   3. Apply recommended settings: no routes, no spam filter or stored-message change, the certificate "not in plan"
 *      (the https-links row "info"), the inbound steps "Not needed…", no public address.
 *   4. The reply test by hand in Live (test list only): the own headers, a preset reply lands outside, the answers, one
 *      pasted original (http link, the mailto: address), the unsubscribe-by-email question, the unsubscribe via the
 *      Logs catch-up, passed for own-mailbox mode.
 *   5. A live test to the test list with a follow-up: the from-mx guard holds it while red; delivered through the
 *      catch-up; the rehearsal (They replied keeps the test company's status; the other follow-up waits for the inbox
 *      check, the Owner is told once; a Member's click lets it go); going live needs the two ticks (and the spam one).
 *   6. A live campaign with one follow-up to four checked prospects: the path, the headers; the follow-ups wait for an
 *      inbox check made after the first emails; Anna's reply lands outside, They replied stops her (and, in a second
 *      campaign she was put back into by hand, her colleague); Ben bounces and Carl unsubscribes (through the catch-up);
 *      Dora's follow-up goes once the inbox was read.
 *   7. The 100 a day: 89 counted sends, the 90th (a test-mode email) goes, the next waits "plan-limit"; "Send me a
 *      test" still goes until 100; the fake's limit refusal pauses a live email without failing it; the same text on an
 *      address check is today's kind.
 *   8. Authorized recipients only (the fake restarted with the test list authorized): a live email to a prospect pauses
 *      with the payment-card sentence, nothing failed.
 *   9. Safety: no route request, no MX record box, no sending address, every message From the own From line without a
 *      Reply-To.
 *  10. The Free plan's 1 day of logs: 5 days saved, the Logs window 23 hours back, a 30-hour-old cursor records a gap
 *      that holds nobody, a complaint only on Mailgun's list is linked and counted.
 *  11. Back to replies through the app (send.example.com): refused while a live campaign runs; afterwards go-live ended,
 *      the reply test reset, contact@example.com the shared From, the own-mailbox rows count for nothing, the mx row
 *      is back after the next check, nothing waits for the inbox check, and the dashboard says go live again.
 *
 * Two places differ from §9.3's wording on purpose, because the flow would otherwise not show them: the from-mx hold of
 * a LIVE email is checked in step 5 (the first LIVE email exists there), and step 6 has a fourth prospect (Dora) whose
 * follow-up shows that the inbox check lets follow-ups go (Anna, Ben and Carl are all stopped). Step 6 makes its
 * follow-ups due the same day by writing their due time (a live campaign's delay is whole days), so an inbox check made
 * earlier that day, before the first emails, can be seen not to count.
 */

type TestUser = { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number };
const auth = vi.hoisted(() => ({ user: null as TestUser | null }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
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
    requireUser: requireUserAction,
    requireOwnerAction: async () => {
      const user = await requireUserAction();
      if (user.role !== "OWNER") throw new AuthError("Only the Owner can do this.", 403);
      return user;
    },
  };
});
// Any real resolver in this file is a bug: node:dns is replaced by one that refuses to be made.
vi.mock("node:dns/promises", () => ({
  Resolver: class {
    constructor() {
      throw new Error("A real DNS resolver was created in a test.");
    }
  },
}));

const t = await createTestDb("own-mailbox-e2e");

/** Wednesday 23 Sep 2026, 10:00 in Berlin (13:00 in Karachi, the cap day's zone): inside the default sending hours. */
const WEDNESDAY_10_BERLIN = new Date("2026-09-23T08:00:00.000Z");
vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
vi.setSystemTime(WEDNESDAY_10_BERLIN);

const D = "example.com";
const APP_D = "send.example.com";
const FROM = "contact@example.com";
const FROM_LINE = `Arslan from Polygon Paradise <${FROM}>`;
const OUTLOOK = "t.outlook@outlook.com";
const GMAIL = "t.gmail@gmail.com";
const MAILTO = "u+x@example.com";
const TZ = "Europe/Berlin";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The fake's answer to a send past the plan's daily limit (tests/fake-mailgun/handlers/messages.ts). */
const LIMIT_TEXT = `Domain ${D} has reached its daily sending limit of 100 messages.`;
/** The fake Mailgun's DKIM record value (tests/fake-mailgun/state.ts dnsRecords). */
const DKIM_VALUE = "k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu5fakekeyfakekeyfakekeyfakekeyfakekeyfakekeyfakekeyQIDAQAB";
/** Mailgun's receiving MX hosts: never in a row's fix except inside NEVER_MAILGUN_MX_TEXT. */
const MAILGUN_MX_HOSTS = ["mxa.mailgun.org", "mxb.mailgun.org", "mxa.eu.mailgun.org", "mxb.eu.mailgun.org"];

const previousEnv = { base: process.env.OUTREACH_MAILGUN_BASE_URL, pub: process.env.APP_PUBLIC_URL };
const FAKE_OPTIONS: FakeMailgunOptions = {
  domain: D,
  region: "US",
  plan: "free",
  receivesMail: false,
  otherDomains: [APP_D],
  apiKey: "key-fake-api",
  signingKey: "key-fake-signing",
};
const fake: FakeMailgun = await startFakeMailgun(FAKE_OPTIONS);
/** Step 8's fake: the same account, restarted with only the test list as authorized recipients. */
let fakeAuthorized: FakeMailgun | null = null;
process.env.OUTREACH_MAILGUN_BASE_URL = fake.origin;
// No public address (the owner's PC): no Cloudflare, no webhooks; Mailgun's reports come through the Logs catch-up.
process.env.APP_PUBLIC_URL = "";

const { db, dbWrite } = await import("@/server/db");
const { getSetting } = await import("@/server/settings");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { classifyStatus, isMailgunError } = await import("@/server/mailgun/errors");
const { loadTeamFrom } = await import("@/server/services/mailgun/team-from");
const { loadPlanLimits } = await import("@/server/services/mailgun/plan");
const { runApplySettings, APPLY_TEXTS } = await import("@/server/services/mailgun/apply-settings");
const { removeOwnSuppression } = await import("@/server/services/mailgun/suppressions");
const { runCatchUp } = await import("@/server/services/mailgun/catch-up");
const { runDomainCheck, FROM_DOMAIN_NOTICE_TEXTS } = await import("@/server/services/checks/domain-check");
const rt = await import("@/server/services/reply-test");
const { sendReplyTestEmails, sendMeATest, TestSendError } = await import("@/server/services/test-send");
const draft = await import("@/server/services/campaigns/draft");
const { cancelCampaign } = await import("@/server/services/campaigns/control");
const { evaluateCompanies } = await import("@/server/services/eligibility");
const { markRepliedByHand } = await import("@/server/services/companies/replied-by-hand");
const { markInboxChecked } = await import("@/server/services/sending/inbox-check");
const loop = await import("@/server/services/sending/loop");
const { explainCampaignWaiting, inboxCheckHeldIds } = await import("@/server/services/sending/gates");
const { countMailgunSendsSince, loadHealthCounts } = await import("@/server/services/sending/usage");
const { getPauseState, resumeSending } = await import("@/server/services/sending/pause");
const { applyOutageHold } = await import("@/server/services/sequences/holds");
const { processPendingMailEvents } = await import("@/server/services/mail-events/process");
const { processPendingInbound } = await import("@/server/services/replies/process");
const { STOP_SKIP_TEXT } = await import("@/server/services/mail-events/stops");
const { connectMailgunAction, saveFromAddressAction, setSendingModeAction, goLiveAction, saveRetentionAction } = await import(
  "@/app/(app)/settings/sending/actions"
);
const { markRepliedAction } = await import("@/components/company-panel/actions");
const { markInboxCheckedAction } = await import("@/components/replies/inbox-check-actions");
const { loadDashboard } = await import("@/app/(app)/dashboard/load");
const { ATTENTION_TEXTS } = await import("@/core/dashboard/attention");
const { APPLY_STEP_TEXTS, checklistTitle } = await import("@/core/dns/checklist");
const { PLAN_TEXTS } = await import("@/core/mailgun/plan");
const { REPLY_TEST_TEXTS } = await import("@/core/reply-test");
const { GO_LIVE_COPY } = await import("@/core/sending/go-live-copy");
const { MODE_GATE_TEXTS, goLiveRowKeys } = await import("@/core/sending/mode-gates");
const { INBOX_CHECK_TEXTS, NEVER_MAILGUN_MX_TEXT, OWN_MAILBOX_TEXTS, OWN_REPLY_TEST_TEXTS, THEY_REPLIED_TEXTS } = await import(
  "@/core/sending/own-mailbox"
);
const { capDayBounds, capDayOf } = await import("@/core/sending/capday");
const { MASTER_SEQUENCE } = await import("@/core/templates/defaults");
type ChecklistRow = import("@/core/system-state").ChecklistRow;

/** Fast retries and a short timeout against the fake. */
const mailgun = () => getMailgunContext({ retryDelayMs: () => 0, timeoutMs: 2_000 });

/** No public address: nothing may be fetched. */
const noFetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new TypeError(`fetch failed (no network in this test: ${url})`);
}) as typeof fetch;

/** MAIN-DOMAIN-DESIGN §9.3's table: the mail provider's MX, GoDaddy's two _spfm includes, Mailgun reached through dc-2. */
function zone(): FakeZone {
  return {
    [D]: {
      mx: [{ priority: 10, exchange: "mx.provider.example" }],
      txt: [`v=spf1 include:dc-1._spfm.${D} include:dc-2._spfm.${D} ~all`, "google-site-verification=abc"],
    },
    [`dc-1._spfm.${D}`]: { txt: ["v=spf1 include:_spf.provider.example ~all"] },
    [`dc-2._spfm.${D}`]: { txt: ["v=spf1 include:mailgun.org ~all"] },
    "_spf.provider.example": { txt: ["v=spf1 ip4:192.0.2.20 ~all"] },
    "mailgun.org": { txt: ["v=spf1 include:_spf.mailgun.org ~all"] },
    "_spf.mailgun.org": { txt: ["v=spf1 ip4:192.0.2.40 ~all"] },
    [`pdk1._domainkey.${D}`]: { txt: [[DKIM_VALUE.slice(0, 60), DKIM_VALUE.slice(60)]] },
    [`email.${D}`]: { cname: ["mailgun.org"] },
    [`_dmarc.${D}`]: { txt: ["v=DMARC1; p=none"] },
  };
}

/** The Domain checklist's "Check again" with both resolvers answering from `z`. */
async function check(z: FakeZone = zone()) {
  return runDomainCheck({ verify: true, lookups: [new FakeDns(z), new FakeDns(z)], mailgun, fetchImpl: noFetch });
}

function rowsByKey(rows: readonly ChecklistRow[]): Record<string, ChecklistRow> {
  return Object.fromEntries(rows.map((r) => [r.key, r]));
}

/** The clock jumps to `at` (Date only; timers and the network stay real). Never backwards. */
function jumpTo(at: Date): Date {
  const next = new Date(Math.max(at.getTime(), Date.now() + 1_000));
  vi.setSystemTime(next);
  return next;
}

/** The event lane: stored Mailgun events, then stored replies. */
async function lane(): Promise<void> {
  for (let i = 0; i < 10 && (await processPendingMailEvents({ now: new Date() })).processed > 0; i++) {
    /* until nothing is left */
  }
  await processPendingInbound({ now: new Date() });
}

/**
 * "Check with Mailgun now": the Logs catch-up (the only way Mailgun's reports arrive here), then what the worker runs
 * after a complete check (the outage hold: in this mode it marks a found gap handled and holds nobody), then the event
 * lane.
 */
async function catchUp(now: Date = new Date()) {
  const out = await runCatchUp({ reason: "manual", now, mailgun });
  expect(await applyOutageHold({ now })).toMatchObject({ held: 0 });
  await lane();
  return out;
}

/** The background sender's heartbeat, fresh now (going live needs a running background sender). */
async function heartbeat(): Promise<void> {
  const at = new Date();
  await dbWrite((c) =>
    c.workerLease.upsert({ where: { id: 1 }, create: { id: 1, workerId: "own-e2e", heartbeatAt: at, startedAt: at }, update: { heartbeatAt: at } }),
  );
}

/** One sending-loop round (the real loop, renderer and Mailgun transport), after forgetting the pacer's gap. */
async function tick() {
  await dbWrite((c) => c.systemState.deleteMany({ where: { key: "sending.pacer" } }));
  return loop.sendingTick({ mailgun, random: () => 0.5 });
}

/** Sending-loop rounds until `done`, one gated email per round. */
async function sendUntil(done: () => Promise<boolean>, rounds = 12): Promise<void> {
  let last: unknown = null;
  for (let i = 0; i < rounds && !(await done()); i++) last = await tick();
  expect(await done(), `the last round: ${JSON.stringify(last)}`).toBe(true);
}

/** The first email and follow-ups `delays` days after the step before, from the master sequence. */
function stepsWith(delays: number[]) {
  const [s0, ...rest] = MASTER_SEQUENCE.steps;
  return [
    { step: 0, enabled: true, subject: s0!.subject, body: s0!.body, delayDays: 0 },
    ...delays.map((delayDays, i) => ({ step: i + 1, enabled: true, subject: null, body: rest[i]!.body, delayDays })),
  ];
}

type Actor = { id: number; name: string; role: "OWNER" | "MEMBER" };
let owner: Actor;
let ali: Actor;
let ownerUser: TestUser;
let aliUser: TestUser;

/** A draft by Arslan with these companies and steps, in today's sending mode. */
async function newDraft(name: string, companyIds: number[], delays: number[] = []): Promise<number> {
  const d = await draft.createDraft(owner, { companyIds, name, timeZone: TZ });
  await draft.saveDraftSteps(owner, d.id, stepsWith(delays));
  return d.id;
}

/** Every message a fake accepted, the main one and step 8's. */
function allMessages() {
  return [...fake.messages, ...(fakeAuthorized?.messages ?? [])];
}

function allRequests() {
  return [...fake.requests, ...(fakeAuthorized?.requests ?? [])];
}

function messagesOf(campaignId: number) {
  return fake.messages.filter((m) => m.fields["v:campaign_id"]?.[0] === String(campaignId));
}

const field = (m: { fields: Record<string, string[]> }, k: string) => m.fields[k]?.[0];

type Who = { companyId: number; personId: number; email: string };

async function companyWith(name: string, email: string, personName: string, checked: boolean): Promise<Who> {
  const { company, people } = await makeCompany({ name, domain: email.split("@")[1]!, people: [{ name: personName, email }] });
  await dbWrite(async (c) => {
    await c.company.update({ where: { id: company.id }, data: { country: "DE", timeZone: TZ } });
    if (checked) {
      await c.person.update({
        where: { id: people[0]!.id },
        data: { verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: new Date(Date.now() - 10 * DAY), verificationProvider: "mailgun-fake" },
      });
    }
  });
  return { companyId: company.id, personId: people[0]!.id, email };
}

async function recipientOf(campaignId: number, personId: number) {
  return db.campaignRecipient.findFirstOrThrow({ where: { campaignId, personId } });
}

async function emailOf(campaignId: number, email: string, step: number) {
  return db.outboundEmail.findFirstOrThrow({ where: { campaignId, toNorm: email, step } });
}

const S = {
  outlook: {} as Who,
  gmail: {} as Who,
  liveTest: 0,
  prospects: 0,
  p: {} as Record<"anna" | "ben" | "carl" | "dora", Who>,
  firstSentAt: new Date(0),
  finn: {} as Who,
  norway: 0,
};

beforeAll(async () => {
  const users = await dbWrite(async (c) => [
    await c.user.create({
      data: {
        email: "arslan@polygonparadise.test",
        name: "Arslan",
        role: "OWNER",
        timeZone: TZ,
        senderDisplayName: "Arslan from Polygon Paradise",
        replyInbox: "arslan.inbox@example.org",
        signature: "Arslan\nPolygon Paradise",
      },
    }),
    await c.user.create({
      data: {
        email: "ali.khan@polygonparadise.test",
        name: "Ali",
        role: "MEMBER",
        timeZone: TZ,
        senderDisplayName: "Ali from Polygon Paradise",
        replyInbox: "ali.inbox@example.org",
        signature: "Ali\nPolygon Paradise",
      },
    }),
  ]);
  owner = { id: users[0]!.id, name: "Arslan", role: "OWNER" };
  ali = { id: users[1]!.id, name: "Ali", role: "MEMBER" };
  ownerUser = { id: owner.id, email: "arslan@polygonparadise.test", name: "Arslan", role: "OWNER", timeZone: TZ, sessionId: 1 };
  aliUser = { id: ali.id, email: "ali.khan@polygonparadise.test", name: "Ali", role: "MEMBER", timeZone: TZ, sessionId: 2 };
  auth.user = ownerUser;
  // What the owner's Mailgun shows for the domain: SPF, DKIM and tracking verified (its MX "unverified" for good).
  fake.setDns("all");
});

afterAll(async () => {
  vi.useRealTimers();
  if (previousEnv.base === undefined) delete process.env.OUTREACH_MAILGUN_BASE_URL;
  else process.env.OUTREACH_MAILGUN_BASE_URL = previousEnv.base;
  if (previousEnv.pub === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previousEnv.pub;
  await fake.close();
  if (fakeAuthorized) await fakeAuthorized.close();
  await db.$disconnect();
  t.cleanup();
});

describe("the owner's shape: From contact@example.com through example.com itself, replies in the own mailbox", () => {
  it("1. connects in own-mailbox mode and saves the own From: Free plan, no sending address, no route sync", async () => {
    const connected = await connectMailgunAction({ region: "US", domain: D, apiKey: "key-fake-api", replies: "own-mailbox" });
    expect(connected).toMatchObject({ ok: true, message: `Connected to ${D} (US). ${OWN_MAILBOX_TEXTS.connectedNext}${OWN_MAILBOX_TEXTS.planSetFree}` });
    expect(await getSetting("mailgun.replies")).toBe("own-mailbox");
    expect(await getSetting("mailgun.plan")).toBe("free");
    expect(await getSetting("mailgun.logRetentionDays")).toBe(1);
    expect(await getSetting("mailgun.messageRetentionDays")).toBe(1);
    expect(await loadPlanLimits()).toMatchObject({ plan: "free", assumed: false, dailyLimit: 100, logDays: 1 });

    expect(await saveFromAddressAction({ fromAddress: FROM })).toEqual({
      ok: true,
      data: { fromAddress: FROM, goLiveEnded: false },
      message: OWN_MAILBOX_TEXTS.savedOn(FROM),
    });
    expect(await loadTeamFrom()).toMatchObject({ replies: "own-mailbox", address: null, ownFrom: FROM, evidenceFrom: FROM, problem: null });
    expect(await db.senderAddress.count()).toBe(0);
    expect(await db.job.count({ where: { type: "mailgun.syncRoutes" } })).toBe(0);
    expect((await db.sendingDomain.findMany({ select: { name: true, region: true, active: true } }))).toEqual([{ name: D, region: "US", active: true }]);

    // No public address: neither it nor a reply route is ever asked for.
    const gate = await rt.loadGateInputs();
    expect(gate).toMatchObject({ replies: "own-mailbox", ownFrom: FROM, publicAddressSet: false, sendersWithoutRoute: [] });
    const replyTest = rt.replyTestBlockersFor(gate);
    expect(replyTest).not.toContain(MODE_GATE_TEXTS.publicAddress);
    expect(replyTest).not.toContain(MODE_GATE_TEXTS.ownerRoute);
    for (const key of ["webhooks", "remote-access", "https-links", "mx"] as const) {
      expect(goLiveRowKeys(false, { ownMailbox: true, publicAddress: gate.publicAddressSet })).not.toContain(key);
    }
  });

  it("2. the Domain checklist: the own-mailbox rows; a Mailgun MX, a vanished _spfm include and no _dmarc", async () => {
    const state = await check();
    expect(state).toMatchObject({ domain: D, region: "US", error: null, replies: "own-mailbox", lastGoodMx: [{ priority: 10, host: "mx.provider.example" }] });
    const rows = rowsByKey(state.rows);
    for (const key of ["mx", "spam-filter", "retention", "reply-routes", "from-spf"]) expect(rows[key], key).toBeUndefined();
    expect(rows.spf).toMatchObject({ status: "ok", title: checklistTitle("spf", D), text: `Mailgun may send for ${D} (5 of 10 DNS lookups).`, records: [] });
    expect(rows.dkim!.status).toBe("ok");
    expect(rows["from-mx"]).toMatchObject({ status: "ok", title: "Mail for example.com stays with your mail provider (MX)", records: [] });
    expect(rows["from-mx"]!.title).toBe(checklistTitle("from-mx", D));
    expect(rows.dmarc!.status).toBe("ok");
    // Without a public address the webhooks and remote-access rows are information only.
    expect(rows.webhooks!.status).toBe("info");
    expect(rows["remote-access"]!.status).toBe("info");
    expect(rows["monthly-limit"]).toMatchObject({ status: "info", text: PLAN_TEXTS.monthlyNotNeeded(100) });
    const stored = await db.systemState.findUniqueOrThrow({ where: { key: "domain.check" } });
    expect(stored.value).toMatchObject({ replies: "own-mailbox", lastGoodMx: [{ priority: 10, host: "mx.provider.example" }] });

    // example.com's MX pointed at Mailgun (GoDaddy's "@" default): red, the fix names the last good MX, never Mailgun's.
    const red = zone();
    red[D]!.mx = [{ priority: 10, exchange: "mxa.mailgun.org" }];
    const redRow = rowsByKey((await check(red)).rows)["from-mx"]!;
    expect(redRow.status).toBe("bad");
    expect(redRow.fix).toContain("mx.provider.example (priority 10)");
    expect(redRow.fix).toContain(NEVER_MAILGUN_MX_TEXT(D));
    expect(redRow.fix!.endsWith(`${NEVER_MAILGUN_MX_TEXT(D)} Then click Check again.`)).toBe(true);
    for (const host of MAILGUN_MX_HOSTS) expect(redRow.fix!.replace(NEVER_MAILGUN_MX_TEXT(D), "")).not.toContain(host);
    expect(redRow.records).toEqual([]);
    await check(red);
    const gate = await rt.loadGateInputs();
    // Review SCREENS-11: own-mailbox mode's sentence (it names Cloudflare Email Routing too).
    expect(rt.modeBlockersFor("LIVE", gate)).toContain(MODE_GATE_TEXTS.fromMxOwn);
    expect(rt.replyTestBlockersFor(gate)).toContain(MODE_GATE_TEXTS.fromMxOwn);
    expect(rt.goLiveBlockersFor(gate)).toContain(`${checklistTitle("from-mx", D)}: not done yet (Domain checklist).`);
    const told = await db.notification.findMany({ where: { title: FROM_DOMAIN_NOTICE_TEXTS.mxTitle(D) } });
    expect(told.map((n) => [n.userId, n.body])).toEqual([[owner.id, FROM_DOMAIN_NOTICE_TEXTS.mxBodyOwn(D)]]);
    // Put back: done again.
    expect(rowsByKey((await check()).rows)["from-mx"]!.status).toBe("ok");

    // dc-2._spfm.example.com gone: SPF is broken, and no fix shows an SPF value.
    const noInclude = zone();
    delete noInclude[`dc-2._spfm.${D}`];
    const spfState = await check(noInclude);
    expect(rowsByKey(spfState.rows).spf).toMatchObject({
      status: "bad",
      text: `${D}'s SPF record includes dc-2._spfm.${D}, which has no SPF record, so mail servers treat ${D}'s SPF as broken: your campaign emails and your everyday email fail SPF.`,
    });
    for (const r of spfState.rows) expect(r.fix ?? "", r.key).not.toContain("v=spf1");

    // No _dmarc record: the reply test waits for it (its emails would report dmarc=none).
    const noDmarc = zone();
    delete noDmarc[`_dmarc.${D}`];
    await check(noDmarc);
    expect(rt.replyTestBlockersFor(await rt.loadGateInputs())).toContain(MODE_GATE_TEXTS.dmarcFirst);
    await check();
    expect(rt.replyTestBlockersFor(await rt.loadGateInputs())).not.toContain(MODE_GATE_TEXTS.dmarcFirst);
  });

  it("3. Apply recommended settings: no routes, no spam filter or retention change, the certificate not in plan", async () => {
    const before = fake.requests.length;
    const applied = await runApplySettings({ byUserId: owner.id, mailgun, fetchImpl: noFetch });
    const step = (key: string) => applied.steps.find((s) => s.key === key);
    expect(step("public-address")).toMatchObject({ ok: null, text: OWN_MAILBOX_TEXTS.applyNoPublicAddress });
    for (const key of ["spam-filter", "retention", "routes"]) expect(step(key), key).toMatchObject({ ok: null, text: OWN_MAILBOX_TEXTS.applyNotNeeded });
    expect(OWN_MAILBOX_TEXTS.applyNotNeeded).toBe("Not needed: replies go to your own mailbox.");
    // Reviews DOMAIN-3, SCREENS-06: optional webhooks, and the Free plan's missing certificate is no failure.
    expect(step("webhooks")).toMatchObject({ ok: null, text: APPLY_STEP_TEXTS.webhooksOptionalOwn });
    expect(step("certificate")).toMatchObject({ ok: null, text: APPLY_TEXTS.certNotInPlan });
    expect(step("https")).toMatchObject({ ok: null, text: APPLY_STEP_TEXTS.httpsNotInPlanOwn });
    expect(applied.certificate).toMatchObject({ status: "not-in-plan" });
    for (const key of ["tracking-open", "tracking-click", "unsubscribe", "signing-key"]) expect(step(key)?.ok, key).toBe(true);

    const made = fake.requests.slice(before);
    expect(made.filter((r) => r.path.startsWith("/v3/routes"))).toEqual([]);
    const changesReceiving = made.filter((r) => {
      const body = r.body && typeof r.body === "object" ? (r.body as Record<string, unknown>) : {};
      return r.method === "PUT" && ("spam_action" in body || "message_ttl" in body);
    });
    expect(changesReceiving).toEqual([]);
    expect(fake.state().routes).toEqual([]);

    // Checked again: the https row is honest information, the settings rows are done.
    const rows = rowsByKey((await check()).rows);
    expect(rows["https-links"]).toMatchObject({ status: "info" });
    for (const key of ["tracking-off", "unsubscribe", "signing-key", "sending-allowed", "mailgun-domain"]) expect(rows[key]!.status, key).toBe("ok");
  });

  it("4. the reply test by hand in Live (test list only): own headers, answers, the original, the mailto question, passed", async () => {
    expect(await setSendingModeAction({ mode: "LIVE" })).toMatchObject({ ok: true });
    expect(await rt.saveTestList(owner, [OUTLOOK, GMAIL])).toMatchObject({ ok: true, value: [OUTLOOK, GMAIL] });
    const gate = await rt.loadGateInputs();
    // Live mode and the reply test need neither a public address nor a reply route in this mode.
    expect(rt.modeBlockersFor("LIVE", gate)).toEqual([]);
    expect(rt.replyTestBlockersFor(gate)).toEqual([]);

    expect(await sendReplyTestEmails(owner.id, { jobId: 7001, mailgun })).toMatchObject({ sent: 2, failed: 0 });
    const sent = fake.messages.filter((m) => /^<pp\.t\.7001\./.test(field(m, "h:Message-Id") ?? ""));
    expect(sent.map((m) => field(m, "to"))).toEqual([OUTLOOK, GMAIL]);
    for (const m of sent) {
      expect(field(m, "from")).toBe(FROM_LINE);
      expect(m.fields["h:Reply-To"]).toBeUndefined();
      expect(field(m, "h:Message-Id")).toMatch(/@example\.com>$/);
    }
    const sends = await db.testSend.findMany({ where: { purpose: "REPLY_TEST" }, orderBy: { id: "asc" } });
    expect(sends.map((s) => [s.to, s.teamFrom])).toEqual([
      [OUTLOOK, FROM],
      [GMAIL, FROM],
    ]);
    const gmail = sends.find((s) => s.to === GMAIL)!;

    // Each mailbox replies: the reply lands in contact@ at the mail provider, never at Mailgun or in the app.
    for (const s of sends) {
      expect(fake.receivePreset("reply", s.messageId!)).toMatchObject({ ok: true, stored: false, deliveredTo: "outside", to: FROM });
    }
    await lane();
    expect(await db.inboundMessage.count()).toBe(0);

    // Deliveries come through the Logs catch-up (no webhooks without a public address).
    for (const s of sends) fake.deliver(s.messageId!);
    await catchUp();
    let data = await rt.loadReplyTest();
    expect(data.ownMailbox).toBe(true);
    expect(data.facts.get(OUTLOOK)).toMatchObject({ delivered: true, replyStored: false });
    expect(data.facts.get(GMAIL)).toMatchObject({ delivered: true, replyStored: false });

    // The answers: placement No at Outlook.com (junk), Yes at Gmail; the reply arrived in contact@; DMARC read from a
    // pasted Gmail header.
    const answered = await rt.saveReplyTestAnswers(owner, {
      mailboxes: [
        { address: OUTLOOK, placementOk: false, inboxOk: true, dmarcOk: "pass" },
        { address: GMAIL, placementOk: true, inboxOk: true, dmarcOk: "unsure", dmarcPasted: testOriginal({ from: FROM_LINE, messageId: gmail.messageId!, to: GMAIL }) },
      ],
      headersOk: true,
    });
    expect(answered.dmarcFromHeaders).toEqual({ [GMAIL]: "pass" });

    // One pasted original: the return address on example.com, signed by example.com, an http link and a mailto:.
    const { original, ownMailbox } = await rt.saveReplyTestOriginal(owner, {
      pasted: testOriginal({
        from: FROM_LINE,
        messageId: gmail.messageId!,
        to: GMAIL,
        returnPath: "bounce+x@example.com",
        dkimD: D,
        dmarc: "pass",
        listUnsubscribe: `<mailto:${MAILTO}>, <http://email.example.com/u/x>`,
      }),
      address: GMAIL,
    });
    expect(ownMailbox).toBe(true);
    expect(original).toMatchObject({ domain: D, from: FROM, returnPathDomain: D, returnPathOk: true, dmarc: "pass", dkimSigner: D, unsubscribeScheme: "http", mailtoAddress: MAILTO });

    // The unsubscribe-by-email question: unanswered → incomplete; No → failed with the catch-all fix; Yes → on.
    data = await rt.loadReplyTest();
    expect(data.verdict.status).toBe("incomplete");
    expect(data.verdict.missing).toContain(OWN_REPLY_TEST_TEXTS.mailtoUnanswered);
    expect(await rt.decideReplyTest(owner)).toMatchObject({ status: "incomplete" });
    await rt.saveReplyTestAnswers(owner, { mailboxes: [], mailtoArrived: false });
    expect(await rt.decideReplyTest(owner)).toMatchObject({ status: "failed", missing: expect.arrayContaining([OWN_REPLY_TEST_TEXTS.mailtoFailed(MAILTO, D, FROM)]) });
    expect(await getSetting("mailgun.unsubscribeTest")).toMatchObject({ status: "failed", replies: "own-mailbox", from: FROM });
    await rt.saveReplyTestAnswers(owner, { mailboxes: [], mailtoArrived: true });
    data = await rt.loadReplyTest();
    expect(data.verdict.missing).not.toContain(OWN_REPLY_TEST_TEXTS.mailtoUnanswered);
    expect(data.verdict.status).not.toBe("failed");

    // The unsubscribe link of the Gmail test email, heard through the catch-up; the test mailbox is then taken off the
    // do-not-email list so the live test can reach it.
    fake.unsubscribe(gmail.messageId!);
    await catchUp();
    data = await rt.loadReplyTest();
    expect(data.unsubscribeSeen).toBe(true);
    expect(data.verdict).toEqual({ status: "passed", missing: [], warnings: [REPLY_TEST_TEXTS.spamWarning(OUTLOOK)] });
    expect(await rt.decideReplyTest(owner)).toMatchObject({ status: "passed" });
    expect(await getSetting("mailgun.unsubscribeTest")).toMatchObject({ status: "passed", setup: "A", domain: D, from: FROM, replies: "own-mailbox" });
    expect((await rt.loadGateInputs()).replyTestPassedOnDomain).toBe(true);
    expect(await removeOwnSuppression(owner, GMAIL, { mailgun })).toMatchObject({ removed: true });
    expect(await db.job.count({ where: { type: "mailgun.syncRoutes" } })).toBe(0);
  }, 60_000);

  it("5. a live test with a follow-up: the MX guard holds it; the rehearsal; going live needs the two ticks", async () => {
    S.outlook = await companyWith("Test – Outlook", OUTLOOK, "Tess Outlook", false);
    S.gmail = await companyWith("Test – Gmail", GMAIL, "Tess Gmail", false);
    S.liveTest = await newDraft("Live test", [S.outlook.companyId, S.gmail.companyId], [1]);
    expect(await draft.launchDraft(owner, S.liveTest, { mailgun })).toMatchObject({ status: "RUNNING", mode: "LIVE", queued: 2 });
    const domainRow = await db.sendingDomain.findUniqueOrThrow({ where: { name: D } });
    expect(await db.campaign.findUniqueOrThrow({ where: { id: S.liveTest } })).toMatchObject({
      fromName: "Arslan from Polygon Paradise",
      fromAddress: FROM,
      replyTo: null,
      sendingDomainId: domainRow.id,
      launchedGoLive: false,
    });

    // The MX guard: with example.com's MX pointed at Mailgun, every LIVE email waits.
    const red = zone();
    red[D]!.mx = [{ priority: 10, exchange: "mxa.mailgun.org" }];
    await check(red);
    const held = await tick();
    expect(held).toMatchObject({ sent: 0, waiting: { reason: "main-domain-mx" } });
    expect(messagesOf(S.liveTest)).toHaveLength(0);
    await check();

    await sendUntil(async () => messagesOf(S.liveTest).length >= 2);
    for (const m of messagesOf(S.liveTest)) {
      expect(field(m, "from")).toBe(FROM_LINE);
      expect(m.fields["h:Reply-To"]).toBeUndefined();
      expect(field(m, "h:Message-Id")).toMatch(/@example\.com>$/);
      expect(field(m, "o:testmode")).toBeUndefined();
    }
    // Delivered: Mailgun's reports come through the catch-up.
    for (const e of await db.outboundEmail.findMany({ where: { campaignId: S.liveTest, step: 0 } })) fake.deliver(e.providerId ?? e.messageId);
    await catchUp();

    // The rehearsal: a test mailbox answered (in contact@). They replied stops its follow-up, but its status stays.
    const outlookFirst = await emailOf(S.liveTest, OUTLOOK, 0);
    expect(fake.receivePreset("reply", outlookFirst.providerId ?? outlookFirst.messageId)).toMatchObject({ stored: false, deliveredTo: "outside", to: FROM });
    expect(await markRepliedAction({ companyId: S.outlook.companyId, personId: S.outlook.personId })).toEqual({
      ok: true,
      data: { stopped: 1, statusChanged: false, companyName: "Test – Outlook" },
      message: THEY_REPLIED_TEXTS.toast(1),
    });
    expect(await recipientOf(S.liveTest, S.outlook.personId)).toMatchObject({ state: "STOPPED", stopReason: "replied", stoppedByInboundId: null });
    expect(await emailOf(S.liveTest, OUTLOOK, 1)).toMatchObject({ status: "SKIPPED", lastError: STOP_SKIP_TEXT.replied });
    const outlookCompany = await db.company.findUniqueOrThrow({ where: { id: S.outlook.companyId } });
    expect(outlookCompany.status).toBe("NOT_CONTACTED");
    expect(outlookCompany.repliedAt).toBeNull();

    // The next day, at the follow-up's time: it waits for today's inbox check, and the Owner hears once.
    const due = await emailOf(S.liveTest, GMAIL, 1);
    expect(due.status).toBe("QUEUED");
    jumpTo(new Date(due.dueAt.getTime() + 1_000));
    const waiting = await tick();
    expect(waiting).toMatchObject({ sent: 0, waiting: { reason: "inbox-check", until: null } });
    await tick();
    const notes = await db.notification.findMany({ where: { type: "reply.inboxCheck" } });
    expect(notes.map((n) => [n.userId, n.title, n.body, n.link])).toEqual([
      [owner.id, INBOX_CHECK_TEXTS.notificationTitle, INBOX_CHECK_TEXTS.notificationBody(FROM), "/notifications#inbox-check"],
    ]);
    // Ali (a Member) read contact@ and clicks: the follow-up goes.
    auth.user = aliUser;
    expect(await markInboxCheckedAction()).toMatchObject({ ok: true, message: INBOX_CHECK_TEXTS.done });
    auth.user = ownerUser;
    const checked = await db.activityLog.findFirstOrThrow({ where: { type: "sending.inboxChecked" } });
    expect(checked).toMatchObject({ actorId: ali.id, summary: INBOX_CHECK_TEXTS.activity("Ali", FROM) });
    await sendUntil(async () => messagesOf(S.liveTest).filter((m) => field(m, "v:step") === "1").length >= 1);
    const followUp = messagesOf(S.liveTest).find((m) => field(m, "v:step") === "1")!;
    expect(field(followUp, "to")).toBe(GMAIL);
    expect(field(followUp, "from")).toBe(FROM_LINE);
    expect(followUp.fields["h:Reply-To"]).toBeUndefined();

    // Going live: a fresh check and a running background sender; then the ticks, one at a time.
    await check();
    await heartbeat();
    const view = rt.goLiveBlockersFor(await rt.loadGateInputs());
    expect(view).toEqual([]);
    expect(await goLiveAction({ confirm: true })).toEqual({ ok: false, error: GO_LIVE_COPY.ownMailboxRequired });
    expect(await goLiveAction({ confirm: true, confirmOwnMailbox: true })).toEqual({ ok: false, error: GO_LIVE_COPY.httpLinksRequired });
    expect(await goLiveAction({ confirm: true, confirmOwnMailbox: true, confirmHttpLinks: true })).toEqual({
      ok: false,
      error: GO_LIVE_COPY.spamPlacementRequired,
    });
    expect(await getSetting("sending.goLive")).toBe(false);
    const res = await goLiveAction({ confirm: true, confirmOwnMailbox: true, confirmHttpLinks: true, confirmSpamPlacement: true });
    expect(res).toMatchObject({ ok: true, data: { alreadyLive: false } });
    expect(await getSetting("sending.goLive")).toBe(true);
    expect(await getSetting("sending.goLiveFrom")).toBe(FROM);
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "sending.goLive" } });
    expect(log.data).toMatchObject({ from: FROM, replies: "own-mailbox", ownMailboxConfirmed: true, httpLinksConfirmed: true });

    // The rehearsal left the test company as it was: the next live test still includes it.
    const next = (await evaluateCompanies([S.outlook.companyId], { mode: "LIVE" })).get(S.outlook.companyId)!;
    expect(next.status).toBe("NOT_CONTACTED");
    expect(next.companyReasons.map((r) => r.code)).not.toContain("company-replied");
  }, 90_000);

  it("6. a live campaign to four checked prospects: the headers; the inbox check; They replied; a bounce; an unsubscribe", async () => {
    const people = [
      ["anna", "Firma Anna", "anna@firma-anna.example", "Anna Berg"],
      ["ben", "Studio Ben", "ben@studio-ben.example", "Ben Braun"],
      ["carl", "Druck Carl", "carl@druck-carl.example", "Carl Nagel"],
      ["dora", "Werk Dora", "dora@werk-dora.example", "Dora Lind"],
    ] as const;
    for (const [key, name, email, person] of people) S.p[key] = await companyWith(name, email, person, true);
    S.prospects = await newDraft(
      "Germany Q4",
      people.map(([key]) => S.p[key].companyId),
      [1],
    );
    expect(await draft.launchDraft(owner, S.prospects, { mailgun })).toMatchObject({ status: "RUNNING", mode: "LIVE", queued: 4 });
    expect(await db.campaign.findUniqueOrThrow({ where: { id: S.prospects } })).toMatchObject({ fromAddress: FROM, replyTo: null, launchedGoLive: true });
    const before = fake.requests.length;
    S.firstSentAt = new Date();
    await sendUntil(async () => messagesOf(S.prospects).length >= 4);
    const posts = fake.requests.slice(before).filter((r) => r.method === "POST" && r.path.endsWith("/messages"));
    expect(posts.map((r) => r.path)).toEqual([`/v3/${D}/messages`, `/v3/${D}/messages`, `/v3/${D}/messages`, `/v3/${D}/messages`]);
    for (const m of messagesOf(S.prospects)) {
      expect(field(m, "from")).toBe(FROM_LINE);
      expect(m.fields["h:Reply-To"]).toBeUndefined();
      expect(field(m, "h:Message-Id")).toMatch(/^<pp\.[^@<>]+@example\.com>$/);
      expect(field(m, "o:testmode")).toBeUndefined();
    }
    const domainRow = await db.sendingDomain.findUniqueOrThrow({ where: { name: D } });
    expect(domainRow.lastLiveSendAt?.getTime()).toBeGreaterThanOrEqual(S.firstSentAt.getTime());

    // The follow-ups due the same day (written: a live campaign's delay is whole days). Today's inbox check was made
    // before these first emails, so it doesn't count for them.
    await dbWrite((c) =>
      c.outboundEmail.updateMany({ where: { campaignId: S.prospects, step: 1, status: "QUEUED" }, data: { dueAt: new Date(Date.now() + 2 * MINUTE) } }),
    );
    jumpTo(new Date(Date.now() + 5 * MINUTE));
    expect(await tick()).toMatchObject({ sent: 0, waiting: { reason: "inbox-check" } });
    expect(await explainCampaignWaiting(S.prospects, new Date(), { mailgun })).toEqual({ reason: "inbox-check", until: null });
    // The Owner was told this cap day already: no second notification within 24 hours.
    expect(await db.notification.count({ where: { type: "reply.inboxCheck" } })).toBe(1);

    // Anna answers: the reply lands in contact@ (outside Mailgun), nothing is stored, her follow-up still waits.
    const inbound = await db.inboundMessage.count();
    const annaFirst = await emailOf(S.prospects, S.p.anna.email, 0);
    expect(fake.receivePreset("reply", annaFirst.providerId ?? annaFirst.messageId)).toMatchObject({
      ok: true,
      stored: false,
      deliveredTo: "outside",
      to: FROM,
    });
    await lane();
    expect(await db.inboundMessage.count()).toBe(inbound);
    expect((await emailOf(S.prospects, S.p.anna.email, 1)).status).toBe("QUEUED");
    // They replied, with Anna named: stopped, Replied, repliedAt.
    const at = new Date();
    expect(await markRepliedByHand(owner, { companyId: S.p.anna.companyId, personId: S.p.anna.personId }, at)).toEqual({
      stopped: 1,
      statusChanged: true,
      companyName: "Firma Anna",
    });
    expect(await recipientOf(S.prospects, S.p.anna.personId)).toMatchObject({ state: "STOPPED", stopReason: "replied", stoppedByInboundId: null });
    expect(await emailOf(S.prospects, S.p.anna.email, 1)).toMatchObject({ status: "SKIPPED", lastError: STOP_SKIP_TEXT.replied });
    const anna = await db.company.findUniqueOrThrow({ where: { id: S.p.anna.companyId } });
    expect(anna.status).toBe("REPLIED");
    expect(anna.repliedAt?.getTime()).toBe(at.getTime());
    expect((await db.person.findUniqueOrThrow({ where: { id: S.p.anna.personId } })).repliedAt?.getTime()).toBe(at.getTime());

    // Firma Anna was also put back by hand into another running campaign (status already Replied), with her colleague:
    // a second They replied stops that one too.
    const bo = await dbWrite((c) =>
      c.person.create({ data: { companyId: S.p.anna.companyId, name: "Bo Kollege", email: "bo@firma-anna.example", emailNorm: "bo@firma-anna.example" } }),
    );
    const putBack = await dbWrite(async (c) => {
      const campaign = await c.campaign.create({
        data: {
          name: "Put back",
          createdById: owner.id,
          senderId: owner.id,
          status: "RUNNING",
          mode: "LIVE",
          launchedGoLive: true,
          launchedAt: new Date(Date.now() - DAY),
          sendingDomainId: domainRow.id,
          fromName: "Arslan from Polygon Paradise",
          fromAddress: FROM,
          replyTo: null,
          steps: { create: [{ step: 0, subject: "Hi", body: "Hi" }, { step: 1, body: "Following up", delayDays: 3 }] },
        },
      });
      const r = await c.campaignRecipient.create({
        data: { campaignId: campaign.id, companyId: S.p.anna.companyId, personId: bo.id, emailNorm: "bo@firma-anna.example", state: "WAITING", currentStep: 1, nextDueAt: new Date(Date.now() + 2 * DAY) },
      });
      for (const step of [0, 1]) {
        await c.outboundEmail.create({
          data: {
            campaignId: campaign.id,
            recipientId: r.id,
            personId: bo.id,
            companyId: S.p.anna.companyId,
            senderId: owner.id,
            step,
            mode: "LIVE",
            toEmail: "bo@firma-anna.example",
            toNorm: "bo@firma-anna.example",
            companyName: "Firma Anna",
            fromAddress: FROM_LINE,
            subject: "Hi",
            text: "t",
            html: "h",
            messageId: `pp.putback${step}@${D}`,
            sendId: `putback-${step}`,
            dueAt: step === 0 ? new Date(Date.now() - DAY) : new Date(Date.now() + 2 * DAY),
            status: step === 0 ? "SENT" : "QUEUED",
            sentAt: step === 0 ? new Date(Date.now() - DAY) : null,
            claimedAt: step === 0 ? new Date(Date.now() - DAY) : null,
          },
        });
      }
      return campaign;
    });
    expect(await markRepliedByHand(owner, { companyId: S.p.anna.companyId })).toEqual({ stopped: 1, statusChanged: false, companyName: "Firma Anna" });
    expect(await recipientOf(putBack.id, bo.id)).toMatchObject({ state: "STOPPED", stopReason: "company_replied", stoppedByInboundId: null });
    expect(await emailOf(putBack.id, "bo@firma-anna.example", 1)).toMatchObject({ status: "SKIPPED", lastError: STOP_SKIP_TEXT.company_replied });

    // Ben's address bounces (a permanent failure, heard through the catch-up): suppressed and stopped.
    const benFirst = await emailOf(S.prospects, S.p.ben.email, 0);
    fake.bounce(benFirst.providerId ?? benFirst.messageId);
    // Carl clicks the unsubscribe link (heard through the catch-up too): suppressed and stopped.
    const carlFirst = await emailOf(S.prospects, S.p.carl.email, 0);
    fake.unsubscribe(carlFirst.providerId ?? carlFirst.messageId);
    await catchUp();
    expect(await db.suppression.findUnique({ where: { emailNorm: S.p.ben.email } })).toMatchObject({ reason: "BOUNCED" });
    expect((await recipientOf(S.prospects, S.p.ben.personId)).state).toBe("STOPPED");
    expect((await emailOf(S.prospects, S.p.ben.email, 1)).status).not.toBe("QUEUED");
    expect(await db.suppression.findUnique({ where: { emailNorm: S.p.carl.email } })).toMatchObject({ reason: "UNSUBSCRIBED" });
    expect((await recipientOf(S.prospects, S.p.carl.personId)).state).toBe("STOPPED");
    expect((await emailOf(S.prospects, S.p.carl.email, 1)).status).not.toBe("QUEUED");

    // Someone reads contact@ now, after the first emails: Dora's follow-up goes (the only one left).
    await markInboxChecked(owner);
    await sendUntil(async () => messagesOf(S.prospects).filter((m) => field(m, "v:step") === "1").length >= 1);
    const followUps = messagesOf(S.prospects).filter((m) => field(m, "v:step") === "1");
    expect(followUps.map((m) => field(m, "to"))).toEqual([S.p.dora.email]);
    expect(field(followUps[0]!, "from")).toBe(FROM_LINE);
    expect(followUps[0]!.fields["h:Reply-To"]).toBeUndefined();
  }, 90_000);

  it("7. 100 a day: planned at most 90 campaign emails; tests up to 100; a limit refusal pauses, never fails", async () => {
    // Thursday 13:00 in Berlin: Wednesday morning's sends are more than 24 hours old.
    const now = jumpTo(new Date("2026-09-24T11:00:00.000Z"));
    // 89 counted Mailgun sends of the last 24 hours, written directly (yesterday's cap day, so today's limit is untouched).
    const todayStart = capDayBounds(capDayOf(now, "Asia/Karachi"), "Asia/Karachi").start;
    const oldestFiller = new Date(todayStart.getTime() - 2 * HOUR);
    const already = (await countMailgunSendsSince(new Date(now.getTime() - DAY))).total;
    expect(already).toBeLessThan(89);
    const fillers = async (n: number, from: Date) => {
      await dbWrite((c) =>
        c.testSend.createMany({
          data: Array.from({ length: n }, (_, i) => ({
            userId: ali.id,
            to: "filler@studio-filler.example",
            subject: "filler",
            mode: "TEST" as const,
            status: "SENT" as const,
            sentAt: new Date(from.getTime() + i * 1_000),
          })),
        }),
      );
    };
    await fillers(89 - already, oldestFiller);
    expect((await countMailgunSendsSince(new Date(Date.now() - DAY))).total).toBe(89);

    // A test-mode campaign to the test list: one email goes (90), the next waits for the plan's rolling 24 hours.
    expect(await setSendingModeAction({ mode: "TEST" })).toMatchObject({ ok: true });
    const testRun = await newDraft("Test mode check", [S.outlook.companyId, S.gmail.companyId]);
    expect(await draft.launchDraft(owner, testRun, { mailgun })).toMatchObject({ status: "RUNNING", mode: "TEST", queued: 2 });
    expect((await tick()).sent).toBe(1);
    expect((await countMailgunSendsSince(new Date(Date.now() - DAY))).total).toBe(90);
    expect(await tick()).toMatchObject({ sent: 0, waiting: { reason: "plan-limit", until: new Date(oldestFiller.getTime() + DAY) } });
    expect(messagesOf(testRun)).toHaveLength(1);
    expect(field(messagesOf(testRun)[0]!, "o:testmode")).toBe("yes");

    // "Send me a test" still goes: 10 are kept for tests. Up to 100, then refused.
    const recipient = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: testRun } });
    expect(await sendMeATest(owner, { campaignId: testRun, recipientId: recipient.id, step: 0 }, { mailgun })).toMatchObject({ status: "sent" });
    await fillers(8, new Date(oldestFiller.getTime() + 5 * MINUTE));
    expect((await countMailgunSendsSince(new Date(Date.now() - DAY))).total).toBe(99);
    expect(await sendMeATest(owner, { campaignId: testRun, recipientId: recipient.id, step: 0 }, { mailgun })).toMatchObject({ status: "sent" });
    const full = await sendMeATest(owner, { campaignId: testRun, recipientId: recipient.id, step: 0 }, { mailgun }).catch((e: unknown) => e);
    expect(full).toBeInstanceOf(TestSendError);
    expect((full as Error).message).toBe(PLAN_TEXTS.testsFull(100));
    const selfTests = allMessages().filter((m) => field(m, "to") === "arslan.inbox@example.org");
    expect(selfTests).toHaveLength(2);
    for (const m of selfTests) {
      expect(field(m, "from")).toBe(FROM_LINE);
      expect(m.fields["h:Reply-To"]).toBeUndefined();
    }

    // Room again (the fillers gone); a live email the fake refuses for the limit: paused, back in the queue.
    await dbWrite((c) => c.testSend.deleteMany({ where: { subject: "filler" } }));
    await cancelCampaign(testRun, owner.id);
    expect(await setSendingModeAction({ mode: "LIVE" })).toMatchObject({ ok: true });
    const eva = await companyWith("Eva Figuren", "eva@eva-figuren.example", "Eva Stein", true);
    const limitRun = await newDraft("Limit check", [eva.companyId]);
    expect(await draft.launchDraft(owner, limitRun, { mailgun })).toMatchObject({ status: "RUNNING", mode: "LIVE", queued: 1 });
    fake.failNext("POST /v3/:d/messages", { kind: "status", status: 400, body: { message: LIMIT_TEXT } });
    expect(await tick()).toMatchObject({ sent: 0, failed: 0, held: 1 });
    expect(await getPauseState()).toMatchObject({ paused: true, kind: "mailgun-not-allowed", reason: PLAN_TEXTS.limitReason, fixText: PLAN_TEXTS.limitRefused });
    expect(await emailOf(limitRun, eva.email, 0)).toMatchObject({ status: "QUEUED", attempts: 0 });
    expect((await recipientOf(limitRun, eva.personId)).state).not.toBe("STOPPED");
    await resumeSending({ actorId: owner.id, actorName: owner.name });

    // The same words on an address check (not a send): today's kind, and sending isn't paused.
    fake.failNext("GET /v4/address/validate", { kind: "status", status: 400, body: { message: LIMIT_TEXT } });
    const ctx = await mailgun();
    if (!ctx.connected) throw new Error(ctx.text);
    const err = await ctx.client.validateAddress("someone@studio-check.example").catch((e: unknown) => e);
    expect(isMailgunError(err)).toBe(true);
    const kind = (err as { kind: string }).kind;
    expect(kind).toBe(classifyStatus(400, LIMIT_TEXT));
    expect(kind).not.toBe("limit");
    expect((await getPauseState()).paused).toBe(false);
    await cancelCampaign(limitRun, owner.id);
    expect(await db.outboundEmail.count({ where: { status: "FAILED" } })).toBe(0);
  }, 90_000);

  it("8. authorized recipients only: a live email to a prospect pauses with the payment-card sentence, nothing failed", async () => {
    fakeAuthorized = await startFakeMailgun({ ...FAKE_OPTIONS, authorizedRecipients: [OUTLOOK, GMAIL] });
    fakeAuthorized.setDns("all");
    process.env.OUTREACH_MAILGUN_BASE_URL = fakeAuthorized.origin;
    try {
      S.finn = await companyWith("Nord Finn", "finn@nord-finn.example", "Finn Dahl", true);
      S.norway = await newDraft("Norway Q4", [S.finn.companyId], [3]);
      expect(await draft.launchDraft(owner, S.norway, { mailgun })).toMatchObject({ status: "RUNNING", mode: "LIVE", queued: 1 });
      expect(await tick()).toMatchObject({ sent: 0, failed: 0, held: 1 });
      const pause = await getPauseState();
      expect(pause).toMatchObject({ paused: true, kind: "mailgun-not-allowed", reason: PLAN_TEXTS.authorizedReason, fixText: PLAN_TEXTS.authorizedOnlyCampaign });
      // Never the advice to authorize a prospect (Mailgun would email them an invitation).
      expect(pause.fixText).not.toMatch(/Authorized recipients|test mailbox/);
      expect(await emailOf(S.norway, S.finn.email, 0)).toMatchObject({ status: "QUEUED", attempts: 0 });
      expect(fakeAuthorized.requests.filter((r) => r.method === "POST" && r.path === `/v3/${D}/messages`)).toHaveLength(1);
      expect(fakeAuthorized.messages).toHaveLength(0);
      expect(await db.outboundEmail.count({ where: { status: "FAILED" } })).toBe(0);
    } finally {
      process.env.OUTREACH_MAILGUN_BASE_URL = fake.origin;
    }
    // A payment card added, Resume: the email goes (the first fake stands for the account after that).
    await resumeSending({ actorId: owner.id, actorName: owner.name });
    await sendUntil(async () => messagesOf(S.norway).length >= 1);
    expect(field(messagesOf(S.norway)[0]!, "to")).toBe(S.finn.email);
    expect((await recipientOf(S.norway, S.finn.personId)).state).toBe("WAITING");
  }, 60_000);

  it("9. safety: no route, no MX record box, no sending address; every email From the own From line, no Reply-To", async () => {
    const requests = allRequests();
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.filter((r) => r.path.startsWith("/v3/routes")).map((r) => `${r.method} ${r.path}`)).toEqual([]);
    expect(requests.filter((r) => /dns/i.test(r.path) && r.method !== "GET").map((r) => `${r.method} ${r.path}`)).toEqual([]);
    expect(fake.state().routes).toEqual([]);
    const stored = (await db.systemState.findUniqueOrThrow({ where: { key: "domain.check" } })).value as { rows: ChecklistRow[] };
    expect(stored.rows.length).toBeGreaterThan(0);
    for (const r of stored.rows) {
      expect(r.records.filter((x) => x.type.toUpperCase() === "MX"), r.key).toEqual([]);
      expect(r.fix ?? "", r.key).not.toContain("v=spf1");
    }
    expect(await db.senderAddress.count()).toBe(0);
    const messages = allMessages();
    expect(messages.length).toBeGreaterThan(10);
    for (const m of messages) {
      expect(field(m, "from")).toBe(FROM_LINE);
      expect(m.fields["h:Reply-To"]).toBeUndefined();
    }
    const sendPaths = requests.filter((r) => r.method === "POST" && r.path.endsWith("/messages")).map((r) => r.path);
    expect(new Set(sendPaths)).toEqual(new Set([`/v3/${D}/messages`]));
  });

  it("10. 1 day of logs: 5 days saved, the Logs window 23 hours back, a gap holds nobody, a list complaint counts", async () => {
    // Friday: Anna was emailed yesterday.
    const now = jumpTo(new Date("2026-09-25T11:00:00.000Z"));
    expect(await saveRetentionAction({ logRetentionDays: 5, messageRetentionDays: 1, plan: "free" })).toMatchObject({ ok: true });
    expect(await getSetting("mailgun.logRetentionDays")).toBe(5);
    expect(await loadPlanLimits()).toMatchObject({ plan: "free", logDays: 1 });

    // The PC was off: the cursor is 30 hours old. The Logs window starts 23 hours back and the gap is recorded.
    const cursor = new Date(now.getTime() - 30 * HOUR);
    await dbWrite((c) => c.syncCursor.upsert({ where: { key: `${D}:logs` }, create: { key: `${D}:logs`, value: cursor.toISOString() }, update: { value: cursor.toISOString() } }));
    const from = fake.requests.length;
    await runCatchUp({ reason: "hourly", now, mailgun });
    await lane();
    const starts = fake.requests
      .slice(from)
      .filter((r) => r.method === "POST" && r.path === "/v1/analytics/logs")
      .map((r) => Date.parse(String((r.body as { start?: unknown } | null)?.start ?? "")));
    expect(starts.length).toBeGreaterThan(0);
    expect(Math.abs(Math.min(...starts) - (now.getTime() - 23 * HOUR))).toBeLessThan(1_000);
    const outage = (await db.systemState.findUniqueOrThrow({ where: { key: "catchup.outage" } })).value as Record<string, unknown>;
    expect(outage).toMatchObject({ from: cursor.toISOString(), to: new Date(now.getTime() - 23 * HOUR).toISOString(), beyondLogRetention: true });
    // No outage hold in this mode: the gap is marked handled and nobody waits (the inbox check does that job).
    expect(await applyOutageHold({ now })).toEqual({ applied: true, held: 0, senderIds: [] });
    expect((await recipientOf(S.norway, S.finn.personId)).state).toBe("WAITING");

    // Anna marked yesterday's email as spam; the Logs missed it, but Mailgun's complaints list has her.
    const annaFirst = await emailOf(S.prospects, S.p.anna.email, 0);
    fake.addSuppression("complaints", S.p.anna.email, { createdAt: new Date(Math.floor((now.getTime() - 2 * HOUR) / 1_000) * 1_000) });
    await catchUp(new Date());
    const linked = await db.mailEvent.findMany({ where: { recipient: S.p.anna.email, type: "complained" } });
    expect(linked.map((e) => e.outboundEmailId)).toEqual([annaFirst.id]);
    const counts = await loadHealthCounts({ since: null, bounceWindow: 200, complaintWindow: 1000, practiceCopy: false });
    expect(counts.complaints).toBe(1);
    expect(counts.complaintEmailIds).toEqual([annaFirst.id]);
    expect(await db.suppression.findUnique({ where: { emailNorm: S.p.anna.email } })).toMatchObject({ reason: "COMPLAINED" });
  }, 60_000);

  it("11. back to replies through the app on send.example.com: refused while live runs; then everything resets", async () => {
    // Finn's follow-up (a live one) waits for today's inbox check while the own mailbox is in use.
    const finnFollowUp = await emailOf(S.norway, S.finn.email, 1);
    const cand = {
      id: finnFollowUp.id,
      campaignId: S.norway,
      recipientId: finnFollowUp.recipientId,
      companyId: finnFollowUp.companyId,
      toNorm: finnFollowUp.toNorm,
      mode: finnFollowUp.mode,
      step: 1,
    };
    expect([...(await inboxCheckHeldIds([cand], new Date()))]).toEqual([finnFollowUp.id]);

    const refused = await connectMailgunAction({ region: "US", domain: APP_D, apiKey: null, replies: "app" });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok ? "" : refused.error).toContain("Norway Q4");
    expect(await getSetting("mailgun.replies")).toBe("own-mailbox");
    expect(await getSetting("mailgun.domain")).toBe(D);

    await cancelCampaign(S.norway, owner.id);
    const switched = await connectMailgunAction({ region: "US", domain: APP_D, apiKey: null, replies: "app" });
    expect(switched).toMatchObject({ ok: true });
    expect(switched.ok ? switched.message : "").toContain(GO_LIVE_COPY.endedByDomainChange(D, APP_D));
    expect(await getSetting("mailgun.replies")).toBe("app");
    expect(await getSetting("mailgun.domain")).toBe(APP_D);
    expect(await getSetting("sending.goLive")).toBe(false);
    expect(await getSetting("mailgun.unsubscribeTest")).toMatchObject({ status: "untested", setup: "A", mailboxes: [] });
    // contact@example.com stays, and is now the shared From address of send.example.com.
    expect(await getSetting("mailgun.fromAddress")).toBe(FROM);
    expect(await loadTeamFrom()).toMatchObject({ replies: "app", address: FROM, ownFrom: null, evidenceFrom: FROM, problem: null });

    // The own-mailbox rows stored before count for nothing now (O36).
    const gate = await rt.loadGateInputs();
    expect(gate.rows).toEqual([]);
    expect(gate.checkFresh).toBe(false);
    expect(gate.replyTestPassedOnDomain).toBe(false);
    expect(rt.modeBlockersFor("LIVE", gate)).toContain(MODE_GATE_TEXTS.dns);
    expect(rt.replyTestBlockersFor(gate)).toContain(MODE_GATE_TEXTS.dns);
    // Nothing waits for the inbox check in app mode.
    expect((await inboxCheckHeldIds([cand], new Date())).size).toBe(0);

    // The next check is app mode's: the mx row is back (send.example.com has no MX for Mailgun here) and gates Live.
    const state = await check();
    expect(state).toMatchObject({ domain: APP_D, replies: "app" });
    const rows = rowsByKey(state.rows);
    expect(rows.mx!.status).toBe("bad");
    expect(rows["from-mx"]).toMatchObject({ status: "ok", title: checklistTitle("from-mx", D) });
    expect(rt.modeBlockersFor("LIVE", await rt.loadGateInputs())).toContain(MODE_GATE_TEXTS.dns);

    // The dashboard: go live again on the new domain.
    const dashboard = await loadDashboard(ownerUser, new Date());
    expect(dashboard.attention.find((i) => i.key === "go-live-again")).toMatchObject({ text: ATTENTION_TEXTS.goLiveAgainOwner(APP_D) });
  }, 60_000);
});
