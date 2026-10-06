import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { makeCompany, makeDraft } from "../campaigns/seed";
import { addSenderAddress, clearJobs, makeUser, queuedJobs, setSettingValue, writeDomainCheck } from "./helpers";

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

const t = await createTestDb("mg-actions");
const mg: FakeConnection = await connectFakeMailgun();
const { db, dbWrite } = await import("@/server/db");
const { getSetting } = await import("@/server/settings");
const { getPauseState } = await import("@/server/services/sending/pause");
const { MODE_GATE_TEXTS } = await import("@/core/sending/mode-gates");
const sending = await import("@/app/(app)/settings/sending/actions");
const domain = await import("@/app/(app)/settings/domain/actions");
const testSend = await import("@/app/(app)/campaigns/[id]/setup/test-send-actions");

const D = mg.domain;
const PUB = "http://127.0.0.1:3999";
const previousPub = process.env.APP_PUBLIC_URL;
const OWNER_ONLY = "Only the Owner can do this.";
let owner: TestUser;
let member: TestUser;
let campaignId = 0;
let recipientId = 0;

function asUser(u: { id: number; email: string; name: string; role: "OWNER" | "MEMBER" }): TestUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, timeZone: "Asia/Karachi", sessionId: 1 };
}

beforeAll(async () => {
  process.env.APP_PUBLIC_URL = PUB;
  owner = asUser(await makeUser("Arslan", { role: "OWNER", replyInbox: "arslan.owner@gmail.com" }));
  member = asUser(await makeUser("Ali", { replyInbox: "ali.khan@gmail.com" }));
  await addSenderAddress(owner.id, mg.domainId, "arslan", "ok");
  await addSenderAddress(member.id, mg.domainId, "ali", "ok");
  const { company, people } = await makeCompany({ name: "Studio Berg", people: [{ name: "Anna Berg", email: "anna@studio-berg.de" }] });
  const draft = await makeDraft({ name: "Q4", createdById: member.id, senderId: member.id, recipients: [{ companyId: company.id, personId: people[0]!.id }] });
  campaignId = draft.id;
  recipientId = (await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } })).id;
});

beforeEach(async () => {
  auth.user = owner;
  mg.fake.reset();
  await clearJobs();
  await setSettingValue("sending.mode", "DRY_RUN");
});

afterAll(async () => {
  if (previousPub === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previousPub;
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("Owner-only", () => {
  it("every Sending & Mailgun and Domain checklist action refuses a Member", async () => {
    auth.user = member;
    const calls: Array<Promise<{ ok: boolean; error?: string }>> = [
      sending.connectMailgunAction({ region: "EU", domain: D, apiKey: "key-fake-api" }),
      sending.forgetMailgunKeysAction(),
      sending.removeSendingKeyAction({}),
      sending.setSendingModeAction({ mode: "TEST" }),
      sending.saveTestListAction({ addresses: ["x@gmail.com"] }),
      sending.pauseAllAction({ why: null }),
      sending.resumeSendingAction({}),
      sending.saveRetentionAction({ logRetentionDays: 5, messageRetentionDays: 1 }),
      sending.checkWithMailgunAction(),
      sending.switchToDryRunAction(),
      domain.applyRecommendedSettingsAction(),
      domain.checkDomainAgainAction(),
      domain.sendReplyTestAction(),
      domain.saveReplyTestAnswersAction({ mailboxes: [], headersOk: null }),
      domain.decideReplyTestAction({}),
      domain.switchUnsubscribeSetupAction({ setup: "B" }),
      domain.saveDomainAgeAction({ date: null }),
    ];
    for (const res of await Promise.all(calls)) expect(res).toEqual({ ok: false, error: OWNER_ONLY });
    expect(await db.job.count()).toBe(0);
    expect((await getPauseState()).paused).toBe(false);
  });

  it("\"Send me a test\" is open to Members", async () => {
    auth.user = member;
    const info = await testSend.testSendInfoAction({ campaignId });
    expect(info).toMatchObject({ ok: true, data: { mode: "DRY_RUN", inbox: "ali.khan@gmail.com", testsLeft: 20 } });
    const res = await testSend.sendMeATestAction({ campaignId, recipientId, step: 0 });
    expect(res).toMatchObject({ ok: true, data: { status: "preview" } });
    await setSettingValue("sending.mode", "TEST");
    const sent = await testSend.sendMeATestAction({ campaignId, recipientId, step: 0 });
    expect(sent).toMatchObject({ ok: true, data: { status: "sent", preview: null }, message: "Test sent to ali.khan@gmail.com. It should arrive within a minute." });
    expect(mg.fake.messages).toHaveLength(1);
    const wrong = await testSend.sendMeATestAction({ campaignId: campaignId + 1000, recipientId, step: 0 });
    expect(wrong).toEqual({ ok: false, error: "This person isn't in the campaign any more. Refresh the page to see the latest." });
    auth.user = null;
    expect(await testSend.sendMeATestAction({ campaignId, recipientId, step: 0 })).toEqual({
      ok: false,
      error: "Your session has ended. Please sign in again.",
    });
  });
});

describe("Sending & Mailgun actions", () => {
  it("connect puts Mailgun's answer behind Details and the sentence on the field", async () => {
    const res = await sending.connectMailgunAction({ region: "EU", domain: D, apiKey: "key-fake-wrong" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("Mailgun didn't accept this API key. In Mailgun, open API Security, create a key with the Developer role and paste it here.");
    expect(res.fieldErrors?.apiKey).toEqual([res.error]);
    expect(res.fieldErrors?.detail?.[0]).toContain("401");
    const ok = await sending.connectMailgunAction({ region: "EU", domain: D, apiKey: "" });
    expect(ok).toMatchObject({ ok: true });
  });

  it("the sending mode: Live waits for the checklist, Test mode needs Mailgun, and the change is logged", async () => {
    await writeDomainCheck(D, { webhooks: "bad", "tracking-off": "warn" });
    const live = await sending.setSendingModeAction({ mode: "LIVE" });
    expect(live).toEqual({ ok: false, error: MODE_GATE_TEXTS.webhooks });
    expect(await getSetting("sending.mode")).toBe("DRY_RUN");

    const test = await sending.setSendingModeAction({ mode: "TEST" });
    expect(test).toMatchObject({ ok: true, message: "Sending is set to test mode.", data: { mode: "TEST", warning: null } });
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "sending.modeChanged" }, orderBy: { id: "desc" } });
    expect(log.summary).toBe("Arslan set sending to test mode");

    await writeDomainCheck(D);
    expect(await sending.setSendingModeAction({ mode: "LIVE" })).toMatchObject({ ok: true, message: "Sending is set to live (test list only)." });

    // Switching away while a live campaign still sends: saved, with the warning.
    const c = await dbWrite((x) => x.campaign.create({ data: { name: "Test mailboxes", createdById: owner.id, mode: "LIVE", status: "RUNNING" } }));
    const back = await sending.setSendingModeAction({ mode: "DRY_RUN" });
    expect(back).toMatchObject({
      ok: true,
      data: {
        mode: "DRY_RUN",
        warning:
          "1 live campaign is still sending: “Test mailboxes”. New campaigns use the new mode; pause that campaign, or use Pause all sending, to stop it.",
      },
    });
    await dbWrite((x) => x.campaign.update({ where: { id: c.id }, data: { status: "FINISHED" } }));

    await setSettingValue("practice.copy", true);
    expect(await sending.setSendingModeAction({ mode: "TEST" })).toEqual({ ok: false, error: MODE_GATE_TEXTS.practiceCopy });
    await setSettingValue("practice.copy", false);
  });

  it("the test list saves a clean list and explains a refusal on the field", async () => {
    const ok = await sending.saveTestListAction({ addresses: ["T.Outlook@outlook.com", "t.gmail@gmail.com"] });
    expect(ok).toMatchObject({ ok: true, data: { addresses: ["t.outlook@outlook.com", "t.gmail@gmail.com"], warnings: [] } });
    const bad = await sending.saveTestListAction({ addresses: [`x@${D}`] });
    expect(bad).toMatchObject({ ok: false, fieldErrors: { address: [`x@${D} is on your sending domain. Use a normal mailbox, such as Gmail or Outlook.com.`] } });
  });

  it("pause all and resume", async () => {
    expect(await sending.pauseAllAction({ why: "  checking a complaint  " })).toMatchObject({ ok: true });
    expect(await getPauseState()).toMatchObject({ paused: true, kind: "manual", reason: "checking a complaint", byUserId: owner.id });
    expect(await sending.resumeSendingAction({})).toMatchObject({ ok: true, message: "Sending is resumed.", data: { summary: "Resumed by Arslan" } });
    expect(await sending.resumeSendingAction({})).toEqual({ ok: false, error: "Sending isn't paused." });
    await sending.pauseAllAction({});
    expect((await getPauseState()).reason).toBe("by Arslan");
    await sending.resumeSendingAction({});
  });

  it("the page: the resume dialog doesn't repeat its title's question, and 'not connected' says what to do here", async () => {
    const { loadSendingPage } = await import("@/app/(app)/settings/sending/load");
    const { CONNECTION_STATUS_TEXTS } = await import("@/components/settings/sending/texts");
    const { pauseSending, resumeSending } = await import("@/server/services/sending/pause");
    const { setSecret } = await import("@/server/secrets");

    await pauseSending({ kind: "health-bounce", reason: "7 of the last 200 emails bounced", fixText: "Open the bounced list, then click Resume." });
    let page = await loadSendingPage(owner);
    expect(page.pause?.dialog).toEqual(["7 of the last 200 emails bounced. Resuming starts a fresh count: only new bounces count toward the limit."]);
    await resumeSending({ actorId: owner.id, actorName: owner.name });
    await pauseSending({ kind: "manual", reason: "checking a complaint", fixText: "Resume when ready.", byUserId: owner.id });
    page = await loadSendingPage(owner);
    expect(page.pause?.dialog).toEqual(["If the problem is still there, sending pauses again."]);
    expect(page.pause?.dialog.join(" ")).not.toContain("Resume sending?");
    await resumeSending({ actorId: owner.id, actorName: owner.name });

    // Keys removed ("Remove saved keys"), then a key the app can't read: the status line points at the form below,
    // not at the page the Owner is already on.
    await dbWrite((c) => c.secret.deleteMany({ where: { key: "mailgun.apiKey" } }));
    try {
      page = await loadSendingPage(owner);
      expect(page.connection.statusLine).toBe(CONNECTION_STATUS_TEXTS.noKey);
      expect(page.connection.statusLine).toBe("Not connected: paste your API key below and click Save and connect.");
      await dbWrite((c) => c.secret.create({ data: { key: "mailgun.apiKey", ciphertext: "v1:bm90:dmFsaWQ=:Z2FyYmFnZQ==", last4: "0000" } }));
      page = await loadSendingPage(owner);
      expect(page.connection.statusLine).toBe(CONNECTION_STATUS_TEXTS.unreadable);
      expect(page.connection.statusLine).not.toContain("Settings › Sending & Mailgun");
    } finally {
      await setSecret("mailgun.apiKey", mg.apiKey, null);
    }
    expect((await loadSendingPage(owner)).connection.statusLine).toMatch(new RegExp(`^Connected to ${D.replace(/\./g, "\\.")} \\(EU\\)`));
  });

  it("Remove the sending key: only the sending key goes, the page shows it's gone, and the toast says what's next (review SCREENS-01)", async () => {
    const { loadSendingPage } = await import("@/app/(app)/settings/sending/load");
    const { REMOVE_SENDING_KEY_TEXTS } = await import("@/server/services/mailgun/connect");
    const { getSecret, setSecret } = await import("@/server/secrets");
    await setSecret("mailgun.sendingKey", "key-fake-sending", owner.id);
    expect((await loadSendingPage(owner)).connection.hasSendingKey).toBe(true);

    const res = await sending.removeSendingKeyAction({});
    expect(res).toEqual({ ok: true, data: { removed: true }, message: REMOVE_SENDING_KEY_TEXTS.removed });
    expect(REMOVE_SENDING_KEY_TEXTS.removed).toBe(
      "The domain sending key is removed. Emails now go out with the API key. If sending is paused, click Resume sending.",
    );
    expect(await getSecret("mailgun.sendingKey")).toBeNull();
    expect(await getSecret("mailgun.apiKey")).toBe(mg.apiKey);
    expect((await loadSendingPage(owner)).connection.hasSendingKey).toBe(false);
    // A second click (another tab): nothing to remove, said plainly.
    expect(await sending.removeSendingKeyAction()).toEqual({ ok: true, data: { removed: false }, message: REMOVE_SENDING_KEY_TEXTS.nothingSaved });
    // Anything sent along is refused by the schema.
    expect(await sending.removeSendingKeyAction({ key: "x" } as never)).toMatchObject({ ok: false });

    // A Member can't.
    await setSecret("mailgun.sendingKey", "key-fake-sending", owner.id);
    auth.user = member;
    expect(await sending.removeSendingKeyAction({})).toEqual({ ok: false, error: OWNER_ONLY });
    expect(await getSecret("mailgun.sendingKey")).toBe("key-fake-sending");
    auth.user = owner;
    await sending.removeSendingKeyAction({});
  });

  it("retention and the check with Mailgun", async () => {
    expect(await sending.saveRetentionAction({ logRetentionDays: 0, messageRetentionDays: 1 })).toMatchObject({
      ok: false,
      fieldErrors: { logRetentionDays: ["Use 1 to 30 days."] },
    });
    expect(await sending.saveRetentionAction({ logRetentionDays: 5, messageRetentionDays: 3 })).toMatchObject({
      ok: true,
      message: "Saved. Click Apply recommended settings on the Domain checklist so Mailgun keeps stored replies that long.",
    });
    expect(await getSetting("mailgun.messageRetentionDays")).toBe(3);
    await sending.saveRetentionAction({ logRetentionDays: 5, messageRetentionDays: 1 });

    const first = await sending.checkWithMailgunAction();
    const second = await sending.checkWithMailgunAction();
    expect(first.ok && second.ok && first.data.jobId === second.data.jobId).toBe(true);
    expect((await queuedJobs("mailgun.catchUp"))[0]).toMatchObject({ payload: { reason: "manual" }, activeDedupeKey: "mailgun:catchup", priority: 50 });
  });
});

describe("Domain checklist actions", () => {
  it("Apply and Check again queue one job each; Check again waits a minute after a check", async () => {
    const a = await domain.applyRecommendedSettingsAction();
    const b = await domain.applyRecommendedSettingsAction();
    expect(a.ok && b.ok && a.data.jobId === b.data.jobId).toBe(true);
    expect((await queuedJobs("mailgun.applySettings"))[0]).toMatchObject({ payload: { step: "all" }, maxAttempts: 1, activeDedupeKey: "mailgun:apply" });

    await writeDomainCheck(D); // checked just now
    expect(await domain.checkDomainAgainAction()).toEqual({ ok: false, error: "Checked just now. Check again in a minute." });
    const { setState } = await import("@/server/state");
    await setState("domain.check", { domain: D, region: "EU", checkedAt: new Date(Date.now() - 5 * 60_000).toISOString(), rows: [] });
    expect(await domain.checkDomainAgainAction()).toMatchObject({ ok: true });
    expect((await queuedJobs("mailgun.checkDomain"))[0]).toMatchObject({ payload: { verify: true } });
  });

  it("the reply test: refused with what's missing; a double click queues one job", async () => {
    await writeDomainCheck(D);
    await setSettingValue("sending.testList", ["t.outlook@outlook.com", "t.gmail@gmail.com"]);
    const refused = await domain.sendReplyTestAction();
    expect(refused).toEqual({ ok: false, error: `Not yet: ${MODE_GATE_TEXTS.modeForReplyTest}` });
    await setSettingValue("sending.mode", "TEST");
    const [x, y] = await Promise.all([domain.sendReplyTestAction(), domain.sendReplyTestAction()]);
    expect(x.ok && y.ok && x.data.jobId === y.data.jobId).toBe(true);
    const jobs = await queuedJobs("send.testEmail");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ payload: { purpose: "REPLY_TEST", userId: owner.id }, activeDedupeKey: "send:reply-test", maxAttempts: 1, priority: 60 });
  });

  it("answers, an unfinished result, and the setup switch", async () => {
    await setSettingValue("sending.testList", ["t.outlook@outlook.com", "t.gmail@gmail.com"]);
    const saved = await domain.saveReplyTestAnswersAction({
      mailboxes: [{ address: "t.gmail@gmail.com", inboxOk: true, authOk: "unsure", pastedHeaders: "Authentication-Results: mx.google.com; dkim=pass header.i=@gmail.com" }],
      headersOk: null,
    });
    expect(saved).toMatchObject({ ok: true, data: { authFromHeaders: { "t.gmail@gmail.com": "pass" } } });
    const decided = await domain.decideReplyTestAction({});
    expect(decided.ok).toBe(false);
    if (!decided.ok) expect(decided.error).toMatch(/^The reply test isn't finished yet, so nothing was saved\. /);
    expect(await domain.switchUnsubscribeSetupAction({ setup: "B" })).toMatchObject({ ok: true });
    expect((await getSetting("mailgun.unsubscribeTest")).setup).toBe("B");
    await domain.switchUnsubscribeSetupAction({ setup: "A" });
  });

  it("the page shows this domain's Apply run only, and a reply-test email Mailgun refused as Didn't send", async () => {
    const { loadDomainPage } = await import("@/app/(app)/settings/domain/load");
    const { setState } = await import("@/server/state");
    await writeDomainCheck(D);
    await setSettingValue("sending.testList", ["t.outlook@outlook.com", "t.gmail@gmail.com"]);
    const run = (host: string) => ({
      runAt: new Date().toISOString(),
      byUserId: owner.id,
      jobId: 9,
      steps: [{ key: "webhooks", ok: true, text: "Mailgun tells the app about deliveries, bounces, complaints and unsubscribes.", detail: null, at: new Date().toISOString() }],
      certificate: { host, status: "active", startedAt: null, lastPolledAt: null, error: null },
    });

    // An Apply run that finished for the old domain after a domain change: not shown as this domain's.
    await setState("mailgun.setup", run("email.old.example.com"));
    let page = await loadDomainPage(owner);
    if (page.state !== "connected") throw new Error(page.state);
    expect(page.steps).toEqual([]);
    expect(page.setupLine).toBeNull();

    await setState("mailgun.setup", run(`email.${D}`));
    page = await loadDomainPage(owner);
    if (page.state !== "connected") throw new Error(page.state);
    expect(page.steps.map((s) => s.key)).toEqual(["webhooks"]);
    expect(page.setupLine).toMatch(/^Last applied .+ by Arslan\.$/);

    // A reply-test email Mailgun refused (A6: "Didn't send").
    await dbWrite((c) =>
      c.testSend.create({
        data: {
          userId: owner.id,
          to: "t.gmail@gmail.com",
          subject: "Reply test from Polygon Paradise Outreach",
          mode: "TEST",
          purpose: "REPLY_TEST",
          status: "FAILED",
          error: "Mailgun refused this address.",
          messageId: `pp.t.990.abc@${D}`,
        },
      }),
    );
    page = await loadDomainPage(owner);
    if (page.state !== "connected") throw new Error(page.state);
    expect(page.replyTest.mailboxes.find((m) => m.address === "t.gmail@gmail.com")?.testEmail).toBe("Didn't send: Mailgun refused this address.");
    expect(page.replyTest.mailboxes.find((m) => m.address === "t.outlook@outlook.com")?.testEmail).toBe("Not sent yet");
    await setState("mailgun.setup", { runAt: null, byUserId: null, jobId: null, steps: [], certificate: null });
  });

  it("per-person mode doesn't show From-domain rows a check stored before the From address was cleared (review SECURITY-3)", async () => {
    const { loadDomainPage } = await import("@/app/(app)/settings/domain/load");
    expect(await getSetting("mailgun.fromAddress")).toBeNull();
    await writeDomainCheck(D, { "from-mx": "bad", "from-spf": "info" });
    const page = await loadDomainPage(owner);
    if (page.state !== "connected") throw new Error(page.state);
    const keys = page.rows.map((r) => r.key);
    expect(keys).toContain("dmarc");
    expect(keys).not.toContain("from-mx");
    expect(keys).not.toContain("from-spf");
    await writeDomainCheck(D);
  });

  it("the domain's purchase date: a real date, not in the future", async () => {
    expect(await domain.saveDomainAgeAction({ date: "2026-02-30" })).toMatchObject({ ok: false, fieldErrors: { date: ["Pick a date, for example 2026-09-01."] } });
    expect(await domain.saveDomainAgeAction({ date: "2999-01-01" })).toMatchObject({ ok: false, error: "Pick a date that isn't in the future." });
    expect(await domain.saveDomainAgeAction({ date: "2026-08-01" })).toMatchObject({ ok: true });
    expect(await getSetting("mailgun.domainRegisteredOn")).toBe("2026-08-01");
    expect(await queuedJobs("mailgun.checkDomain")).toHaveLength(1);
    await domain.saveDomainAgeAction({ date: null });
    expect(await getSetting("mailgun.domainRegisteredOn")).toBeNull();
  });
});
