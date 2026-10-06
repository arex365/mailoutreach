import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeUser, setSettingValue } from "../campaigns/seed";
import { checklistRows, launchTo, resetSendingState, setupM3, worldClock, type M3World } from "./helpers";
import type { ChecklistRowKey } from "@/core/system-state";

/**
 * Launching in test mode and live (M3-DESIGN §4.3.9): every reason a launch is refused, in order, and the controls
 * for emails whose outcome isn't known (§4.3.5/§4.3.6): Retry and Skip of "Not sure it was sent", both refused while
 * the app is still checking. Also the top-bar label's counts (§4.1.5).
 */

const t = await createTestDb("m3-launch-control");
const { db, dbWrite } = await import("@/server/db");
const { setState } = await import("@/server/state");
const { launchModeProblems, launchCampaign, MAILGUN_NOT_CONNECTED_LAUNCH_TEXT, PRACTICE_COPY_LAUNCH_TEXT } = await import(
  "@/server/services/campaigns/launch"
);
const { retryEmail, skipRecipient, finishCheck } = await import("@/server/services/campaigns/control");
const { CampaignError } = await import("@/server/services/campaigns/errors");
const { MODE_GATE_TEXTS } = await import("@/core/sending/mode-gates");
const { getSendingLabel, getSendingState } = await import("@/server/sending-state");
const { pauseSending } = await import("@/server/services/sending/pause");
const { makeDraft, makeCompany } = await import("../campaigns/seed");

const LIST = ["l1@launch-1.de", "l2@launch-2.de", "l3@launch-3.de"];
const [A, B] = LIST as [string, string, string];
const ALI = { name: "Ali", address: { address: "ali@send.example.com", routeStatus: "ok" } };

let world: M3World;

beforeAll(async () => {
  world = await setupM3({ testList: LIST });
});

beforeEach(async () => {
  await resetSendingState();
  await setSettingValue("sending.testList", LIST);
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.goLive", false);
  await setSettingValue("practice.copy", false);
  await setSettingValue("mailgun.unsubscribeTest", {
    setup: "A",
    status: "passed",
    domain: world.mg.domain,
    mailboxes: [],
    headersOk: true,
    decidedAt: new Date().toISOString(),
    decidedById: world.owner.id,
    note: null,
  });
  await checklist();
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

async function checklist(overrides: Partial<Record<ChecklistRowKey, "ok" | "bad" | "warn">> = {}, domain = world.mg.domain) {
  await setState("domain.check", {
    domain,
    region: "EU",
    checkedAt: new Date().toISOString(),
    lastVerifyAt: null,
    rows: checklistRows(overrides),
    error: null,
  });
}

async function problems(mode: "DRY_RUN" | "TEST" | "LIVE", sender = ALI as Parameters<typeof launchModeProblems>[1]) {
  return launchModeProblems(mode, sender, { mailgun: world.mailgun });
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(CampaignError);
    return { code: (err as InstanceType<typeof CampaignError>).code, message: (err as Error).message };
  }
  throw new Error("expected a refusal");
}

describe("launch readiness", () => {
  it("everything set: no problems; dry runs never have any", async () => {
    expect(await problems("LIVE")).toEqual([]);
    expect(await problems("TEST")).toEqual([]);
    await setSettingValue("practice.copy", true);
    expect(await problems("DRY_RUN", null)).toEqual([]);
  });

  it("the practice copy and a Mailgun that isn't connected each give one reason only", async () => {
    await setSettingValue("practice.copy", true);
    expect(await problems("LIVE")).toEqual([{ code: "practice-copy", text: PRACTICE_COPY_LAUNCH_TEXT }]);
    await setSettingValue("practice.copy", false);
    const notConnected = async () => ({ connected: false as const, reason: "no-key" as const, text: "No key." });
    expect(await launchModeProblems("TEST", ALI, { mailgun: notConnected })).toEqual([
      { code: "mailgun-not-connected", text: MAILGUN_NOT_CONNECTED_LAUNCH_TEXT },
    ]);
  });

  it.each([
    ["spf", MODE_GATE_TEXTS.dns],
    ["mx", MODE_GATE_TEXTS.dns],
    ["tracking-off", MODE_GATE_TEXTS.trackingOff],
    ["unsubscribe", MODE_GATE_TEXTS.unsubscribe],
    ["webhooks", MODE_GATE_TEXTS.webhooks],
    ["signing-key", MODE_GATE_TEXTS.signingKey],
    ["sending-allowed", MODE_GATE_TEXTS.sendingAllowed],
  ] as const)("live: the checklist row %s blocks", async (key, text) => {
    await checklist({ [key]: "bad" });
    expect(await problems("LIVE")).toEqual([{ code: "mode-not-ready", text }]);
    // Test mode needs only Mailgun.
    expect(await problems("TEST")).toEqual([]);
  });

  it("live: a row that is only still spreading doesn't block", async () => {
    await checklist({ dkim: "warn" });
    expect(await problems("LIVE")).toEqual([]);
  });

  it("live: Setup B, a reply test passed on another domain, and an empty test list each block", async () => {
    await setSettingValue("mailgun.unsubscribeTest", {
      setup: "B",
      status: "passed",
      domain: world.mg.domain,
      mailboxes: [],
      headersOk: true,
      decidedAt: new Date().toISOString(),
      decidedById: world.owner.id,
      note: null,
    });
    expect((await problems("LIVE")).map((p) => p.text)).toEqual([MODE_GATE_TEXTS.setupA]);

    await setSettingValue("mailgun.unsubscribeTest", {
      setup: "A",
      status: "passed",
      domain: "old-domain.example.com",
      mailboxes: [],
      headersOk: true,
      decidedAt: new Date().toISOString(),
      decidedById: world.owner.id,
      note: null,
    });
    expect((await problems("LIVE")).map((p) => p.text)).toEqual([MODE_GATE_TEXTS.replyTestPass]);

    await setSettingValue("mailgun.unsubscribeTest", {
      setup: "A",
      status: "untested",
      domain: null,
      mailboxes: [],
      headersOk: null,
      decidedAt: null,
      decidedById: null,
      note: null,
    });
    await setSettingValue("sending.testList", []);
    expect((await problems("LIVE")).map((p) => p.text)).toEqual([MODE_GATE_TEXTS.replyTestPass, MODE_GATE_TEXTS.emptyTestListLaunch]);
  });

  it("live: a checklist made for another domain says nothing about this one", async () => {
    await checklist({}, "old-domain.example.com");
    expect((await problems("LIVE")).map((p) => p.text)).toEqual([
      MODE_GATE_TEXTS.dns,
      MODE_GATE_TEXTS.trackingOff,
      MODE_GATE_TEXTS.unsubscribe,
      MODE_GATE_TEXTS.webhooks,
      MODE_GATE_TEXTS.signingKey,
      MODE_GATE_TEXTS.sendingAllowed,
    ]);
  });

  it("the sender needs a sending address, and for live a working reply route", async () => {
    expect(await problems("TEST", { name: "Sara", address: null })).toEqual([
      { code: "no-sender-address", text: "Sara has no sending address yet. Sara can add one in Settings › My profile." },
    ]);
    const pending = { name: "Ali", address: { address: "ali@send.example.com", routeStatus: "pending" } };
    expect(await problems("TEST", pending)).toEqual([]);
    expect(await problems("LIVE", pending)).toEqual([
      {
        code: "no-reply-route",
        text: "Replies to Ali can't reach Ali yet: the reply route isn't working. Click Apply recommended settings in Settings › Domain checklist.",
      },
    ]);
  });

  it("the launch refuses with the first reason and its code", async () => {
    const clock = worldClock(world);
    await checklist({ "tracking-off": "bad", webhooks: "bad" });
    expect(await refusal(launchTo(world, [A], { now: clock.now() }))).toEqual({ code: "mode-not-ready", message: MODE_GATE_TEXTS.trackingOff });
    await checklist();

    // A sender without a sending address.
    const sara = await makeUser("Sara", { email: "sara@polygonparadise.test" });
    await setSettingValue("sending.mode", "TEST");
    expect(await refusal(launchTo(world, [A], { now: clock.now(), senderId: sara.id }))).toEqual({
      code: "no-sender-address",
      message: "Sara has no sending address yet. Sara can add one in Settings › My profile.",
    });

    // A live sender whose reply route isn't working yet.
    await setSettingValue("sending.mode", "LIVE");
    await dbWrite((c) => c.senderAddress.updateMany({ where: { userId: world.member.id }, data: { routeStatus: "pending" } }));
    try {
      expect((await refusal(launchTo(world, [A], { now: clock.now() }))).code).toBe("no-reply-route");
    } finally {
      await dbWrite((c) => c.senderAddress.updateMany({ where: { userId: world.member.id }, data: { routeStatus: "ok" } }));
    }
  });

  it("test and live campaigns always keep sending hours; a dry run may ignore them", async () => {
    const clock = worldClock(world);
    const live = await launchTo(world, [A], { now: clock.now(), ignoreWindow: true });
    expect((await db.campaign.findUniqueOrThrow({ where: { id: live.campaignId } })).ignoreWindow).toBe(false);
    await setSettingValue("sending.mode", "DRY_RUN");
    const dry = await launchTo(world, ["dry@launch-dry.de"], { now: clock.now() });
    expect((await db.campaign.findUniqueOrThrow({ where: { id: dry.campaignId } })).ignoreWindow).toBe(true);
    const dryOff = await launchTo(world, ["dry2@launch-dry.de"], { now: clock.now(), ignoreWindow: false });
    expect((await db.campaign.findUniqueOrThrow({ where: { id: dryOff.campaignId } })).ignoreWindow).toBe(false);
  });

  it("a launch in test mode says so", async () => {
    await setSettingValue("sending.mode", "TEST");
    const { company, people } = await makeCompany({ name: "Test mode Co", people: [{ name: "Tina", email: B }] });
    const draft = await makeDraft({
      name: "Test mode campaign",
      createdById: world.owner.id,
      senderId: world.member.id,
      recipients: [{ companyId: company.id, personId: people[0]!.id }],
    });
    const res = await launchCampaign(draft.id, world.owner.id, { now: worldClock(world).now(), mailgun: world.mailgun });
    expect(res.message).toMatch(/ in test mode/);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: draft.id } })).mode).toBe("TEST");
  });
});

describe("emails whose outcome isn't known", () => {
  async function liveEmail(status: "UNKNOWN" | "UNCONFIRMED", data: { providerId?: string } = {}) {
    const clock = worldClock(world);
    const launched = await launchTo(world, [A], { now: clock.now() });
    const email = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: launched.campaignId } });
    await dbWrite((c) =>
      c.outboundEmail.update({
        where: { id: email.id },
        data: { status, claimedAt: clock.now(), attempts: 1, lastError: "We couldn't confirm with Mailgun whether this email was sent", ...data },
      }),
    );
    return { ...launched, email, recipient: await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: launched.campaignId } }) };
  }

  it("while the app is still checking: Retry and Skip are refused with the 2-hour text", async () => {
    const { email, recipient } = await liveEmail("UNKNOWN");
    expect(await refusal(retryEmail(email.id, world.owner.id))).toEqual({
      code: "checking",
      message:
        "We're still checking with Mailgun whether this email went out. You can choose Retry or Skip once it's marked 'Not sure it was sent', at most 2 hours after it was sent.",
    });
    const skip = await refusal(skipRecipient(recipient.id, world.owner.id));
    expect(skip.code).toBe("checking");
    expect(skip.message).toMatch(/^We're still checking with Mailgun whether the email to .+ went out\. You can choose Retry or Skip once it's marked 'Not sure it was sent', at most 2 hours after it was sent\.$/);
  });

  it("the campaign doesn't finish while an email is 'Not sure it was sent'; Skip settles it and finishes", async () => {
    const { campaignId, email, recipient } = await liveEmail("UNCONFIRMED");
    expect(await finishCheck(campaignId)).toBe(false);
    const res = await skipRecipient(recipient.id, world.owner.id);
    expect(res.skippedEmails).toBe(1);
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: email.id } })).toMatchObject({
      status: "SKIPPED",
      lastError: "Skipped by Arslan (we couldn't confirm it was sent)",
    });
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("FINISHED");
  });

  it("Retry of a live 'Not sure it was sent' email needs the duplicate-risk confirmation, then keeps the Message-ID", async () => {
    const { email } = await liveEmail("UNCONFIRMED");
    const refused = await refusal(retryEmail(email.id, world.owner.id));
    expect(refused.code).toBe("confirm-duplicate");
    expect(refused.message).toBe(
      `We couldn't confirm with Mailgun whether this email reached ${A}. Retry sends it again. If the first one did arrive, Person 0 gets it twice.`,
    );
    const ok = await retryEmail(email.id, world.owner.id, { confirmDuplicateRisk: true });
    expect(ok.status).toBe("QUEUED");
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: email.id } })).toMatchObject({
      status: "QUEUED",
      messageId: email.messageId,
      attempts: 0,
      claimedAt: null,
      lastError: null,
    });
  });

  it("Retry is refused for an email Mailgun already has", async () => {
    const { email } = await liveEmail("UNCONFIRMED", { providerId: "mailgun-has-it@send.example.com" });
    expect(await refusal(retryEmail(email.id, world.owner.id, { confirmDuplicateRisk: true }))).toEqual({
      code: "provider-has-it",
      message: "Mailgun already has this email, so it won't be sent again.",
    });
  });

  it("test mode: Retry needs no confirmation (nothing is delivered)", async () => {
    await setSettingValue("sending.mode", "TEST");
    const { email } = await liveEmail("UNCONFIRMED");
    expect((await retryEmail(email.id, world.owner.id)).status).toBe("QUEUED");
  });
});

describe("the top-bar label", () => {
  it("counts running and scheduled test and live campaigns", async () => {
    await setSettingValue("sending.mode", "DRY_RUN");
    expect(await getSendingState()).toEqual({ kind: "dry-run" });

    await setSettingValue("sending.mode", "LIVE");
    await launchTo(world, [A], { now: worldClock(world).now() });
    await setSettingValue("sending.mode", "DRY_RUN");
    const info = await getSendingLabel();
    expect(info.activeRealCampaigns).toEqual({ live: 1, test: 0, liveAfterGoLive: 0 });
    expect(info.state).toEqual({ kind: "test-list" });
    expect(info.label.title).toBe(
      "New campaigns use dry run; 1 campaign still sends through Mailgun. Pause it, or use Pause all sending.",
    );

    // After go-live, a live campaign launched before it still only reaches the test list (G2): no "Sending live"
    // (review GOLIVE-03); one launched after go-live is.
    await setSettingValue("sending.goLive", true);
    expect(await getSendingState()).toEqual({ kind: "test-list" });
    const running = await db.campaign.findFirstOrThrow({ where: { mode: "LIVE", status: { in: ["RUNNING", "SCHEDULED"] } } });
    await dbWrite((c) => c.campaign.update({ where: { id: running.id }, data: { launchedGoLive: true } }));
    expect((await getSendingLabel()).activeRealCampaigns).toEqual({ live: 1, test: 0, liveAfterGoLive: 1 });
    expect(await getSendingState()).toEqual({ kind: "live" });
    await dbWrite((c) => c.campaign.update({ where: { id: running.id }, data: { launchedGoLive: running.launchedGoLive } }));
    await setSettingValue("sending.goLive", false);

    await pauseSending({ kind: "manual", reason: "by Arslan", fixText: "Click Resume.", byUserId: world.owner.id });
    expect(await getSendingState()).toEqual({ kind: "paused", reason: "by Arslan" });
    expect((await getSendingLabel()).label).toMatchObject({ text: "Paused by Arslan", tone: "danger" });
  });
});
