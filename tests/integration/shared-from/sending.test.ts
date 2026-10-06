import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChecklistRow } from "@/core/system-state";
import { TEAM_FROM_TEXTS } from "@/core/sending/from-address";
import { createTestDb } from "../helpers/test-db";
import { INBOUND_URL } from "../helpers/replies";
import { makeCompany, setSettingValue, type StepSeed } from "../campaigns/seed";
import { checklistRows, clearPacer, launchTo, resetSendingState, setupM3, tickDeps, worldClock, type M3World } from "../sending-m3/helpers";

/**
 * Every email's From and Reply-To in shared-From mode (docs/dev/SHARED-FROM-DESIGN.md §2.3, §2.4, §8 P1), through the
 * real launch, sending loop, reconciler, restore scan and reply processing against the fake Mailgun (send.example.com):
 * recipients see From "Ali from Polygon Paradise <contact@example.com>", replies go to Ali's own address (Reply-To),
 * and everything Mailgun-side stays on the one sending domain. Per-person campaigns in the same database are unchanged.
 */

const t = await createTestDb("shared-from-sending");
const { db, dbWrite } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");
const rec = await import("@/server/services/sending/reconcile");
const restore = await import("@/server/services/sending/restore");
const { getPauseState } = await import("@/server/services/sending/pause");
const { simulateReply } = await import("@/server/services/mail-events/simulate");
const { handleInboundWebhook } = await import("@/server/services/mail-events/webhook");
const { processPendingInbound } = await import("@/server/services/replies/process");
const { setState } = await import("@/server/state");
const { setSecret, deleteSecret } = await import("@/server/secrets");
const { CampaignError } = await import("@/server/services/campaigns/errors");
const { SENDER_HEADERS_PAUSE, AUTH_PAUSE_FIX, SENDING_KEY_TEAM_FROM_FIX } = await import("@/server/services/sending/mailgun-transport");

const TEAM = "contact@example.com";
const ALI = "ali@send.example.com";
const TEAM_LINE = `Ali from Polygon Paradise <${TEAM}>`;
const LIST = Array.from({ length: 10 }, (_, i) => `s${i}@team-${i}.de`);
const MIN = 60_000;
const FOLLOW_UP: StepSeed[] = [
  { step: 0, subject: "Hello", body: "First" },
  { step: 1, body: "Second", delayDays: 3 },
];

let world: M3World;

function fromMxRow(status: ChecklistRow["status"]): ChecklistRow {
  return { key: "from-mx", group: "dns", status, title: "Mail for example.com stays with your mail provider (MX)", text: "", fix: null, records: [], detail: null };
}

/** Shared-From mode on (the From address, a reply test passed with it, a green from-mx row) or off (per-person). */
async function useTeamFrom(on: boolean): Promise<void> {
  await setSettingValue("mailgun.fromAddress", on ? TEAM : null);
  await setSettingValue("mailgun.unsubscribeTest", {
    setup: "A",
    status: "passed",
    domain: world.mg.domain,
    mailboxes: [],
    headersOk: true,
    decidedAt: new Date().toISOString(),
    decidedById: world.owner.id,
    note: null,
    from: on ? TEAM : null,
  });
  const rows = [...checklistRows(), ...(on ? [fromMxRow("ok")] : [])];
  await setState("domain.check", { domain: world.mg.domain, region: "EU", checkedAt: new Date().toISOString(), lastVerifyAt: null, rows, error: null });
}

async function rowOf(campaignId: number, step = 0) {
  return db.outboundEmail.findFirstOrThrow({ where: { campaignId, step } });
}

async function aliAddressId(): Promise<number> {
  return (await db.senderAddress.findUniqueOrThrow({ where: { address: ALI } })).id;
}

beforeAll(async () => {
  world = await setupM3({ testList: LIST });
});

beforeEach(async () => {
  world.mg.fake.reset();
  await resetSendingState();
  await setSettingValue("sending.testList", LIST);
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.goLive", false);
  await useTeamFrom(true);
  await dbWrite(async (c) => {
    // Earlier tests' sent emails must not act as a later test's positive control.
    await c.outboundEmail.updateMany({ where: { status: "SENT" }, data: { sentAt: new Date("2020-01-01T00:00:00Z") } });
    await c.senderAddress.updateMany({ where: { address: ALI }, data: { routeStatus: "ok" } });
  });
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("the headers of every email", () => {
  it("test mode: the campaign and its row keep the team snapshot; Mailgun gets the team From, h:Reply-To and ids on the sending domain", async () => {
    await setSettingValue("sending.mode", "TEST");
    const clock = worldClock(world);
    const { campaignId } = await launchTo(world, [LIST[0]!], { now: clock.now() });
    expect(await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).toMatchObject({
      fromName: "Ali from Polygon Paradise",
      fromAddress: TEAM,
      replyTo: ALI,
      sendingDomainId: world.mg.domainId,
    });
    const row = await rowOf(campaignId);
    expect(row).toMatchObject({ fromAddress: TEAM_LINE, replyTo: ALI });
    expect(row.messageId).toMatch(/^pp\.[0-9a-f]{24}@send\.example\.com$/);

    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    const f = world.mg.fake.messages[0]!.fields;
    expect(f.from).toEqual([TEAM_LINE]);
    expect(f["h:Reply-To"]).toEqual([ALI]);
    expect(f["h:Message-Id"]).toEqual([`<${row.messageId}>`]);
    expect(f["o:testmode"]).toEqual(["yes"]);
    expect(world.mg.fake.requests.some((r) => r.path === "/v3/send.example.com/messages")).toBe(true);
    // The main domain is never a Mailgun path segment (§2.5).
    expect(world.mg.fake.requests.every((r) => !/\/example\.com(\/|$)/.test(r.path))).toBe(true);
  });

  it("live: the follow-up copies the From line and the Reply-To and threads to the first email; lastLiveSendAt by the campaign's domain", async () => {
    await dbWrite((c) => c.sendingDomain.update({ where: { id: world.mg.domainId }, data: { lastLiveSendAt: null } }));
    const clock = worldClock(world);
    const { campaignId } = await launchTo(world, [LIST[1]!], { now: clock.now(), steps: FOLLOW_UP });
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect((await db.sendingDomain.findUniqueOrThrow({ where: { id: world.mg.domainId } })).lastLiveSendAt).toEqual(clock.now());
    expect(await db.sendingDomain.count({ where: { name: "example.com" } })).toBe(0);

    const first = await rowOf(campaignId, 0);
    const next = await rowOf(campaignId, 1);
    expect(next).toMatchObject({ status: "QUEUED", fromAddress: TEAM_LINE, replyTo: ALI, inReplyTo: first.messageId });
    expect(next.messageId).toMatch(/@send\.example\.com$/);
    clock.set(next.dueAt);
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    const f = world.mg.fake.messages[1]!.fields;
    expect(f.from).toEqual([TEAM_LINE]);
    expect(f["h:Reply-To"]).toEqual([ALI]);
    expect(f["h:In-Reply-To"]).toEqual([`<${first.messageId}>`]);
    expect((await db.sendingDomain.findUniqueOrThrow({ where: { id: world.mg.domainId } })).lastLiveSendAt).toEqual(clock.now());
  });

  it("per-person campaigns are unchanged: From the sender's own address, no Reply-To; lastLiveSendAt still written", async () => {
    await useTeamFrom(false);
    await dbWrite((c) => c.sendingDomain.update({ where: { id: world.mg.domainId }, data: { lastLiveSendAt: null } }));
    const clock = worldClock(world);
    const { campaignId } = await launchTo(world, [LIST[2]!], { now: clock.now() });
    expect(await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).toMatchObject({ fromAddress: ALI, replyTo: null });
    expect(await rowOf(campaignId)).toMatchObject({ fromAddress: `Ali from Polygon Paradise <${ALI}>`, replyTo: null });
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    const f = world.mg.fake.messages[0]!.fields;
    expect(f.from).toEqual([`Ali from Polygon Paradise <${ALI}>`]);
    expect(f["h:Reply-To"]).toBeUndefined();
    expect((await db.sendingDomain.findUniqueOrThrow({ where: { id: world.mg.domainId } })).lastLiveSendAt).toEqual(clock.now());
  });
});

describe("replies reach the route address", () => {
  it("a live email waits while Ali's reply route isn't working, and goes once it works", async () => {
    const clock = worldClock(world);
    const { campaignId } = await launchTo(world, [LIST[3]!], { now: clock.now() });
    await dbWrite((c) => c.senderAddress.updateMany({ where: { address: ALI }, data: { routeStatus: "pending" } }));
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ sent: 0, waiting: { reason: "reply-route" } });
    expect(world.mg.fake.messages).toHaveLength(0);
    await dbWrite((c) => c.senderAddress.updateMany({ where: { address: ALI }, data: { routeStatus: "ok" } }));
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect((await rowOf(campaignId)).status).toBe("SENT");
  });

  it("a reply to the Reply-To (the fake's preset) is stored for Ali's address and, processed, stops the recipient and marks the company Replied", async () => {
    await setSettingValue("sending.goLive", true);
    try {
      const clock = worldClock(world);
      const email = "gina@team-golive.de";
      await makeCompany({ name: "Team go-live", people: [{ name: "Gina", email, verificationStatus: "VALID", verifiedAt: clock.now() }] });
      const { campaignId, companyIds } = await launchTo(world, [email], { now: clock.now(), steps: FOLLOW_UP });
      expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
      const sent = await rowOf(campaignId);

      const preset = world.mg.fake.receivePreset("reply", sent.messageId);
      if (!preset.stored) throw new Error("The reply should reach the fake Mailgun (Ali's route address).");
      expect(preset).toMatchObject({ to: ALI, target: "reply-to" });
      const res = await handleInboundWebhook(world.mg.fake.signedInboundRequest(INBOUND_URL, preset.fields), { now: world.mg.fake.now() });
      expect(res.status).toBe(200);
      const stored = await db.inboundMessage.findUniqueOrThrow({ where: { storageKey: preset.storageKey } });
      expect(stored).toMatchObject({ toAddress: ALI, senderAddressId: await aliAddressId() });

      await processPendingInbound({ now: clock.advance(MIN) });
      expect(await db.inboundMessage.findUniqueOrThrow({ where: { id: stored.id } })).toMatchObject({ kind: "REPLY", outboundEmailId: sent.id });
      expect((await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } })).state).toBe("STOPPED");
      expect((await db.company.findUniqueOrThrow({ where: { id: companyIds[0]! } })).status).toBe("REPLIED");
    } finally {
      await setSettingValue("sending.goLive", false);
    }
  });

  it("Simulate reply on a dry-run email is stored for the Reply-To address and Ali's SenderAddress", async () => {
    await setSettingValue("sending.mode", "DRY_RUN");
    const clock = worldClock(world);
    const { campaignId } = await launchTo(world, [LIST[4]!], { now: clock.now(), ignoreWindow: true });
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    const email = await rowOf(campaignId);
    expect(email).toMatchObject({ status: "SENT", fromAddress: TEAM_LINE, replyTo: ALI });
    expect(email.messageId).toMatch(/@dry-run\.invalid$/);
    await simulateReply({ id: world.owner.id, name: world.owner.name }, email.id, "reply", { now: clock.now() });
    const stored = await db.inboundMessage.findFirstOrThrow({ where: { source: "SIMULATED", inReplyTo: email.messageId } });
    expect(stored).toMatchObject({ toAddress: ALI, senderAddressId: await aliAddressId() });
    expect(world.mg.fake.messages).toHaveLength(0);
  });
});

describe("the reconciler and the restore scan", () => {
  it("an email whose answer was lost is confirmed by the reconciler through the Logs of the sending domain", async () => {
    const clock = worldClock(world);
    const { campaignId } = await launchTo(world, [LIST[5]!], { now: clock.now() });
    world.mg.fake.failNext("POST /v3/:d/messages", { kind: "acceptThenDrop" });
    expect((await loop.sendingTick(tickDeps(world, clock))).unknown).toBe(1);
    const lost = await rowOf(campaignId);
    expect(lost.status).toBe("UNKNOWN");
    const r = await rec.reconcileSends({ now: clock.advance(5 * MIN), mailgun: world.mailgun });
    expect(r).toMatchObject({ checked: 1, sent: 1, requeued: 0 });
    expect(await rowOf(campaignId)).toMatchObject({ status: "SENT", providerId: lost.messageId });
    expect(world.mg.fake.messages).toHaveLength(1);
    // The Logs searches name the sending domain in their filter, never the From address's domain (§2.3, §2.5).
    type LogsBody = { filter?: { AND?: Array<{ attribute: string; values: Array<{ value: string }> }> } };
    const searched = world.mg.fake.requests
      .filter((q) => q.path === "/v1/analytics/logs")
      .flatMap((q) => (q.body as LogsBody).filter?.AND ?? [])
      .filter((p) => p.attribute === "domain")
      .flatMap((p) => p.values.map((v) => v.value));
    expect(searched.length).toBeGreaterThan(0);
    expect([...new Set(searched)]).toEqual(["send.example.com"]);
  });

  it("a row the restore scan re-creates gets the campaign's From line and Reply-To, and so does its follow-up", async () => {
    const clock = worldClock(world);
    const restoredFrom = new Date(clock.now().getTime() + MIN);
    const known = await launchTo(world, [LIST[6]!], { now: clock.now(), steps: FOLLOW_UP });
    clock.advance(2 * MIN);
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    const sent = await rowOf(known.campaignId);
    // The backup didn't know these rows.
    await dbWrite(async (c) => {
      await c.outboundEmail.deleteMany({ where: { campaignId: known.campaignId } });
      await c.campaignRecipient.updateMany({ where: { campaignId: known.campaignId }, data: { state: "SCHEDULED", currentStep: 0 } });
    });
    await setState("restore", {
      status: "pending",
      restoredFrom: restoredFrom.toISOString(),
      scanFrom: new Date(clock.now().getTime() - 60 * MIN).toISOString(),
      markerAt: clock.now().toISOString(),
      file: null,
      handledAt: null,
      report: null,
      acknowledgedAt: null,
      acknowledgedById: null,
    });
    const report = await restore.runRestoreScan({ now: clock.advance(5 * MIN), pass: 1, mailgun: world.mailgun });
    expect(report).toMatchObject({ matchedByRecipient: 1, rowsCreated: 1 });
    expect(await rowOf(known.campaignId, 0)).toMatchObject({ status: "SENT", messageId: sent.messageId, fromAddress: TEAM_LINE, replyTo: ALI });
    expect(await rowOf(known.campaignId, 1)).toMatchObject({ status: "QUEUED", fromAddress: TEAM_LINE, replyTo: ALI });
  });
});

describe("fail closed (§2.4)", () => {
  it("a saved From address that no longer fits refuses a test launch with the misfit sentence; nothing is sent", async () => {
    await setSettingValue("sending.mode", "TEST");
    await setSettingValue("mailgun.fromAddress", "contact@other.com");
    const clock = worldClock(world);
    const err = await launchTo(world, [LIST[7]!], { now: clock.now() }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CampaignError);
    expect(err).toMatchObject({ code: "from-invalid", message: TEAM_FROM_TEXTS.misfit("contact@other.com", "send.example.com") });
    expect(world.mg.fake.messages).toHaveLength(0);
  });

  it("a shared-From email whose Message-ID isn't on the sending domain: nothing is sent, sending pauses with the From-or-reply sentence", async () => {
    const clock = worldClock(world);
    const { campaignId } = await launchTo(world, [LIST[8]!], { now: clock.now() });
    const row = await rowOf(campaignId);
    await dbWrite((c) => c.outboundEmail.update({ where: { id: row.id }, data: { messageId: row.messageId.replace(/@.*$/, "@old.example.com") } }));
    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r).toMatchObject({ sent: 0, held: 1 });
    expect(world.mg.fake.messages).toHaveLength(0);
    expect(await getPauseState()).toMatchObject({
      paused: true,
      kind: "mailgun-settings",
      reason: SENDER_HEADERS_PAUSE.reason,
      fixText: SENDER_HEADERS_PAUSE.fixText,
    });
    expect((await rowOf(campaignId)).status).toBe("QUEUED");
  });

  it("a key refused while the domain sending key sends a shared-From email: the key pause with the sending-key sentence", async () => {
    await setSecret("mailgun.sendingKey", "key-fake-sending-unknown", null);
    try {
      const clock = worldClock(world);
      const { campaignId } = await launchTo(world, [LIST[9]!], { now: clock.now() });
      expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(0);
      expect(await getPauseState()).toMatchObject({ paused: true, kind: "mailgun-auth", fixText: AUTH_PAUSE_FIX + SENDING_KEY_TEAM_FROM_FIX });
      expect((await rowOf(campaignId)).status).toBe("QUEUED");
    } finally {
      await deleteSecret("mailgun.sendingKey");
    }
  });
});
