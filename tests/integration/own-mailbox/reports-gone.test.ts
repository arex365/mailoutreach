import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckStatus, ChecklistGroup, ChecklistRowKey } from "@/core/system-state";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { makeCompany } from "../campaigns/seed";
import { makeUser, setSettingValue } from "../mailgun-setup/helpers";

/**
 * Review REPLIES-08 (own-mailbox mode on Free: 1 day of Mailgun logs, no webhooks): a report that fell into a gap longer
 * than the logs the app can read never arrives, so the reply test and the go-live card say plainly to send the test
 * again instead of "hasn't been delivered yet" / "wait a few minutes". Checked with `now` moved past the logs' reach
 * (1 day + 1 hour); within it, today's sentences stay. Against the fake Mailgun on example.com; nothing reaches the network.
 */

vi.mock("server-only", () => ({}));

const D = "example.com";
const FROM = "contact@example.com";
const OUTLOOK = "t.outlook@outlook.com";
const GMAIL = "t.gmail@gmail.com";
const HOUR = 60 * 60_000;

const t = await createTestDb("own-mailbox-reports-gone");
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
const { setState } = await import("@/server/state");
const rt = await import("@/server/services/reply-test");
const { MODE_GATE_TEXTS } = await import("@/core/sending/mode-gates");
const { REPLY_TEST_TEXTS } = await import("@/core/reply-test");
const { OWN_MAILBOX_TEXTS, OWN_REPLY_TEST_TEXTS } = await import("@/core/sending/own-mailbox");

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
];

async function ownCheck(): Promise<void> {
  const info: Partial<Record<ChecklistRowKey, CheckStatus>> = { "https-links": "info", webhooks: "info", "remote-access": "info" };
  const rows = OWN_ROWS.map(([key, group]) => ({ key, group, status: info[key] ?? "ok", title: `Row ${key}`, text: "", fix: null, records: [], detail: null }));
  await setState("domain.check", { domain: D, region: "US", checkedAt: new Date().toISOString(), lastVerifyAt: null, rows, error: null, replies: "own-mailbox" });
}

let owner: { id: number; name: string; email: string };
let tess: { companyId: number; personId: number };
let n = 0;

/** A reply-test email of the own From to a test mailbox, sent now; delivered only when asked. */
async function replyTestEmail(to: string, delivered: boolean): Promise<{ id: number; sentAt: Date }> {
  n += 1;
  const row = await dbWrite((c) =>
    c.testSend.create({
      data: { userId: owner.id, to, subject: "Reply test", mode: "TEST", purpose: "REPLY_TEST", status: "SENT", messageId: `pp.t.${n}.abc@${D}`, teamFrom: FROM, sentAt: new Date() },
    }),
  );
  if (delivered) {
    await dbWrite((c) =>
      c.mailEvent.create({ data: { dedupeKey: `rt-${n}`, type: "delivered", occurredAt: new Date(), recipient: to, testSendId: row.id, isTestMode: false, source: "LOGS", raw: {} } }),
    );
  }
  return { id: row.id, sentAt: row.sentAt };
}

/** A finished LIVE own-mailbox campaign with one SENT email to the Outlook.com test mailbox and no report yet. */
async function liveTestWithoutReport(): Promise<void> {
  n += 1;
  const at = new Date();
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
        fromAddress: FROM,
        replyTo: null,
        launchedAt: at,
        launchedGoLive: false,
      },
    }),
  );
  const recipient = await dbWrite((c) =>
    c.campaignRecipient.create({ data: { campaignId: campaign.id, companyId: tess.companyId, personId: tess.personId, emailNorm: OUTLOOK, state: "FINISHED" } }),
  );
  const messageId = `pp.live${n}@${D}`;
  await dbWrite((c) =>
    c.outboundEmail.create({
      data: {
        campaignId: campaign.id,
        recipientId: recipient.id,
        personId: tess.personId,
        companyId: tess.companyId,
        senderId: owner.id,
        step: 0,
        mode: "LIVE",
        toEmail: OUTLOOK,
        toNorm: OUTLOOK,
        companyName: "Test mailboxes",
        fromAddress: `Arslan from Polygon Paradise <${FROM}>`,
        replyTo: null,
        subject: "Live test",
        text: "t",
        html: "h",
        messageId,
        sendId: `live-${n}`,
        dueAt: at,
        status: "SENT",
        claimedAt: at,
        sentAt: at,
        providerId: messageId,
      },
    }),
  );
}

beforeAll(async () => {
  owner = await makeUser("Arslan", { role: "OWNER", replyInbox: "arslan.owner@gmail.com" });
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.testList", [OUTLOOK, GMAIL]);
  const { company, people } = await makeCompany({ name: "Test mailboxes", people: [{ name: "Tess", email: OUTLOOK }] });
  tess = { companyId: company.id, personId: people[0]!.id };
  await ownCheck();
});

beforeEach(async () => {
  await dbWrite(async (c) => {
    await c.mailEvent.deleteMany({});
    await c.testSend.deleteMany({});
    await c.outboundEmail.deleteMany({});
    await c.campaignRecipient.deleteMany({});
    await c.campaign.deleteMany({});
  });
});

afterAll(async () => {
  if (previousPub === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previousPub;
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("the reply test after a gap longer than Mailgun's logs", () => {
  it("a test email without a delivery report: 'hasn't been delivered yet' within the logs' reach, 'send again' past it", async () => {
    await replyTestEmail(OUTLOOK, false);
    await replyTestEmail(GMAIL, true);
    const soon = await rt.loadReplyTest(new Date(Date.now() + 2 * HOUR));
    expect(soon.facts.get(OUTLOOK)).not.toHaveProperty("reportGone");
    expect(soon.verdict.missing).toContain(`${OUTLOOK}: the test email hasn't been delivered yet.`);

    const later = await rt.loadReplyTest(new Date(Date.now() + 26 * HOUR));
    expect(later.facts.get(OUTLOOK)).toMatchObject({ delivered: false, reportGone: true });
    expect(later.facts.get(GMAIL)).not.toHaveProperty("reportGone");
    expect(later.verdict.missing).toContain(OWN_REPLY_TEST_TEXTS.reportGone(OUTLOOK));
    expect(later.verdict.missing.join(" ")).not.toContain("hasn't been delivered yet");

    // The mailbox's own "Test email" line on the Domain checklist page says the same (integration of REPLIES-08).
    const { loadDomainPage } = await import("@/app/(app)/settings/domain/load");
    const viewer = { id: owner.id, email: owner.email, name: owner.name, role: "OWNER" as const, timeZone: "Asia/Karachi", sessionId: 1 };
    const testEmailOf = async (at: Date, address: string) => {
      const page = await loadDomainPage(viewer, at);
      if (page.state !== "connected") throw new Error(page.state);
      return page.replyTest.mailboxes.find((m) => m.address === address)?.testEmail;
    };
    expect(await testEmailOf(new Date(Date.now() + 2 * HOUR), OUTLOOK)).toBe("Sent, waiting for delivery");
    expect(await testEmailOf(new Date(Date.now() + 26 * HOUR), OUTLOOK)).toBe("Sent, but Mailgun's report is gone: send the test emails again");
    expect(await testEmailOf(new Date(Date.now() + 26 * HOUR), GMAIL)).toBe("Delivered");
  });

  it("the logs the app counts on follow the plan: 5 days (Foundation) keep the report reachable for longer", async () => {
    await replyTestEmail(OUTLOOK, false);
    await replyTestEmail(GMAIL, true);
    await setSettingValue("mailgun.plan", "foundation");
    await setSettingValue("mailgun.logRetentionDays", 5);
    try {
      expect((await rt.loadReplyTest(new Date(Date.now() + 26 * HOUR))).facts.get(OUTLOOK)).not.toHaveProperty("reportGone");
      expect((await rt.loadReplyTest(new Date(Date.now() + 6 * 24 * HOUR))).facts.get(OUTLOOK)).toMatchObject({ reportGone: true });
    } finally {
      await setSettingValue("mailgun.plan", "free");
      await setSettingValue("mailgun.logRetentionDays", 1);
    }
  });

  it("an unsubscribe click that only came back through Mailgun's list: Remove and click again once its report is gone", async () => {
    const gmail = await replyTestEmail(GMAIL, true);
    await replyTestEmail(OUTLOOK, true);
    const clickedAt = new Date(gmail.sentAt.getTime() + 60_000);
    await dbWrite((c) =>
      c.mailEvent.create({
        data: {
          dedupeKey: `sup:unsubscribes:${GMAIL}:${clickedAt.toISOString()}`,
          type: "unsubscribed",
          occurredAt: clickedAt,
          messageId: null,
          recipient: GMAIL,
          isTestMode: false,
          source: "LOGS",
          raw: {},
        },
      }),
    );
    const soon = await rt.loadReplyTest(new Date(Date.now() + 2 * HOUR));
    expect(soon.unsubscribeSeen).toBe(false);
    expect(soon.verdict.missing).toContain(REPLY_TEST_TEXTS.unsubscribe);
    const later = await rt.loadReplyTest(new Date(Date.now() + 26 * HOUR));
    expect(later.verdict.missing).toContain(OWN_REPLY_TEST_TEXTS.unsubscribeGone);
    expect(later.verdict.missing).not.toContain(REPLY_TEST_TEXTS.unsubscribe);
    // A click linked to a test email (its report arrived) counts as always.
    await dbWrite((c) =>
      c.mailEvent.create({
        data: { dedupeKey: "rt-unsub", type: "unsubscribed", occurredAt: clickedAt, recipient: GMAIL, testSendId: gmail.id, isTestMode: false, source: "LOGS", raw: {} },
      }),
    );
    const seen = await rt.loadReplyTest(new Date(Date.now() + 26 * HOUR));
    expect(seen.unsubscribeSeen).toBe(true);
    expect(seen.verdict.missing).not.toContain(OWN_REPLY_TEST_TEXTS.unsubscribeGone);
  });
});

describe("the live test after a gap longer than Mailgun's logs", () => {
  it("'wait a few minutes' within the logs' reach; 'send one more live campaign' past it", async () => {
    await liveTestWithoutReport();
    const soon = await rt.loadGateInputs(new Date(Date.now() + 2 * HOUR));
    expect(soon).toMatchObject({ liveTest: "sent", liveTestReportGone: false });
    expect(rt.goLiveBlockersFor(soon)).toContain(MODE_GATE_TEXTS.liveTestSent);
    const later = await rt.loadGateInputs(new Date(Date.now() + 26 * HOUR));
    expect(later).toMatchObject({ liveTest: "sent", liveTestReportGone: true });
    const blockers = rt.goLiveBlockersFor(later);
    expect(blockers).toContain(OWN_MAILBOX_TEXTS.liveTestGone);
    expect(blockers).not.toContain(MODE_GATE_TEXTS.liveTestSent);
  });

  it("no live test at all stays 'send one live campaign first'", async () => {
    const gate = await rt.loadGateInputs(new Date(Date.now() + 26 * HOUR));
    expect(gate).toMatchObject({ liveTest: "none", liveTestReportGone: false });
    expect(rt.goLiveBlockersFor(gate)).toContain(MODE_GATE_TEXTS.liveTestNoneOwn);
  });
});
