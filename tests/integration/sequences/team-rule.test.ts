import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, setSettingValue, type StepSeed } from "../campaigns/seed";
import { clearPacer, launchTo, resetSendingState, setupM3, tickDeps, worldClock, type M3World } from "../sending-m3/helpers";

/**
 * The 30-day team rule with follow-ups (SPEC milestone 4, PLAN B6.1 "all steps and people in the same campaign are
 * exempt"): now that follow-ups go out in modes that count as emailed, a campaign's own follow-ups and its first
 * emails to colleagues at the same company are never blocked by its own earlier emails, and a live follow-up after
 * go-live still holds its company's reservation.
 */

const t = await createTestDb("sequences-team-rule");
const { db, dbWrite } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");

const WED = new Date("2026-09-23T08:00:00Z");
const MON = new Date("2026-09-28T07:00:00Z");

let world: M3World;

beforeAll(async () => {
  world = await setupM3({ testList: ["mailbox@team-rule-test.de"] });
});

beforeEach(async () => {
  world.mg.fake.reset();
  await resetSendingState();
  await setSettingValue("sending.goLive", false);
  await setSettingValue("practice.copy", false);
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("the 30-day rule inside one campaign", () => {
  it("practice copy: follow-up 1 to Anna and a first email to Ben at the same company both go", async () => {
    await setSettingValue("practice.copy", true);
    await setSettingValue("sending.mode", "DRY_RUN");
    const clock = worldClock(world, WED);
    const steps: StepSeed[] = [
      { step: 0, subject: "3D models for your shop", body: "First" },
      { step: 1, body: "Second", delayDays: 1 },
    ];
    const { campaignId, companyIds } = await launchTo(world, ["anna@same-firma.de", "ben@same-firma.de"], {
      now: clock.now(),
      sameCompany: true,
      ignoreWindow: false,
      steps,
    });
    await dbWrite((c) => c.campaign.update({ where: { id: campaignId }, data: { daysAsMinutes: true } }));
    // One gated email per tick: Anna's first email; the company now counts as emailed (practice copy).
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect(await db.company.findUniqueOrThrow({ where: { id: companyIds[0]! } })).toMatchObject({ status: "CONTACTED" });
    clock.advance(60_000);
    await clearPacer();
    // Anna's follow-up first (follow-ups before first emails), then Ben's first email.
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    const emails = await db.outboundEmail.findMany({ where: { campaignId }, orderBy: [{ toNorm: "asc" }, { step: "asc" }] });
    expect(emails.map((e) => [e.toNorm, e.step, e.status])).toEqual([
      ["anna@same-firma.de", 0, "SENT"],
      ["anna@same-firma.de", 1, "SENT"],
      ["ben@same-firma.de", 0, "SENT"],
      ["ben@same-firma.de", 1, "QUEUED"],
    ]);
    expect(await db.campaignRecipient.count({ where: { campaignId, state: "STOPPED" } })).toBe(0);
  });

  it("after go-live: a live follow-up still holds its company's reservation and goes", async () => {
    await setSettingValue("sending.mode", "LIVE");
    await setSettingValue("sending.goLive", true);
    const clock = worldClock(world, WED);
    await makeCompany({
      name: "Golive Follow",
      people: [{ name: "Gina", email: "gina@golive-follow.de", verificationStatus: "VALID", verifiedAt: clock.now() }],
    });
    const { campaignId, companyIds } = await launchTo(world, ["gina@golive-follow.de"], {
      now: clock.now(),
      steps: [
        { step: 0, subject: "3D models for your shop", body: "First" },
        { step: 1, body: "Second", delayDays: 3 },
      ],
    });
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect(await db.companyReservation.count({ where: { campaignId, companyId: companyIds[0]!, releasedAt: null } })).toBe(1);
    clock.set(MON);
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect(world.mg.fake.messages.map((m) => m.fields.to?.[0])).toEqual(["gina@golive-follow.de", "gina@golive-follow.de"]);
    // Finished: the reservation is let go.
    expect(await db.companyReservation.count({ where: { campaignId, companyId: companyIds[0]!, releasedAt: null } })).toBe(0);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("FINISHED");
  });
});
