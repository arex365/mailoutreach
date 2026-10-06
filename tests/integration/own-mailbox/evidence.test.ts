import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CheckStatus, ChecklistGroup, ChecklistRowKey } from "@/core/system-state";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { makeCompany } from "../campaigns/seed";
import { makeUser, setSettingValue, writeDomainCheck } from "../mailgun-setup/helpers";

/**
 * Evidence belongs to one way of sending (MAIN-DOMAIN-DESIGN O15, O36, §8 P4): a shared-From pass and live test on
 * send.example.com count in shared-From mode; after the switch to own-mailbox mode on example.com (settings written as
 * the connect would) the reply test is "not tested", the live test "none" and going live blocked, even with the old pass
 * still stored; new own-mailbox evidence (a pass decided in this mode, a live campaign From contact@ with no Reply-To,
 * reply-test emails of the own From) counts; and after a same-domain mode switch the old mode's stored checklist rows
 * are left out of every gate and the page says "not checked yet" until the next check.
 */

vi.mock("server-only", () => ({}));

const SHARED_D = "send.example.com";
const D = "example.com";
const FROM = "contact@example.com";
const OUTLOOK = "t.outlook@outlook.com";
const GMAIL = "t.gmail@gmail.com";

const t = await createTestDb("own-mailbox-evidence");
const previousPub = process.env.APP_PUBLIC_URL;
delete process.env.APP_PUBLIC_URL;
const mg: FakeConnection = await connectFakeMailgun({ domain: D, region: "US", fake: { domain: D, region: "US", plan: "free", receivesMail: false } });
const { db, dbWrite } = await import("@/server/db");
const { setState } = await import("@/server/state");
const rt = await import("@/server/services/reply-test");
const { loadDomainPage } = await import("@/app/(app)/settings/domain/load");
const { MODE_GATE_TEXTS } = await import("@/core/sending/mode-gates");

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

async function ownCheck(replies: "own-mailbox" | "app" = "own-mailbox"): Promise<void> {
  const info: Partial<Record<ChecklistRowKey, CheckStatus>> = { "https-links": "info", webhooks: "info", "remote-access": "info" };
  const rows = OWN_ROWS.map(([key, group]) => ({ key, group, status: info[key] ?? "ok", title: `Row ${key}`, text: "", fix: null, records: [], detail: null }));
  await setState("domain.check", { domain: D, region: "US", checkedAt: new Date().toISOString(), lastVerifyAt: null, rows, error: null, replies });
}

let owner: { id: number; name: string; email: string };
let tess: { companyId: number; personId: number };
let sharedDomainId = 0;
let n = 0;

/** A finished LIVE campaign on a domain with one SENT, delivered email to the Outlook.com test mailbox. */
async function liveCampaign(o: { domainId: number; replyTo: string | null; fromAddress: string; launchedAt?: Date }): Promise<void> {
  n += 1;
  const at = o.launchedAt ?? new Date();
  const campaign = await dbWrite((c) =>
    c.campaign.create({
      data: {
        name: `Live test ${n}`,
        createdById: owner.id,
        senderId: owner.id,
        mode: "LIVE",
        status: "FINISHED",
        sendingDomainId: o.domainId,
        fromName: "Arslan from Polygon Paradise",
        fromAddress: o.fromAddress,
        replyTo: o.replyTo,
        launchedAt: at,
        launchedGoLive: false,
      },
    }),
  );
  const recipient = await dbWrite((c) =>
    c.campaignRecipient.create({ data: { campaignId: campaign.id, companyId: tess.companyId, personId: tess.personId, emailNorm: OUTLOOK, state: "FINISHED" } }),
  );
  const messageId = `pp.ev${n}@${o.domainId === sharedDomainId ? SHARED_D : D}`;
  const email = await dbWrite((c) =>
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
        fromAddress: `Arslan from Polygon Paradise <${o.fromAddress}>`,
        replyTo: o.replyTo,
        subject: "Live test",
        text: "t",
        html: "h",
        messageId,
        sendId: `ev-${n}`,
        dueAt: at,
        status: "SENT",
        claimedAt: at,
        sentAt: at,
        providerId: messageId,
      },
    }),
  );
  await dbWrite((c) =>
    c.mailEvent.create({
      data: { dedupeKey: `ev-${n}`, type: "delivered", occurredAt: new Date(at.getTime() + 60_000), messageId, recipient: OUTLOOK, outboundEmailId: email.id, source: "LOGS", raw: {}, processedAt: new Date() },
    }),
  );
}

/** A delivered reply-test email to a test mailbox, recorded with the From it showed. */
async function replyTestEmail(to: string, teamFrom: string | null, domain: string): Promise<number> {
  n += 1;
  const row = await dbWrite((c) =>
    c.testSend.create({
      data: { userId: owner.id, to, subject: "Reply test", mode: "TEST", purpose: "REPLY_TEST", status: "SENT", messageId: `pp.t.${n}.abc@${domain}`, teamFrom, sentAt: new Date() },
    }),
  );
  await dbWrite((c) =>
    c.mailEvent.create({ data: { dedupeKey: `rt-${n}`, type: "delivered", occurredAt: new Date(), recipient: to, testSendId: row.id, isTestMode: false, source: "LOGS", raw: {} } }),
  );
  return row.id;
}

async function page() {
  const p = await loadDomainPage({ id: owner.id, email: owner.email, name: owner.name, role: "OWNER", timeZone: "Asia/Karachi", sessionId: 1 });
  if (p.state !== "connected") throw new Error(p.state);
  return p;
}

beforeAll(async () => {
  owner = await makeUser("Arslan", { role: "OWNER", replyInbox: "arslan.owner@gmail.com" });
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.testList", [OUTLOOK, GMAIL]);
  const { company, people } = await makeCompany({ name: "Test mailboxes", people: [{ name: "Tess", email: OUTLOOK }] });
  tess = { companyId: company.id, personId: people[0]!.id };
  // Shared-From mode on send.example.com (the Shape B setup), settings written as the connect would.
  const shared = await dbWrite(async (c) => {
    await c.sendingDomain.updateMany({ data: { active: false } });
    return c.sendingDomain.create({ data: { name: SHARED_D, region: "US", active: true } });
  });
  sharedDomainId = shared.id;
  await setSettingValue("mailgun.domain", SHARED_D);
  await setSettingValue("mailgun.fromAddress", FROM);
});

afterAll(async () => {
  if (previousPub === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previousPub;
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("evidence belongs to one way of sending (O15)", () => {
  it("shared-From mode: its pass and live test count", async () => {
    await writeDomainCheck(SHARED_D, { "from-mx": "ok", "from-spf": "ok" });
    await setSettingValue("mailgun.unsubscribeTest", {
      setup: "A",
      status: "passed",
      domain: SHARED_D,
      mailboxes: [],
      headersOk: true,
      decidedAt: new Date().toISOString(),
      decidedById: owner.id,
      note: null,
      from: FROM,
    });
    await liveCampaign({ domainId: sharedDomainId, replyTo: `arslan@${SHARED_D}`, fromAddress: FROM });
    const gate = await rt.loadGateInputs();
    expect(gate).toMatchObject({ replies: "app", teamFrom: FROM, evidenceFrom: FROM, ownFrom: null, replyTestPassedOnDomain: true, liveTest: "delivered" });
  });

  it("after the switch to own-mailbox mode on example.com: not tested, no live test, go-live blocked (the old pass still stored)", async () => {
    await dbWrite(async (c) => {
      await c.sendingDomain.updateMany({ data: { active: false } });
      await c.sendingDomain.update({ where: { id: mg.domainId }, data: { active: true } });
    });
    await setSettingValue("mailgun.domain", D);
    await setSettingValue("mailgun.replies", "own-mailbox");
    // restartEvidence: the connect re-writes the From row, so evidence counts from now.
    await setSettingValue("mailgun.fromAddress", FROM);
    await ownCheck();
    const data = await rt.loadReplyTest();
    expect(data).toMatchObject({ ownMailbox: true, evidenceFrom: FROM, decided: null });
    expect(data.verdict.status).toBe("incomplete");
    expect(data.gate).toMatchObject({ replies: "own-mailbox", ownFrom: FROM, teamFrom: null, replyTestPassedOnDomain: false, liveTest: "none" });
    const blockers = rt.goLiveBlockersFor(data.gate);
    expect(blockers).toContain(MODE_GATE_TEXTS.replyTestNotPassed);
    // Review SCREENS-11: the own guide's live-test step.
    expect(blockers).toContain(MODE_GATE_TEXTS.liveTestNoneOwn);
    // Even a stored app-mode pass for this very domain and From wouldn't count here (it belongs to app mode).
    await setSettingValue("mailgun.unsubscribeTest", { setup: "A", status: "passed", domain: D, mailboxes: [], headersOk: true, decidedAt: new Date().toISOString(), decidedById: owner.id, note: null, from: FROM });
    expect((await rt.loadGateInputs()).replyTestPassedOnDomain).toBe(false);
    expect((await rt.loadReplyTest()).decided).toBeNull();
  });

  it("new own-mailbox evidence counts: reply-test emails of the own From, a pass decided in this mode, a live campaign with no Reply-To", async () => {
    const perPerson = await replyTestEmail(OUTLOOK, null, D);
    const own = await replyTestEmail(GMAIL, FROM, D);
    let data = await rt.loadReplyTest();
    expect(data.countedTestSendIds).toEqual([own]);
    expect(data.countedTestSendIds).not.toContain(perPerson);
    expect(data.facts.get(GMAIL)).toMatchObject({ testSendId: own, delivered: true, replyStored: false });
    expect(data.facts.get(OUTLOOK)).toMatchObject({ testSendId: null, olderSent: true });

    await setSettingValue("mailgun.unsubscribeTest", {
      setup: "A",
      status: "passed",
      domain: D,
      mailboxes: [],
      headersOk: true,
      decidedAt: new Date().toISOString(),
      decidedById: owner.id,
      note: null,
      from: FROM,
      replies: "own-mailbox",
    });
    data = await rt.loadReplyTest();
    expect(data.decided).toMatchObject({ status: "passed" });
    expect(data.gate.replyTestPassedOnDomain).toBe(true);

    // A live campaign with a Reply-To (shared-From style) or another From never counts; the own one does.
    await liveCampaign({ domainId: mg.domainId, replyTo: `arslan@${SHARED_D}`, fromAddress: FROM });
    await liveCampaign({ domainId: mg.domainId, replyTo: null, fromAddress: "info@example.com" });
    expect((await rt.loadGateInputs()).liveTest).toBe("none");
    await liveCampaign({ domainId: mg.domainId, replyTo: null, fromAddress: FROM });
    const gate = await rt.loadGateInputs();
    expect(gate.liveTest).toBe("delivered");
    expect(rt.goLiveBlockersFor(gate)).not.toContain(MODE_GATE_TEXTS.liveTestNoneOwn);
    expect(rt.goLiveBlockersFor(gate)).not.toContain(MODE_GATE_TEXTS.replyTestNotPassed);
    expect(await rt.loadLiveTest(mg.domainId, [OUTLOOK], { since: gate.teamFromChangedAt, ownFrom: null })).toBe("none");
  });

  it("a same-domain mode switch leaves the old mode's stored rows out of every gate until the next check (O36)", async () => {
    await ownCheck("own-mailbox");
    const own = await rt.loadGateInputs();
    expect(own.rows.length).toBeGreaterThan(0);
    expect(own.checkFresh).toBe(true);

    await setSettingValue("mailgun.replies", "app");
    const app = await rt.loadGateInputs();
    expect(app.replies).toBe("app");
    expect(app.rows).toEqual([]);
    expect(app.checkFresh).toBe(false);
    expect(app.httpsLinksOk).toBe(false);
    // The own-mailbox pass never counts in app mode.
    expect(app.replyTestPassedOnDomain).toBe(false);
    expect(rt.modeBlockersFor("LIVE", app)).toContain(MODE_GATE_TEXTS.dns);
    expect(rt.goLiveBlockersFor(app)).toContain(MODE_GATE_TEXTS.checkStale);
    expect(rt.replyTestBlockersFor(app)).toContain(MODE_GATE_TEXTS.dns);
    const p = await page();
    expect(p.rows).toEqual([]);
    expect(p.headerLine).toContain("not checked yet");

    // The next check (made for app mode) counts again; switching back leaves those rows out in turn.
    await ownCheck("app");
    expect((await rt.loadGateInputs()).rows.length).toBeGreaterThan(0);
    await setSettingValue("mailgun.replies", "own-mailbox");
    const back = await rt.loadGateInputs();
    expect(back.rows).toEqual([]);
    expect(back.checkFresh).toBe(false);
    expect(rt.replyTestBlockersFor(back)).toContain(MODE_GATE_TEXTS.dmarcFirst);
    expect((await page()).headerLine).toContain("not checked yet");
  });
});
