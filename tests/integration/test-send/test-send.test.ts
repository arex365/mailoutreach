import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { makeCompany, makeDraft } from "../campaigns/seed";
import { addSenderAddress, fastMailgun, makeUser, setSettingValue, writeDomainCheck } from "../mailgun-setup/helpers";

const t = await createTestDb("test-send");
const mg: FakeConnection = await connectFakeMailgun();
const { db, dbWrite } = await import("@/server/db");
const ts = await import("@/server/services/test-send");
const { getTodayCap } = await import("@/server/services/sending/usage");
const { getPauseState, pauseSending, resumeSending } = await import("@/server/services/sending/pause");
const { AUTH_TEXT } = await import("@/server/mailgun/errors");
const { MODE_GATE_TEXTS } = await import("@/core/sending/mode-gates");
const { REPLY_TEST_SUBJECT } = await import("@/core/reply-test");
const { capDayOf } = await import("@/core/sending/capday");
const { sendTestEmailJob } = await import("../../../worker/jobs/send-test-email");

const D = mg.domain;
const PUB = "http://127.0.0.1:3999";
const previousPub = process.env.APP_PUBLIC_URL;
const TEST_LIST = ["t.outlook@outlook.com", "t.gmail@gmail.com", "t.other@company.de"];
let owner: { id: number; name: string };
let ali: { id: number; name: string };
let sara: { id: number; name: string };
let campaignId = 0;
let recipientId = 0;
let saraCampaignId = 0;
let saraRecipientId = 0;

const deps = { mailgun: fastMailgun };
const last = () => mg.fake.messages[mg.fake.messages.length - 1]!;
const field = (m: { fields: Record<string, string[]> }, k: string) => m.fields[k]?.[0];

async function rejection(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ts.TestSendError);
  return (err as Error).message;
}

beforeAll(async () => {
  process.env.APP_PUBLIC_URL = PUB;
  owner = await makeUser("Arslan", { role: "OWNER", replyInbox: "arslan.owner@gmail.com", signature: "Arslan\nPolygon Paradise" });
  ali = await makeUser("Ali", { replyInbox: "ali.khan@gmail.com" });
  sara = await makeUser("Sara", { replyInbox: "sara.b@outlook.com" });
  await addSenderAddress(owner.id, mg.domainId, "arslan", "ok");
  await addSenderAddress(ali.id, mg.domainId, "ali", "ok");
  const { company, people } = await makeCompany({ name: "Studio Berg", people: [{ name: "Anna Berg", email: "anna@studio-berg.de" }] });
  const draft = await makeDraft({
    name: "Germany Q4",
    createdById: owner.id,
    senderId: ali.id,
    recipients: [{ companyId: company.id, personId: people[0]!.id }],
  });
  campaignId = draft.id;
  recipientId = (await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } })).id;
  const saraDraft = await makeDraft({
    name: "From Sara",
    createdById: owner.id,
    senderId: sara.id,
    recipients: [{ companyId: company.id, personId: people[0]!.id }],
  });
  saraCampaignId = saraDraft.id;
  saraRecipientId = (await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: saraCampaignId } })).id;
});

beforeEach(async () => {
  mg.fake.reset();
  await setSettingValue("sending.mode", "TEST");
  await setSettingValue("practice.copy", false);
});

afterAll(async () => {
  if (previousPub === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previousPub;
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("Send me a test", () => {
  it("in dry run only shows the email as it would arrive", async () => {
    await setSettingValue("sending.mode", "DRY_RUN");
    const res = await ts.sendMeATest(ali, { campaignId, recipientId, step: 0 }, deps);
    expect(res.status).toBe("preview");
    expect(res.message).toBe(ts.TEST_SEND_TEXTS.dryRunPreview);
    expect(res.preview?.text).toContain("[unsubscribe link]");
    expect(mg.fake.requests).toHaveLength(0);
    expect(await db.testSend.count()).toBe(0);
  });

  it("refuses in order: practice copy, not connected, paused, no sender address, inbox on the do-not-email list", async () => {
    await setSettingValue("practice.copy", true);
    expect(await rejection(ts.sendMeATest(ali, { campaignId, recipientId, step: 0 }, deps))).toBe(MODE_GATE_TEXTS.practiceCopy);
    await setSettingValue("practice.copy", false);

    const notConnected = async () => ({ connected: false as const, reason: "no-key" as const, text: "The Mailgun API key isn't saved yet. Open Settings › Sending & Mailgun." });
    expect(await rejection(ts.sendMeATest(ali, { campaignId, recipientId, step: 0 }, { mailgun: notConnected }))).toBe(
      "The Mailgun API key isn't saved yet. Open Settings › Sending & Mailgun.",
    );

    await pauseSending({ kind: "manual", reason: "by Arslan", fixText: "Resume when ready.", byUserId: owner.id });
    expect(await rejection(ts.sendMeATest(ali, { campaignId, recipientId, step: 0 }, deps))).toBe(
      "Sending is paused (by Arslan). Tests go out again once it's resumed.",
    );
    await resumeSending({ actorId: owner.id, actorName: owner.name });

    expect(await rejection(ts.sendMeATest(ali, { campaignId: saraCampaignId, recipientId: saraRecipientId, step: 0 }, deps))).toBe(
      "Sara has no sending address yet. Sara can add one in Settings › My profile.",
    );

    await dbWrite((c) => c.suppression.create({ data: { emailNorm: "ali.khan@gmail.com", reason: "BOUNCED", source: "webhook" } }));
    expect(await rejection(ts.sendMeATest(ali, { campaignId, recipientId, step: 0 }, deps))).toBe(
      "Your reply inbox (ali.khan@gmail.com) is on the do-not-email list (it bounced), so tests can't be sent to it.",
    );
    await dbWrite((c) => c.suppression.deleteMany({ where: { emailNorm: "ali.khan@gmail.com" } }));

    expect(await rejection(ts.sendMeATest(ali, { campaignId: saraCampaignId, recipientId, step: 0 }, deps))).toBe(ts.TEST_SEND_TEXTS.notInCampaign);
    expect(mg.fake.messages).toHaveLength(0);
  });

  it("sends the person's email to your own reply inbox, never in test mode, and it counts toward today's limit", async () => {
    const before = await getTodayCap(new Date());
    const res = await ts.sendMeATest(ali, { campaignId, recipientId, step: 0 }, deps);
    expect(res).toEqual({ status: "sent", message: "Test sent to ali.khan@gmail.com. It should arrive within a minute." });
    const m = last();
    expect(field(m, "to")).toBe("ali.khan@gmail.com");
    expect(field(m, "from")).toBe(`Ali from Polygon Paradise <ali@${D}>`);
    expect(field(m, "h:Message-Id")).toMatch(/^<pp\.t\.[0-9a-f]{24}@send\.example\.com>$/);
    expect(m.fields["o:tag"]).toEqual(["outreach-test"]);
    expect(m.fields["o:testmode"]).toBeUndefined();
    expect(field(m, "text")).toContain("%unsubscribe_url%");
    const row = await db.testSend.findFirstOrThrow({ orderBy: { id: "desc" } });
    expect(row).toMatchObject({ userId: ali.id, to: "ali.khan@gmail.com", purpose: "SELF", status: "SENT", mode: "TEST", recipientId });
    expect(row.providerId).toBe(row.messageId);
    expect(field(m, "v:test_send_id")).toBe(String(row.id));
    expect(`<${row.messageId}>`).toBe(field(m, "h:Message-Id"));
    const after = await getTodayCap(new Date());
    expect(after.testSends).toBe(before.testSends + 1);
    expect(after.used).toBe(before.used + 1);
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "test.sent" }, orderBy: { id: "desc" } });
    expect(log).toMatchObject({ actorId: ali.id, campaignId, summary: "Ali sent a test of “Germany Q4” to ali.khan@gmail.com" });
  });

  it("a test still on its way (the last 2 minutes) blocks the next click", async () => {
    await dbWrite((c) =>
      c.testSend.create({ data: { userId: owner.id, to: "arslan.owner@gmail.com", subject: "x", mode: "TEST", status: "SENDING", messageId: `pp.t.inflight@${D}` } }),
    );
    expect(await rejection(ts.sendMeATest(owner, { campaignId, recipientId, step: 0 }, deps))).toBe(ts.TEST_SEND_TEXTS.stillOnItsWay);
    await dbWrite((c) => c.testSend.update({ where: { messageId: `pp.t.inflight@${D}` }, data: { status: "SENT" } }));
  });

  it("a reply-test email on its way in the Owner's name doesn't block the Owner's own test (SETUP-06)", async () => {
    const before = (await db.testSend.findFirst({ orderBy: { id: "desc" }, select: { id: true } }))?.id ?? 0;
    await dbWrite((c) =>
      c.testSend.create({
        data: { userId: owner.id, to: "t.gmail@gmail.com", subject: "x", mode: "LIVE", purpose: "REPLY_TEST", status: "SENDING", messageId: `pp.t.rt-inflight@${D}` },
      }),
    );
    try {
      const res = await ts.sendMeATest(owner, { campaignId, recipientId, step: 0 }, deps);
      expect(res.status).toBe("sent");
      expect(field(last(), "to")).toBe("arslan.owner@gmail.com");
    } finally {
      // Leave the day's counts as the other tests expect them.
      await dbWrite((c) => c.testSend.deleteMany({ where: { id: { gt: before } } }));
    }
  });

  it("checks 20 a day in the same write that records the test: two clicks at 19 send one", async () => {
    await dbWrite((c) =>
      c.testSend.createMany({
        data: Array.from({ length: 18 }, (_, i) => ({ userId: ali.id, to: "ali.khan@gmail.com", subject: "old", mode: "TEST" as const, status: "SENT" as const, messageId: `pp.t.old${i}@${D}` })),
      }),
    );
    expect(await ts.testSendInfo(ali)).toMatchObject({ testsLeft: 1, perDay: 20, blocker: null, inbox: "ali.khan@gmail.com" });
    const results = await Promise.allSettled([
      ts.sendMeATest(ali, { campaignId, recipientId, step: 0 }, deps),
      ts.sendMeATest(ali, { campaignId, recipientId, step: 0 }, deps),
    ]);
    const sent = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(sent).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0]!.reason as Error).message).toBe(ts.TEST_SEND_TEXTS.dailyMax);
    expect(mg.fake.messages).toHaveLength(1);
    expect(await ts.testSendInfo(ali)).toMatchObject({ testsLeft: 0, blocker: ts.TEST_SEND_TEXTS.dailyMax });
  });

  it("refuses when today's limit is reached, because tests count toward it", async () => {
    const today = await getTodayCap(new Date());
    await setSettingValue("sending.capOverride", {
      capDay: capDayOf(new Date(), "Asia/Karachi"),
      cap: today.used,
      byUserId: owner.id,
      at: new Date().toISOString(),
    });
    try {
      expect(await rejection(ts.sendMeATest(owner, { campaignId, recipientId, step: 0 }, deps))).toBe(ts.capReachedTestText(today.used));
    } finally {
      await setSettingValue("sending.capOverride", null);
    }
  });

  it("an answer that may hide an acceptance leaves the test UNKNOWN", async () => {
    mg.fake.failNext("POST /v3/:d/messages", { kind: "acceptWithoutId" });
    expect(await rejection(ts.sendMeATest(owner, { campaignId, recipientId, step: 0 }, deps))).toBe(
      "Mailgun didn't answer in time, so the test may or may not arrive.",
    );
    expect((await db.testSend.findFirstOrThrow({ where: { userId: owner.id }, orderBy: { id: "desc" } })).status).toBe("UNKNOWN");
  });

  it("a refused key fails the test and pauses all sending", async () => {
    mg.fake.failNext("POST /v3/:d/messages", { kind: "status", status: 401, body: "Forbidden" });
    await dbWrite((c) => c.testSend.updateMany({ where: { userId: owner.id, status: "UNKNOWN" }, data: { status: "FAILED" } }));
    expect(await rejection(ts.sendMeATest(owner, { campaignId, recipientId, step: 0 }, deps))).toBe(AUTH_TEXT);
    const row = await db.testSend.findFirstOrThrow({ where: { userId: owner.id }, orderBy: { id: "desc" } });
    expect(row).toMatchObject({ status: "FAILED", error: AUTH_TEXT });
    const pause = await getPauseState();
    expect(pause).toMatchObject({ paused: true, kind: "mailgun-auth", reason: "Mailgun didn't accept the API key" });
    await resumeSending({ actorId: owner.id, actorName: owner.name });
  });
});

describe("the reply test's emails", () => {
  beforeEach(async () => {
    await setSettingValue("sending.testList", TEST_LIST);
    await writeDomainCheck(D);
  });

  it("refuses with what's missing, and sends nothing", async () => {
    await setSettingValue("sending.mode", "DRY_RUN");
    const err = await ts.sendReplyTestEmails(owner.id, { jobId: 70, mailgun: fastMailgun }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ts.ReplyTestRefusedError);
    expect((err as InstanceType<typeof ts.ReplyTestRefusedError>).reasons).toEqual([MODE_GATE_TEXTS.modeForReplyTest]);
    await setSettingValue("sending.mode", "TEST");
    await writeDomainCheck(D, { webhooks: "bad" });
    const err2 = await ts.sendReplyTestEmails(owner.id, { jobId: 70, mailgun: fastMailgun }).catch((e: unknown) => e);
    expect((err2 as InstanceType<typeof ts.ReplyTestRefusedError>).reasons).toEqual([MODE_GATE_TEXTS.webhooks]);
    expect(mg.fake.messages).toHaveLength(0);
  });

  it("sends one email per test mailbox with a Message-ID fixed by the job, and a rerun sends nothing twice", async () => {
    const res = await ts.sendReplyTestEmails(owner.id, { jobId: 71, mailgun: fastMailgun });
    expect(res).toEqual({ sent: 3, failed: 0, skipped: [], paused: [] });
    expect(mg.fake.messages.map((m) => field(m, "to"))).toEqual(TEST_LIST);
    for (const m of mg.fake.messages) {
      expect(field(m, "h:Message-Id")).toBe(`<${ts.replyTestMessageId(71, field(m, "to")!, D)}>`);
      expect(field(m, "from")).toBe(`Arslan from Polygon Paradise <arslan@${D}>`);
      expect(field(m, "subject")).toBe(REPLY_TEST_SUBJECT);
      // Multipart form data carries line breaks as CRLF.
      expect(field(m, "text")!.replace(/\r\n/g, "\n")).toContain("Arslan\nPolygon Paradise\n\n--\n");
      expect(field(m, "text")).toContain("%unsubscribe_url%");
      expect(m.fields["o:testmode"]).toBeUndefined();
    }
    expect(ts.replyTestMessageId(71, "T.Gmail@Gmail.com", "Send.Example.com")).toMatch(/^pp\.t\.71\.[0-9a-f]{12}@send\.example\.com$/);
    expect(ts.replyTestMessageId(71, "t.gmail@gmail.com", D)).toBe(ts.replyTestMessageId(71, "T.Gmail@Gmail.com", D));
    const rows = await db.testSend.findMany({ where: { purpose: "REPLY_TEST" } });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "SENT" && r.userId === owner.id)).toBe(true);

    const again = await ts.sendReplyTestEmails(owner.id, { jobId: 71, mailgun: fastMailgun });
    expect(again).toEqual({ sent: 0, failed: 0, skipped: TEST_LIST, paused: [] });
    expect(mg.fake.messages).toHaveLength(3);
  });

  it("a failed mailbox is sent again on a rerun of the same job, the others aren't", async () => {
    mg.fake.failNext("POST /v3/:d/messages", { kind: "status", status: 400, body: { message: "to parameter is not a valid address. please check documentation." } });
    const res = await ts.sendReplyTestEmails(owner.id, { jobId: 72, mailgun: fastMailgun });
    expect(res).toEqual({ sent: 2, failed: 1, skipped: [], paused: [] });
    const failed = await db.testSend.findUniqueOrThrow({ where: { messageId: ts.replyTestMessageId(72, TEST_LIST[0]!, D) } });
    expect(failed.status).toBe("FAILED");
    const again = await ts.sendReplyTestEmails(owner.id, { jobId: 72, mailgun: fastMailgun });
    expect(again).toEqual({ sent: 1, failed: 0, skipped: TEST_LIST.slice(1), paused: [] });
    expect((await db.testSend.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe("SENT");
  });

  it("the job sums up", async () => {
    const out = (await sendTestEmailJob.handler(
      { purpose: "REPLY_TEST", userId: owner.id },
      { jobId: 73, createdById: owner.id, signal: new AbortController().signal, progress: async () => undefined },
    )) as { summary: string };
    expect(out.summary).toBe("Sent the reply test to 3 mailboxes.");
  });

  /** fastMailgun, but "Pause all sending" is clicked right after the first email went out. */
  const pausedAfterFirst = async () => {
    const ctx = await fastMailgun();
    if (!ctx.connected) return ctx;
    const real = ctx.sendClient;
    let calls = 0;
    const sendClient = {
      sendMessage: async (...args: Parameters<typeof real.sendMessage>) => {
        const res = await real.sendMessage(...args);
        calls += 1;
        if (calls === 1) await pauseSending({ kind: "manual", reason: "checking a complaint", fixText: "Resume when ready.", byUserId: owner.id });
        return res;
      },
    } as unknown as typeof real;
    return { ...ctx, sendClient };
  };

  it("a pause that lands mid-run stops the rest: no more emails, no rows for them, and the summary says so", async () => {
    try {
      const res = await ts.sendReplyTestEmails(owner.id, { jobId: 74, mailgun: pausedAfterFirst });
      expect(res).toEqual({ sent: 1, failed: 0, skipped: [], paused: TEST_LIST.slice(1) });
      expect(mg.fake.messages.map((m) => field(m, "to"))).toEqual([TEST_LIST[0]]);
      for (const address of TEST_LIST.slice(1)) {
        expect(await db.testSend.findUnique({ where: { messageId: ts.replyTestMessageId(74, address, D) } })).toBeNull();
      }
      expect(ts.replyTestPausedText(2)).toBe(
        "Sending was paused, so 2 mailboxes didn't get the test email. Once sending is resumed, click Send test emails to my test list again.",
      );
    } finally {
      await resumeSending({ actorId: owner.id, actorName: owner.name });
    }
  });

  it("a pause that lands before the first email refuses like one found at the start", async () => {
    const pausedBeforeFirst = async () => {
      const ctx = await fastMailgun();
      await pauseSending({ kind: "manual", reason: "checking a complaint", fixText: "Resume when ready.", byUserId: owner.id });
      return ctx;
    };
    const before = mg.fake.messages.length;
    try {
      const err = await ts.sendReplyTestEmails(owner.id, { jobId: 76, mailgun: pausedBeforeFirst }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ts.ReplyTestRefusedError);
      expect((err as Error).message).toBe("Sending is paused (checking a complaint). Tests go out again once it's resumed.");
      expect(mg.fake.messages.length).toBe(before);
      expect(await db.testSend.count({ where: { messageId: { startsWith: "pp.t.76." } } })).toBe(0);
    } finally {
      await resumeSending({ actorId: owner.id, actorName: owner.name });
    }
  });

  it("review SEND-2: a failed mailbox recorded again for a rerun but never sent (paused first) goes back to what it was", async () => {
    mg.fake.failNext("POST /v3/:d/messages", { kind: "status", status: 400, body: { message: "to parameter is not a valid address. please check documentation." } });
    expect(await ts.sendReplyTestEmails(owner.id, { jobId: 77, mailgun: fastMailgun })).toEqual({ sent: 2, failed: 1, skipped: [], paused: [] });
    const failed = await db.testSend.findUniqueOrThrow({ where: { messageId: ts.replyTestMessageId(77, TEST_LIST[0]!, D) } });
    expect(failed.status).toBe("FAILED");
    const pausedBeforeFirst = async () => {
      const ctx = await fastMailgun();
      await pauseSending({ kind: "manual", reason: "checking a complaint", fixText: "Resume when ready.", byUserId: owner.id });
      return ctx;
    };
    const before = mg.fake.messages.length;
    try {
      const err = await ts.sendReplyTestEmails(owner.id, { jobId: 77, mailgun: pausedBeforeFirst }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ts.ReplyTestRefusedError);
      expect(mg.fake.messages.length).toBe(before);
      expect(await db.testSend.findUniqueOrThrow({ where: { id: failed.id } })).toEqual(failed);
    } finally {
      await resumeSending({ actorId: owner.id, actorName: owner.name });
    }
  });
});
