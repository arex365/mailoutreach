import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setSettingValue } from "../campaigns/seed";
import { createTestDb } from "../helpers/test-db";
import { resetSendingState, worldClock, type M3World } from "../sending-m3/helpers";
import { ALI_LINE, DOMAIN, OWN, draftTo, launchOwn, passReplyTest, setupOwnMailbox, storeCheck } from "./p1-setup";

/**
 * Launching in own-mailbox mode (docs/dev/MAIN-DOMAIN-DESIGN.md §2.3, §2.4, O3, O9, O13, §8 P1): a missing own From
 * refuses test and live launches ("from-invalid"); live needs the by-hand reply test passed for this mode; nobody
 * needs a sending address or a reply route; the launch's last transaction refuses when the way of sending changed
 * meanwhile (F29 extended); dry runs never need a From.
 */

const t = await createTestDb("own-mailbox-launch");
const { db, dbWrite } = await import("@/server/db");
const { launchCampaign, launchModeProblems } = await import("@/server/services/campaigns/launch");
const { CampaignError } = await import("@/server/services/campaigns/errors");
const { OWN_MAILBOX_TEXTS } = await import("@/core/sending/own-mailbox");
const { MODE_GATE_TEXTS } = await import("@/core/sending/mode-gates");
const { LAUNCH_SETTINGS_CHANGED_TEXT } = await import("@/core/sending/from-address");

const LIST = Array.from({ length: 12 }, (_, i) => `l${i}@team-${i}.de`);

let world: M3World;

async function refusal(p: Promise<unknown>): Promise<InstanceType<typeof CampaignError>> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CampaignError);
  return err as InstanceType<typeof CampaignError>;
}

beforeAll(async () => {
  world = await setupOwnMailbox({ testList: LIST });
});

beforeEach(async () => {
  world.mg.fake.reset();
  await resetSendingState();
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("mailgun.fromAddress", OWN);
  await setSettingValue("mailgun.replies", "own-mailbox");
  await passReplyTest(world.owner.id);
  await storeCheck();
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("the own From (O3)", () => {
  it("no own From: test and live launches are refused 'from-invalid' with the missing-From sentence", async () => {
    await setSettingValue("mailgun.fromAddress", null);
    const clock = worldClock(world);
    for (const mode of ["TEST", "LIVE"] as const) {
      await setSettingValue("sending.mode", mode);
      const err = await refusal(launchOwn(world, [LIST[0]!], { now: clock.now() }));
      expect(err, mode).toMatchObject({ code: "from-invalid", message: OWN_MAILBOX_TEXTS.fromMissing(DOMAIN) });
    }
    // A From on another domain is a misfit, with its own sentence.
    await setSettingValue("mailgun.fromAddress", "contact@other.com");
    await setSettingValue("sending.mode", "TEST");
    expect(await refusal(launchOwn(world, [LIST[0]!], { now: clock.now() }))).toMatchObject({
      code: "from-invalid",
      message: OWN_MAILBOX_TEXTS.misfit("contact@other.com", DOMAIN),
    });
    expect(world.mg.fake.messages).toHaveLength(0);
  });

  it("a dry run needs no From: without one it uses the placeholder; with one, the own From line and dry-run ids", async () => {
    await setSettingValue("sending.mode", "DRY_RUN");
    await setSettingValue("mailgun.fromAddress", null);
    const clock = worldClock(world);
    const without = await launchOwn(world, [LIST[1]!], { now: clock.now() });
    expect(await db.campaign.findUniqueOrThrow({ where: { id: without.campaignId } })).toMatchObject({
      mode: "DRY_RUN",
      fromAddress: "ali@your-sending-domain",
      replyTo: null,
      sendingDomainId: null,
    });

    await setSettingValue("mailgun.fromAddress", OWN);
    const withFrom = await launchOwn(world, [LIST[2]!], { now: clock.now() });
    const domainRow = await db.sendingDomain.findUniqueOrThrow({ where: { name: DOMAIN } });
    expect(await db.campaign.findUniqueOrThrow({ where: { id: withFrom.campaignId } })).toMatchObject({
      fromAddress: OWN,
      replyTo: null,
      sendingDomainId: domainRow.id,
    });
    const row = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: withFrom.campaignId } });
    expect(row).toMatchObject({ fromAddress: ALI_LINE, replyTo: null });
    expect(row.messageId).toMatch(/@dry-run\.invalid$/);
  });
});

describe("live launches (O9, O13)", () => {
  it("without the own-mailbox reply-test pass → the reply-test sentence; an app-mode pass doesn't count; with it → launched", async () => {
    const clock = worldClock(world);
    await setSettingValue("mailgun.unsubscribeTest", null);
    expect(await refusal(launchOwn(world, [LIST[3]!], { now: clock.now() }))).toMatchObject({
      code: "mode-not-ready",
      message: MODE_GATE_TEXTS.replyTestPass,
    });
    // A pass stored by app mode (no `replies`) for the same domain and From.
    await passReplyTest(world.owner.id, { replies: undefined });
    expect(await refusal(launchOwn(world, [LIST[3]!], { now: clock.now() }))).toMatchObject({ message: MODE_GATE_TEXTS.replyTestPass });
    // A pass with another From.
    await passReplyTest(world.owner.id, { from: "info@example.com" });
    expect(await refusal(launchOwn(world, [LIST[3]!], { now: clock.now() }))).toMatchObject({ message: MODE_GATE_TEXTS.replyTestPass });

    await passReplyTest(world.owner.id);
    const { campaignId } = await launchOwn(world, [LIST[3]!], { now: clock.now() });
    expect(await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).toMatchObject({ status: "RUNNING", mode: "LIVE", fromAddress: OWN, replyTo: null });
  });

  it("launchModeProblems never names a sending address or a reply route in this mode", async () => {
    for (const mode of ["TEST", "LIVE"] as const) {
      for (const address of [null, { address: "ali@example.com", routeStatus: "pending" }, { address: "ali@example.com", routeStatus: null }]) {
        const problems = await launchModeProblems(mode, { name: "Ali", address }, { mailgun: world.mailgun });
        expect(problems.map((p) => p.code), `${mode} ${JSON.stringify(address)}`).not.toContain("no-sender-address");
        expect(problems.map((p) => p.code)).not.toContain("no-reply-route");
        expect(problems).toEqual([]);
      }
    }
  });

  it("the Setup sentence in this mode is 'Back to normal', never Setup A's", async () => {
    await passReplyTest(world.owner.id, { setup: "B" });
    const problems = await launchModeProblems("LIVE", { name: "Ali", address: null }, { mailgun: world.mailgun });
    expect(problems.map((p) => p.text)).toContain(OWN_MAILBOX_TEXTS.setupNotNormal);
    expect(problems.map((p) => p.text)).not.toContain(MODE_GATE_TEXTS.setupA);
  });
});

describe("the launch's last re-check (F29 extended)", () => {
  it("refuses when the way of sending changed between the chunks and the last transaction; the draft stays a draft", async () => {
    const clock = worldClock(world);
    const d = await draftTo(world, [LIST[4]!]);
    const err = await refusal(
      launchCampaign(d.draftId, world.owner.id, {
        now: clock.now(),
        mailgun: world.mailgun,
        beforeFinalize: async () => {
          await setSettingValue("mailgun.replies", "app");
        },
      }),
    );
    expect(err).toMatchObject({ code: "changed", message: LAUNCH_SETTINGS_CHANGED_TEXT });
    expect((await db.campaign.findUniqueOrThrow({ where: { id: d.draftId } })).status).toBe("DRAFT");
  });

  it("refuses when the sending domain's row was deactivated meanwhile", async () => {
    const clock = worldClock(world);
    const d = await draftTo(world, [LIST[5]!]);
    const row = await db.sendingDomain.findUniqueOrThrow({ where: { name: DOMAIN } });
    const err = await refusal(
      launchCampaign(d.draftId, world.owner.id, {
        now: clock.now(),
        mailgun: world.mailgun,
        beforeFinalize: async () => {
          await dbWrite((c) => c.sendingDomain.update({ where: { id: row.id }, data: { active: false } }));
        },
      }),
    );
    expect(err).toMatchObject({ code: "changed" });
    await dbWrite((c) => c.sendingDomain.update({ where: { id: row.id }, data: { active: true } }));
  });

  it("an unchanged setting launches as before", async () => {
    const clock = worldClock(world);
    const d = await draftTo(world, [LIST[6]!]);
    await launchCampaign(d.draftId, world.owner.id, { now: clock.now(), mailgun: world.mailgun, beforeFinalize: async () => undefined });
    expect((await db.campaign.findUniqueOrThrow({ where: { id: d.draftId } })).status).toBe("RUNNING");
  });
});
