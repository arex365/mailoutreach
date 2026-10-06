import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { worldClock, type M3World } from "../sending-m3/helpers";
import { OWN, launchOwn, setupOwnMailbox } from "./p1-setup";

/**
 * The chosen sender's notification when someone else launches a live campaign (MAIN-DOMAIN-DESIGN O19, P9 seam): in
 * own-mailbox mode replies never come to the sender's inbox, so the notification says where they go and what the team
 * does with them (`OWN_MAILBOX_TEXTS.followUpReminder`) instead of "Replies to its emails will come to your inbox."
 */

const t = await createTestDb("own-mailbox-sender-notice");
const { db } = await import("@/server/db");
const { OWN_MAILBOX_TEXTS } = await import("@/core/sending/own-mailbox");

let world: M3World;

beforeAll(async () => {
  world = await setupOwnMailbox({ testList: ["t.outlook@outlook.com", "t.gmail@gmail.com"] });
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("campaign.sender in own-mailbox mode", () => {
  it("a live launch by the Owner for Ali tells Ali that replies go to the own From, never to Ali's inbox", async () => {
    const clock = worldClock(world);
    const { campaignId } = await launchOwn(world, ["t.outlook@outlook.com"], { now: clock.now() });
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).mode).toBe("LIVE");
    const notes = await db.notification.findMany({ where: { userId: world.member.id, type: "campaign.sender" } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toBe(OWN_MAILBOX_TEXTS.followUpReminder(OWN));
    expect(notes[0]!.body).not.toContain("your inbox");
    expect(notes[0]!.link).toBe(`/campaigns/${campaignId}`);
  });
});
