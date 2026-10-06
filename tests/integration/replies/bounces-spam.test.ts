import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { postInbound, replyTo, vectorInput } from "../helpers/replies";
import { A, vector } from "../../unit/replies-core/vectors";

/**
 * Delivery-failure notices that reach our reply address, and messages Mailgun marked as spam (M4-DESIGN §3.3.2, §3.5,
 * D9): a notice stops only the address it is about (no suppression, no person flag); spam that can't be linked is
 * listed for the Owner only.
 */

const t = await createTestDb("replies-bounces");
const mg = await connectFakeMailgun();
const { db } = await import("@/server/db");
const w = await import("./world");
const { getWaitingReply, listOtherMessages } = await import("@/server/services/replies");

let owner: Awaited<ReturnType<typeof w.makeSender>>;
let ali: Awaited<ReturnType<typeof w.makeSender>>;

beforeAll(async () => {
  owner = await w.makeSender("Arslan", { role: "OWNER", local: "arslan" });
  ali = await w.makeSender("Ali");
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

/** A person emailed in two LIVE campaigns, with a colleague in the first. */
async function world(domain: string, local = "anna", name = "Anna Berg") {
  const company = await w.makeCompany(`Company ${domain}`, { domain });
  const person = await w.makePerson(company.id, `${local}@${domain}`, name);
  const colleague = await w.makePerson(company.id, `ben@${domain}`, "Ben Braun");
  const one = await w.makeCampaign({ createdById: ali.id });
  const two = await w.makeCampaign({ createdById: ali.id });
  const sent = await w.sendEmail(one, person);
  const other = await w.sendEmail(two, person);
  const ben = await w.sendEmail(one, colleague);
  return { company, person, one, two, sent, other, ben, address: `${local}@${domain}` };
}

describe("delivery-failure notices", () => {
  it("V14 (our id quoted in the text): that address stops in every campaign, no suppression, no person flag", async () => {
    const x = await world("firma14.de");
    const posted = await postInbound(mg.fake, vectorInput(vector("V14"), { ids: { [A]: x.sent.messageId, "anna@firma.de": x.address } }));
    await w.processAll();
    const row = await w.inbound(posted.id);
    expect(row).toMatchObject({ kind: "BOUNCE_NOTICE", autoReason: "dsn", linkMethod: "body-id", outboundEmailId: x.sent.emailId, companyId: x.company.id });
    expect(await w.recipient(x.sent.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "bounced", stoppedByInboundId: row.id });
    expect(await w.recipient(x.other.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "bounced" });
    expect(await w.email(x.sent.queuedId!)).toMatchObject({ status: "SKIPPED", lastError: "Stopped: this address bounced" });
    expect(await w.recipient(x.ben.recipientId)).toMatchObject({ state: "WAITING" });
    expect(await db.suppression.findUnique({ where: { emailNorm: x.address } })).toBeNull();
    expect((await db.person.findUniqueOrThrow({ where: { id: x.person.id } })).bouncedAt).toBeNull();
    expect(await w.notificationsOf(ali.id)).toContainEqual({
      type: "reply.bounce",
      title: `An email to ${x.address} couldn't be delivered`,
      body: "A mail server sent back a delivery failure notice, so the follow-ups to this address stopped.",
      link: `/campaigns/${x.one.id}?recipient=${x.sent.recipientId}`,
    });
    const [act] = (await w.activities("reply.bounce")).filter((a) => a.companyId === x.company.id);
    expect(act?.summary).toBe(`Delivery failure notice for ${x.address}: follow-ups to this address stopped`);
    expect(await getWaitingReply(owner, row.id)).toBeNull();
  });

  it("V15 (only the failed address, an Exim bounce carrying Auto-Submitted): linked by that address and stopped", async () => {
    const x = await world("firma15.de", "carl", "Carl Weber");
    const posted = await postInbound(mg.fake, vectorInput(vector("V15"), { ids: { "anna@firma.de": x.address } }));
    await w.processAll();
    expect(await w.inbound(posted.id)).toMatchObject({ kind: "BOUNCE_NOTICE", linkMethod: "bounce-address", outboundEmailId: x.other.emailId });
    expect(await w.recipient(x.sent.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "bounced" });
    expect(await w.recipient(x.other.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "bounced" });
  });

  it("in campaign scope (Mailgun's test mode) only that one recipient stops", async () => {
    const company = await w.makeCompany("Test Mode Shop", { domain: "testshop.de" });
    const dana = await w.makePerson(company.id, "dana@testshop.de", "Dana");
    const test = await w.makeCampaign({ createdById: ali.id, mode: "TEST" });
    const live = await w.makeCampaign({ createdById: ali.id });
    const t1 = await w.sendEmail(test, dana);
    const l1 = await w.sendEmail(live, dana);
    const posted = await postInbound(mg.fake, vectorInput(vector("V14"), { ids: { [A]: t1.messageId, "anna@firma.de": "dana@testshop.de" } }));
    await w.processAll();
    expect(await w.inbound(posted.id)).toMatchObject({ kind: "BOUNCE_NOTICE", replyScope: "campaign", outboundEmailId: t1.emailId });
    expect(await w.recipient(t1.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "bounced" });
    expect(await w.recipient(l1.recipientId)).toMatchObject({ state: "WAITING" });
    expect(await w.notificationsOf(ali.id)).toContainEqual(expect.objectContaining({ title: "Test: An email to dana@testshop.de couldn't be delivered" }));
  });

  it("a notice naming only another address (a forward from the person's mailbox failed): nothing stops, the sender is told once", async () => {
    const x = await world("firma16.de");
    const input = () => vectorInput(vector("V14"), { ids: { [A]: x.sent.messageId, "anna@firma.de": "anna.private@home16.de" } });
    const posted = await postInbound(mg.fake, input());
    await w.processAll();
    const row = await w.inbound(posted.id);
    expect(row).toMatchObject({ kind: "BOUNCE_NOTICE", linkMethod: "body-id", outboundEmailId: x.sent.emailId });
    expect(await w.recipient(x.sent.recipientId)).toMatchObject({ state: "WAITING" });
    expect(await w.recipient(x.other.recipientId)).toMatchObject({ state: "WAITING" });
    const attention = (await w.notificationsOf(ali.id)).filter((n) => n.type === "reply.attention" && n.title.includes("forward"));
    expect(attention).toEqual([
      {
        type: "reply.attention",
        title: "A forward from Anna Berg's mailbox failed",
        body: "Anna's mailbox passed your email on to another address, and that address doesn't work. Anna's own address is fine, so their follow-ups continue.",
        link: `/campaigns/${x.one.id}?recipient=${x.sent.recipientId}`,
      },
    ]);
    const [act] = (await w.activities("reply.bounce")).filter((a) => a.companyId === x.company.id);
    expect(act?.summary).toBe(`Delivery failure notice after ${x.address}'s mailbox forwarded the email: follow-ups continue`);
    // The forward fails again at the next follow-up: timeline only.
    await postInbound(mg.fake, input());
    await w.processAll();
    expect((await w.notificationsOf(ali.id)).filter((n) => n.type === "reply.attention" && n.title.includes("forward")).length).toBe(1);
  });

  it("a delay notice (V18) stops nothing and notifies nobody", async () => {
    const x = await world("firma18.de");
    const before = (await w.notificationsOf(ali.id)).length;
    const posted = await postInbound(mg.fake, vectorInput(vector("V18"), { ids: { "anna@firma.de": x.address } }));
    await w.processAll();
    expect(await w.inbound(posted.id)).toMatchObject({ kind: "BOUNCE_NOTICE", autoReason: "delay", linkMethod: "bounce-address" });
    expect(await w.recipient(x.sent.recipientId)).toMatchObject({ state: "WAITING" });
    expect((await w.notificationsOf(ali.id)).length).toBe(before);
    const [act] = (await w.activities("reply.bounce")).filter((a) => a.companyId === x.company.id);
    expect(act?.summary).toBe(`Delivery delay notice for ${x.address} (the other server is still trying)`);
  });
});

describe("messages Mailgun marked as spam", () => {
  it("unlinked spam: no notification, not waiting, listed for the Owner as 'marked as spam by Mailgun'", async () => {
    const posted = await postInbound(mg.fake, {
      from: "offers@bulk-mailer.example",
      to: "ali@send.example.com",
      subject: "Grow your sales 300% this month",
      text: "Get more customers today. Reply to this email to learn how.",
      headers: [
        ["X-Mailgun-Sflag", "Yes"],
        ["X-Mailgun-Sscore", "12.5"],
      ],
    });
    await w.processAll();
    const row = await w.inbound(posted.id);
    expect(row).toMatchObject({ kind: "UNLINKED", autoReason: "spam", answerOutcome: "spam", assigneeId: null, heldCompanyId: null });
    expect(row.answeredAt).toBeInstanceOf(Date);
    expect((await w.notificationsOf(ali.id)).filter((n) => n.body?.includes("offers@bulk-mailer.example"))).toEqual([]);
    expect(await getWaitingReply(owner, row.id)).toBeNull();
    expect(await listOtherMessages(owner)).toContainEqual(
      expect.objectContaining({ id: row.id, fromEmail: "offers@bulk-mailer.example", what: "marked as spam by Mailgun" }),
    );
    expect((await w.activities("reply.unlinked")).filter((a) => (a.data as { inboundId?: number }).inboundId === row.id)).toEqual([]);
  });

  it("the same flag on a reply to one of our emails is ignored: a normal REPLY", async () => {
    const x = await world("firma20.de");
    const posted = await replyTo(mg.fake, x.sent.emailId, { headers: [["X-Mailgun-Sflag", "Yes"]] });
    await w.processAll();
    const row = await w.inbound(posted.id);
    expect(row).toMatchObject({ kind: "REPLY", autoReason: null, answerOutcome: null });
    expect(row.signals).toContain("mailgun-spam");
    expect(await w.recipient(x.sent.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "replied" });
    expect(await w.notificationsOf(ali.id)).toContainEqual(expect.objectContaining({ type: "reply.received", title: `New reply from Company firma20.de` }));
  });
});
