import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { postInbound, vectorInput } from "../helpers/replies";
import { A, vector } from "../../unit/replies-core/vectors";
import type { SentEmail } from "./world";

/**
 * Auto-replies (SPEC "auto-reply detection"; PLAN B12 "auto-replies in three languages"; M4-DESIGN §3.4, §3.5, §5.5):
 * the research vectors go through the fake Mailgun and the signed inbound webhook, then the event lane.
 */

const t = await createTestDb("replies-auto");
const mg = await connectFakeMailgun();
const { db } = await import("@/server/db");
const w = await import("./world");
const { listOtherMessages, getWaitingReply } = await import("@/server/services/replies");

let owner: Awaited<ReturnType<typeof w.makeSender>>;
let ali: Awaited<ReturnType<typeof w.makeSender>>;
let firma: { id: number };
let anna: { id: number; companyId: number; email: string | null };
let annaSent: SentEmail;
let campaignId: number;

beforeAll(async () => {
  owner = await w.makeSender("Arslan", { role: "OWNER", local: "arslan" });
  ali = await w.makeSender("Ali");
  firma = await w.makeCompany("Firma GmbH", { domain: "firma.de" });
  anna = await w.makePerson(firma.id, "anna@firma.de", "Anna Berg");
  const camp = await w.makeCampaign({ createdById: ali.id, name: "Germany Q4" });
  campaignId = camp.id;
  annaSent = await w.sendEmail(camp, anna, { sentAt: new Date(Date.now() - 2 * w.DAY) });
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

const replyNotifications = async (userId: number) => (await w.notificationsOf(userId)).filter((n) => n.type.startsWith("reply."));

describe("out-of-office replies in three languages are logged, and change nothing", () => {
  it("V03 (en, by headers), V04 (de, by address) and V05 (nb, by address)", async () => {
    const butikk = await w.makeCompany("Butikk AS", { domain: "butikk.no" });
    const ole = await w.makePerson(butikk.id, "ole@butikk.no", "Ole Hansen");
    const norway = await w.makeCampaign({ createdById: ali.id, name: "Norway prints" });
    const oleSent = await w.sendEmail(norway, ole, { sentAt: new Date(Date.now() - w.DAY), subject: "3D-modeller til butikken deres" });
    const before = (await replyNotifications(ali.id)).length;

    const en = await postInbound(mg.fake, vectorInput(vector("V03"), { ids: { [A]: annaSent.messageId } }));
    const de = await postInbound(mg.fake, vectorInput(vector("V04")));
    const nb = await postInbound(mg.fake, vectorInput(vector("V05")));
    await w.processAll();

    expect(await w.inbound(en.id)).toMatchObject({ kind: "AUTO_REPLY", autoReason: "out-of-office", linkMethod: "headers", companyId: firma.id, personId: anna.id });
    expect(await w.inbound(de.id)).toMatchObject({ kind: "AUTO_REPLY", autoReason: "out-of-office", linkMethod: "from", outboundEmailId: annaSent.emailId });
    expect(await w.inbound(nb.id)).toMatchObject({ kind: "AUTO_REPLY", autoReason: "out-of-office", linkMethod: "from", outboundEmailId: oleSent.emailId });
    // Nothing stops, nothing is held, nobody is notified, nothing waits for an answer.
    expect(await w.recipient(annaSent.recipientId)).toMatchObject({ state: "WAITING", stopReason: null, holdReason: null });
    expect(await w.email(annaSent.queuedId!)).toMatchObject({ status: "QUEUED" });
    expect(await w.recipient(oleSent.recipientId)).toMatchObject({ state: "WAITING" });
    expect((await replyNotifications(ali.id)).length).toBe(before);
    expect(await getWaitingReply(owner, en.id!)).toBeNull();
    const auto = (await w.activities("reply.auto")).filter((a) => a.companyId === firma.id);
    expect(auto.map((a) => a.summary)).toEqual([
      "Automatic reply from anna@firma.de (out of office)",
      "Automatic reply from anna@firma.de (out of office)",
    ]);
    expect(auto[0]).toMatchObject({ personId: anna.id, mode: "LIVE", actorId: null });
    expect(await db.company.findUniqueOrThrow({ where: { id: firma.id } })).toMatchObject({ status: "CONTACTED", repliedAt: null });
  });
});

describe("messages that need the sender's attention (reply.attention, once per person and reason per 30 days)", () => {
  it("a 'left the company' auto-reply tells the sender, with the suggested address, once", async () => {
    const first = await postInbound(mg.fake, vectorInput(vector("V38")));
    await w.processAll();
    expect(await w.inbound(first.id)).toMatchObject({ kind: "AUTO_REPLY", autoReason: "left-company", linkMethod: "from" });
    const notes = (await replyNotifications(ali.id)).filter((n) => n.type === "reply.attention" && n.title.includes("has left"));
    expect(notes).toEqual([
      {
        type: "reply.attention",
        title: "Anna Berg has left Firma GmbH",
        body: "Their automatic reply suggests info@firma.de instead. Follow-ups to Anna continue unless you skip them in the campaign.",
        link: `/campaigns/${campaignId}?recipient=${annaSent.recipientId}`,
      },
    ]);
    expect(await w.recipient(annaSent.recipientId)).toMatchObject({ state: "WAITING" });

    // The next follow-up gets the same auto-reply: the timeline says so, the bell stays quiet.
    const second = await postInbound(mg.fake, vectorInput(vector("V38")));
    await w.processAll();
    expect(await w.inbound(second.id)).toMatchObject({ kind: "AUTO_REPLY", autoReason: "left-company" });
    expect((await replyNotifications(ali.id)).filter((n) => n.title.includes("has left")).length).toBe(1);
    const timeline = (await w.activities("reply.auto")).filter((a) => (a.data as { autoReason?: string }).autoReason === "left-company");
    expect(timeline.length).toBe(2);
  });

  it("a challenge from a filter address with no thread headers is linked by the address it names (V20)", async () => {
    const posted = await postInbound(mg.fake, vectorInput(vector("V20")));
    await w.processAll();
    const row = await w.inbound(posted.id);
    expect(row).toMatchObject({ kind: "AUTO_REPLY", autoReason: "challenge", linkMethod: "named-address", outboundEmailId: annaSent.emailId, companyId: firma.id });
    expect(await replyNotifications(ali.id)).toContainEqual({
      type: "reply.attention",
      title: "Anna Berg's spam filter is holding your email",
      body: "It asks you to confirm you're a person. Open the message in your own inbox if you want to; the app never clicks such links. Follow-ups continue.",
      link: `/contacts?company=${firma.id}`,
    });
    expect(await w.recipient(annaSent.recipientId)).toMatchObject({ state: "WAITING" });
  });

  it("a challenge without a strong automatic marker (V21) is a possible reply: the company waits, the sender is told", async () => {
    const info = await w.makePerson(firma.id, "info@firma.de", "Firma Info");
    const camp = await w.makeCampaign({ createdById: ali.id });
    const infoSent = await w.sendEmail(camp, info);
    const posted = await postInbound(mg.fake, vectorInput(vector("V21")));
    await w.processAll();
    const row = await w.inbound(posted.id);
    expect(row).toMatchObject({ kind: "POSSIBLE_REPLY", autoReason: "challenge", linkMethod: "named-address", outboundEmailId: infoSent.emailId });
    expect(await w.recipient(infoSent.recipientId)).toMatchObject({ state: "HELD", holdReason: "possible-reply" });
    expect(await w.recipient(annaSent.recipientId)).toMatchObject({ state: "HELD", holdReason: "possible-reply" });
    expect(await replyNotifications(ali.id)).toContainEqual({
      type: "reply.attention",
      title: "Firma Info's spam filter is holding your email",
      body:
        "It asks you to confirm you're a person. Open the message in your own inbox if you want to; the app never clicks such links. " +
        "Follow-ups to Firma GmbH wait until you choose Real reply or It was an auto-reply.",
      link: `/notifications?reply=${row.id}#replies`,
    });
    const view = await getWaitingReply(owner, row.id);
    expect(view?.whyLines).toContain("It looks like a spam filter asking you to confirm you're a person.");
  });
});

describe("automatic messages nobody could link", () => {
  it("go only to the Owner's 'Messages we couldn't link' (V36), with no notification", async () => {
    const posted = await postInbound(mg.fake, vectorInput(vector("V36")));
    await w.processAll();
    const row = await w.inbound(posted.id);
    expect(row).toMatchObject({ kind: "AUTO_REPLY", autoReason: "out-of-office", companyId: null, assigneeId: null });
    expect((await replyNotifications(owner.id)).filter((n) => n.body?.includes("kari@butikk.no"))).toEqual([]);
    const others = await listOtherMessages(owner);
    expect(others).toContainEqual(expect.objectContaining({ id: row.id, fromEmail: "kari@butikk.no", subject: "Fråværsmelding", what: "out of office" }));
    expect(await listOtherMessages(ali)).toEqual([]);
    expect(await w.activities("reply.auto").then((a) => a.filter((x) => (x.data as { inboundId?: number }).inboundId === row.id))).toEqual([]);
  });
});
