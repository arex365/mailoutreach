import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { addSenderAddress, clearJobs, fastMailgun, makeUser, queuedJobs, setSettingValue, writeDomainCheck } from "./helpers";

const t = await createTestDb("mg-reply-test");
const mg: FakeConnection = await connectFakeMailgun();
const { db, dbWrite } = await import("@/server/db");
const { getSetting } = await import("@/server/settings");
const rt = await import("@/server/services/reply-test");
const { sendReplyTestEmails } = await import("@/server/services/test-send");
const { MODE_GATE_TEXTS } = await import("@/core/sending/mode-gates");
const { REPLY_TEST_TEXTS } = await import("@/core/reply-test");
const { DEFAULT_UNSUBSCRIBE_TEST } = await import("@/core/setting-types");

const D = mg.domain;
const PUB = "http://127.0.0.1:3999";
const OUTLOOK = "t.outlook@outlook.com";
const GMAIL = "t.gmail@gmail.com";
const previousPub = process.env.APP_PUBLIC_URL;
let owner: { id: number; name: string };
let ownerAddressId = 0;
let n = 0;

const GMAIL_HEADERS = `Delivered-To: arslan.owner@gmail.com
X-Unique-Marker: paste-7f3a9c
ARC-Authentication-Results: i=2; mx.google.com;
       dkim=pass header.i=@gmail.com header.s=20230601 header.b=abc;
       spf=pass smtp.mailfrom=bounce@send.example.com
Authentication-Results: mx.google.com;
       dkim=pass header.i=@gmail.com header.s=20230601 header.b=abc
`;

async function event(
  type: string,
  fields: { testSendId?: number | null; recipient?: string; occurredAt?: Date; source?: "WEBHOOK" | "LOGS" | "SIMULATED"; isTestMode?: boolean },
) {
  n += 1;
  await dbWrite((c) =>
    c.mailEvent.create({
      data: {
        dedupeKey: `t-${n}`,
        type,
        occurredAt: fields.occurredAt ?? new Date(),
        recipient: fields.recipient ?? null,
        testSendId: fields.testSendId ?? null,
        isTestMode: fields.isTestMode ?? false,
        source: fields.source ?? "WEBHOOK",
        raw: {},
      },
    }),
  );
}

async function reply(from: string, to: string, receivedAt: Date) {
  n += 1;
  await dbWrite((c) =>
    c.inboundMessage.create({ data: { storageKey: `k-${n}`, receivedAt, toAddress: to, fromEmail: from, subject: "Re: test", source: "NOTIFY" } }),
  );
}

beforeAll(async () => {
  process.env.APP_PUBLIC_URL = PUB;
  owner = await makeUser("Arslan", { role: "OWNER", replyInbox: "arslan.owner@gmail.com" });
  ownerAddressId = (await addSenderAddress(owner.id, mg.domainId, "arslan", "ok")).id;
  await setSettingValue("sending.mode", "TEST");
  await setSettingValue("sending.testList", [OUTLOOK, GMAIL]);
  await writeDomainCheck(D);
});

beforeEach(() => {
  mg.fake.reset();
});

afterAll(async () => {
  if (previousPub === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previousPub;
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("what blocks the reply test (§1.5 step 0)", () => {
  it("nothing when the domain is ready", async () => {
    const data = await rt.loadReplyTest();
    expect(data.blockers).toEqual([]);
    expect(data.testList).toEqual([OUTLOOK, GMAIL]);
    expect(data.ownerAddress).toBe(`arslan@${D}`);
    expect(data.verdict.missing[0]).toBe(REPLY_TEST_TEXTS.sendFirst);
  });

  it("the Owner's route, the public address, the mode and old checklist rows", async () => {
    await dbWrite((c) => c.senderAddress.update({ where: { id: ownerAddressId }, data: { routeStatus: "pending" } }));
    process.env.APP_PUBLIC_URL = "";
    await setSettingValue("sending.mode", "DRY_RUN");
    try {
      const gate = await rt.loadGateInputs();
      expect(rt.replyTestBlockersFor(gate)).toEqual([MODE_GATE_TEXTS.modeForReplyTest, MODE_GATE_TEXTS.ownerRoute, MODE_GATE_TEXTS.publicAddress]);
      // Rows written for another domain count as never checked.
      await writeDomainCheck("old.example.com");
      expect(rt.replyTestBlockersFor(await rt.loadGateInputs())).toContain(MODE_GATE_TEXTS.dns);
    } finally {
      await dbWrite((c) => c.senderAddress.update({ where: { id: ownerAddressId }, data: { routeStatus: "ok" } }));
      process.env.APP_PUBLIC_URL = PUB;
      await setSettingValue("sending.mode", "TEST");
      await writeDomainCheck(D);
    }
    expect(rt.replyTestBlockersFor(await rt.loadGateInputs())).toEqual([]);
  });

  it("an Owner without a sending address is told to add one", async () => {
    await dbWrite((c) => c.senderAddress.update({ where: { id: ownerAddressId }, data: { retiredAt: new Date() } }));
    try {
      expect(rt.replyTestBlockersFor(await rt.loadGateInputs())).toEqual([rt.OWNER_ADDRESS_MISSING_TEXT]);
    } finally {
      await dbWrite((c) => c.senderAddress.update({ where: { id: ownerAddressId }, data: { retiredAt: null } }));
    }
  });
});

describe("the facts, the answers and the result", () => {
  it("sees each test email, its delivery and the reply that came after it", async () => {
    await sendReplyTestEmails(owner.id, { jobId: 501, mailgun: fastMailgun });
    let data = await rt.loadReplyTest();
    const o = data.facts.get(OUTLOOK)!;
    expect(o).toMatchObject({ delivered: false, replyStored: false, status: "SENT" });
    expect(o.testSendId).not.toBeNull();

    const sentAt = o.sentAt!;
    await event("delivered", { testSendId: o.testSendId, recipient: OUTLOOK });
    await event("delivered", { testSendId: data.facts.get(GMAIL)!.testSendId, recipient: GMAIL });
    await reply(OUTLOOK, `arslan@${D}`, new Date(sentAt.getTime() - 60_000)); // before the test: doesn't count
    await reply(GMAIL, `someone@${D}`, new Date(sentAt.getTime() + 60_000)); // to another address: doesn't count
    data = await rt.loadReplyTest();
    expect(data.facts.get(OUTLOOK)).toMatchObject({ delivered: true, replyStored: false });
    expect(data.facts.get(GMAIL)).toMatchObject({ delivered: true, replyStored: false });

    await reply(OUTLOOK, `arslan@${D}`, new Date(sentAt.getTime() + 60_000));
    await reply(GMAIL, `arslan@${D}`, new Date(sentAt.getTime() + 120_000));
    const gmailTest = data.facts.get(GMAIL)!.testSendId;
    await event("unsubscribed", { testSendId: gmailTest, recipient: GMAIL, occurredAt: new Date(sentAt.getTime() - 3_600_000) }); // older: no
    data = await rt.loadReplyTest();
    expect(data.facts.get(OUTLOOK)!.replyStored).toBe(true);
    expect(data.facts.get(GMAIL)!.replyStored).toBe(true);
    expect(data.unsubscribeSeen).toBe(false);
    await event("unsubscribed", { testSendId: gmailTest, recipient: GMAIL, occurredAt: new Date(sentAt.getTime() + 180_000) });
    expect((await rt.loadReplyTest()).unsubscribeSeen).toBe(true);
  });

  it("only a real unsubscribe from a reply-test email of this domain counts", async () => {
    const sentAt = (await rt.loadReplyTest()).facts.get(GMAIL)!.sentAt!;
    const later = new Date(sentAt.getTime() + 240_000);
    await dbWrite((c) => c.mailEvent.deleteMany({ where: { type: "unsubscribed" } }));
    expect((await rt.loadReplyTest()).unsubscribeSeen).toBe(false);

    // A dry run's "Simulate › Unsubscribe" to a test-list address (the review's scenario).
    const { makeCompany, makeSentEmail } = await import("../campaigns/seed");
    const { simulateEmailEvent } = await import("@/server/services/mail-events/simulate");
    const { company, people } = await makeCompany({ name: "Test Gmail", people: [{ name: "T", email: GMAIL }] });
    const dry = await makeSentEmail({ createdById: owner.id, mode: "DRY_RUN", companyId: company.id, personId: people[0]!.id, toNorm: GMAIL, sentAt: later });
    await simulateEmailEvent(owner, dry.email.id, "unsubscribe", { now: later });
    expect(await db.mailEvent.count({ where: { type: "unsubscribed", source: "SIMULATED" } })).toBe(1);
    // A real unsubscribe of some other email to that address (no reply-test email behind it).
    await event("unsubscribed", { recipient: GMAIL, occurredAt: later });
    // Mailgun's test mode, and a reply-test email sent from an older sending domain.
    const gmailTest = (await rt.loadReplyTest()).facts.get(GMAIL)!.testSendId;
    await event("unsubscribed", { testSendId: gmailTest, recipient: GMAIL, occurredAt: later, isTestMode: true });
    const oldDomainTest = await dbWrite((c) =>
      c.testSend.create({
        data: { userId: owner.id, to: GMAIL, subject: "x", mode: "LIVE", purpose: "REPLY_TEST", status: "SENT", messageId: "pp.t.old.1@old.example.com", sentAt },
      }),
    );
    await event("unsubscribed", { testSendId: oldDomainTest.id, recipient: GMAIL, occurredAt: later });
    const data = await rt.loadReplyTest();
    expect(data.unsubscribeSeen).toBe(false);
    expect(data.verdict.missing).toContain(REPLY_TEST_TEXTS.unsubscribe);

    // The real click on this domain's reply-test email, reported by Mailgun's Logs.
    await event("unsubscribed", { testSendId: gmailTest, recipient: GMAIL, occurredAt: later, source: "LOGS" });
    expect((await rt.loadReplyTest()).unsubscribeSeen).toBe(true);
  });

  it("an unfinished test saves nothing", async () => {
    const verdict = await rt.decideReplyTest(owner);
    expect(verdict.status).toBe("incomplete");
    expect(await getSetting("mailgun.unsubscribeTest")).toMatchObject({ status: "untested", domain: null });
  });

  it("reads pasted headers but never stores them, and keeps answers only for test-list mailboxes", async () => {
    const res = await rt.saveReplyTestAnswers(owner, {
      mailboxes: [
        { address: OUTLOOK, inboxOk: true, authOk: "pass" },
        { address: "T.Gmail@Gmail.com", inboxOk: true, authOk: "unsure", pastedHeaders: GMAIL_HEADERS },
        { address: "not.listed@gmail.com", inboxOk: false, authOk: "fail" },
      ],
      headersOk: true,
    });
    expect(res.authFromHeaders).toEqual({ [GMAIL]: "pass" });
    const stored = await getSetting("mailgun.unsubscribeTest");
    expect(stored.mailboxes).toEqual([
      { address: OUTLOOK, provider: "microsoft", inboxOk: true, authOk: "pass", authFromHeaders: false },
      { address: GMAIL, provider: "gmail", inboxOk: true, authOk: "pass", authFromHeaders: true },
    ]);
    expect(stored.headersOk).toBe(true);
    const row = await db.setting.findUniqueOrThrow({ where: { key: "mailgun.unsubscribeTest" } });
    expect(JSON.stringify(row.value)).not.toContain("paste-7f3a9c");
    expect(JSON.stringify(row.value)).not.toContain("Delivered-To");
  });

  it("one answer (what the page now sends) keeps every other saved answer; per-person pages are never checked for a round", async () => {
    const before = await getSetting("mailgun.unsubscribeTest");
    const res = await rt.saveReplyTestAnswers(owner, {
      mailboxes: [{ address: OUTLOOK, inboxOk: true, was: { inboxOk: true } }],
      round: { domain: "old.example.com", from: null, setup: "B" },
    });
    expect(res).toEqual({ authFromHeaders: {}, dmarcFromHeaders: {} });
    const after = await getSetting("mailgun.unsubscribeTest");
    expect(after).toEqual(before);
    // Gmail's dkim answer read from its pasted headers stays read from them; no shared-From keys appear.
    expect(after.mailboxes[1]).toEqual({ address: GMAIL, provider: "gmail", inboxOk: true, authOk: "pass", authFromHeaders: true });
  });

  it("passes on this domain, stored with who and when", async () => {
    const verdict = await rt.decideReplyTest(owner);
    expect(verdict).toEqual({ status: "passed", missing: [] });
    expect(await getSetting("mailgun.unsubscribeTest")).toMatchObject({ status: "passed", domain: D, setup: "A", decidedById: owner.id });
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "replyTest.decided" } });
    expect(log.summary).toBe(`Arslan saved the reply test result: Setup A passed on ${D}`);
    const gate = await rt.loadGateInputs();
    expect(gate.replyTestPassedOnDomain).toBe(true);
    expect((await rt.loadReplyTest()).decided).toMatchObject({ status: "passed" });
  });

  it("a pass on another domain doesn't count", async () => {
    const stored = await getSetting("mailgun.unsubscribeTest");
    await setSettingValue("mailgun.unsubscribeTest", { ...stored, domain: "other.example.com" });
    expect((await rt.loadGateInputs()).replyTestPassedOnDomain).toBe(false);
    expect((await rt.loadReplyTest()).decided).toBeNull();
    await setSettingValue("mailgun.unsubscribeTest", stored);
  });

  it("fails as soon as a mailbox says No", async () => {
    await rt.saveReplyTestAnswers(owner, { mailboxes: [{ address: OUTLOOK, inboxOk: false, authOk: "pass" }], headersOk: true });
    const verdict = await rt.decideReplyTest(owner);
    expect(verdict.status).toBe("failed");
    expect(await getSetting("mailgun.unsubscribeTest")).toMatchObject({ status: "failed", note: `${OUTLOOK}: the reply didn't arrive in your reply inbox.` });
  });

  it("switching to Setup B starts again and queues Apply", async () => {
    await clearJobs();
    await rt.switchUnsubscribeSetup(owner, "B");
    expect(await getSetting("mailgun.unsubscribeTest")).toEqual({ ...DEFAULT_UNSUBSCRIBE_TEST, mailboxes: [], setup: "B" });
    const jobs = await queuedJobs("mailgun.applySettings");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ activeDedupeKey: "mailgun:apply", payload: { step: "all" }, maxAttempts: 1 });
    await rt.switchUnsubscribeSetup(owner, "A");
    expect((await getSetting("mailgun.unsubscribeTest")).setup).toBe("A");
  });

  it("marks tests left SENDING for more than 2 minutes as UNKNOWN", async () => {
    const old = await dbWrite((c) =>
      c.testSend.create({
        data: { userId: owner.id, to: OUTLOOK, subject: "x", mode: "TEST", status: "SENDING", messageId: `pp.t.stale@${D}`, sentAt: new Date(Date.now() - 5 * 60_000) },
      }),
    );
    const fresh = await dbWrite((c) =>
      c.testSend.create({ data: { userId: owner.id, to: OUTLOOK, subject: "x", mode: "TEST", status: "SENDING", messageId: `pp.t.fresh@${D}` } }),
    );
    expect(await rt.markStaleTestSends()).toBe(1);
    expect((await db.testSend.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("UNKNOWN");
    expect((await db.testSend.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe("SENDING");
  });
});

describe("saveTestList", () => {
  it("saves a clean list, logs it, and refuses the sending domain", async () => {
    const mate = await makeUser("Mira", { replyInbox: "mira.m@gmail.com" });
    const res = await rt.saveTestList(owner, [OUTLOOK, " T.Gmail@gmail.com ", "mira.m@gmail.com"]);
    expect(res).toEqual({
      ok: true,
      value: [OUTLOOK, GMAIL, "mira.m@gmail.com"],
      warnings: [`mira.m@gmail.com is ${mate.name}'s reply inbox. Gmail hides emails sent to and from the same address, so use a different mailbox.`],
    });
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "sending.testList" }, orderBy: { id: "desc" } });
    expect(log.summary).toBe("Arslan changed the test list (3 addresses)");
    expect(await rt.saveTestList(owner, [`me@${D}`])).toEqual({
      ok: false,
      error: `me@${D} is on your sending domain. Use a normal mailbox, such as Gmail or Outlook.com.`,
    });
    expect(await getSetting("sending.testList")).toEqual([OUTLOOK, GMAIL, "mira.m@gmail.com"]);
    await rt.saveTestList(owner, [OUTLOOK, GMAIL]);
  });

  it("refuses the shared From address with its own sentence, not 'it is on your test list' (SCREENS-04)", async () => {
    await setSettingValue("mailgun.fromAddress", "contact@example.com");
    try {
      const res = await rt.saveTestList(owner, [OUTLOOK, GMAIL, "Contact@Example.com"]);
      expect(res).toEqual({ ok: false, error: REPLY_TEST_TEXTS.fromOnTestList("contact@example.com") });
      expect(res.ok ? "" : res.error).toBe(
        "contact@example.com is your From address, so it can't be a test mailbox. Use a normal mailbox, such as Gmail or Outlook.com.",
      );
      expect(res.ok ? "" : res.error).not.toContain("is on your test list");
      expect(await getSetting("sending.testList")).toEqual([OUTLOOK, GMAIL]);
    } finally {
      await setSettingValue("mailgun.fromAddress", null);
    }
  });
});
