import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReplyTestRound } from "@/core/reply-test";
import type { CheckStatus, ChecklistGroup, ChecklistRowKey } from "@/core/system-state";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { fastMailgun, makeUser, setSettingValue } from "../mailgun-setup/helpers";
import { testOriginal } from "../../unit/setup-core/originals";

/**
 * Own-mailbox mode's last resort (review REPLIES-03), against the fake Mailgun on example.com (Free, its MX elsewhere):
 * the email to the unsubscribe address doesn't arrive, the test fails with the ordered fix (catch-all, aliases, leave
 * out); "Leave out unsubscribe by email" starts the proof again and every own-mailbox email then carries the app's own
 * `List-Unsubscribe: <%unsubscribe_url%>` (so Mailgun adds none with its mailto:); the test passes only with a new
 * original that shows a web link and no mailto: (fail closed when Mailgun didn't fill in its link, or its own header
 * came back); refused while a test or live campaign is busy, for another round and outside own-mailbox mode; "Offer
 * unsubscribe by email again" brings Mailgun's header back. Plus review SECURITY-03: an unreadable mailto: is stored
 * as such and fails the test.
 */

vi.mock("server-only", () => ({}));

const D = "example.com";
const FROM = "contact@example.com";
const FROM_LINE = "Arslan from Polygon Paradise <contact@example.com>";
const OUTLOOK = "t.outlook@outlook.com";
const GMAIL = "t.gmail@gmail.com";
const MAILTO = "u+x@example.com";

const t = await createTestDb("own-mailbox-leave-out-mailto");
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
const { db, dbWrite } = await import("@/server/db");
const { getSetting } = await import("@/server/settings");
const { setState } = await import("@/server/state");
const rt = await import("@/server/services/reply-test");
const ts = await import("@/server/services/test-send");
const { runCatchUp } = await import("@/server/services/mailgun/catch-up");
const { loadDomainPage } = await import("@/app/(app)/settings/domain/load");
const { REPLY_TEST_TEXTS } = await import("@/core/reply-test");
const { OWN_REPLY_TEST_TEXTS, WEB_ONLY_LIST_UNSUBSCRIBE } = await import("@/core/sending/own-mailbox");

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
  ["remote-access", "connection"],
  ["reply-test", "connection"],
];

async function ownCheck(): Promise<void> {
  const info: Partial<Record<ChecklistRowKey, CheckStatus>> = { "https-links": "info", webhooks: "info", "remote-access": "info" };
  const rows = OWN_ROWS.map(([key, group]) => ({ key, group, status: info[key] ?? "ok", title: `Row ${key}`, text: "", fix: null, records: [], detail: null }));
  await setState("domain.check", { domain: D, region: "US", checkedAt: new Date().toISOString(), lastVerifyAt: null, rows, error: null, replies: "own-mailbox" });
}

const field = (m: { fields: Record<string, string[]> }, k: string) => m.fields[k]?.[0];
let owner: { id: number; name: string; email: string };
let round: ReplyTestRound;

async function replyTestSends(jobId: number) {
  return db.testSend.findMany({ where: { purpose: "REPLY_TEST", messageId: { startsWith: `pp.t.${jobId}.` } }, orderBy: { id: "asc" } });
}

/** Sends the reply-test emails (job `jobId`), and Mailgun delivers them (Logs catch-up). */
async function sendAndDeliver(jobId: number): Promise<Awaited<ReturnType<typeof replyTestSends>>> {
  mg.fake.reset();
  expect(await ts.sendReplyTestEmails(owner.id, { jobId, mailgun: fastMailgun })).toMatchObject({ sent: 2, failed: 0 });
  const sends = await replyTestSends(jobId);
  for (const s of sends) mg.fake.deliver(s.messageId!);
  await runCatchUp({ reason: "manual", mailgun: fastMailgun });
  return sends;
}

/** A pasted original of `messageId` with this List-Unsubscribe value. */
function pasted(messageId: string, listUnsubscribe: string | null): string {
  return testOriginal({ from: FROM_LINE, messageId, to: GMAIL, returnPath: "bounce+x@example.com", dkimD: D, dmarc: "pass", listUnsubscribe });
}

beforeAll(async () => {
  owner = await makeUser("Arslan", { role: "OWNER", replyInbox: "arslan.owner@gmail.com" });
  await setSettingValue("sending.mode", "TEST");
  await setSettingValue("sending.testList", [OUTLOOK, GMAIL]);
  await ownCheck();
  const since = (await db.setting.findUniqueOrThrow({ where: { key: "mailgun.fromAddress" } })).updatedAt.toISOString();
  round = { domain: D, from: FROM, setup: "A", since };
});

afterAll(async () => {
  if (previousPub === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previousPub;
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("leaving out unsubscribe by email (the last resort)", () => {
  it("before: Mailgun's own header; the email to its mailto: doesn't arrive → failed with catch-all, aliases, leave out", async () => {
    const sends = await sendAndDeliver(801);
    for (const m of mg.fake.messages) expect(field(m, "h:List-Unsubscribe")).toBeUndefined();
    // The unsubscribe click on the Gmail test email reached the app (its Logs event, linked to the test email). Written
    // directly, so the test mailbox stays off the do-not-email list for the next rounds.
    const clicked = sends.find((s) => s.to === GMAIL)!;
    await dbWrite((c) =>
      c.mailEvent.create({
        data: { dedupeKey: "leave-out-unsub", type: "unsubscribed", occurredAt: new Date(), recipient: GMAIL, testSendId: clicked.id, isTestMode: false, source: "LOGS", raw: {} },
      }),
    );
    await rt.saveReplyTestAnswers(owner, {
      mailboxes: [
        { address: OUTLOOK, placementOk: true, inboxOk: true, dmarcOk: "pass" },
        { address: GMAIL, placementOk: true, inboxOk: true, dmarcOk: "pass" },
      ],
      headersOk: true,
      round,
    });
    const gmail = sends.find((s) => s.to === GMAIL)!;
    await rt.saveReplyTestOriginal(owner, { pasted: pasted(gmail.messageId!, `<mailto:${MAILTO}>, <http://email.example.com/u/x>`), address: GMAIL });
    await rt.saveReplyTestAnswers(owner, { mailboxes: [], mailtoArrived: false, round });
    const data = await rt.loadReplyTest();
    expect(data.verdict).toEqual({ status: "failed", missing: [OWN_REPLY_TEST_TEXTS.mailtoFailed(MAILTO, D, FROM)], warnings: [] });
    expect(await rt.decideReplyTest(owner, new Date(), { round })).toMatchObject({ status: "failed" });
  });

  it("is refused while a test or live campaign is busy, for another round, and in app mode", async () => {
    const busy = await dbWrite((c) =>
      c.campaign.create({
        data: { name: "Germany Q4", createdById: owner.id, senderId: owner.id, mode: "LIVE", status: "PAUSED", sendingDomainId: mg.domainId, fromName: "Arslan", fromAddress: FROM, replyTo: null },
      }),
    );
    await expect(rt.setLeaveOutMailto(owner, { leaveOut: true, round })).rejects.toThrow(new rt.ReplyTestError(OWN_REPLY_TEST_TEXTS.leaveOutBusy("Germany Q4")));
    await dbWrite((c) => c.campaign.delete({ where: { id: busy.id } }));
    await expect(rt.setLeaveOutMailto(owner, { leaveOut: true, round: { ...round, from: "info@example.com" } })).rejects.toThrow(
      new rt.ReplyTestError(REPLY_TEST_TEXTS.roundChanged),
    );
    await setSettingValue("mailgun.replies", "app");
    await expect(rt.setLeaveOutMailto(owner, { leaveOut: true })).rejects.toThrow(new rt.ReplyTestError(OWN_REPLY_TEST_TEXTS.leaveOutNotOwn));
    await setSettingValue("mailgun.replies", "own-mailbox");
    expect((await getSetting("mailgun.unsubscribeTest")).leaveOutMailto).toBeUndefined();
  });

  it("leaving it out starts the proof again: result, original, List-Unsubscribe and mailto answers cleared; logged", async () => {
    expect(await rt.setLeaveOutMailto(owner, { leaveOut: true, round })).toEqual({ changed: true });
    const stored = await getSetting("mailgun.unsubscribeTest");
    expect(stored).toMatchObject({ leaveOutMailto: true, status: "untested", decidedAt: null, original: null, headersOk: null, mailtoArrived: null });
    expect(stored.mailboxes).toHaveLength(2);
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "settings.updated" }, orderBy: { id: "desc" } });
    expect(log.summary).toBe("Arslan left out unsubscribe by email");
    // Clicking again changes nothing.
    expect(await rt.setLeaveOutMailto(owner, { leaveOut: true, round })).toEqual({ changed: false });
    const data = await rt.loadReplyTest();
    expect(data.verdict.status).toBe("incomplete");
    expect(data.verdict.missing).toContain(OWN_REPLY_TEST_TEXTS.leftOutSendAgain);
    expect(data.verdict.warnings).toEqual([OWN_REPLY_TEST_TEXTS.leftOutNote]);
    // The page shows the note, and the saved choice itself (`mailtoLeftOut`, which the section's switch back reads).
    const page = await loadDomainPage({ id: owner.id, email: owner.email, name: owner.name, role: "OWNER", timeZone: "Asia/Karachi", sessionId: 1 });
    if (page.state !== "connected") throw new Error(page.state);
    expect(page.replyTest.warnings).toContain(OWN_REPLY_TEST_TEXTS.leftOutNote);
    expect(page.replyTest.mailtoLeftOut).toBe(true);
    expect(page.replyTest.mailtoAddress).toBeNull();
  });

  it("every own-mailbox email now carries the app's own List-Unsubscribe with only the web link", async () => {
    const sends = await sendAndDeliver(802);
    expect(mg.fake.messages).toHaveLength(2);
    for (const m of mg.fake.messages) expect(m.fields["h:List-Unsubscribe"]).toEqual([WEB_ONLY_LIST_UNSUBSCRIBE]);
    // The unsubscribe link of a new test email is clicked again (the reply test counts clicks after its latest emails).
    const clicked = sends.find((s) => s.to === GMAIL)!;
    await dbWrite((c) =>
      c.mailEvent.create({
        data: { dedupeKey: "leave-out-unsub-2", type: "unsubscribed", occurredAt: new Date(), recipient: GMAIL, testSendId: clicked.id, isTestMode: false, source: "LOGS", raw: {} },
      }),
    );
    expect((await rt.loadReplyTest()).unsubscribeSeen).toBe(true);
  });

  it("an original of an older email (Mailgun's header with its mailto:) fails: send again", async () => {
    const old = (await replyTestSends(801)).find((s) => s.to === GMAIL)!;
    await rt.saveReplyTestOriginal(owner, { pasted: pasted(old.messageId!, `<mailto:${MAILTO}>, <http://email.example.com/u/x>`), address: GMAIL });
    await rt.saveReplyTestAnswers(owner, { mailboxes: [], headersOk: true, round });
    expect((await rt.loadReplyTest()).verdict).toMatchObject({ status: "failed", missing: [OWN_REPLY_TEST_TEXTS.leftOutMailtoStill] });
  });

  it("a new original whose List-Unsubscribe has no link (Mailgun didn't fill it in) fails closed", async () => {
    const gmail = (await replyTestSends(802)).find((s) => s.to === GMAIL)!;
    await rt.saveReplyTestOriginal(owner, { pasted: pasted(gmail.messageId!, WEB_ONLY_LIST_UNSUBSCRIBE), address: GMAIL });
    const data = await rt.loadReplyTest();
    expect(data.original).toMatchObject({ unsubscribeScheme: null, mailtoAddress: null });
    expect(data.verdict).toMatchObject({ status: "failed", missing: [OWN_REPLY_TEST_TEXTS.leftOutNoLink] });
    expect(await rt.decideReplyTest(owner, new Date(), { round })).toMatchObject({ status: "failed" });
    expect((await rt.loadGateInputs()).replyTestPassedOnDomain).toBe(false);
  });

  it("a new original with Mailgun's link and no mailto: passes, without the mailto question", async () => {
    const gmail = (await replyTestSends(802)).find((s) => s.to === GMAIL)!;
    await rt.saveReplyTestOriginal(owner, { pasted: pasted(gmail.messageId!, "<http://email.example.com/u/abc123>"), address: GMAIL });
    const data = await rt.loadReplyTest();
    expect(data.verdict).toEqual({ status: "passed", missing: [], warnings: [OWN_REPLY_TEST_TEXTS.leftOutNote] });
    expect(await rt.decideReplyTest(owner, new Date(), { round })).toMatchObject({ status: "passed" });
    expect(await getSetting("mailgun.unsubscribeTest")).toMatchObject({ status: "passed", leaveOutMailto: true, replies: "own-mailbox" });
    expect((await rt.loadGateInputs()).replyTestPassedOnDomain).toBe(true);
  });

  it("offering it again brings Mailgun's header back and starts the proof again (the pass is gone)", async () => {
    expect(await rt.setLeaveOutMailto(owner, { leaveOut: false, round })).toEqual({ changed: true });
    const stored = await getSetting("mailgun.unsubscribeTest");
    expect(stored).not.toHaveProperty("leaveOutMailto");
    expect(stored).toMatchObject({ status: "untested", original: null, headersOk: null, mailtoArrived: null });
    expect((await rt.loadGateInputs()).replyTestPassedOnDomain).toBe(false);
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "settings.updated" }, orderBy: { id: "desc" } });
    expect(log.summary).toBe("Arslan offered unsubscribe by email again");
    const page = await loadDomainPage({ id: owner.id, email: owner.email, name: owner.name, role: "OWNER", timeZone: "Asia/Karachi", sessionId: 1 });
    if (page.state !== "connected") throw new Error(page.state);
    expect(page.replyTest.mailtoLeftOut).toBe(false);
    await sendAndDeliver(803);
    for (const m of mg.fake.messages) expect(field(m, "h:List-Unsubscribe")).toBeUndefined();
  });
});

describe("review SECURITY-03: an unreadable mailto: is stored as such and fails the test", () => {
  it("the original keeps the flag, its line says so, and the verdict fails whatever the answer", async () => {
    const gmail = (await replyTestSends(803)).find((s) => s.to === GMAIL)!;
    const { original } = await rt.saveReplyTestOriginal(owner, { pasted: pasted(gmail.messageId!, "<mailto:a@b@example.com>, <http://email.example.com/u/x>"), address: GMAIL });
    expect(original).toMatchObject({ mailtoAddress: null, mailtoUnreadable: true, unsubscribeScheme: "http" });
    expect((await getSetting("mailgun.unsubscribeTest")).original).toMatchObject({ mailtoUnreadable: true });
    await rt.saveReplyTestAnswers(owner, { mailboxes: [], headersOk: true, mailtoArrived: true, round });
    expect((await rt.loadReplyTest()).verdict).toMatchObject({ status: "failed", missing: [OWN_REPLY_TEST_TEXTS.mailtoUnreadable] });
  });
});
