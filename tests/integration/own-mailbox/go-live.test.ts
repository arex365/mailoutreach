import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckStatus, ChecklistGroup, ChecklistRowKey } from "@/core/system-state";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { makeCompany } from "../campaigns/seed";
import { addSenderAddress, makeUser, setSettingValue } from "../mailgun-setup/helpers";

/**
 * Going live in own-mailbox mode (MAIN-DOMAIN-DESIGN O14, O15, O20, O21, §3.4, §8 P4) against the fake Mailgun on
 * example.com (US, Free, `receivesMail: false`) with no public address: the blockers need no reply route and no
 * webhooks or remote access; `goLive()` refuses without the replies tick, then without the http-links tick while the
 * https-links row isn't "ok", then without the spam tick; with them it goes live, records contact@ as
 * `sending.goLiveFrom` and the ticks in the activity; the view carries the own-mailbox part; a change of the way of
 * sending or of the plan between the check and the switch refuses.
 */

/** Runs once right after goLive() loaded its gate inputs (the "changed meanwhile" cases). */
const hooks = vi.hoisted(() => ({ afterGate: null as null | (() => Promise<void>) }));
vi.mock("@/server/services/reply-test", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/server/services/reply-test")>();
  return {
    ...orig,
    loadGateInputs: async (now?: Date) => {
      const gate = await orig.loadGateInputs(now);
      const after = hooks.afterGate;
      hooks.afterGate = null;
      if (after) await after();
      return gate;
    },
  };
});

const D = "example.com";
const FROM = "contact@example.com";
const OUTLOOK = "t.outlook@outlook.com";

const t = await createTestDb("own-mailbox-go-live");
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
const { GoLiveError, goLive, loadGoLiveView } = await import("@/server/services/go-live");
const { goLiveBlockersFor, loadGateInputs } = await import("@/server/services/reply-test");
const { GO_LIVE_COPY } = await import("@/core/sending/go-live-copy");
const { MODE_GATE_TEXTS } = await import("@/core/sending/mode-gates");
const { goLiveCardView } = await import("@/components/settings/sending/go-live-view");

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

/** A fresh own-mailbox check: every row ok, except the Free plan's and no-public-address "info" rows. */
async function freshOwnCheck(statuses: Partial<Record<ChecklistRowKey, CheckStatus>> = {}): Promise<void> {
  const base: Partial<Record<ChecklistRowKey, CheckStatus>> = { "https-links": "info", webhooks: "info", "remote-access": "info", "monthly-limit": "info" };
  const rows = OWN_ROWS.map(([key, group]) => ({
    key,
    group,
    status: statuses[key] ?? base[key] ?? "ok",
    title: `Row ${key}`,
    text: `Text of ${key}`,
    fix: null,
    records: [],
    detail: null,
  }));
  await setState("domain.check", { domain: D, region: "US", checkedAt: new Date().toISOString(), lastVerifyAt: null, rows, error: null, replies: "own-mailbox" });
}

async function holdLease(at: Date): Promise<void> {
  await dbWrite((c) =>
    c.workerLease.upsert({ where: { id: 1 }, create: { id: 1, workerId: "own-go-live", heartbeatAt: at, startedAt: at }, update: { heartbeatAt: at, startedAt: at } }),
  );
}

let owner: { id: number; name: string };
let n = 0;

/** A finished LIVE campaign From contact@ with no Reply-To, its email to the test mailbox SENT and delivered (the live test). */
async function ownLiveTest(companyId: number, personId: number): Promise<void> {
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
  const recipient = await dbWrite((c) => c.campaignRecipient.create({ data: { campaignId: campaign.id, companyId, personId, emailNorm: OUTLOOK, state: "FINISHED" } }));
  const messageId = `pp.live${n}@${D}`;
  const email = await dbWrite((c) =>
    c.outboundEmail.create({
      data: {
        campaignId: campaign.id,
        recipientId: recipient.id,
        personId,
        companyId,
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
  await dbWrite((c) =>
    c.mailEvent.create({
      data: { dedupeKey: `live-ev-${n}`, type: "delivered", occurredAt: new Date(at.getTime() + 60_000), messageId, recipient: OUTLOOK, outboundEmailId: email.id, source: "LOGS", raw: {}, processedAt: new Date() },
    }),
  );
}

async function goLiveActivities() {
  return db.activityLog.findMany({ where: { type: "sending.goLive" }, orderBy: { id: "asc" } });
}

beforeAll(async () => {
  owner = await makeUser("Arslan", { role: "OWNER", replyInbox: "arslan.owner@gmail.com" });
  // A teammate with a broken route left from another setup: own-mailbox mode never asks for routes (O9).
  const ali = await makeUser("Ali");
  await addSenderAddress(ali.id, mg.domainId, "ali", "error");
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.testList", [OUTLOOK]);
  await setSettingValue("mailgun.unsubscribeTest", {
    setup: "A",
    status: "passed",
    domain: D,
    mailboxes: [{ address: OUTLOOK, provider: "microsoft", inboxOk: true, authOk: null, authFromHeaders: false, placementOk: false, dmarcOk: "pass", dmarcFromHeaders: false }],
    headersOk: true,
    decidedAt: new Date().toISOString(),
    decidedById: owner.id,
    note: null,
    from: FROM,
    replies: "own-mailbox",
    mailtoArrived: true,
  });
  const { company, people } = await makeCompany({ name: "Test mailboxes", people: [{ name: "Tess", email: OUTLOOK }] });
  await ownLiveTest(company.id, people[0]!.id);
});

beforeEach(async () => {
  hooks.afterGate = null;
  await setSettingValue("sending.goLive", false);
  await setSettingValue("sending.goLiveAt", null);
  await setSettingValue("sending.goLiveDomain", null);
  await setSettingValue("sending.goLiveFrom", null);
  await setSettingValue("mailgun.plan", "free");
  await setSettingValue("mailgun.replies", "own-mailbox");
  await freshOwnCheck();
  await holdLease(new Date());
  await dbWrite(async (c) => {
    await c.activityLog.deleteMany({ where: { type: "sending.goLive" } });
    await c.notification.deleteMany({});
  });
});

afterAll(async () => {
  if (previousPub === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previousPub;
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("going live in own-mailbox mode", () => {
  it("no blockers without routes, webhooks or remote access; the view carries the own-mailbox part", async () => {
    const gate = await loadGateInputs();
    expect(gate).toMatchObject({ replies: "own-mailbox", ownFrom: FROM, publicAddressSet: false, httpsLinksOk: false, liveTest: "delivered", checkFresh: true });
    expect(gate.replyTestPassedOnDomain).toBe(true);
    expect(goLiveBlockersFor(gate)).toEqual([]);
    const view = await loadGoLiveView();
    expect(view).toMatchObject({ blockers: [], ownFromExample: null, from: null, ownMailbox: { from: FROM, domain: D, httpLinksTick: true } });
    expect(view.spamPlacements).toEqual(["Outlook.com (t.outlook@outlook.com)"]);
    const card = goLiveCardView(view, { timeZone: "Asia/Karachi", warmup: { startCap: 50, maxCap: 90, steps: 20 } });
    expect(card).toMatchObject({ state: "ready", ownMailboxTick: GO_LIVE_COPY.ownMailboxTick(FROM), httpLinksTick: GO_LIVE_COPY.httpLinksTick, guideLine: GO_LIVE_COPY.guideLineOwn });
    expect(card.dialogItems).toContain(GO_LIVE_COPY.dialogOwnMailboxItem(FROM, D));
  });

  it("a bad from-mx row or a stale check blocks (the rows' words)", async () => {
    await freshOwnCheck({ "from-mx": "bad" });
    expect(goLiveBlockersFor(await loadGateInputs())).toEqual(["Row from-mx: not done yet (Domain checklist)."]);
    await setState("domain.check", { domain: D, region: "US", checkedAt: new Date().toISOString(), lastVerifyAt: null, rows: [], error: null, replies: "app" });
    const other = goLiveBlockersFor(await loadGateInputs());
    // A check made for the other way of sending isn't fresh, and its rows don't count (O36).
    expect(other[0]).toBe(MODE_GATE_TEXTS.checkStale);
    expect(other).toContain(`${"Mail servers know your policy (DMARC)"}: not done yet (Domain checklist).`);
  });

  it("refuses without the replies tick, then without the http-links tick, then without the spam tick; nothing written", async () => {
    await expect(goLive(owner, {})).rejects.toThrow(new GoLiveError(GO_LIVE_COPY.ownMailboxRequired));
    await expect(goLive(owner, { confirmOwnMailbox: true })).rejects.toThrow(new GoLiveError(GO_LIVE_COPY.httpLinksRequired));
    await expect(goLive(owner, { confirmOwnMailbox: true, confirmHttpLinks: true })).rejects.toThrow(new GoLiveError(GO_LIVE_COPY.spamPlacementRequired));
    expect(await getSetting("sending.goLive")).toBe(false);
    expect(await goLiveActivities()).toHaveLength(0);
  });

  it("with the ticks: live, contact@ as sending.goLiveFrom, the ticks in the activity, warm-up from 50", async () => {
    const res = await goLive(owner, { confirmOwnMailbox: true, confirmHttpLinks: true, confirmSpamPlacement: true });
    expect(res.alreadyLive).toBe(false);
    expect(await getSetting("sending.goLive")).toBe(true);
    expect(await getSetting("sending.goLiveFrom")).toBe(FROM);
    expect(await getSetting("sending.goLiveDomain")).toBe(D);
    const [activity] = await goLiveActivities();
    expect(activity!.data).toMatchObject({
      domain: D,
      from: FROM,
      replies: "own-mailbox",
      ownMailboxConfirmed: true,
      httpLinksConfirmed: true,
      spamPlacementConfirmed: true,
    });
    const note = await db.notification.findFirstOrThrow({ where: { type: "sending.wentLive", userId: owner.id } });
    expect(note.body).toBe(GO_LIVE_COPY.notificationBody(owner.name, 50));
    // Live: the card shows the own From line.
    const card = goLiveCardView(await loadGoLiveView(), { timeZone: "Asia/Karachi", warmup: { startCap: 50, maxCap: 90, steps: 20 } });
    expect(card.fromLine).toBe(GO_LIVE_COPY.liveOwnFromLine(FROM));
  });

  it("with https links ok, the http-links tick isn't needed", async () => {
    await freshOwnCheck({ "https-links": "ok" });
    const view = await loadGoLiveView();
    expect(view.ownMailbox).toEqual({ from: FROM, domain: D, httpLinksTick: false });
    const res = await goLive(owner, { confirmOwnMailbox: true, confirmSpamPlacement: true });
    expect(res.alreadyLive).toBe(false);
    const [activity] = await goLiveActivities();
    expect(activity!.data).toMatchObject({ ownMailboxConfirmed: true, httpLinksConfirmed: false });
  });

  it("a change of the way of sending between the check and the switch refuses, and nothing is written", async () => {
    hooks.afterGate = async () => setSettingValue("mailgun.replies", "app");
    await expect(goLive(owner, { confirmOwnMailbox: true, confirmHttpLinks: true, confirmSpamPlacement: true })).rejects.toThrow(
      new GoLiveError(GO_LIVE_COPY.changed),
    );
    expect(await getSetting("sending.goLive")).toBe(false);
    expect(await goLiveActivities()).toHaveLength(0);
  });

  it("a plan change between the check and the switch refuses too", async () => {
    hooks.afterGate = async () => setSettingValue("mailgun.plan", "foundation");
    await expect(goLive(owner, { confirmOwnMailbox: true, confirmHttpLinks: true, confirmSpamPlacement: true })).rejects.toThrow(
      new GoLiveError(GO_LIVE_COPY.changed),
    );
    expect(await getSetting("sending.goLive")).toBe(false);
  });
});
