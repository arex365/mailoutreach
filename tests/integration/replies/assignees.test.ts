import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { postInbound, replyTo } from "../helpers/replies";
import type { TestCampaign } from "./world";

/**
 * Who answers a reply and who hears about it (M4-DESIGN §4.2): the assignee is the email's sender while active, else
 * the Owner; the owner of the address the reply reached and the Owner (catch-all) are told too; a simulated reply tells
 * only the campaign's sender.
 */

const t = await createTestDb("replies-assignees");
const mg = await connectFakeMailgun();
const { db } = await import("@/server/db");
const w = await import("./world");
const { simulateReply } = await import("@/server/services/mail-events/simulate");

let owner: Awaited<ReturnType<typeof w.makeSender>>;
let ali: Awaited<ReturnType<typeof w.makeSender>>;
let sara: Awaited<ReturnType<typeof w.makeSender>>;

beforeAll(async () => {
  owner = await w.makeSender("Arslan", { role: "OWNER", local: "arslan" });
  ali = await w.makeSender("Ali");
  sara = await w.makeSender("Sara");
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

async function emailed(name: string, domain: string, campaign: TestCampaign) {
  const company = await w.makeCompany(name, { domain });
  const person = await w.makePerson(company.id, `anna@${domain}`, "Anna Berg");
  return { company, person, sent: await w.sendEmail(campaign, person) };
}

describe("assignee and notify set (§4.2)", () => {
  it("a reply to Ali's email that reached Sara's address: Ali answers it, Ali and Sara are told", async () => {
    const camp = await w.makeCampaign({ createdById: ali.id });
    const x = await emailed("Sara Address Co", "saraaddress.de", camp);
    const posted = await replyTo(mg.fake, x.sent.emailId, { to: sara.address! });
    await w.processAll();
    expect(await w.inbound(posted.id)).toMatchObject({ kind: "REPLY", assigneeId: ali.id });
    expect(await notified(posted.id)).toEqual([ali.id, sara.id].sort((a, b) => a - b));
  });

  it("a reply that reached the catch-all (an unknown or retired address): the Owner is told as well", async () => {
    const camp = await w.makeCampaign({ createdById: ali.id });
    const x = await emailed("Catch All Co", "catchall.de", camp);
    const posted = await replyTo(mg.fake, x.sent.emailId, { to: "old-address@send.example.com" });
    await w.processAll();
    expect(await w.inbound(posted.id)).toMatchObject({ kind: "REPLY", assigneeId: ali.id, senderAddressId: null });
    expect(await notified(posted.id)).toEqual([owner.id, ali.id].sort((a, b) => a - b));
  });

  it("a switched-off sender's reply goes to the Owner", async () => {
    const gone = await w.makeSender("Gone", { active: false });
    const camp = await w.makeCampaign({ createdById: gone.id, fromAddress: `Gone <${gone.address}>` });
    const x = await emailed("Gone Sender Co", "gonesender.de", camp);
    const posted = await replyTo(mg.fake, x.sent.emailId);
    await w.processAll();
    expect(await w.inbound(posted.id)).toMatchObject({ kind: "REPLY", assigneeId: owner.id });
    expect(await notified(posted.id)).toEqual([owner.id]);
  });

  it("an unlinked human reply is assigned to the owner of the address it reached", async () => {
    const posted = await postInbound(mg.fake, { from: "stranger@unknown-shop.de", to: sara.address!, subject: "Hello", text: "Hi, who are you?" });
    await w.processAll();
    expect(await w.inbound(posted.id)).toMatchObject({ kind: "UNLINKED", assigneeId: sara.id });
    expect(await notified(posted.id)).toEqual([sara.id]);
  });

  it("an unlinked reply to the catch-all is the Owner's", async () => {
    const posted = await postInbound(mg.fake, { from: "stranger2@unknown-shop.de", to: "nobody@send.example.com", subject: "Hello", text: "Hi" });
    await w.processAll();
    expect(await w.inbound(posted.id)).toMatchObject({ kind: "UNLINKED", assigneeId: owner.id });
    expect(await notified(posted.id)).toEqual([owner.id]);
  });

  it("a simulated reply tells only the campaign's sender, with a real sender address or a placeholder alike", async () => {
    const real = await w.makeCampaign({ createdById: owner.id, senderId: sara.id, mode: "DRY_RUN", fromAddress: `Sara <${sara.address}>` });
    const placeholder = await w.makeCampaign({ createdById: owner.id, senderId: ali.id, mode: "DRY_RUN", fromAddress: "Ali <ali@dry-run.invalid>" });
    const a = await emailed("Sim Real Co", "simreal.de", real);
    const b = await emailed("Sim Placeholder Co", "simplaceholder.de", placeholder);
    await simulateReply(ali, a.sent.emailId, "reply");
    await simulateReply(ali, b.sent.emailId, "reply");
    const rowA = await db.inboundMessage.findFirstOrThrow({ where: { storageKey: `sim:${a.sent.emailId}:reply` } });
    const rowB = await db.inboundMessage.findFirstOrThrow({ where: { storageKey: `sim:${b.sent.emailId}:reply` } });
    expect(rowA).toMatchObject({ assigneeId: sara.id, toAddress: sara.address });
    expect(rowB).toMatchObject({ assigneeId: ali.id, senderAddressId: null });
    expect(await notified(rowA.id)).toEqual([sara.id]);
    expect(await notified(rowB.id)).toEqual([ali.id]);
  });
});
