import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReplyTestRound } from "@/core/reply-test";
import type { CheckStatus, ChecklistGroup, ChecklistRowKey } from "@/core/system-state";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { fastMailgun, makeUser, setSettingValue } from "../mailgun-setup/helpers";
import { testOriginal } from "../../unit/setup-core/originals";

/**
 * The reply test by hand in own-mailbox mode (MAIN-DOMAIN-DESIGN O13, O38, §3.5, §8 P4) against the fake Mailgun on
 * example.com (US, Free, `receivesMail: false`: its MX is the mail provider's) with no public address: the blockers need
 * no reply route and no public address but the DMARC row; the emails come From the Owner's name with contact@, no
 * Reply-To, Message-IDs on example.com, `TestSend.teamFrom`; a preset reply goes "outside" and nothing is stored;
 * deliveries and the unsubscribe arrive through the Logs catch-up; the answers and one pasted original (stored with the
 * link's scheme and the mailto: address); the unsubscribe-by-email answer fails or passes the test; the decision records
 * the mode; the Domain checklist page's own-mailbox data; Setup B refused; an authorized-only refusal of a test email.
 */

vi.mock("server-only", () => ({}));

const D = "example.com";
const FROM = "contact@example.com";
const FROM_LINE = "Arslan from Polygon Paradise <contact@example.com>";
const OUTLOOK = "t.outlook@outlook.com";
const GMAIL = "t.gmail@gmail.com";
const MAILTO = "u+x@example.com";

const t = await createTestDb("own-mailbox-reply-test");
const previousPub = process.env.APP_PUBLIC_URL;
delete process.env.APP_PUBLIC_URL;
const mg: FakeConnection = await connectFakeMailgun({
  domain: D,
  region: "US",
  replies: "own-mailbox",
  fromAddress: FROM,
  plan: "free",
  fake: { domain: D, region: "US", plan: "free", receivesMail: false },
});
const { db } = await import("@/server/db");
const { getSetting } = await import("@/server/settings");
const { setState } = await import("@/server/state");
const rt = await import("@/server/services/reply-test");
const ts = await import("@/server/services/test-send");
const { runCatchUp } = await import("@/server/services/mailgun/catch-up");
const { getPauseState, resumeSending } = await import("@/server/services/sending/pause");
const { loadDomainPage } = await import("@/app/(app)/settings/domain/load");
const { MODE_GATE_TEXTS } = await import("@/core/sending/mode-gates");
const { REPLY_TEST_TEXTS } = await import("@/core/reply-test");
const { OWN_MAILBOX_TEXTS, OWN_REPLY_TEST_TEXTS } = await import("@/core/sending/own-mailbox");
const { PLAN_TEXTS } = await import("@/core/mailgun/plan");

const OWN_ROWS: ReadonlyArray<[ChecklistRowKey, ChecklistGroup]> = [
  ["mailgun-domain", "mailgun"],
  ["spf", "dns"],
  ["dkim", "dns"],
  ["tracking-cname", "dns"],
  ["https-links", "dns"],
  ["dmarc", "dns"],
  ["from-mx", "dns"],
  ["tracking-off", "settings"],
  ["unsubscribe", "settings"],
  ["signing-key", "settings"],
  ["webhooks", "settings"],
  ["sending-allowed", "settings"],
  ["monthly-limit", "settings"],
  ["remote-access", "connection"],
  ["reply-test", "connection"],
  ["postmaster", "optional"],
  ["domain-age", "optional"],
];

/** SystemState "domain.check" as an own-mailbox check writes it (Free, no public address: those rows are "info"). */
async function writeOwnCheck(
  statuses: Partial<Record<ChecklistRowKey, CheckStatus | "absent">> = {},
  opts: { replies?: "own-mailbox" | "app" } = {},
): Promise<void> {
  const base: Partial<Record<ChecklistRowKey, CheckStatus>> = { "https-links": "info", webhooks: "info", "remote-access": "info", "monthly-limit": "info" };
  const rows = OWN_ROWS.filter(([key]) => statuses[key] !== "absent").map(([key, group]) => ({
    key,
    group,
    status: (statuses[key] as CheckStatus | undefined) ?? base[key] ?? "ok",
    title: `Row ${key}`,
    text: `Text of ${key}`,
    fix: null,
    records: [],
    detail: null,
  }));
  await setState("domain.check", {
    domain: D,
    region: "US",
    checkedAt: new Date().toISOString(),
    lastVerifyAt: null,
    rows,
    error: null,
    replies: opts.replies ?? "own-mailbox",
  });
}

const field = (m: { fields: Record<string, string[]> }, k: string) => m.fields[k]?.[0];
let owner: { id: number; name: string; email: string };
let round: ReplyTestRound;

async function replyTestSends(jobId: number) {
  return db.testSend.findMany({ where: { purpose: "REPLY_TEST", messageId: { startsWith: `pp.t.${jobId}.` } }, orderBy: { id: "asc" } });
}

async function sessionOwner() {
  return { id: owner.id, email: owner.email, name: owner.name, role: "OWNER" as const, timeZone: "Asia/Karachi", sessionId: 1 };
}

beforeAll(async () => {
  owner = await makeUser("Arslan", { role: "OWNER", replyInbox: "arslan.owner@gmail.com" });
  await setSettingValue("sending.mode", "TEST");
  await setSettingValue("sending.testList", [OUTLOOK, GMAIL]);
  await writeOwnCheck();
});

afterAll(async () => {
  if (previousPub === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previousPub;
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("the reply test by hand in own-mailbox mode", () => {
  it("its gate inputs: the mode, the own From, no public address, the Free plan", async () => {
    const gate = await rt.loadGateInputs();
    expect(gate).toMatchObject({
      replies: "own-mailbox",
      ownFrom: FROM,
      evidenceFrom: FROM,
      teamFrom: null,
      publicAddressSet: false,
      httpsLinksOk: false,
      ownerAddress: null,
      sendersWithoutRoute: [],
    });
    expect(gate.planLimits).toMatchObject({ plan: "free", dailyLimit: 100 });
    expect(gate.rows.map((r) => r.key)).not.toContain("mx");
  });

  it("blockers: no owner route and no public address needed; the DMARC row first (O38)", async () => {
    expect(rt.replyTestBlockersFor(await rt.loadGateInputs())).toEqual([]);
    await writeOwnCheck({ dmarc: "absent" });
    expect(rt.replyTestBlockersFor(await rt.loadGateInputs())).toEqual([MODE_GATE_TEXTS.dmarcFirst]);
    await writeOwnCheck({ dmarc: "bad" });
    expect(rt.replyTestBlockersFor(await rt.loadGateInputs())).toEqual([MODE_GATE_TEXTS.dmarcFirst]);
    await writeOwnCheck({ dmarc: "warn" });
    expect(rt.replyTestBlockersFor(await rt.loadGateInputs())).toEqual([]);
    await writeOwnCheck({ "from-mx": "bad" });
    expect(rt.replyTestBlockersFor(await rt.loadGateInputs())).toEqual([MODE_GATE_TEXTS.fromMxOwn]);
    // Rows stored for the other way of sending count as never checked (O36).
    await writeOwnCheck({}, { replies: "app" });
    const other = await rt.loadGateInputs();
    expect(other.rows).toEqual([]);
    expect(rt.replyTestBlockersFor(other)).toContain(MODE_GATE_TEXTS.dns);
    expect(rt.replyTestBlockersFor(other)).toContain(MODE_GATE_TEXTS.dmarcFirst);
    await writeOwnCheck();
  });

  it("with no own From saved, its sentence comes first and nothing is sent", async () => {
    await setSettingValue("mailgun.fromAddress", "");
    const gate = await rt.loadGateInputs();
    expect(rt.replyTestBlockersFor(gate)[0]).toBe(OWN_MAILBOX_TEXTS.fromMissing(D));
    const err = await ts.sendReplyTestEmails(owner.id, { jobId: 700, mailgun: fastMailgun }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ts.ReplyTestRefusedError);
    expect((err as InstanceType<typeof ts.ReplyTestRefusedError>).reasons[0]).toBe(OWN_MAILBOX_TEXTS.fromMissing(D));
    expect(mg.fake.messages).toHaveLength(0);
    // The page still shows the from-mx guard, and says to type a From address.
    const page = await loadDomainPage(await sessionOwner());
    if (page.state !== "connected") throw new Error(page.state);
    expect(page.rows.some((r) => r.key === "from-mx")).toBe(true);
    expect(page.headerFromLine).toBe(OWN_MAILBOX_TEXTS.checklistLine(null, D));
    expect(page.replyTest.ownFrom).toBeNull();
    await setSettingValue("mailgun.fromAddress", FROM);
    const since = (await db.setting.findUniqueOrThrow({ where: { key: "mailgun.fromAddress" } })).updatedAt.toISOString();
    round = { domain: D, from: FROM, setup: "A", since };
  });

  it("the emails: From the Owner's name with contact@, no Reply-To, Message-IDs on example.com, TestSend.teamFrom", async () => {
    mg.fake.reset();
    expect(await ts.sendReplyTestEmails(owner.id, { jobId: 701, mailgun: fastMailgun })).toMatchObject({ sent: 2, failed: 0 });
    expect(mg.fake.messages.map((m) => field(m, "to"))).toEqual([OUTLOOK, GMAIL]);
    for (const m of mg.fake.messages) {
      expect(field(m, "from")).toBe(FROM_LINE);
      expect(field(m, "h:Reply-To")).toBeUndefined();
      expect(field(m, "h:Message-Id")).toMatch(/^<pp\.t\.701\.[0-9a-f]{12}@example\.com>$/);
    }
    expect(mg.fake.requests.filter((r) => r.method === "POST").map((r) => r.path)).toEqual([`/v3/${D}/messages`, `/v3/${D}/messages`]);
    const sends = await replyTestSends(701);
    expect(sends.map((s) => s.teamFrom)).toEqual([FROM, FROM]);
  });

  it("a preset reply goes outside: nothing is stored, and the test never waits for one", async () => {
    const sends = await replyTestSends(701);
    for (const s of sends) {
      const res = mg.fake.receivePreset("reply", s.messageId!);
      expect(res).toMatchObject({ ok: true, stored: false, deliveredTo: "outside", to: FROM });
    }
    expect(await db.inboundMessage.count()).toBe(0);
    const data = await rt.loadReplyTest();
    expect(data.ownMailbox).toBe(true);
    for (const s of sends) expect(data.facts.get(s.to)).toMatchObject({ testSendId: s.id, replyStored: false });
    expect(data.verdict.missing.join(" ")).not.toContain("no reply has reached the app");
  });

  it("deliveries and the unsubscribe arrive through the Logs catch-up (no public address)", async () => {
    const sends = await replyTestSends(701);
    for (const s of sends) mg.fake.deliver(s.messageId!);
    mg.fake.unsubscribe(sends.find((s) => s.to === GMAIL)!.messageId!);
    await runCatchUp({ reason: "manual", mailgun: fastMailgun });
    const data = await rt.loadReplyTest();
    expect(data.facts.get(OUTLOOK)).toMatchObject({ delivered: true });
    expect(data.facts.get(GMAIL)).toMatchObject({ delivered: true });
    expect(data.unsubscribeSeen).toBe(true);
    expect(data.verdict.status).toBe("incomplete");
  });

  it("answers with the own-mailbox round: placement, the reply in contact@, DMARC (a pasted original read, never kept)", async () => {
    const gmail = (await replyTestSends(701)).find((s) => s.to === GMAIL)!;
    const pasted = testOriginal({ from: FROM_LINE, messageId: gmail.messageId!, to: GMAIL, extraHeaders: [["X-Unique-Marker", "own-4b2e"]] });
    const res = await rt.saveReplyTestAnswers(owner, {
      mailboxes: [
        { address: OUTLOOK, placementOk: false, inboxOk: true, dmarcOk: "pass" },
        { address: GMAIL, placementOk: true, inboxOk: true, dmarcOk: "unsure", dmarcPasted: pasted },
      ],
      headersOk: true,
      round,
    });
    expect(res.dmarcFromHeaders).toEqual({ [GMAIL]: "pass" });
    const stored = await getSetting("mailgun.unsubscribeTest");
    expect(stored.mailboxes).toEqual([
      { address: OUTLOOK, provider: "microsoft", inboxOk: true, authOk: null, authFromHeaders: false, placementOk: false, dmarcOk: "pass", dmarcFromHeaders: false },
      { address: GMAIL, provider: "gmail", inboxOk: true, authOk: null, authFromHeaders: false, placementOk: true, dmarcOk: "pass", dmarcFromHeaders: true },
    ]);
    expect(JSON.stringify(stored)).not.toContain("own-4b2e");
    const data = await rt.loadReplyTest();
    expect(data.verdict).toEqual({ status: "incomplete", missing: [REPLY_TEST_TEXTS.originalMissing], warnings: [REPLY_TEST_TEXTS.spamWarning(OUTLOOK)] });
    // A page of app mode (no From) is another round.
    await expect(rt.saveReplyTestAnswers(owner, { mailboxes: [], headersOk: true, round: { domain: D, from: null, setup: "A" } })).rejects.toThrow(
      new rt.ReplyTestError(REPLY_TEST_TEXTS.roundChanged),
    );
  });

  it("the pasted original is stored with the link's scheme and the whole mailto: address, never the text", async () => {
    const gmail = (await replyTestSends(701)).find((s) => s.to === GMAIL)!;
    const pasted = testOriginal({
      from: FROM_LINE,
      messageId: gmail.messageId!,
      to: GMAIL,
      returnPath: "bounce+x@example.com",
      dkimD: D,
      dmarc: "pass",
      listUnsubscribe: `<mailto:${MAILTO}>, <http://email.example.com/u/x>`,
      extraHeaders: [["X-Unique-Marker", "paste-own-9c1d"]],
    });
    const { original, ownMailbox } = await rt.saveReplyTestOriginal(owner, { pasted, address: GMAIL });
    expect(ownMailbox).toBe(true);
    expect(original).toMatchObject({
      domain: D,
      from: FROM,
      address: GMAIL,
      testSendId: gmail.id,
      returnPathDomain: D,
      returnPathOk: true,
      dmarc: "pass",
      dkimSigner: D,
      unsubscribeScheme: "http",
      mailtoAddress: MAILTO,
    });
    const stored = await getSetting("mailgun.unsubscribeTest");
    expect(stored.original).toEqual(original);
    expect(stored.mailtoArrived).toBeNull();
    const row = await db.setting.findUniqueOrThrow({ where: { key: "mailgun.unsubscribeTest" } });
    expect(JSON.stringify(row.value)).not.toContain("paste-own-9c1d");
    const data = await rt.loadReplyTest();
    expect(data.original).toEqual(original);
    expect(data.verdict).toEqual({ status: "incomplete", missing: [OWN_REPLY_TEST_TEXTS.mailtoUnanswered], warnings: [REPLY_TEST_TEXTS.spamWarning(OUTLOOK)] });
  });

  it("the unsubscribe-by-email answer: No fails the test with the catch-all fix; Yes passes it", async () => {
    await rt.saveReplyTestAnswers(owner, { mailboxes: [], mailtoArrived: false, round });
    expect((await getSetting("mailgun.unsubscribeTest")).mailtoArrived).toBe(false);
    const no = await rt.loadReplyTest();
    expect(no.verdict).toMatchObject({ status: "failed", missing: [OWN_REPLY_TEST_TEXTS.mailtoFailed(MAILTO, D, FROM)] });
    expect(await rt.decideReplyTest(owner, new Date(), { round })).toMatchObject({ status: "failed" });
    expect(await getSetting("mailgun.unsubscribeTest")).toMatchObject({ status: "failed", from: FROM, replies: "own-mailbox" });
    expect((await rt.loadGateInputs()).replyTestPassedOnDomain).toBe(false);

    await rt.saveReplyTestAnswers(owner, { mailboxes: [], mailtoArrived: true, round });
    const yes = await rt.loadReplyTest();
    expect(yes.verdict).toEqual({ status: "passed", missing: [], warnings: [REPLY_TEST_TEXTS.spamWarning(OUTLOOK)] });
  });

  it("the decision stores the own From and the mode; the gates count it", async () => {
    expect(await rt.decideReplyTest(owner, new Date(), { round })).toMatchObject({ status: "passed" });
    expect(await getSetting("mailgun.unsubscribeTest")).toMatchObject({ status: "passed", domain: D, from: FROM, replies: "own-mailbox", decidedById: owner.id });
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "replyTest.decided" }, orderBy: { id: "desc" } });
    expect(log.data).toMatchObject({ from: FROM, domain: D, status: "passed", replies: "own-mailbox" });
    const gate = await rt.loadGateInputs();
    expect(gate.replyTestPassedOnDomain).toBe(true);
    expect(gate.spamPlacements).toEqual(["Outlook.com (t.outlook@outlook.com)"]);
    expect((await rt.loadReplyTest()).decided).toMatchObject({ status: "passed" });
  });

  it("the Domain checklist page: the own header line, the own Apply hint, no reply routes, the by-hand view", async () => {
    const page = await loadDomainPage(await sessionOwner());
    if (page.state !== "connected") throw new Error(page.state);
    expect(page.headerFromLine).toBe(OWN_MAILBOX_TEXTS.checklistLine(FROM, D));
    expect(page.headerFromLine).toBe("Emails show From contact@example.com and go out through example.com itself. Replies go straight to that mailbox.");
    expect(page.applyHint).toBe(OWN_MAILBOX_TEXTS.applyHint);
    expect(page.ownMailbox).toBe(true);
    expect(page.senders).toEqual([]);
    expect(page.ageDomain).toBe(D);
    expect(page.rows.some((r) => r.key === "from-mx")).toBe(true);
    expect(page.replyTest).toMatchObject({ ownFrom: FROM, mailtoAddress: MAILTO, mailtoArrived: true, roundSince: round.since });
    expect(page.replyTest).not.toHaveProperty("teamFrom");
    expect(page.replyTest.decided?.text).toMatch(/^The reply test passed on .+ with the From address contact@example\.com: test emails arrived/);
    expect(page.replyTest.decided?.text).not.toContain("Setup A");
    expect(page.replyTest.mailboxes[0]).toMatchObject({ placementOk: false, dmarcOk: "pass" });
  });

  it("Setup B is refused in own-mailbox mode; back to normal (A) is allowed", async () => {
    await expect(rt.switchUnsubscribeSetup(owner, "B")).rejects.toThrow(new rt.ReplyTestError(OWN_MAILBOX_TEXTS.setupAOnly));
    expect((await getSetting("mailgun.unsubscribeTest")).status).toBe("passed");
  });

  it("an authorized-recipients refusal of a test email says the test sentence and pauses with its reason", async () => {
    mg.fake.failNext("POST /v3/:d/messages", {
      kind: "status",
      status: 403,
      body: {
        message:
          "Domain example.com is not allowed to send: Free accounts are for test purposes only. Please upgrade or add the address to authorized recipients in Account Settings.",
      },
    });
    expect(await ts.sendReplyTestEmails(owner.id, { jobId: 702, mailgun: fastMailgun })).toMatchObject({ sent: 0, failed: 1 });
    const failed = (await replyTestSends(702))[0]!;
    expect(failed).toMatchObject({ status: "FAILED", error: PLAN_TEXTS.authorizedOnlyTest });
    expect(PLAN_TEXTS.authorizedOnlyTest).toContain("or add this test mailbox under Authorized recipients");
    const pause = await getPauseState();
    expect(pause).toMatchObject({ paused: true, kind: "mailgun-not-allowed", reason: PLAN_TEXTS.authorizedReason, fixText: PLAN_TEXTS.authorizedOnlyTest });
    await resumeSending({ actorId: owner.id, actorName: owner.name });
    expect((await getPauseState()).paused).toBe(false);
  });
});
