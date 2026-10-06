import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { INBOUND_URL } from "../helpers/replies";
import { makeCompany } from "../campaigns/seed";
import { startFakeMailgun, type FakeMailgun } from "../../fake-mailgun/server";
import { FakeDns, type FakeZone } from "../../unit/checks/fake-dns";
import { testOriginal } from "../../unit/setup-core/originals";

/**
 * The owner's shape end to end (docs/dev/SHARED-FROM-DESIGN.md §9.3): every campaign email shows From
 * contact@example.com with the sender's display name, goes out through the Mailgun subdomain send.example.com (US
 * region, signed by example.com's DKIM key) with the sender's own address as Reply-To, and example.com's mail stays with
 * its mail provider. Nothing inside the app is mocked but the signed-in user of the server actions: Mailgun is the local
 * fake server, DNS a fake table (the §9.3 table), the app's public address is answered in-process, and the clock is the
 * test's own (Date only, running from Wednesday 23 Sep 2026, 10:00 in Berlin, moved on by hand). Nothing reaches the
 * network.
 *
 *   Set-up: Arslan (Owner) and Ali (Member), Mailgun connected through connectMailgun (US), each with an address on
 *     send.example.com.
 *   1. The Owner saves contact@example.com (saveFromAddressAction); before any check, Live mode names the unchecked
 *      main-domain MX row right after the DNS sentence.
 *   2. The Domain checklist: from-mx, from-spf, DMARC (on example.com) and DKIM (example.com's signature) done, titled
 *      with example.com; example.com's MX pointed at Mailgun turns from-mx red for Live, the reply test and going live,
 *      and tells the Owner once; put back, it is done again.
 *   3. Apply recommended settings: reply routes for both senders on send.example.com (and the certificate, https).
 *   4. The Owner's reply inbox becomes contact@example.com (the profile's check allows it) and his route forwards there.
 *   5. The reply test with the team headers, preset replies to the Reply-To, the answers (a spam placement at
 *      Outlook.com), one pasted original, an unsubscribe: passed for contact@example.com, with the spam-placement
 *      recommendation. A pasted original whose return address is on example.com fails it (then the good one again).
 *   6. A live campaign to the test list, delivered; going live needs the spam-placement tick; the dialog names the
 *      From address; `sending.goLiveFrom` records it.
 *   7. A live campaign with two follow-ups to four checked prospects (the fourth never answers, so the campaign is still
 *      running in step 10): the team headers; Anna replies (to the Reply-To) → stopped, Replied, Arslan told; Ben's
 *      out-of-office is automatic and his follow-up goes a day later in the same thread with the same From and Reply-To;
 *      Carl's address bounces → suppression, stopped; lastLiveSendAt of send.example.com.
 *   7b. Ben's new email to contact@example.com lands outside Mailgun (the fake stores nothing, the app sees nothing), so
 *      his follow-up still goes; a person sets his company to Replied and the rest stop.
 *   8. An unsubscribe from Ben's follow-up → suppression.
 *   9. Safety: example.com is never a Mailgun path segment, a SendingDomain or a route expression.
 *  10. Clearing the From address: refused while the live campaign runs; after cancelling it (and confirming), go-live
 *      ends, the reply test is reset with Setup A kept, the dashboard says "go live again", a live launch waits for the
 *      reply test and the go-live list for a new live test; a test-mode email goes From arslan@send.example.com without
 *      a Reply-To.
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

const t = await createTestDb("shared-from-e2e");

/** Wednesday 23 Sep 2026, 10:00 in Berlin: inside the default sending hours. The clock runs on from here. */
const WEDNESDAY_10_BERLIN = new Date("2026-09-23T08:00:00.000Z");
vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
vi.setSystemTime(WEDNESDAY_10_BERLIN);

const D = "send.example.com";
const ORG = "example.com";
const FROM = "contact@example.com";
const OWN = `arslan@${D}`;
const ALI_OWN = `ali@${D}`;
const FROM_LINE = `Arslan from Polygon Paradise <${FROM}>`;
const OWN_LINE = `Arslan from Polygon Paradise <${OWN}>`;
const OUTLOOK = "t.outlook@outlook.com";
const GMAIL = "t.gmail@gmail.com";
const TZ = "Europe/Berlin";
const PUB = "http://127.0.0.1:3100";
const EVENTS_URL = `${PUB}/api/webhooks/mailgun/events`;
const MINUTE = 60_000;
/** The fake Mailgun's DKIM record value (tests/fake-mailgun/state.ts dnsRecords). */
const DKIM_VALUE = "k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu5fakekeyfakekeyfakekeyfakekeyfakekeyfakekeyfakekeyQIDAQAB";

const previousEnv = { base: process.env.OUTREACH_MAILGUN_BASE_URL, pub: process.env.APP_PUBLIC_URL };
const fake: FakeMailgun = await startFakeMailgun({ domain: D, region: "US", dkimAuthority: ORG, apiKey: "key-fake-api", signingKey: "key-fake-signing" });
process.env.OUTREACH_MAILGUN_BASE_URL = fake.origin;
process.env.APP_PUBLIC_URL = PUB;

const { db, dbWrite } = await import("@/server/db");
const { getSetting } = await import("@/server/settings");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { connectMailgun } = await import("@/server/services/mailgun/connect");
const { runApplySettings } = await import("@/server/services/mailgun/apply-settings");
const { syncRoutes } = await import("@/server/services/mailgun/routes");
const { removeOwnSuppression } = await import("@/server/services/mailgun/suppressions");
const { runDomainCheck } = await import("@/server/services/checks/domain-check");
const { setSenderLocalPart } = await import("@/server/services/sender-addresses");
const rt = await import("@/server/services/reply-test");
const { sendReplyTestEmails } = await import("@/server/services/test-send");
const { loadGoLiveView } = await import("@/server/services/go-live");
const draft = await import("@/server/services/campaigns/draft");
const { launchModeProblems } = await import("@/server/services/campaigns/launch");
const { cancelCampaign } = await import("@/server/services/campaigns/control");
const { CampaignError } = await import("@/server/services/campaigns/errors");
const { setCompanyStatus } = await import("@/server/services/companies/mutations");
const loop = await import("@/server/services/sending/loop");
const { handleEventWebhook, handleInboundWebhook } = await import("@/server/services/mail-events/webhook");
const { processPendingMailEvents } = await import("@/server/services/mail-events/process");
const { processPendingInbound } = await import("@/server/services/replies/process");
const { saveFromAddressAction, setSendingModeAction, goLiveAction } = await import("@/app/(app)/settings/sending/actions");
const { updateProfileAction } = await import("@/app/(app)/settings/profile/actions");
const { loadDashboard } = await import("@/app/(app)/dashboard/load");
const { goLiveCardView } = await import("@/components/settings/sending/go-live-view");
const { ATTENTION_TEXTS } = await import("@/core/dashboard/attention");
const { checklistTitle } = await import("@/core/dns/checklist");
const { REPLY_TEST_TEXTS } = await import("@/core/reply-test");
const { GO_LIVE_COPY } = await import("@/core/sending/go-live-copy");
const { GO_LIVE_RECOMMENDATION_TEXTS, MODE_GATE_TEXTS } = await import("@/core/sending/mode-gates");
const { TEAM_FROM_TEXTS } = await import("@/core/sending/from-address");
const { MASTER_SEQUENCE } = await import("@/core/templates/defaults");
type ChecklistRow = import("@/core/system-state").ChecklistRow;

/** Fast retries and a short timeout against the fake. */
const mailgun = () => getMailgunContext({ retryDelayMs: () => 0, timeoutMs: 2_000 });

/**
 * The app's public address, answered in-process: the health route's JSON and the events webhook's own handler (the
 * public-address self-check of Apply and the Domain checklist). Anything else is refused.
 */
const appFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === `${PUB}/api/health`) return Response.json({ ok: true, database: "ok", workerLastSeen: null, time: new Date().toISOString() });
  if (url === EVENTS_URL) return handleEventWebhook(new Request(url, init), { now: new Date() });
  throw new TypeError(`fetch failed (no network in this test: ${url})`);
}) as typeof fetch;

/** The §9.3 DNS table: send.example.com is Mailgun's (US), example.com keeps its mail provider. */
function zone(): FakeZone {
  return {
    [D]: {
      txt: ["v=spf1 include:mailgun.org ~all"],
      mx: [
        { priority: 10, exchange: "mxa.mailgun.org" },
        { priority: 10, exchange: "mxb.mailgun.org" },
      ],
    },
    "mailgun.org": { txt: ["v=spf1 include:_spf.mailgun.org -all"] },
    "_spf.mailgun.org": { txt: ["v=spf1 ip4:159.135.224.0/20 ~all"] },
    [`pdk1._domainkey.${ORG}`]: { txt: [[DKIM_VALUE.slice(0, 60), DKIM_VALUE.slice(60)]] },
    [`email.${D}`]: { cname: ["mailgun.org."] },
    [ORG]: { mx: [{ priority: 10, exchange: "mx.provider.example" }], txt: ["v=spf1 include:_spf.provider.example ~all"] },
    "_spf.provider.example": { txt: ["v=spf1 ip4:192.0.2.20 ~all"] },
    [`_dmarc.${ORG}`]: { txt: ["v=DMARC1; p=none"] },
  };
}

/** The Domain checklist's "Check again" with both resolvers answering from `z`. */
async function check(z: FakeZone = zone()) {
  return runDomainCheck({ verify: true, lookups: [new FakeDns(z), new FakeDns(z)], mailgun, fetchImpl: appFetch });
}

function rowsByKey(rows: readonly ChecklistRow[]): Record<string, ChecklistRow> {
  return Object.fromEntries(rows.map((r) => [r.key, r]));
}

/** The clock jumps forward (Date only; timers and the network stay real). */
function advance(ms: number): Date {
  const next = new Date(Date.now() + ms);
  vi.setSystemTime(next);
  return next;
}

async function postEvent(data: Record<string, unknown>): Promise<void> {
  const res = await handleEventWebhook(fake.signedEventRequest(EVENTS_URL, data), { now: new Date() });
  expect(res.status).toBe(200);
}

/** The fake's answer of kind `preset` to one of its sent messages, posted to the app when it reached Mailgun. */
async function preset(kind: "reply" | "out-of-office" | "new-email", messageId: string) {
  const res = fake.receivePreset(kind, messageId);
  if (res.stored) {
    const posted = await handleInboundWebhook(fake.signedInboundRequest(INBOUND_URL, res.fields), { now: fake.now() });
    expect(posted.status).toBe(200);
  }
  return res;
}

/** The event lane: stored Mailgun events, then stored replies. */
async function lane(): Promise<void> {
  for (let i = 0; i < 10 && (await processPendingMailEvents({ now: new Date() })).processed > 0; i++) {
    /* until nothing is left */
  }
  await processPendingInbound({ now: new Date() });
}

/** The background sender's heartbeat, fresh now (going live needs a running background sender). */
async function heartbeat(): Promise<void> {
  const at = new Date();
  await dbWrite((c) =>
    c.workerLease.upsert({ where: { id: 1 }, create: { id: 1, workerId: "shared-from-e2e", heartbeatAt: at, startedAt: at }, update: { heartbeatAt: at } }),
  );
}

/**
 * Sending-loop rounds (the real loop, renderer and Mailgun transport) until `done`, each after forgetting the pacer's
 * gap, so one gated email goes per round.
 */
async function sendUntil(done: () => Promise<boolean>, rounds = 12): Promise<void> {
  let last: unknown = null;
  for (let i = 0; i < rounds && !(await done()); i++) {
    await dbWrite((c) => c.systemState.deleteMany({ where: { key: "sending.pacer" } }));
    last = await loop.sendingTick({ mailgun, random: () => 0.5 });
  }
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

/** A draft by Arslan with these companies and steps, in today's sending mode. */
async function newDraft(name: string, companyIds: number[], delays: number[] = []): Promise<number> {
  const d = await draft.createDraft(owner, { companyIds, name, timeZone: TZ });
  await draft.saveDraftSteps(owner, d.id, stepsWith(delays));
  return d.id;
}

function messagesOf(campaignId: number) {
  return fake.messages.filter((m) => m.fields["v:campaign_id"]?.[0] === String(campaignId));
}

const field = (m: { fields: Record<string, string[]> }, k: string) => m.fields[k]?.[0];

/**
 * Where a request the fake received names the From domain as a whole value (a Logs search's domain filter, a form
 * field, a query parameter): the From domain is never a Mailgun domain (SHARED-FROM-DESIGN §2.5). Addresses on it
 * ("contact@example.com" in a From line or a forward) are not domain names and don't count.
 */
function fromDomainNamedIn(): string[] {
  const hits: string[] = [];
  const walk = (v: unknown, where: string): void => {
    if (typeof v === "string") {
      if (v.trim().toLowerCase().replace(/\.+$/, "") === ORG) hits.push(where);
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${where}[${i}]`));
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`);
    }
  };
  for (const r of fake.requests) {
    walk(r.query, `${r.method} ${r.path} query`);
    walk(r.body, `${r.method} ${r.path} body`);
  }
  return hits;
}

async function companyWith(name: string, email: string, personName: string, checked: boolean): Promise<{ companyId: number; personId: number }> {
  const { company, people } = await makeCompany({ name, domain: email.split("@")[1]!, people: [{ name: personName, email }] });
  await dbWrite(async (c) => {
    await c.company.update({ where: { id: company.id }, data: { country: "DE", timeZone: TZ } });
    if (checked) {
      await c.person.update({
        where: { id: people[0]!.id },
        data: { verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: new Date(Date.now() - 10 * 86_400_000), verificationProvider: "mailgun-fake" },
      });
    }
  });
  return { companyId: company.id, personId: people[0]!.id };
}

const S = {
  outlook: { companyId: 0, personId: 0 },
  gmail: { companyId: 0, personId: 0 },
  liveTest: 0,
  prospects: 0,
  prospect: {} as Record<"anna" | "ben" | "carl" | "dora", { companyId: number; personId: number; email: string }>,
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
        replyInbox: "arslan.owner@example.org",
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
  auth.user = ownerUser;

  // Mailgun connected for real (US), the records Mailgun sees as valid, and each sender's own address.
  expect(await connectMailgun(owner, { region: "US", domain: D, apiKey: "key-fake-api" }, { retryDelayMs: () => 0 })).toMatchObject({ ok: true });
  fake.setDns("all");
  fake.setMonthlyLimit({ limit: 30_000, current: 0 });
  expect((await setSenderLocalPart(owner, owner.id, "arslan")).address).toBe(OWN);
  expect((await setSenderLocalPart(owner, ali.id, "ali")).address).toBe(ALI_OWN);
});

afterAll(async () => {
  vi.useRealTimers();
  if (previousEnv.base === undefined) delete process.env.OUTREACH_MAILGUN_BASE_URL;
  else process.env.OUTREACH_MAILGUN_BASE_URL = previousEnv.base;
  if (previousEnv.pub === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previousEnv.pub;
  await fake.close();
  await db.$disconnect();
  t.cleanup();
});

describe("the owner's shape: From contact@example.com through send.example.com", () => {
  it("1. the Owner saves the From address; before any check, Live names the unchecked main-domain MX", async () => {
    expect(fake.dkimAuthority).toBe(ORG);
    expect(await saveFromAddressAction({ fromAddress: FROM })).toEqual({
      ok: true,
      data: { fromAddress: FROM, goLiveEnded: false },
      message: TEAM_FROM_TEXTS.savedOn(FROM, D),
    });
    expect(await getSetting("mailgun.fromAddress")).toBe(FROM);
    const blockers = rt.modeBlockersFor("LIVE", await rt.loadGateInputs());
    expect(blockers).toContain(MODE_GATE_TEXTS.fromMxUnchecked);
    expect(blockers.indexOf(MODE_GATE_TEXTS.fromMxUnchecked)).toBe(blockers.indexOf(MODE_GATE_TEXTS.dns) + 1);
  });

  it("2. the Domain checklist: the From domain's rows done and titled with it; a Mailgun MX on example.com is red everywhere and told once", async () => {
    const state = await check();
    expect(state).toMatchObject({ domain: D, region: "US", error: null });
    const rows = rowsByKey(state.rows);
    const keys = state.rows.map((r) => r.key);
    expect(keys.slice(keys.indexOf("dmarc"), keys.indexOf("dmarc") + 3)).toEqual(["dmarc", "from-mx", "from-spf"]);
    expect(rows["from-mx"]).toMatchObject({
      status: "ok",
      title: checklistTitle("from-mx", ORG),
      text: `Mail for ${ORG} goes to your mail provider (mx.provider.example), not to Mailgun. Keep it that way.`,
    });
    expect(rows["from-mx"]!.title).toBe("Mail for example.com stays with your mail provider (MX)");
    expect(rows["from-spf"]).toMatchObject({ status: "ok", title: checklistTitle("from-spf", ORG) });
    expect(rows["from-spf"]!.title).toBe("example.com's SPF record (your everyday email)");
    for (const key of ["from-mx", "from-spf"]) expect(rows[key]!.title).not.toContain(D);
    expect(rows.dmarc).toMatchObject({ status: "ok", text: `${ORG}'s policy: monitor only. Right for now.` });
    expect(rows.dkim!.status).toBe("ok");
    expect(rows.dkim!.text).toMatch(/^Your emails carry example\.com's digital signature.*, which matches your From address\.$/);
    for (const key of ["mailgun-domain", "spf", "mx", "tracking-cname"]) expect(rows[key]!.status, key).toBe("ok");

    // example.com's MX pointed at Mailgun (GoDaddy's "@" default): red for Live, the reply test and going live.
    const red = zone();
    red[ORG]!.mx = [
      { priority: 10, exchange: "mxa.mailgun.org" },
      { priority: 10, exchange: "mxb.mailgun.org" },
    ];
    expect(rowsByKey((await check(red)).rows)["from-mx"]).toMatchObject({ status: "bad", text: expect.stringContaining(`${ORG}'s mail servers (MX) point to Mailgun.`) });
    await check(red);
    const gate = await rt.loadGateInputs();
    expect(rt.modeBlockersFor("LIVE", gate)).toContain(MODE_GATE_TEXTS.fromMx);
    expect(rt.replyTestBlockersFor(gate)).toContain(MODE_GATE_TEXTS.fromMx);
    expect(rt.goLiveBlockersFor(gate)).toContain(`${checklistTitle("from-mx", ORG)}: not done yet (Domain checklist).`);
    const told = await db.notification.findMany({ where: { title: `Mail for ${ORG} goes to the wrong place` } });
    expect(told.map((n) => [n.userId, n.type, n.link])).toEqual([[owner.id, "system.mailgun", "/settings/domain"]]);

    // Put back: done again.
    expect(rowsByKey((await check()).rows)["from-mx"]!.status).toBe("ok");
    expect(rt.modeBlockersFor("LIVE", await rt.loadGateInputs())).not.toContain(MODE_GATE_TEXTS.fromMx);
  });

  it("3. Apply recommended settings: reply routes for both senders on send.example.com, and secure links", async () => {
    const applied = await runApplySettings({ byUserId: owner.id, mailgun, fetchImpl: appFetch });
    expect(applied.steps.filter((s) => s.ok === false).map((s) => `${s.key}: ${s.text}`)).toEqual([]);
    for (const attempt of [1, 2]) await runApplySettings({ byUserId: owner.id, step: "certificate-poll", attempt, mailgun, fetchImpl: appFetch });
    expect(fake.state().tracking.webScheme).toBe("https");
    const routes = fake.state().routes;
    const expressions = routes.map((r) => String(r.expression));
    expect(expressions).toEqual(
      expect.arrayContaining([
        'match_recipient("^arslan@send\\.example\\.com$")',
        'match_recipient("^ali@send\\.example\\.com$")',
        'match_recipient("^.*@send\\.example\\.com$")',
      ]),
    );
    for (const address of [OWN, ALI_OWN]) {
      expect((await db.senderAddress.findUniqueOrThrow({ where: { address } })).routeStatus, address).toBe("ok");
    }
  });

  it("4. the Owner's reply inbox contact@example.com passes the profile's check, and his route forwards there", async () => {
    const res = await updateProfileAction({
      name: "Arslan",
      senderDisplayName: "Arslan from Polygon Paradise",
      replyInbox: FROM,
      signature: "Arslan\nPolygon Paradise",
      timeZone: TZ,
    });
    expect(res).toMatchObject({ ok: true, message: "Profile saved." });
    expect(await db.job.count({ where: { type: "mailgun.syncRoutes", status: "QUEUED" } })).toBeGreaterThan(0);
    const synced = await syncRoutes({ mailgun });
    expect(synced.problems).toEqual([]);
    const route = fake.state().routes.find((r) => String(r.expression).includes("^arslan@send"));
    expect(route?.actions).toContain(`forward("${FROM}")`);
    expect(await db.senderAddress.findUniqueOrThrow({ where: { address: OWN } })).toMatchObject({ routeStatus: "ok", forwardTo: FROM });
  });

  it("5. the reply test with the team headers, one pasted original and a spam placement passes for contact@example.com", async () => {
    // "Check again" after Apply; Test mode; the test list (never contact@).
    await check();
    expect(await setSendingModeAction({ mode: "TEST" })).toMatchObject({ ok: true });
    expect(await rt.saveTestList(owner, [OUTLOOK, GMAIL])).toMatchObject({ ok: true, value: [OUTLOOK, GMAIL] });
    expect(rt.replyTestBlockersFor(await rt.loadGateInputs())).toEqual([]);

    expect(await sendReplyTestEmails(owner.id, { jobId: 7001, mailgun })).toMatchObject({ sent: 2, failed: 0 });
    expect(fake.messages.map((m) => field(m, "to"))).toEqual([OUTLOOK, GMAIL]);
    for (const m of fake.messages) {
      expect(field(m, "from")).toBe(FROM_LINE);
      expect(field(m, "h:Reply-To")).toBe(OWN);
      expect(field(m, "h:Message-Id")).toMatch(/@send\.example\.com>$/);
    }
    const sends = await db.testSend.findMany({ where: { purpose: "REPLY_TEST" }, orderBy: { id: "asc" } });
    expect(sends.map((s) => [s.to, s.teamFrom])).toEqual([
      [OUTLOOK, FROM],
      [GMAIL, FROM],
    ]);
    const gmail = sends.find((s) => s.to === GMAIL)!;

    // Delivered; a minute later each mailbox replies (to the Reply-To: Arslan's route, the app).
    for (const s of sends) await postEvent(fake.deliver(s.messageId!));
    advance(MINUTE);
    for (const s of sends) {
      const r = await preset("reply", s.messageId!);
      expect(r).toMatchObject({ stored: true, deliveredTo: "mailgun", to: OWN, target: "reply-to" });
    }

    // The answers: placement Yes at Gmail, No (junk) at Outlook.com; DMARC read from a pasted Gmail original.
    const pastedHeaders = testOriginal({ from: FROM_LINE, messageId: gmail.messageId!, replyTo: OWN, to: GMAIL });
    const answered = await rt.saveReplyTestAnswers(owner, {
      mailboxes: [
        { address: OUTLOOK, inboxOk: true, authOk: "pass", placementOk: false, dmarcOk: "pass" },
        { address: GMAIL, inboxOk: true, authOk: "pass", placementOk: true, dmarcOk: "unsure", dmarcPasted: pastedHeaders },
      ],
      headersOk: true,
    });
    expect(answered.dmarcFromHeaders).toEqual({ [GMAIL]: "pass" });

    // One pasted original: the return address and the unsubscribe mailto on send.example.com, signed by example.com.
    const { original } = await rt.saveReplyTestOriginal(owner, { pasted: testOriginal({ from: FROM_LINE, messageId: gmail.messageId!, replyTo: OWN, to: GMAIL }), address: GMAIL });
    expect(original).toMatchObject({ domain: D, from: FROM, returnPathDomain: D, returnPathOk: true, dmarc: "pass", dkimSigner: ORG, mailtoDomain: D, mailtoOk: true });

    // The unsubscribe link of the Gmail test email (Mailgun tells the app); the test mailbox is then taken off the list.
    await postEvent(fake.unsubscribe(gmail.messageId!));
    await lane();
    expect(await removeOwnSuppression(owner, GMAIL, { mailgun })).toMatchObject({ removed: true });

    const data = await rt.loadReplyTest();
    expect(data.verdict).toEqual({ status: "passed", missing: [], warnings: [REPLY_TEST_TEXTS.spamWarning(OUTLOOK)] });
    expect(await rt.decideReplyTest(owner)).toMatchObject({ status: "passed" });
    expect(await getSetting("mailgun.unsubscribeTest")).toMatchObject({ status: "passed", setup: "A", domain: D, from: FROM });
    const gate = await rt.loadGateInputs();
    expect(gate.replyTestPassedOnDomain).toBe(true);
    expect(rt.goLiveRecommendationsFor(gate)).toContain(GO_LIVE_RECOMMENDATION_TEXTS.spamPlacement(`Outlook.com (${OUTLOOK})`));

    // A second run of the verdict: an original whose return address is on example.com fails it.
    await rt.saveReplyTestOriginal(owner, {
      pasted: testOriginal({ from: FROM_LINE, messageId: gmail.messageId!, replyTo: OWN, to: GMAIL, returnPath: "bounce+1a2b3c=gmail.com@example.com" }),
      address: GMAIL,
    });
    expect((await rt.loadReplyTest()).verdict).toMatchObject({ status: "failed", missing: [REPLY_TEST_TEXTS.returnPathFailed(ORG, D)] });
    // The good one again.
    await rt.saveReplyTestOriginal(owner, { pasted: testOriginal({ from: FROM_LINE, messageId: gmail.messageId!, replyTo: OWN, to: GMAIL }), address: GMAIL });
    expect((await rt.loadReplyTest()).verdict.status).toBe("passed");
  });

  it("6. a delivered live test email; going live needs the spam-placement tick and records the From address", async () => {
    S.outlook = await companyWith("Test – Outlook", OUTLOOK, "Tess Outlook", false);
    S.gmail = await companyWith("Test – Gmail", GMAIL, "Tess Gmail", false);
    expect(await setSendingModeAction({ mode: "LIVE" })).toMatchObject({ ok: true });
    S.liveTest = await newDraft("Live test", [S.outlook.companyId, S.gmail.companyId]);
    expect(await draft.launchDraft(owner, S.liveTest, { mailgun })).toMatchObject({ status: "RUNNING", mode: "LIVE", queued: 2 });
    expect(await db.campaign.findUniqueOrThrow({ where: { id: S.liveTest } })).toMatchObject({ fromAddress: FROM, replyTo: OWN, launchedGoLive: false });
    await sendUntil(async () => messagesOf(S.liveTest).length >= 2);
    for (const m of messagesOf(S.liveTest)) {
      expect(field(m, "from")).toBe(FROM_LINE);
      expect(field(m, "h:Reply-To")).toBe(OWN);
      expect(field(m, "o:testmode")).toBeUndefined();
    }
    const outlookEmail = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: S.liveTest, toNorm: OUTLOOK } });
    await postEvent(fake.deliver(outlookEmail.providerId ?? outlookEmail.messageId));
    await lane();

    // A fresh check and a running background sender: the only thing left is the tick about Outlook.com's junk folder.
    await check();
    await heartbeat();
    const view = await loadGoLiveView();
    expect(view).toMatchObject({ live: false, blockers: [], from: FROM, spamPlacements: [`Outlook.com (${OUTLOOK})`] });
    const card = goLiveCardView(view, { timeZone: TZ, warmup: { startCap: 50, maxCap: 1000, steps: 20 } });
    expect(card.dialogItems).toContain(GO_LIVE_COPY.dialogTeamFromItem(FROM, ORG));
    expect(card.spamPlacementTick).toBe(GO_LIVE_COPY.spamPlacementTick(`Outlook.com (${OUTLOOK})`));

    expect(await goLiveAction({ confirm: true })).toEqual({ ok: false, error: GO_LIVE_COPY.spamPlacementRequired });
    expect(await getSetting("sending.goLive")).toBe(false);
    const res = await goLiveAction({ confirm: true, confirmSpamPlacement: true });
    expect(res).toMatchObject({ ok: true, data: { alreadyLive: false } });
    expect(await getSetting("sending.goLive")).toBe(true);
    expect(await getSetting("sending.goLiveFrom")).toBe(FROM);
    expect(await getSetting("sending.goLiveDomain")).toBe(D);
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "sending.goLive" } });
    expect(log.data).toMatchObject({ domain: D, from: FROM, spamPlacementConfirmed: true });
  });

  it("7. a live campaign to checked prospects: team headers; a reply stops, an out-of-office doesn't, a bounce suppresses", async () => {
    await dbWrite((c) => c.sendingDomain.update({ where: { name: D }, data: { lastLiveSendAt: null } }));
    const people = [
      ["anna", "Firma Anna", "anna@firma-anna.example", "Anna Berg"],
      ["ben", "Studio Ben", "ben@studio-ben.example", "Ben Braun"],
      ["carl", "Druck Carl", "carl@druck-carl.example", "Carl Nagel"],
      ["dora", "Werk Dora", "dora@werk-dora.example", "Dora Lind"],
    ] as const;
    for (const [key, name, email, person] of people) S.prospect[key] = { ...(await companyWith(name, email, person, true)), email };
    S.prospects = await newDraft(
      "Germany Q4",
      people.map(([key]) => S.prospect[key].companyId),
      [1, 2],
    );
    expect(await draft.launchDraft(owner, S.prospects, { mailgun })).toMatchObject({ status: "RUNNING", mode: "LIVE", queued: 4 });
    expect(await db.campaign.findUniqueOrThrow({ where: { id: S.prospects } })).toMatchObject({
      fromName: "Arslan from Polygon Paradise",
      fromAddress: FROM,
      replyTo: OWN,
      launchedGoLive: true,
    });
    const sentAt = new Date();
    await sendUntil(async () => messagesOf(S.prospects).length >= 4);
    for (const m of messagesOf(S.prospects)) {
      expect(field(m, "from")).toBe(FROM_LINE);
      expect(field(m, "h:Reply-To")).toBe(OWN);
      expect(field(m, "h:Message-Id")).toMatch(/^<pp\.[0-9a-f]+@send\.example\.com>$/);
      expect(field(m, "o:testmode")).toBeUndefined();
    }
    expect(fake.requests.filter((r) => r.method === "POST" && r.path.endsWith("/messages")).every((r) => r.path === `/v3/${D}/messages`)).toBe(true);
    const domainRow = await db.sendingDomain.findUniqueOrThrow({ where: { name: D } });
    expect(domainRow.lastLiveSendAt?.getTime()).toBeGreaterThanOrEqual(sentAt.getTime());
    const first = async (key: keyof typeof S.prospect) =>
      db.outboundEmail.findFirstOrThrow({ where: { campaignId: S.prospects, toNorm: S.prospect[key].email, step: 0 } });
    const recipient = async (key: keyof typeof S.prospect) =>
      db.campaignRecipient.findFirstOrThrow({ where: { campaignId: S.prospects, personId: S.prospect[key].personId } });

    // Anna replies (to the Reply-To): stored for Arslan's address, stopped, Replied, Arslan told.
    advance(MINUTE);
    const anna = await first("anna");
    expect(await preset("reply", anna.messageId)).toMatchObject({ stored: true, to: OWN });
    await lane();
    const annaReply = await db.inboundMessage.findFirstOrThrow({ where: { fromEmail: S.prospect.anna.email } });
    expect(annaReply).toMatchObject({ kind: "REPLY", toAddress: OWN, outboundEmailId: anna.id });
    expect(await recipient("anna")).toMatchObject({ state: "STOPPED", stopReason: "replied" });
    expect((await db.company.findUniqueOrThrow({ where: { id: S.prospect.anna.companyId } })).status).toBe("REPLIED");
    const toldArslan = await db.notification.findMany({ where: { userId: owner.id, type: "reply.received" } });
    expect(toldArslan.map((n) => n.title)).toEqual(["New reply from Firma Anna"]);

    // Ben's out-of-office (to the Reply-To) is automatic: his follow-up still waits.
    const ben = await first("ben");
    expect(await preset("out-of-office", ben.messageId)).toMatchObject({ stored: true, to: OWN });
    await lane();
    expect(await db.inboundMessage.findFirstOrThrow({ where: { fromEmail: S.prospect.ben.email } })).toMatchObject({ kind: "AUTO_REPLY" });
    expect((await recipient("ben")).state).toBe("WAITING");
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: S.prospects, toNorm: S.prospect.ben.email, step: 1 } })).status).toBe("QUEUED");

    // Carl's address bounces (a permanent failure on send.example.com): suppressed and stopped.
    const carl = await first("carl");
    const bounce = fake.bounce(carl.providerId ?? carl.messageId);
    expect((bounce.domain as { name: string }).name).toBe(D);
    await postEvent(bounce);
    await lane();
    expect(await db.suppression.findUnique({ where: { emailNorm: S.prospect.carl.email } })).toMatchObject({ reason: "BOUNCED" });
    expect((await recipient("carl")).state).toBe("STOPPED");
  });

  it("7b. Ben's new email to contact@example.com never reaches Mailgun or the app, so his follow-up goes; Replied by hand stops the rest", async () => {
    const storedBefore = await db.inboundMessage.count();
    const eventsBefore = fake.state().logEvents.length;
    const ben = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: S.prospects, toNorm: S.prospect.ben.email, step: 0 } });
    const outside = await preset("new-email", ben.messageId);
    expect(outside).toEqual({ ok: true, stored: false, deliveredTo: "outside", to: FROM, target: "from" });
    const logEvents = fake.state().logEvents;
    expect(logEvents.length).toBe(eventsBefore);
    expect(logEvents.filter((e) => e.event === "stored" && /@example\.com$/.test(String(e.recipient)))).toEqual([]);
    await lane();
    expect(await db.inboundMessage.count()).toBe(storedBefore);

    // A day later: Ben's and Dora's follow-up 1, from the same From line and Reply-To, in the thread.
    const f1 = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: S.prospects, toNorm: S.prospect.ben.email, step: 1 } });
    expect(f1).toMatchObject({ fromAddress: FROM_LINE, replyTo: OWN });
    vi.setSystemTime(new Date(Math.max(f1.dueAt.getTime(), Date.now()) + 1_000));
    await heartbeat();
    const followUps = () => messagesOf(S.prospects).filter((m) => field(m, "v:step") === "1");
    await sendUntil(async () => followUps().length >= 2);
    const benFollowUp = followUps().find((m) => field(m, "to") === S.prospect.ben.email)!;
    expect(field(benFollowUp, "from")).toBe(FROM_LINE);
    expect(field(benFollowUp, "h:Reply-To")).toBe(OWN);
    const received = ben.providerId && ben.providerId.includes("@") ? ben.providerId : ben.messageId;
    expect(field(benFollowUp, "h:In-Reply-To")).toBe(`<${received}>`);
    expect(followUps().map((m) => field(m, "to")).sort()).toEqual([S.prospect.ben.email, S.prospect.dora.email].sort());

    // Ben had answered at contact@: a person sets his company to Replied, and his last follow-up stops.
    await setCompanyStatus(owner, S.prospect.ben.companyId, "REPLIED");
    expect(
      (await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: S.prospects, personId: S.prospect.ben.personId } })).state,
    ).toBe("STOPPED");
    expect(await db.outboundEmail.count({ where: { campaignId: S.prospects, toNorm: S.prospect.ben.email, status: "QUEUED" } })).toBe(0);
  });

  it("8. an unsubscribe from Ben's follow-up is recorded (suppression)", async () => {
    const f1 = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: S.prospects, toNorm: S.prospect.ben.email, step: 1 } });
    await postEvent(fake.unsubscribe(f1.providerId ?? f1.messageId));
    await lane();
    expect(await db.suppression.findUnique({ where: { emailNorm: S.prospect.ben.email } })).toMatchObject({ reason: "UNSUBSCRIBED" });
    expect(
      (await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: S.prospects, personId: S.prospect.ben.personId } })).state,
    ).toBe("STOPPED");
  });

  it("9. example.com is never Mailgun's: no request path, no SendingDomain, no route expression names it", async () => {
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(fake.requests.filter((r) => /\/example\.com(\/|$)/.test(r.path)).map((r) => `${r.method} ${r.path}`)).toEqual([]);
    // Nor a request's body or query (the Logs API names its domain in the body's filter).
    expect(fromDomainNamedIn()).toEqual([]);
    expect((await db.sendingDomain.findMany({ select: { name: true } })).map((d) => d.name)).toEqual([D]);
    const expressions = fake.state().routes.map((r) => String(r.expression));
    expect(expressions.length).toBeGreaterThan(0);
    expect(expressions.filter((e) => e.includes("@example\\.com$"))).toEqual([]);
  });

  it("10. clearing the From address: refused while the live campaign runs; afterwards go-live ends and each person's own address is the From again", async () => {
    // Dora still waits for her last follow-up: the campaign runs.
    expect((await db.campaign.findUniqueOrThrow({ where: { id: S.prospects } })).status).toBe("RUNNING");
    expect(await saveFromAddressAction({ fromAddress: "" })).toEqual({
      ok: false,
      error: "Finish or cancel “Germany Q4” first: it sends with the current From address.",
    });
    expect(await getSetting("mailgun.fromAddress")).toBe(FROM);

    await cancelCampaign(S.prospects, owner.id);
    expect(await saveFromAddressAction({ fromAddress: "" })).toEqual({ ok: false, error: TEAM_FROM_TEXTS.confirmBody });
    expect(await saveFromAddressAction({ fromAddress: "", confirmEndGoLive: true })).toEqual({
      ok: true,
      data: { fromAddress: null, goLiveEnded: true },
      message: `${TEAM_FROM_TEXTS.savedOff(D)} ${GO_LIVE_COPY.endedByFromChange}`,
    });
    expect(await getSetting("mailgun.fromAddress")).toBeNull();
    expect(await getSetting("sending.goLive")).toBe(false);
    const reset = await getSetting("mailgun.unsubscribeTest");
    expect(reset).toMatchObject({ setup: "A", status: "untested", mailboxes: [] });
    expect(reset.from ?? null).toBeNull();
    expect(reset.original ?? null).toBeNull();

    // The dashboard: go live again.
    const dashboard = await loadDashboard(ownerUser, new Date());
    expect(dashboard.attention.find((i) => i.key === "go-live-again")).toMatchObject({ text: ATTENTION_TEXTS.goLiveAgainFromOwner });

    // A live launch waits for the reply test; going live needs a live test sent with each person's own address.
    expect(await getSetting("sending.mode")).toBe("LIVE");
    const again = await newDraft("Live again", [S.outlook.companyId]);
    const problems = await launchModeProblems("LIVE", { name: "Arslan", address: { address: OWN, routeStatus: "ok" } }, { mailgun });
    expect(problems[0]).toEqual({ code: "mode-not-ready", text: MODE_GATE_TEXTS.replyTestPass });
    const err = await draft.launchDraft(owner, again, { mailgun }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CampaignError);
    expect(err).toMatchObject({ code: "mode-not-ready", message: MODE_GATE_TEXTS.replyTestPass });
    expect(await db.campaign.findUniqueOrThrow({ where: { id: again } })).toMatchObject({ status: "DRAFT" });
    await heartbeat();
    expect(rt.goLiveBlockersFor(await rt.loadGateInputs())).toContain(MODE_GATE_TEXTS.liveTestNone);

    // A test-mode email to the test list: From Arslan's own address, no Reply-To.
    expect(await setSendingModeAction({ mode: "TEST" })).toMatchObject({ ok: true });
    const testRun = await newDraft("Test mode check", [S.outlook.companyId]);
    expect(await draft.launchDraft(owner, testRun, { mailgun })).toMatchObject({ status: "RUNNING", mode: "TEST", queued: 1 });
    expect(await db.campaign.findUniqueOrThrow({ where: { id: testRun } })).toMatchObject({ fromAddress: OWN, replyTo: null });
    await sendUntil(async () => messagesOf(testRun).length >= 1);
    const [m] = messagesOf(testRun);
    expect(field(m!, "from")).toBe(OWN_LINE);
    expect(m!.fields["h:Reply-To"]).toBeUndefined();
    expect(field(m!, "o:testmode")).toBe("yes");
    expect(fake.requests.filter((r) => /\/example\.com(\/|$)/.test(r.path))).toEqual([]);
    expect(fromDomainNamedIn()).toEqual([]);
  });
});
