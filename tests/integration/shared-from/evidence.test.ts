import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReplyTestRound } from "@/core/reply-test";
import type { Tx } from "@/server/db";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { INBOUND_URL } from "../helpers/replies";
import { makeCompany } from "../campaigns/seed";
import { addSenderAddress, fastMailgun, makeUser, setSettingValue, writeDomainCheck } from "../mailgun-setup/helpers";
import { testOriginal } from "../../unit/setup-core/originals";

/**
 * Evidence belongs to one From address (SHARED-FROM-DESIGN F26, critique C1-1), and the reply test in shared-From mode
 * (§3.4, F12, F25) against the fake Mailgun: a per-person reply test passes and a per-person live campaign reaches the
 * test list; then the From address is set (written directly, as P2's service would) and none of that counts any more;
 * the team's test emails carry the team headers and `TestSend.teamFrom`, preset replies to the Reply-To reach the app,
 * answers read DMARC from a pasted original, one pasted original is stored (an older email's is refused), the verdict
 * passes with the spam warning and the decision stores the From address; a From change during the decision is refused;
 * the live test counts only a team campaign launched after the change; another From makes all of it stale again.
 *
 * Review fixes: a DMARC FAIL read from a pasted original survives a page that never showed it (SECURITY-1); answers and
 * results from a page of another round are refused, and the decision refuses answers that changed meanwhile
 * (REPLIES-03); with a new From, only a reply that answers one of its test emails counts (REPLIES-01).
 */

/** Runs once inside the next transaction that reads the From address (decideReplyTest's compare-and-set). */
const hooks = vi.hoisted(() => ({ inTx: null as null | ((tx: Tx) => Promise<void>) }));
vi.mock("@/server/services/mailgun/team-from", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/server/services/mailgun/team-from")>();
  return {
    ...orig,
    loadTeamFrom: async (reader?: Parameters<typeof orig.loadTeamFrom>[0]) => {
      const hook = hooks.inTx;
      if (reader && hook) {
        hooks.inTx = null;
        await hook(reader as Tx);
      }
      return reader ? orig.loadTeamFrom(reader) : orig.loadTeamFrom();
    },
  };
});

const t = await createTestDb("shared-from-evidence");
const mg: FakeConnection = await connectFakeMailgun();
const { db, dbWrite } = await import("@/server/db");
const { getSetting } = await import("@/server/settings");
const rt = await import("@/server/services/reply-test");
const { sendReplyTestEmails } = await import("@/server/services/test-send");
const { handleInboundWebhook } = await import("@/server/services/mail-events/webhook");
const { MODE_GATE_TEXTS } = await import("@/core/sending/mode-gates");
const { REPLY_TEST_TEXTS } = await import("@/core/reply-test");

const D = mg.domain;
const FROM = "contact@example.com";
const OWN = `arslan@${D}`;
const FROM_LINE = "Arslan from Polygon Paradise <contact@example.com>";
const OUTLOOK = "t.outlook@outlook.com";
const GMAIL = "t.gmail@gmail.com";
const PUB = "http://127.0.0.1:3999";
const previousPub = process.env.APP_PUBLIC_URL;
let owner: { id: number; name: string };
let mailbox: { companyId: number; personId: number };
let n = 0;

const field = (m: { fields: Record<string, string[]> }, k: string) => m.fields[k]?.[0];

async function event(type: string, testSendId: number, recipient: string, occurredAt = new Date()) {
  n += 1;
  await dbWrite((c) =>
    c.mailEvent.create({ data: { dedupeKey: `ev-${n}`, type, occurredAt, recipient, testSendId, isTestMode: false, source: "WEBHOOK", raw: {} } }),
  );
}

/** A reply stored straight in the app (the per-person part; the team part goes through the fake's presets). */
async function reply(from: string, to: string) {
  n += 1;
  await dbWrite((c) =>
    c.inboundMessage.create({ data: { storageKey: `k-${n}`, receivedAt: new Date(), toAddress: to, fromEmail: from, subject: "Re: test", source: "NOTIFY" } }),
  );
}

/** A reply stored straight in the app with its thread headers (In-Reply-To, References), as the store keeps them. */
async function threadedReply(from: string, to: string, t: { inReplyTo?: string; references?: string; receivedAt: Date }) {
  n += 1;
  await dbWrite((c) =>
    c.inboundMessage.create({
      data: {
        storageKey: `k-${n}`,
        receivedAt: t.receivedAt,
        toAddress: to,
        fromEmail: from,
        subject: "Re: Reply test from Polygon Paradise Outreach",
        source: "NOTIFY",
        inReplyTo: t.inReplyTo ?? null,
        references: t.references ?? null,
      },
    }),
  );
}

/**
 * The mailbox answers the fake's sent message with the "reply" preset (to its real target), posted to the app. The
 * reply comes a minute later (Mailgun's timestamps have whole seconds, so "at once" could read as before the test email).
 */
async function presetReply(messageId: string) {
  const later = new Date(Date.now() + 60_000);
  mg.fake.setNow(() => later);
  try {
    const res = mg.fake.receivePreset("reply", messageId);
    if (!res.stored) throw new Error(`The preset reply went ${res.deliveredTo} (${res.to}).`);
    expect(res.to).toBe(OWN);
    const posted = await handleInboundWebhook(mg.fake.signedInboundRequest(INBOUND_URL, res.fields), { now: mg.fake.now() });
    expect(posted.status).toBe(200);
  } finally {
    mg.fake.setNow(() => new Date());
  }
}

/** A finished LIVE campaign with one SENT, delivered email to the Outlook.com test mailbox (the live test, M6 §0.3). */
async function liveCampaign(o: { replyTo: string | null; fromAddress: string; launchedAt: Date }) {
  n += 1;
  const campaign = await dbWrite((c) =>
    c.campaign.create({
      data: {
        name: `Live test ${n}`,
        createdById: owner.id,
        senderId: owner.id,
        mode: "LIVE",
        status: "FINISHED",
        sendingDomainId: mg.domainId,
        fromName: "Arslan from Polygon Paradise",
        fromAddress: o.fromAddress,
        replyTo: o.replyTo,
        launchedAt: o.launchedAt,
        launchedGoLive: false,
      },
    }),
  );
  const recipient = await dbWrite((c) =>
    c.campaignRecipient.create({ data: { campaignId: campaign.id, companyId: mailbox.companyId, personId: mailbox.personId, emailNorm: OUTLOOK, state: "FINISHED" } }),
  );
  const messageId = `pp.live${n}@${D}`;
  const email = await dbWrite((c) =>
    c.outboundEmail.create({
      data: {
        campaignId: campaign.id,
        recipientId: recipient.id,
        personId: mailbox.personId,
        companyId: mailbox.companyId,
        senderId: owner.id,
        step: 0,
        mode: "LIVE",
        toEmail: OUTLOOK,
        toNorm: OUTLOOK,
        companyName: "Test mailboxes",
        fromAddress: o.replyTo ? FROM_LINE : `Arslan from Polygon Paradise <${o.fromAddress}>`,
        replyTo: o.replyTo,
        subject: "Live test",
        text: "t",
        html: "h",
        messageId,
        sendId: `live-${n}`,
        dueAt: o.launchedAt,
        status: "SENT",
        claimedAt: o.launchedAt,
        sentAt: o.launchedAt,
        providerId: messageId,
      },
    }),
  );
  n += 1;
  await dbWrite((c) =>
    c.mailEvent.create({
      data: {
        dedupeKey: `live-ev-${n}`,
        type: "delivered",
        occurredAt: new Date(o.launchedAt.getTime() + 60_000),
        messageId,
        recipient: OUTLOOK,
        outboundEmailId: email.id,
        source: "WEBHOOK",
        raw: {},
        processedAt: new Date(),
      },
    }),
  );
}

async function replyTestSends(jobId: number) {
  return db.testSend.findMany({ where: { purpose: "REPLY_TEST", messageId: { startsWith: `pp.t.${jobId}.` } }, orderBy: { id: "asc" } });
}

beforeAll(async () => {
  process.env.APP_PUBLIC_URL = PUB;
  owner = await makeUser("Arslan", { role: "OWNER", replyInbox: "arslan.owner@gmail.com" });
  await addSenderAddress(owner.id, mg.domainId, "arslan", "ok");
  await setSettingValue("sending.mode", "TEST");
  await setSettingValue("sending.testList", [OUTLOOK, GMAIL]);
  await writeDomainCheck(D);
  const { company, people } = await makeCompany({ name: "Test mailboxes", people: [{ name: "Tess", email: OUTLOOK }] });
  mailbox = { companyId: company.id, personId: people[0]!.id };
});

afterAll(async () => {
  if (previousPub === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previousPub;
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("evidence belongs to one From address (F26)", () => {
  it("per-person mode: the reply test passes and a live campaign to the test list is delivered", async () => {
    expect(await sendReplyTestEmails(owner.id, { jobId: 601, mailgun: fastMailgun })).toMatchObject({ sent: 2, failed: 0 });
    const sends = await replyTestSends(601);
    expect(sends.map((s) => s.teamFrom)).toEqual([null, null]);
    for (const m of mg.fake.messages) expect(m.fields["h:Reply-To"]).toBeUndefined();
    for (const s of sends) {
      await event("delivered", s.id, s.to);
      await reply(s.to, OWN);
    }
    await event("unsubscribed", sends[1]!.id, GMAIL);
    await rt.saveReplyTestAnswers(owner, {
      mailboxes: [
        { address: OUTLOOK, inboxOk: true, authOk: "pass" },
        { address: GMAIL, inboxOk: true, authOk: "pass" },
      ],
      headersOk: true,
    });
    expect(await rt.decideReplyTest(owner)).toEqual({ status: "passed", missing: [] });
    expect(await getSetting("mailgun.unsubscribeTest")).toMatchObject({ status: "passed", domain: D, from: null });
    await liveCampaign({ replyTo: null, fromAddress: OWN, launchedAt: new Date() });
    const gate = await rt.loadGateInputs();
    expect(gate).toMatchObject({ teamFrom: null, teamFromChangedAt: null, replyTestPassedOnDomain: true, liveTest: "delivered" });
    expect(rt.goLiveBlockersFor(gate)).not.toContain(MODE_GATE_TEXTS.liveTestNone);
  });

  it("once the From address is set, none of it counts: no sent email per mailbox, no unsubscribe, no live test", async () => {
    await setSettingValue("mailgun.fromAddress", FROM);
    await writeDomainCheck(D, { "from-mx": "ok", "from-spf": "ok" });
    const data = await rt.loadReplyTest();
    expect(data.teamFrom).toBe(FROM);
    for (const address of [OUTLOOK, GMAIL]) {
      expect(data.facts.get(address)).toMatchObject({ testSendId: null, delivered: false, replyStored: false, olderSent: true });
    }
    expect(data.unsubscribeSeen).toBe(false);
    expect(data.verdict.status).toBe("incomplete");
    expect(data.verdict.missing[0]).toBe(REPLY_TEST_TEXTS.sendFirst);
    expect(data.decided).toBeNull();
    expect(data.gate).toMatchObject({ replyTestPassedOnDomain: false, liveTest: "none" });
    expect(data.gate.teamFromChangedAt).toBeInstanceOf(Date);
    const blockers = rt.goLiveBlockersFor(data.gate);
    expect(blockers).toContain(MODE_GATE_TEXTS.liveTestNone);
    expect(blockers).toContain(MODE_GATE_TEXTS.replyTestNotPassed);
    expect(data.blockers).toEqual([]);
  });

  it("the team's test emails: From the shared address, Reply-To the Owner's own, TestSend.teamFrom; preset replies reach the app", async () => {
    mg.fake.reset();
    expect(await sendReplyTestEmails(owner.id, { jobId: 602, mailgun: fastMailgun })).toMatchObject({ sent: 2, failed: 0 });
    expect(mg.fake.messages.map((m) => field(m, "to"))).toEqual([OUTLOOK, GMAIL]);
    for (const m of mg.fake.messages) {
      expect(field(m, "from")).toBe(FROM_LINE);
      expect(field(m, "h:Reply-To")).toBe(OWN);
      expect(field(m, "h:Message-Id")).toMatch(/^<pp\.t\.602\.[0-9a-f]{12}@send\.example\.com>$/);
    }
    expect(mg.fake.requests.every((r) => !/\/example\.com(\/|$)/.test(r.path))).toBe(true);
    const sends = await replyTestSends(602);
    expect(sends.map((s) => s.teamFrom)).toEqual([FROM, FROM]);
    for (const s of sends) {
      await presetReply(s.messageId!);
      await event("delivered", s.id, s.to);
    }
    const data = await rt.loadReplyTest();
    for (const s of sends) {
      const f = data.facts.get(s.to)!;
      expect(f).toMatchObject({ testSendId: s.id, delivered: true, replyStored: true });
      expect(f.olderSent).toBeUndefined();
    }
    expect(data.verdict.status).toBe("incomplete");
    expect(data.verdict.missing).toEqual(
      expect.arrayContaining([
        REPLY_TEST_TEXTS.placementUnanswered(OUTLOOK),
        REPLY_TEST_TEXTS.dmarcUnanswered(GMAIL),
        REPLY_TEST_TEXTS.originalMissing,
        REPLY_TEST_TEXTS.unsubscribe,
      ]),
    );
  });

  it("answers: placement and DMARC, read from a pasted original that is never stored", async () => {
    const gmail = (await replyTestSends(602)).find((s) => s.to === GMAIL)!;
    const pasted = testOriginal({ from: FROM_LINE, messageId: gmail.messageId!, replyTo: OWN, to: GMAIL, extraHeaders: [["X-Unique-Marker", "dmarc-4b2e"]] });
    const res = await rt.saveReplyTestAnswers(owner, {
      mailboxes: [
        { address: OUTLOOK, inboxOk: true, authOk: "pass", placementOk: false, dmarcOk: "pass" },
        { address: GMAIL, inboxOk: true, authOk: "pass", placementOk: true, dmarcOk: "unsure", dmarcPasted: pasted },
      ],
      headersOk: true,
    });
    expect(res.dmarcFromHeaders).toEqual({ [GMAIL]: "pass" });
    const stored = await getSetting("mailgun.unsubscribeTest");
    expect(stored.mailboxes).toEqual([
      { address: OUTLOOK, provider: "microsoft", inboxOk: true, authOk: "pass", authFromHeaders: false, placementOk: false, dmarcOk: "pass", dmarcFromHeaders: false },
      { address: GMAIL, provider: "gmail", inboxOk: true, authOk: "pass", authFromHeaders: false, placementOk: true, dmarcOk: "pass", dmarcFromHeaders: true },
    ]);
    const row = await db.setting.findUniqueOrThrow({ where: { key: "mailgun.unsubscribeTest" } });
    expect(JSON.stringify(row.value)).not.toContain("dmarc-4b2e");
    expect((await rt.loadGateInputs()).spamPlacements).toEqual(["Outlook.com (t.outlook@outlook.com)"]);
  });

  it("the pasted original: an older email's is refused; today's is stored with what it shows, never the text", async () => {
    const older = (await replyTestSends(601)).find((s) => s.to === GMAIL)!;
    const refused = REPLY_TEST_TEXTS.notCurrentOriginal(FROM);
    expect(refused).toBe("This isn't one of the current test emails. Paste the original of a test email sent with the From address contact@example.com.");
    await expect(rt.saveReplyTestOriginal(owner, { pasted: testOriginal({ from: `Arslan <${OWN}>`, messageId: older.messageId! }) })).rejects.toThrow(
      new rt.ReplyTestError(refused),
    );
    await expect(rt.saveReplyTestOriginal(owner, { pasted: testOriginal({ from: FROM_LINE, messageId: older.messageId! }) })).rejects.toThrow(refused);
    await expect(rt.saveReplyTestOriginal(owner, { pasted: "Subject: nothing to read" })).rejects.toThrow(refused);
    expect((await getSetting("mailgun.unsubscribeTest")).original ?? null).toBeNull();

    const gmail = (await replyTestSends(602)).find((s) => s.to === GMAIL)!;
    // The right email, but for the other mailbox → refused too.
    await expect(
      rt.saveReplyTestOriginal(owner, { pasted: testOriginal({ from: FROM_LINE, messageId: gmail.messageId! }), address: OUTLOOK }),
    ).rejects.toThrow(refused);
    const pasted = testOriginal({ from: FROM_LINE, messageId: gmail.messageId!, replyTo: OWN, to: GMAIL, extraHeaders: [["X-Unique-Marker", "paste-9c1d"]] });
    const { original } = await rt.saveReplyTestOriginal(owner, { pasted, address: GMAIL });
    expect(original).toMatchObject({
      domain: D,
      from: FROM,
      address: GMAIL,
      testSendId: gmail.id,
      returnPathDomain: D,
      returnPathOk: true,
      dmarc: "pass",
      dkimSigner: "example.com",
      mailtoDomain: D,
      mailtoOk: true,
    });
    const row = await db.setting.findUniqueOrThrow({ where: { key: "mailgun.unsubscribeTest" } });
    expect((row.value as { original?: unknown }).original).toEqual(original);
    expect(JSON.stringify(row.value)).not.toContain("paste-9c1d");
    expect(JSON.stringify(row.value)).not.toContain("Delivered-To");
    expect((await rt.loadReplyTest()).original).toEqual(original);
  });

  it("with the unsubscribe on a team email the verdict passes with the spam warning; the decision stores the From", async () => {
    const gmail = (await replyTestSends(602)).find((s) => s.to === GMAIL)!;
    await event("unsubscribed", gmail.id, GMAIL);
    const data = await rt.loadReplyTest();
    expect(data.unsubscribeSeen).toBe(true);
    expect(data.verdict).toEqual({ status: "passed", missing: [], warnings: ["t.outlook@outlook.com: the test email landed in spam."] });
    expect(await rt.decideReplyTest(owner)).toMatchObject({ status: "passed" });
    expect(await getSetting("mailgun.unsubscribeTest")).toMatchObject({ status: "passed", domain: D, from: FROM, decidedById: owner.id });
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "replyTest.decided" }, orderBy: { id: "desc" } });
    expect(log.summary).toBe(`Arslan saved the reply test result: Setup A passed on ${D} with the From address ${FROM}`);
    expect(log.data).toMatchObject({ from: FROM, domain: D, status: "passed" });
    expect((await rt.loadGateInputs()).replyTestPassedOnDomain).toBe(true);
    expect((await rt.loadReplyTest()).decided).toMatchObject({ status: "passed" });
  });

  it("decideReplyTest is a compare-and-set: a From change inside its transaction refuses and writes nothing", async () => {
    const before = await getSetting("mailgun.unsubscribeTest");
    const logs = await db.activityLog.count({ where: { type: "replyTest.decided" } });
    hooks.inTx = async (tx) => {
      await tx.setting.update({ where: { key: "mailgun.fromAddress" }, data: { value: "info@example.com" } });
    };
    await expect(rt.decideReplyTest(owner)).rejects.toThrow(new rt.ReplyTestError(REPLY_TEST_TEXTS.changedWhileDeciding));
    expect(REPLY_TEST_TEXTS.changedWhileDeciding).toBe(
      "The From address or the sending domain changed while you were deciding. Open the reply test again.",
    );
    expect(await getSetting("mailgun.unsubscribeTest")).toEqual(before);
    expect(await getSetting("mailgun.fromAddress")).toBe(FROM);
    expect(await db.activityLog.count({ where: { type: "replyTest.decided" } })).toBe(logs);
  });

  it("decideReplyTest also refuses when the answers changed after it read them, and writes nothing (REPLIES-03)", async () => {
    const before = await getSetting("mailgun.unsubscribeTest");
    const logs = await db.activityLog.count({ where: { type: "replyTest.decided" } });
    // A pasted original stored between the verdict's read and its write: the decision would put the older answers back.
    hooks.inTx = async (tx) => {
      await tx.setting.update({ where: { key: "mailgun.unsubscribeTest" }, data: { value: { ...before, headersOk: false } as never } });
    };
    await expect(rt.decideReplyTest(owner)).rejects.toThrow(new rt.ReplyTestError(REPLY_TEST_TEXTS.answersChangedWhileDeciding));
    expect(REPLY_TEST_TEXTS.answersChangedWhileDeciding).toBe(
      "The answers changed while the result was being saved, so nothing was saved. Click Save the result again.",
    );
    expect(await getSetting("mailgun.unsubscribeTest")).toEqual(before);
    expect(await db.activityLog.count({ where: { type: "replyTest.decided" } })).toBe(logs);
  });

  it("a DMARC FAIL read from a pasted original can't be erased by a page that never showed it (SECURITY-1)", async () => {
    const round: ReplyTestRound = { domain: D, from: FROM, setup: "A" };
    const sends = await replyTestSends(602);
    const outlook = sends.find((s) => s.to === OUTLOOK)!;
    const gmail = sends.find((s) => s.to === GMAIL)!;
    const outlookOriginal = (dmarc: "pass" | "fail") =>
      testOriginal({ from: FROM_LINE, messageId: outlook.messageId!, replyTo: OWN, to: OUTLOOK, provider: "outlook", dmarc });

    // Outlook.com's original says DMARC: FAIL; then Gmail's passing one replaces the stored original.
    expect((await rt.saveReplyTestOriginal(owner, { pasted: outlookOriginal("fail") })).original).toMatchObject({ address: OUTLOOK, dmarc: "fail" });
    await rt.saveReplyTestOriginal(owner, { pasted: testOriginal({ from: FROM_LINE, messageId: gmail.messageId!, replyTo: OWN, to: GMAIL }) });
    const stored = await getSetting("mailgun.unsubscribeTest");
    expect(stored.original).toMatchObject({ address: GMAIL, dmarc: "pass" });
    expect(stored.mailboxes.find((m) => m.address === OUTLOOK)).toMatchObject({ dmarcOk: "fail", dmarcFromHeaders: true });

    // A page opened before the paste still shows Outlook.com's "Yes": its click is refused, and so is the whole-page
    // save the section used to send with "Save the result". Nothing is written.
    const refused = new rt.ReplyTestError(REPLY_TEST_TEXTS.dmarcReadMeanwhile(OUTLOOK));
    await expect(rt.saveReplyTestAnswers(owner, { mailboxes: [{ address: OUTLOOK, dmarcOk: "pass", was: { dmarcOk: "pass" } }], round })).rejects.toThrow(refused);
    await expect(
      rt.saveReplyTestAnswers(owner, {
        mailboxes: [
          { address: OUTLOOK, inboxOk: true, authOk: "pass", placementOk: false, dmarcOk: "pass" },
          { address: GMAIL, inboxOk: true, authOk: "pass", placementOk: true, dmarcOk: "pass" },
        ],
        headersOk: true,
      }),
    ).rejects.toThrow(refused);
    expect(await getSetting("mailgun.unsubscribeTest")).toEqual(stored);

    // Another answer from a page that shows the saved answers leaves the FAIL alone, and the result fails.
    await rt.saveReplyTestAnswers(owner, { mailboxes: [{ address: GMAIL, placementOk: true, was: { placementOk: true } }], round });
    expect(await rt.decideReplyTest(owner, new Date(), { round })).toMatchObject({ status: "failed", missing: [REPLY_TEST_TEXTS.dmarcFailed(OUTLOOK)] });
    expect(await getSetting("mailgun.unsubscribeTest")).toMatchObject({ status: "failed", from: FROM });

    // A passing Outlook.com original puts it right, and the test passes again.
    await rt.saveReplyTestOriginal(owner, { pasted: outlookOriginal("pass") });
    expect((await getSetting("mailgun.unsubscribeTest")).mailboxes.find((m) => m.address === OUTLOOK)).toMatchObject({ dmarcOk: "pass", dmarcFromHeaders: true });
    expect(await rt.decideReplyTest(owner, new Date(), { round })).toMatchObject({ status: "passed" });
  });

  it("answers and results from a page of another round are refused and write nothing (REPLIES-03)", async () => {
    const before = await getSetting("mailgun.unsubscribeTest");
    const logs = await db.activityLog.count({ where: { type: "replyTest.decided" } });
    const changedAt = (await db.setting.findUniqueOrThrow({ where: { key: "mailgun.fromAddress" } })).updatedAt;
    const others: ReplyTestRound[] = [
      { domain: D, from: null, setup: "A" }, // opened before the From address was set
      { domain: D, from: "info@example.com", setup: "A" }, // for another From address
      { domain: "mail.example.com", from: FROM, setup: "A" }, // before a sending-domain change
      { domain: D, from: FROM, setup: "B" }, // before a setup switch
      // Opened before the From address was changed and changed back, or before a region-only move: the same values,
      // but evidence restarted since (the page's `roundSince`, `loadTeamFrom().changedAt`).
      { domain: D, from: FROM, setup: "A", since: new Date(changedAt.getTime() - 60_000).toISOString() },
    ];
    const refused = new rt.ReplyTestError(REPLY_TEST_TEXTS.roundChanged);
    for (const round of others) {
      await expect(rt.saveReplyTestAnswers(owner, { mailboxes: [{ address: OUTLOOK, placementOk: true, was: { placementOk: false } }], round })).rejects.toThrow(
        refused,
      );
      await expect(rt.saveReplyTestAnswers(owner, { mailboxes: [], headersOk: false, round })).rejects.toThrow(refused);
      await expect(rt.decideReplyTest(owner, new Date(), { round })).rejects.toThrow(refused);
    }
    expect(REPLY_TEST_TEXTS.roundChanged).toBe(
      "The From address, the sending domain or the setup changed since this page was opened, so nothing was saved. The page now shows the current reply test.",
    );
    expect(await getSetting("mailgun.unsubscribeTest")).toEqual(before);
    expect(await db.activityLog.count({ where: { type: "replyTest.decided" } })).toBe(logs);
    // The same round (in any case) saves, with or without the time the evidence counts from.
    await rt.saveReplyTestAnswers(owner, { mailboxes: [], headersOk: true, round: { domain: D.toUpperCase(), from: FROM.toUpperCase(), setup: "A" } });
    await rt.saveReplyTestAnswers(owner, { mailboxes: [], headersOk: true, round: { domain: D, from: FROM, setup: "A", since: changedAt.toISOString() } });
  });

  it("the live test counts only a campaign with today's From launched since the change", async () => {
    const changedAt = (await db.setting.findUniqueOrThrow({ where: { key: "mailgun.fromAddress" } })).updatedAt;
    await liveCampaign({ replyTo: OWN, fromAddress: FROM, launchedAt: new Date(changedAt.getTime() - 60_000) });
    await liveCampaign({ replyTo: null, fromAddress: OWN, launchedAt: new Date() });
    await liveCampaign({ replyTo: OWN, fromAddress: "info@example.com", launchedAt: new Date() });
    expect((await rt.loadGateInputs()).liveTest).toBe("none");
    await liveCampaign({ replyTo: OWN, fromAddress: FROM, launchedAt: new Date() });
    const gate = await rt.loadGateInputs();
    expect(gate.liveTest).toBe("delivered");
    expect(rt.goLiveBlockersFor(gate)).not.toContain(MODE_GATE_TEXTS.liveTestNone);
    // Without options the query is today's (every LIVE campaign on the domain).
    expect(await rt.loadLiveTest(mg.domainId, [OUTLOOK])).toBe("delivered");
  });

  it("another From address makes the pass, the original, the emails and the live test stale again", async () => {
    await setSettingValue("mailgun.fromAddress", "info@example.com");
    const data = await rt.loadReplyTest();
    expect(data.teamFrom).toBe("info@example.com");
    expect(data.decided).toBeNull();
    expect(data.original).toBeNull();
    expect(data.gate).toMatchObject({ replyTestPassedOnDomain: false, liveTest: "none", spamPlacements: ["Outlook.com (t.outlook@outlook.com)"] });
    for (const address of [OUTLOOK, GMAIL]) expect(data.facts.get(address)).toMatchObject({ testSendId: null, olderSent: true });
    expect(data.verdict.status).toBe("incomplete");
    const gmail = (await replyTestSends(602)).find((s) => s.to === GMAIL)!;
    await expect(rt.saveReplyTestOriginal(owner, { pasted: testOriginal({ from: FROM_LINE, messageId: gmail.messageId! }) })).rejects.toThrow(
      REPLY_TEST_TEXTS.notCurrentOriginal("info@example.com"),
    );
  });

  it("with the new From, a reply counts only when it answers one of that From's test emails (REPLIES-01)", async () => {
    mg.fake.reset();
    expect(await sendReplyTestEmails(owner.id, { jobId: 603, mailgun: fastMailgun })).toMatchObject({ sent: 2, failed: 0 });
    const sends = await replyTestSends(603);
    expect(sends.map((s) => s.teamFrom)).toEqual(["info@example.com", "info@example.com"]);
    const outlook = sends.find((s) => s.to === OUTLOOK)!;
    const gmail = sends.find((s) => s.to === GMAIL)!;
    const perPersonEmail = (await replyTestSends(601)).find((s) => s.to === OUTLOOK)!;
    const contactEmail = (await replyTestSends(602)).find((s) => s.to === OUTLOOK)!;

    // The replies already stored answer the per-person and the contact@ emails (the presets' arrive a minute "late",
    // so after these emails were sent): none of them counts for the new ones.
    let data = await rt.loadReplyTest();
    expect(data.facts.get(OUTLOOK)).toMatchObject({ testSendId: outlook.id, replyStored: false });
    expect(data.facts.get(GMAIL)).toMatchObject({ testSendId: gmail.id, replyStored: false });

    // The review's case: the new email sits in junk, and the Owner answers the older same-subject email in the inbox.
    const later = new Date(Date.now() + 5 * 60_000);
    await threadedReply(OUTLOOK, OWN, { inReplyTo: `<${perPersonEmail.messageId}>`, references: `<${perPersonEmail.messageId}>`, receivedAt: later });
    await threadedReply(OUTLOOK, OWN, { inReplyTo: contactEmail.messageId!, receivedAt: later });
    await threadedReply(OUTLOOK, OWN, { receivedAt: later });
    expect((await rt.loadReplyTest()).facts.get(OUTLOOK)!.replyStored).toBe(false);

    // A reply in the new email's thread counts (named in References), and so does one naming the id Mailgun gave it.
    await threadedReply(OUTLOOK, OWN, { references: `<${contactEmail.messageId}> <${outlook.messageId}>`, receivedAt: later });
    await dbWrite((c) => c.testSend.update({ where: { id: gmail.id }, data: { providerId: `rewritten.603@${D}` } }));
    await threadedReply(GMAIL, OWN, { inReplyTo: `<Rewritten.603@${D}>`, receivedAt: later });
    data = await rt.loadReplyTest();
    expect(data.facts.get(OUTLOOK)!.replyStored).toBe(true);
    expect(data.facts.get(GMAIL)!.replyStored).toBe(true);
  });
});
