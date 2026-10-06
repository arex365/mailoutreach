import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { INBOUND_URL, postInbound, replyInput, replyTo } from "../helpers/replies";
import type { sendEmail, TestCampaign } from "./world";

type SendOptions = NonNullable<Parameters<typeof sendEmail>[2]>;

/**
 * Special cases of reply processing (M4-DESIGN §3.7, §3.8, §5.5): twins, duplicate deliveries, the quiet M3 backlog,
 * a reply proving an email arrived, and the finish check.
 */

const t = await createTestDb("replies-edge");
const mg = await connectFakeMailgun();
const { db } = await import("@/server/db");
const w = await import("./world");
const { processPendingInbound, INBOUND_BATCH } = await import("@/server/services/replies");
const { handleInboundWebhook } = await import("@/server/services/mail-events/webhook");

let ali: Awaited<ReturnType<typeof w.makeSender>>;
let sara: Awaited<ReturnType<typeof w.makeSender>>;

beforeAll(async () => {
  await w.makeSender("Arslan", { role: "OWNER", local: "arslan" });
  ali = await w.makeSender("Ali");
  sara = await w.makeSender("Sara");
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

async function emailed(domain: string, campaign?: TestCampaign, opts: SendOptions = {}) {
  const camp = campaign ?? (await w.makeCampaign({ createdById: ali.id }));
  const company = await w.makeCompany(`Company ${domain}`, { domain });
  const person = await w.makePerson(company.id, `anna@${domain}`, "Anna Berg");
  return { camp, company, person, sent: await w.sendEmail(camp, person, opts) };
}

describe("twins and duplicates", () => {
  it("the same message (same Message-ID and sender) to ali@ and sara@ is processed once; the copy is a twin", async () => {
    const x = await emailed("twins.de");
    const input = replyInput(await db.outboundEmail.findUniqueOrThrow({ where: { id: x.sent.emailId } }), { messageId: "same-1@twins.de" });
    const toAli = await postInbound(mg.fake, input);
    const toSara = await postInbound(mg.fake, { ...input, to: sara.address! });
    await w.processAll();
    const first = await w.inbound(toAli.id);
    const twin = await w.inbound(toSara.id);
    expect(first).toMatchObject({ kind: "REPLY", answerOutcome: null });
    expect(twin).toMatchObject({ kind: "REPLY", answerOutcome: "duplicate", companyId: first.companyId, personId: first.personId, replyScope: "real", assigneeId: ali.id });
    expect((await w.activities("reply.received")).filter((a) => a.companyId === x.company.id).length).toBe(1);
    expect(await db.notification.count({ where: { link: `/notifications?reply=${twin.id}#replies` } })).toBe(0);
    expect(await db.notification.count({ where: { link: `/notifications?reply=${first.id}#replies` } })).toBe(1);
  });

  it("two rows without a Message-ID are never twins", async () => {
    const x = await emailed("no-message-id.de");
    const base = { fromEmail: "anna@no-message-id.de", subject: "Re: 3D models for your shop", snippet: "Yes!", receivedAt: new Date(Date.now() - w.HOUR), inReplyTo: x.sent.messageId, messageIdHeader: null };
    const one = await w.storeM3Reply(base);
    const two = await w.storeM3Reply({ ...base, toAddress: sara.address! });
    await w.processAll();
    expect(await w.inbound(one.id)).toMatchObject({ kind: "REPLY", answerOutcome: null });
    expect(await w.inbound(two.id)).toMatchObject({ kind: "REPLY", answerOutcome: null });
  });

  it("the notify POST delivered twice (a retry, or the catch-up) is stored and processed once", async () => {
    const x = await emailed("retried.de");
    const input = replyInput(await db.outboundEmail.findUniqueOrThrow({ where: { id: x.sent.emailId } }));
    const received = mg.fake.receive(input);
    for (let i = 0; i < 2; i++) {
      const res = await handleInboundWebhook(mg.fake.signedInboundRequest(INBOUND_URL, received.fields), { now: mg.fake.now() });
      expect(res.status).toBe(200);
    }
    await w.processAll();
    expect(await db.inboundMessage.count({ where: { fromEmail: "anna@retried.de" } })).toBe(1);
    expect((await w.activities("reply.received")).filter((a) => a.companyId === x.company.id).length).toBe(1);
  });
});

describe("the quiet backlog (M3 rows, long outages)", () => {
  it("45 old replies over 3 batches: every effect applies, no notification of their own, one grouped summary", async () => {
    const camp = await w.makeCampaign({ createdById: ali.id, name: "Backlog" });
    const rows: number[] = [];
    const recipients: number[] = [];
    for (let i = 0; i < 45; i++) {
      const company = await w.makeCompany(`Backlog ${i}`, { domain: `backlog${i}.de` });
      const person = await w.makePerson(company.id, `p@backlog${i}.de`, `Person ${i}`);
      const sent = await w.sendEmail(camp, person, { sentAt: new Date(Date.now() - 20 * w.DAY) });
      recipients.push(sent.recipientId);
      const row = await w.storeM3Reply({
        fromEmail: `p@backlog${i}.de`,
        subject: "Re: 3D models for your shop",
        snippet: "Sounds good, send prices.",
        receivedAt: new Date(Date.now() - (5 * w.DAY + i * 60_000)),
        inReplyTo: sent.messageId,
        references: sent.messageId,
      });
      rows.push(row.id);
    }
    const before = await w.notificationsOf(ali.id);
    const now = new Date();
    const failures = new Map();
    let processed = 0;
    for (let batch = 0; batch < 3; batch++) processed += (await processPendingInbound({ now, failures })).processed;
    expect(processed).toBe(45);
    expect(INBOUND_BATCH).toBe(20);
    for (const id of rows) expect(await w.inbound(id)).toMatchObject({ kind: "REPLY", assigneeId: ali.id });
    for (const id of recipients) expect(await w.recipient(id)).toMatchObject({ state: "STOPPED", stopReason: "replied" });
    const added = (await w.notificationsOf(ali.id)).slice(before.length).filter((n) => n.type.startsWith("reply."));
    expect(added.map((n) => n.type)).toEqual(["reply.summary"]);
    // Every company replied, so the campaign finished right away (finishCheck after each stop).
    expect(await db.campaign.findUniqueOrThrow({ where: { id: camp.id } })).toMatchObject({ status: "FINISHED" });
    expect((await w.activities("reply.received")).filter((a) => rows.includes((a.data as { inboundId: number }).inboundId)).length).toBe(45);
  });
});

describe("a reply proves the email it answers arrived (§3.7, D12)", () => {
  it("an UNKNOWN email becomes SENT; a SENDING one is left alone", async () => {
    const claimedAt = new Date(Date.now() - 2 * w.HOUR);
    const unknown = await emailed("unknown-status.de", undefined, { status: "UNKNOWN", providerId: null, claimedAt });
    const sending = await emailed("sending-status.de", undefined, { status: "SENDING", providerId: null, claimedAt });
    const a = await replyTo(mg.fake, unknown.sent.emailId);
    const b = await replyTo(mg.fake, sending.sent.emailId);
    await w.processAll();
    expect(await w.email(unknown.sent.emailId)).toMatchObject({ status: "SENT", sentAt: claimedAt });
    expect(await w.email(sending.sent.emailId)).toMatchObject({ status: "SENDING", sentAt: null });
    expect(await w.inbound(a.id)).toMatchObject({ kind: "REPLY", outboundEmailId: unknown.sent.emailId });
    expect(await w.inbound(b.id)).toMatchObject({ kind: "REPLY", outboundEmailId: sending.sent.emailId });
    expect(await w.recipient(unknown.sent.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "replied" });
  });
});

describe("the finish check", () => {
  it("a campaign whose last open company replied finishes in the same call", async () => {
    const camp = await w.makeCampaign({ createdById: ali.id, name: "Tiny" });
    const x = await emailed("last-company.de", camp);
    const posted = await replyTo(mg.fake, x.sent.emailId);
    const result = await processPendingInbound({ now: new Date(), failures: new Map() });
    expect(result.processed).toBeGreaterThan(0);
    expect(await w.inbound(posted.id)).toMatchObject({ kind: "REPLY" });
    expect(await db.campaign.findUniqueOrThrow({ where: { id: camp.id } })).toMatchObject({ status: "FINISHED" });
    expect(await w.notificationsOf(ali.id)).toContainEqual(expect.objectContaining({ type: "campaign.finished", title: "Tiny finished" }));
  });
});
