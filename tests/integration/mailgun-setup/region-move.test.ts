import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { startFakeMailgun, type FakeMailgun } from "../../fake-mailgun/server";
import { makeCompany } from "../campaigns/seed";
import { makeUser, setSettingValue } from "./helpers";

/**
 * Review SETTING-1: a region-only move (the same sending domain name in the other region, F28) keeps the domain name
 * and its SendingDomain row, which the reply test's and the live test's evidence filters key on. The move now also
 * moves the moment evidence counts from (`loadTeamFrom().changedAt`, F26), so reply-test emails, a delivered live test
 * and a checklist check from the old region no longer count, in both modes, while the From address itself is kept as it
 * was. The message says so, and says that the old region's late reports can't reach the app any more.
 */

const t = await createTestDb("mg-region-move");
const { db, dbWrite } = await import("@/server/db");
const connect = await import("@/server/services/mailgun/connect");
const rt = await import("@/server/services/reply-test");
const { loadTeamFrom } = await import("@/server/services/mailgun/team-from");
const { getSetting } = await import("@/server/settings");

const deps = { retryDelayMs: () => 0 };
const DOMAIN = "send.example.com";
const OUTLOOK = "t.outlook@outlook.com";
const previousBase = process.env.OUTREACH_MAILGUN_BASE_URL;
let eu: FakeMailgun;
let us: FakeMailgun;
let owner: { id: number; name: string };
let mailbox: { companyId: number; personId: number };
let n = 0;

async function connectIn(region: "EU" | "US", apiKey: string | null = null) {
  process.env.OUTREACH_MAILGUN_BASE_URL = (region === "EU" ? eu : us).origin;
  return connect.connectMailgun(owner, { region, domain: DOMAIN, apiKey }, deps);
}

const minuteAgo = () => new Date(Date.now() - 60_000);

/** A delivered reply-test email to the Outlook.com test mailbox (per-person unless `teamFrom` is given). */
async function replyTestEmail(sentAt: Date, teamFrom: string | null = null) {
  n += 1;
  const messageId = `pp.t.${n}.abc${n}@${DOMAIN}`;
  const send = await dbWrite((c) =>
    c.testSend.create({ data: { userId: owner.id, to: OUTLOOK, subject: "Reply test", mode: "LIVE", purpose: "REPLY_TEST", messageId, sentAt, teamFrom } }),
  );
  await dbWrite((c) =>
    c.mailEvent.create({ data: { dedupeKey: `rt-${n}`, type: "delivered", occurredAt: new Date(), recipient: OUTLOOK, testSendId: send.id, isTestMode: false, source: "WEBHOOK", raw: {} } }),
  );
  return send;
}

/** A finished per-person LIVE campaign with one delivered email to the test mailbox (the live test, M6 §0.3). */
async function liveTest(domainId: number, launchedAt: Date) {
  n += 1;
  const from = `arslan@${DOMAIN}`;
  const campaign = await dbWrite((c) =>
    c.campaign.create({
      data: {
        name: `Live test ${n}`,
        createdById: owner.id,
        senderId: owner.id,
        mode: "LIVE",
        status: "FINISHED",
        sendingDomainId: domainId,
        fromName: "Arslan from Polygon Paradise",
        fromAddress: from,
        replyTo: null,
        launchedAt,
        launchedGoLive: false,
      },
    }),
  );
  const recipient = await dbWrite((c) =>
    c.campaignRecipient.create({ data: { campaignId: campaign.id, companyId: mailbox.companyId, personId: mailbox.personId, emailNorm: OUTLOOK, state: "FINISHED" } }),
  );
  const messageId = `pp.live${n}@${DOMAIN}`;
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
        fromAddress: `Arslan from Polygon Paradise <${from}>`,
        replyTo: null,
        subject: "Live test",
        text: "t",
        html: "h",
        messageId,
        sendId: `live-${n}`,
        dueAt: launchedAt,
        status: "SENT",
        claimedAt: launchedAt,
        sentAt: launchedAt,
        providerId: messageId,
      },
    }),
  );
  await dbWrite((c) =>
    c.mailEvent.create({
      data: {
        dedupeKey: `live-ev-${n}`,
        type: "delivered",
        occurredAt: new Date(),
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

/** The live test exactly as the gates ask for it (loadGateInputs). */
async function liveTestNow(domainId: number) {
  const team = await loadTeamFrom();
  return rt.loadLiveTest(domainId, [OUTLOOK], { teamFrom: team.address, since: team.changedAt });
}

beforeAll(async () => {
  eu = await startFakeMailgun({ domain: DOMAIN, region: "EU" });
  us = await startFakeMailgun({ domain: DOMAIN, region: "US" });
  const o = await makeUser("Arslan", { role: "OWNER", replyInbox: "arslan.owner@gmail.com" });
  owner = { id: o.id, name: o.name };
  expect((await connectIn("EU", "key-fake-api")).ok).toBe(true);
  await setSettingValue("sending.testList", [OUTLOOK]);
  const { company, people } = await makeCompany({ name: "Test mailboxes", people: [{ name: "Tess", email: OUTLOOK }] });
  mailbox = { companyId: company.id, personId: people[0]!.id };
});

afterAll(async () => {
  if (previousBase === undefined) delete process.env.OUTREACH_MAILGUN_BASE_URL;
  else process.env.OUTREACH_MAILGUN_BASE_URL = previousBase;
  await Promise.all([eu.close(), us.close()]);
  await db.$disconnect();
  t.cleanup();
});

describe("a region-only move restarts the evidence (review SETTING-1)", () => {
  it("per-person mode: the EU region's reply-test email and live test stop counting; the From stays empty", async () => {
    const row = await db.sendingDomain.findUniqueOrThrow({ where: { name: DOMAIN } });
    const send = await replyTestEmail(minuteAgo());
    await liveTest(row.id, minuteAgo());
    // Before the move both count (per-person mode, no From change ever: changedAt is null).
    expect((await loadTeamFrom()).changedAt).toBeNull();
    expect((await rt.loadReplyTest()).facts.get(OUTLOOK)).toMatchObject({ testSendId: send.id, delivered: true });
    expect(await liveTestNow(row.id)).toBe("delivered");

    const before = Date.now();
    const res = await connectIn("US");
    expect(res.ok).toBe(true);
    // The owner hears what the move means for the tests and for the old region's reports.
    if (res.ok) expect(res.message).toContain(connect.regionMovedText("EU"));
    expect(connect.regionMovedText("EU")).toBe(
      "Emails sent through the EU region no longer count for the reply test or the live test: run both again. Late bounces, complaints and unsubscribes of those emails can't reach the app any more: if someone asks to be removed, add them in Settings › Deliverability.",
    );

    // Same row, same name: only the evidence moment tells the regions apart.
    expect(await db.sendingDomain.findUniqueOrThrow({ where: { name: DOMAIN } })).toMatchObject({ id: row.id, region: "US" });
    const team = await loadTeamFrom();
    expect(team).toMatchObject({ address: null, saved: null });
    expect(team.changedAt!.getTime()).toBeGreaterThanOrEqual(before - 5);
    expect(await getSetting("mailgun.fromAddress")).toBeNull();

    expect((await rt.loadReplyTest()).facts.get(OUTLOOK)).toMatchObject({ testSendId: null, delivered: false, olderSent: true });
    expect(await liveTestNow(row.id)).toBe("none");
    expect((await rt.loadGateInputs()).liveTest).toBe("none");

    // Evidence made after the move counts again.
    const later = new Date(team.changedAt!.getTime() + 1_000);
    const fresh = await replyTestEmail(later);
    await liveTest(row.id, later);
    expect((await rt.loadReplyTest()).facts.get(OUTLOOK)).toMatchObject({ testSendId: fresh.id, delivered: true });
    expect(await liveTestNow(row.id)).toBe("delivered");
  });

  it("a Domain checklist check made before the move is too old to go live on", async () => {
    const team = await loadTeamFrom();
    const check = { domain: DOMAIN, checkedAt: new Date(team.changedAt!.getTime() - 1_000).toISOString(), error: null };
    expect(rt.isCheckFresh(check, DOMAIN, null, new Date(), team.changedAt)).toBe(false);
    const after = { ...check, checkedAt: new Date(team.changedAt!.getTime() + 1_000).toISOString() };
    expect(rt.isCheckFresh(after, DOMAIN, null, new Date(team.changedAt!.getTime() + 2_000), team.changedAt)).toBe(true);
  });

  it("shared-From mode: the From address is kept as it was, and its evidence from the old region stops counting too", async () => {
    await setSettingValue("mailgun.fromAddress", "contact@example.com");
    const changedAt = (await loadTeamFrom()).changedAt!;
    const send = await replyTestEmail(new Date(changedAt.getTime() + 1), "contact@example.com");
    expect((await rt.loadReplyTest()).facts.get(OUTLOOK)).toMatchObject({ testSendId: send.id });

    await new Promise((r) => setTimeout(r, 20));
    expect((await connectIn("EU")).ok).toBe(true);
    expect(await getSetting("mailgun.fromAddress")).toBe("contact@example.com");
    expect((await loadTeamFrom()).address).toBe("contact@example.com");
    expect((await loadTeamFrom()).changedAt!.getTime()).toBeGreaterThan(send.sentAt.getTime());
    expect((await rt.loadReplyTest()).facts.get(OUTLOOK)).toMatchObject({ testSendId: null, olderSent: true });
    // Only the move is logged: the From address didn't change, so there is no From change activity.
    expect(await db.activityLog.count({ where: { type: "mailgun.fromAddressChanged" } })).toBe(0);
    expect(await db.activityLog.count({ where: { type: "mailgun.domainChanged" } })).toBe(2);
  });

  it("reconnecting in the same region changes nothing: the evidence moment stays", async () => {
    const before = (await loadTeamFrom()).changedAt!.getTime();
    await new Promise((r) => setTimeout(r, 20));
    const res = await connectIn("EU");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.message).not.toContain("no longer count");
    expect((await loadTeamFrom()).changedAt!.getTime()).toBe(before);
  });
});
