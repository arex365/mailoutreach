import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { replyTo } from "../helpers/replies";

/**
 * Someone is switched off while a reply to their email is being processed (M4-DESIGN §4.2, §3.7 "Sender switched off";
 * review DATA-07): the assignee is chosen before the transaction, so the transaction checks it again. A switched-off
 * assignee hands the reply to the Owner, who is told, so it never sits on the list of someone who can't sign in.
 *
 * The race is made deterministic: the audience lookup runs as usual, then `race.between` runs (the switch-off commits)
 * before the processing transaction starts.
 */

const race = vi.hoisted(() => ({ between: null as null | (() => Promise<void>) }));

vi.mock("@/server/services/replies/effects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/replies/effects")>();
  return {
    ...actual,
    audienceFor: async (...args: Parameters<typeof actual.audienceFor>) => {
      const audience = await actual.audienceFor(...args);
      const between = race.between;
      race.between = null;
      if (between) await between();
      return audience;
    },
  };
});

const t = await createTestDb("replies-audience-race");
const mg = await connectFakeMailgun();
const { db, dbWrite } = await import("@/server/db");
const w = await import("./world");
const { waitingReplyCount } = await import("@/server/notifications");

let owner: Awaited<ReturnType<typeof w.makeSender>>;

beforeAll(async () => {
  owner = await w.makeSender("Arslan", { role: "OWNER", local: "arslan" });
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

/** Who got a notification pointing at this reply. */
async function notified(inboundId: number | null): Promise<number[]> {
  const rows = await db.notification.findMany({ where: { link: `/notifications?reply=${inboundId}#replies` }, select: { userId: true } });
  return rows.map((r) => r.userId).sort((a, b) => a - b);
}

const switchOff = (userId: number) => async () => {
  await dbWrite((c) => c.user.update({ where: { id: userId }, data: { active: false } }));
};

describe("the assignee is checked again inside the processing transaction (DATA-07)", () => {
  it("the sender switched off meanwhile: the Owner gets the reply and is told", async () => {
    const ali = await w.makeSender("Ali");
    const firma = await w.makeCompany("Firma GmbH", { domain: "firma.de" });
    const anna = await w.makePerson(firma.id, "anna@firma.de", "Anna Berg");
    const camp = await w.makeCampaign({ createdById: ali.id });
    const sent = await w.sendEmail(camp, anna);
    const posted = await replyTo(mg.fake, sent.emailId);

    race.between = switchOff(ali.id);
    await w.processAll();
    expect(race.between).toBeNull();

    const row = await w.inbound(posted.id);
    expect(row).toMatchObject({ kind: "REPLY", assigneeId: owner.id });
    expect(await notified(row.id)).toEqual([owner.id]);
    expect(await waitingReplyCount(owner.id)).toBe(1);
    expect(await waitingReplyCount(ali.id)).toBe(0);
    expect(await w.recipient(sent.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "replied" });
  });

  it("the owner of the address it reached switched off meanwhile: the sender keeps it, the switched-off person isn't told", async () => {
    const ali = await w.makeSender("Ali", { local: "ali2" });
    const sara = await w.makeSender("Sara");
    const shop = await w.makeCompany("Shop AG", { domain: "shop.de" });
    const bea = await w.makePerson(shop.id, "bea@shop.de", "Bea Shop");
    const camp = await w.makeCampaign({ createdById: ali.id, fromAddress: `Ali <${ali.address}>` });
    const sent = await w.sendEmail(camp, bea);
    const posted = await replyTo(mg.fake, sent.emailId, { to: sara.address! });

    race.between = switchOff(sara.id);
    await w.processAll();

    const row = await w.inbound(posted.id);
    expect(row).toMatchObject({ kind: "REPLY", assigneeId: ali.id });
    expect(await notified(row.id)).toEqual([ali.id]);
  });
});
