import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { postInbound, replyTo } from "../helpers/replies";

/**
 * Reply matching (SPEC "reply matching"; PLAN B12 "reply matching: headers, from-address, unlinked"; M4-DESIGN §3.3):
 * every reply goes through the fake Mailgun and the signed inbound webhook (store only), then the event lane's
 * `processPendingInbound`.
 */

const t = await createTestDb("replies-matching");
const mg = await connectFakeMailgun();
const { db } = await import("@/server/db");
const w = await import("./world");
const { getWaitingReply, markReplyNotNeeded, reopenReply, linkReply } = await import("@/server/services/replies");

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

const ALI = "ali@send.example.com";

async function activityFor(type: string, inboundId: number) {
  const rows = await w.activities(type);
  return rows.filter((a) => (a.data as { inboundId?: number } | null)?.inboundId === inboundId);
}

describe("linking by thread ids (§3.3.1)", () => {
  it("links a reply by In-Reply-To and stops the whole company in every campaign, dry runs included", async () => {
    const firma = await w.makeCompany("Firma GmbH", { domain: "firma1.de" });
    const anna = await w.makePerson(firma.id, "anna@firma1.de", "Anna Berg");
    const ben = await w.makePerson(firma.id, "ben@firma1.de", "Ben Braun");
    const live = await w.makeCampaign({ createdById: ali.id, name: "Germany Q4" });
    const dry = await w.makeCampaign({ createdById: ali.id, mode: "DRY_RUN", name: "Practice run" });
    const a = await w.sendEmail(live, anna);
    const b = await w.sendEmail(live, ben);
    const d = await w.sendEmail(dry, anna);

    const posted = await replyTo(mg.fake, a.emailId, { text: "Hi Ali,\nyes, please send prices.\n\nBest, Anna" });
    expect(posted.status).toBe(200);
    expect((await w.inbound(posted.id)).processedAt).toBeNull(); // the webhook only stores
    await w.processAll();

    const row = await w.inbound(posted.id);
    expect(row).toMatchObject({
      kind: "REPLY",
      linkMethod: "headers",
      outboundEmailId: a.emailId,
      personId: anna.id,
      companyId: firma.id,
      campaignId: live.id,
      replyScope: "real",
      changesStatus: false,
      assigneeId: ali.id,
      answeredAt: null,
      snippet: "Hi Ali, yes, please send prices.",
    });
    expect(await w.recipient(a.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "replied", stoppedByInboundId: row.id });
    expect(await w.recipient(b.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "company_replied", stoppedByInboundId: row.id });
    expect(await w.recipient(d.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "replied" });
    expect(await w.email(a.queuedId!)).toMatchObject({ status: "SKIPPED", lastError: "Stopped: they replied" });
    expect(await w.email(b.queuedId!)).toMatchObject({ status: "SKIPPED", lastError: "Stopped: someone at the company replied" });
    // LIVE before go-live (a test-list mailbox): stops, but the status and repliedAt stay (§3.6).
    expect(await db.company.findUniqueOrThrow({ where: { id: firma.id } })).toMatchObject({ status: "CONTACTED", repliedAt: null });

    expect(await w.notificationsOf(ali.id)).toContainEqual({
      type: "reply.received",
      title: "New reply from Firma GmbH",
      body: "Anna Berg replied to “3D models for your shop”.",
      link: `/notifications?reply=${row.id}#replies`,
    });
    const [act] = await activityFor("reply.received", row.id);
    expect(act).toMatchObject({
      summary: "Anna Berg replied: “Re: 3D models for your shop”",
      companyId: firma.id,
      personId: anna.id,
      campaignId: live.id,
      mode: "LIVE",
      actorId: null,
    });
    expect(act!.data).toMatchObject({ snippet: "Hi Ali, yes, please send prices.", linkMethod: "headers", replierPersonIds: [anna.id], emailId: a.emailId, step: 0 });
  });

  it("links by References only: an unknown colleague answers a forward (Anna replied, others company_replied)", async () => {
    const firma = await w.makeCompany("Firma Zwei", { domain: "firma2.de" });
    const anna = await w.makePerson(firma.id, "anna@firma2.de", "Anna Zwei");
    const ben = await w.makePerson(firma.id, "ben@firma2.de", "Ben Zwei");
    const camp = await w.makeCampaign({ createdById: ali.id });
    const a = await w.sendEmail(camp, anna);
    const b = await w.sendEmail(camp, ben);
    const posted = await postInbound(mg.fake, {
      from: "jonas@firma2.de",
      to: ALI,
      subject: "Re: 3D models for your shop",
      text: "Hi Ali, Anna forwarded me your email. We're interested in a set of dragon busts.",
      inReplyTo: "CAFwd123@mail.gmail.com",
      references: [a.messageId, "CAFwd123@mail.gmail.com"],
    });
    await w.processAll();
    const row = await w.inbound(posted.id);
    expect(row).toMatchObject({ kind: "REPLY", linkMethod: "headers", outboundEmailId: a.emailId, personId: anna.id, companyId: firma.id });
    expect(await w.recipient(a.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "replied" });
    expect(await w.recipient(b.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "company_replied" });
    const view = await getWaitingReply(owner, row.id);
    expect(view).toMatchObject({ fromIsContact: false, fromName: null, canAddPerson: true, company: { id: firma.id, name: "Firma Zwei" } });
    expect(await w.notificationsOf(ali.id)).toContainEqual(
      expect.objectContaining({ body: "jonas@firma2.de replied to your email to Anna Zwei (“3D models for your shop”)." }),
    );
    expect(await db.person.count({ where: { emailNorm: "jonas@firma2.de" } })).toBe(0); // never created by itself
  });

  it("a known colleague (Ben) answering Anna's email is the replier: Ben replied + repliedAt, Anna company_replied", async () => {
    await w.setSetting("sending.goLive", true);
    try {
      const firma = await w.makeCompany("Firma Drei", { domain: "firma3.de" });
      const anna = await w.makePerson(firma.id, "anna@firma3.de", "Anna Drei");
      const ben = await w.makePerson(firma.id, "ben@firma3.de", "Ben Braun");
      const camp = await w.makeCampaign({ createdById: ali.id });
      const a = await w.sendEmail(camp, anna);
      const b = await w.sendEmail(camp, ben);
      const posted = await replyTo(mg.fake, a.emailId, { from: "ben@firma3.de", text: "Ben here, we'd like a quote." });
      await w.processAll();
      const row = await w.inbound(posted.id);
      expect(row).toMatchObject({ kind: "REPLY", personId: anna.id, replyScope: "real", changesStatus: true });
      expect(await w.recipient(b.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "replied" });
      expect(await w.recipient(a.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "company_replied" });
      expect(await db.company.findUniqueOrThrow({ where: { id: firma.id } })).toMatchObject({ status: "REPLIED", repliedAt: row.receivedAt });
      expect((await db.person.findUniqueOrThrow({ where: { id: ben.id } })).repliedAt).toEqual(row.receivedAt);
      expect((await db.person.findUniqueOrThrow({ where: { id: anna.id } })).repliedAt).toBeNull();
      const [status] = (await w.activities("company.status")).filter((x) => x.companyId === firma.id);
      expect(status).toMatchObject({ summary: "Status changed to Replied: ben@firma3.de replied", actorId: null, mode: "LIVE" });
      expect(status!.data).toMatchObject({ from: "CONTACTED", to: "REPLIED", automatic: true });
      expect(await w.notificationsOf(ali.id)).toContainEqual(
        expect.objectContaining({ body: "Ben Braun replied to your email to Anna Drei (“3D models for your shop”)." }),
      );
      const [act] = await activityFor("reply.received", row.id);
      expect(act!.summary).toBe("Ben Braun replied to the email to Anna Drei: “Re: 3D models for your shop”");
    } finally {
      await w.setSetting("sending.goLive", false);
    }
  });

  it("a real message quoting a dry-run id on real data is not linked by it (dry runs never leave the PC)", async () => {
    const shop = await w.makeCompany("Dry Shop", { domain: null });
    const dora = await w.makePerson(shop.id, "dora@dryshop.de", "Dora", { deleted: true });
    const dry = await w.makeCampaign({ createdById: ali.id, mode: "DRY_RUN" });
    const d = await w.sendEmail(dry, dora);
    const posted = await replyTo(mg.fake, d.emailId);
    await w.processAll();
    expect(await w.inbound(posted.id)).toMatchObject({ kind: "UNLINKED", outboundEmailId: null, companyId: null });
    expect(await w.recipient(d.recipientId)).toMatchObject({ state: "WAITING" });
  });
});

describe("linking by the sender's address (§3.3.3): the 90 days count back from the arrival", () => {
  it("links a backlog reply to the email sent 89 days before it arrived, never to one sent after", async () => {
    const studio = await w.makeCompany("Studio Vier", { domain: null });
    // A removed contact: only the from-address rule can link it (a live contact would link by §3.3.3b).
    const olga = await w.makePerson(studio.id, "olga@studio4.de", "Olga Vier", { deleted: true });
    const first = await w.makeCampaign({ createdById: ali.id, name: "Autumn" });
    const later = await w.makeCampaign({ createdById: ali.id, name: "Winter" });
    const now = Date.now();
    const arrival = new Date(Math.floor((now - 10 * w.DAY) / 1000) * 1000);
    const old = await w.sendEmail(first, olga, { sentAt: new Date(arrival.getTime() - 89 * w.DAY) });
    await w.sendEmail(later, olga, { sentAt: new Date(now - 5 * w.DAY) });

    mg.fake.setNow(() => arrival);
    let posted;
    try {
      posted = await postInbound(mg.fake, { from: "olga@studio4.de", to: ALI, subject: "Question", text: "Do you also make figurines?" });
    } finally {
      mg.fake.setNow(() => new Date());
    }
    await w.processAll();
    const row = await w.inbound(posted.id);
    expect(row.receivedAt.getTime()).toBe(arrival.getTime());
    expect(row).toMatchObject({ kind: "REPLY", linkMethod: "from", outboundEmailId: old.emailId, campaignId: first.id, companyId: studio.id });
    // Quiet (arrived more than 3 days before processing): no notification of its own, one grouped summary instead.
    const mine = await w.notificationsOf(ali.id);
    expect(mine.filter((n) => n.link === `/notifications?reply=${row.id}#replies`)).toEqual([]);
    expect(mine).toContainEqual({
      type: "reply.summary",
      title: "Older replies were found",
      body: "They arrived more than 3 days ago, while the app couldn't process them. They're on Replies waiting for an answer.",
      link: "/notifications#replies",
    });
    expect((await getWaitingReply(owner, row.id))?.quietLine).toMatch(/^Arrived on \d{1,2} \w+, before the app processed replies\.$/);
  });

  it("leaves a reply unlinked when the email went out 91 days before it arrived, with the removed-contact hint", async () => {
    const studio = await w.makeCompany("Studio Fünf", { domain: null });
    const greta = await w.makePerson(studio.id, "greta@studio5.de", "Greta Fünf", { deleted: true });
    const camp = await w.makeCampaign({ createdById: ali.id });
    await w.sendEmail(camp, greta, { sentAt: new Date(Date.now() - 91 * w.DAY) });
    const posted = await postInbound(mg.fake, { from: "greta@studio5.de", to: ALI, subject: "Your offer", text: "Is this still valid?" });
    await w.processAll();
    const row = await w.inbound(posted.id);
    expect(row).toMatchObject({ kind: "UNLINKED", linkMethod: null, outboundEmailId: null, companyId: null, replyScope: "none", assigneeId: ali.id });
    const view = await getWaitingReply(owner, row.id);
    expect(view?.hints).toContain(`greta@studio5.de was Greta Fünf at Studio Fünf (C-${studio.id}), who was removed.`);
    expect(await w.notificationsOf(ali.id)).toContainEqual({
      type: "reply.unlinked",
      title: "A reply we couldn't link to a company",
      body: "From greta@studio5.de: “Your offer”. Link it to a company so the right follow-ups stop.",
      link: `/notifications?reply=${row.id}#replies`,
    });
    const [act] = await activityFor("reply.unlinked", row.id);
    expect(act).toMatchObject({ summary: "Reply from greta@studio5.de that couldn't be linked to a company", companyId: null });
  });

  it("never matches TEST (Mailgun test mode) emails by address", async () => {
    const co = await w.makeCompany("Test Mode Co", { domain: null });
    const tess = await w.makePerson(co.id, "tess@testmode.de", "Tess");
    const camp = await w.makeCampaign({ createdById: ali.id, mode: "TEST" });
    const sent = await w.sendEmail(camp, tess, { sentAt: new Date(Date.now() - w.DAY) });
    const posted = await postInbound(mg.fake, { from: "tess@testmode.de", to: ALI, subject: "Hello", text: "Nice to hear from you." });
    await w.processAll();
    const row = await w.inbound(posted.id);
    // Linked to her company by her exact address (§3.3.3b), not to the TEST email.
    expect(row).toMatchObject({ kind: "REPLY", linkMethod: "person", outboundEmailId: null, companyId: co.id, personId: tess.id, replyScope: "real" });
    expect(await w.recipient(sent.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "replied" });
  });
});

describe("known contact (§3.3.3b)", () => {
  it("Ben, a contact at Firma who was never emailed, writes a new email: REPLY by person, Firma stopped", async () => {
    const firma = await w.makeCompany("Firma Acht", { domain: "firma8.de" });
    const anna = await w.makePerson(firma.id, "anna@firma8.de", "Anna Acht");
    await w.makePerson(firma.id, "ben@firma8.de", "Ben Braun");
    const camp = await w.makeCampaign({ createdById: ali.id });
    const a = await w.sendEmail(camp, anna, { sentAt: new Date(Date.now() - 10 * w.DAY) });
    const posted = await postInbound(mg.fake, { from: "ben@firma8.de", to: ALI, subject: "Question about prices", text: "What do 10 busts cost?" });
    await w.processAll();
    const row = await w.inbound(posted.id);
    expect(row).toMatchObject({ kind: "REPLY", linkMethod: "person", outboundEmailId: a.emailId, personId: anna.id, companyId: firma.id, replyScope: "real", changesStatus: false });
    expect(await w.recipient(a.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "company_replied" });
    expect(await w.notificationsOf(ali.id)).toContainEqual(expect.objectContaining({ body: "Ben Braun wrote to you: “Question about prices”." }));
    const [act] = await activityFor("reply.received", row.id);
    expect(act!.summary).toBe("Ben Braun wrote: “Question about prices”");
  });
});

describe("domain hold (§3.3.4)", () => {
  it("holds the one company on the sender's domain; No answer needed releases, Undo holds again, Link elsewhere releases", async () => {
    const firma = await w.makeCompany("Firma Neun", { domain: "firma9.de" });
    const anna = await w.makePerson(firma.id, "anna@firma9.de", "Anna Neun");
    const other = await w.makeCompany("Elsewhere Ltd", { domain: "elsewhere9.de" });
    const camp = await w.makeCampaign({ createdById: ali.id });
    const a = await w.sendEmail(camp, anna);
    const posted = await postInbound(mg.fake, { from: "jonas@firma9.de", to: ALI, subject: "Your 3D offer", text: "Do you also do busts?" });
    await w.processAll();
    const row = await w.inbound(posted.id);
    expect(row).toMatchObject({ kind: "UNLINKED", heldCompanyId: firma.id, companyId: null, assigneeId: ali.id });
    expect(await w.recipient(a.recipientId)).toMatchObject({ state: "HELD", holdReason: "possible-reply" });
    expect(await w.email(a.queuedId!)).toMatchObject({ status: "QUEUED" });
    const view = await getWaitingReply(owner, row.id);
    expect(view?.hints).toEqual([
      `Same domain as Firma Neun (C-${firma.id}).`,
      "Follow-ups to Firma Neun wait until you link this reply or mark it.",
    ]);
    expect(view?.hintCompanyId).toBe(firma.id);
    expect(await w.notificationsOf(ali.id)).toContainEqual(
      expect.objectContaining({
        type: "reply.unlinked",
        body: "From jonas@firma9.de: “Your 3D offer”. Link it to a company so the right follow-ups stop. Follow-ups to Firma Neun wait until you do.",
      }),
    );
    const [act] = await activityFor("reply.unlinked", row.id);
    expect(act).toMatchObject({
      summary: "Reply from jonas@firma9.de that couldn't be linked to a company (follow-ups to Firma Neun wait)",
      companyId: firma.id,
    });

    await markReplyNotNeeded(sara, row.id);
    expect(await w.recipient(a.recipientId)).toMatchObject({ state: "WAITING", holdReason: null, heldAt: null });
    await reopenReply(sara, row.id);
    expect(await w.recipient(a.recipientId)).toMatchObject({ state: "HELD", holdReason: "possible-reply" });

    await linkReply(sara, row.id, { companyId: other.id, addPerson: false });
    expect(await w.recipient(a.recipientId)).toMatchObject({ state: "WAITING", holdReason: null });
    expect(await w.inbound(row.id)).toMatchObject({ kind: "REPLY", companyId: other.id, heldCompanyId: null, linkMethod: "manual" });
  });

  it("Link to the held company turns the hold into the stop", async () => {
    const firma = await w.makeCompany("Firma Zehn", { domain: "firma10.de" });
    const anna = await w.makePerson(firma.id, "anna@firma10.de", "Anna Zehn");
    const camp = await w.makeCampaign({ createdById: ali.id });
    const a = await w.sendEmail(camp, anna);
    const posted = await postInbound(mg.fake, { from: "jonas@firma10.de", to: ALI, subject: "Your 3D offer", text: "Hello!" });
    await w.processAll();
    expect(await w.recipient(a.recipientId)).toMatchObject({ state: "HELD" });
    await linkReply(sara, posted.id!, { companyId: firma.id, addPerson: false });
    expect(await w.recipient(a.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "replied", holdReason: null });
  });

  it("never holds for shared or free-mail domains, nor when two companies share the domain", async () => {
    const one = await w.makeCompany("Shared One", { domain: "twins11.de" });
    const two = await w.makeCompany("Shared Two", { domain: "twins11.de" });
    const camp = await w.makeCampaign({ createdById: ali.id });
    const p1 = await w.makePerson(one.id, "a@twins11.de", "A");
    const p2 = await w.makePerson(two.id, "b@twins11.de", "B");
    await w.sendEmail(camp, p1);
    await w.sendEmail(camp, p2);
    const shared = await postInbound(mg.fake, { from: "c@twins11.de", to: ALI, subject: "Hi", text: "Hello" });
    const gmail = await postInbound(mg.fake, { from: "someone@gmail.com", to: ALI, subject: "Hi", text: "Hello" });
    await w.processAll();
    expect(await w.inbound(shared.id)).toMatchObject({ kind: "UNLINKED", heldCompanyId: null });
    expect(await w.inbound(gmail.id)).toMatchObject({ kind: "UNLINKED", heldCompanyId: null });
  });
});

describe("our own senders and test emails (§3.3.0, §3.3.1)", () => {
  it("a team member forwarding a reply to a colleague changes nothing (TEST_REPLY, internal)", async () => {
    const firma = await w.makeCompany("Firma Elf", { domain: "firma11.de" });
    const anna = await w.makePerson(firma.id, "anna@firma11.de", "Anna Elf");
    const camp = await w.makeCampaign({ createdById: ali.id });
    const a = await w.sendEmail(camp, anna);
    const forward = await postInbound(mg.fake, {
      from: ali.email,
      to: sara.address!,
      subject: "Fwd: Re: 3D models for your shop",
      text: "FYI, see Anna's answer below.",
      references: [a.messageId],
      inReplyTo: a.messageId,
    });
    const fromDomain = await postInbound(mg.fake, { from: "robot@send.example.com", to: ALI, subject: "Note", text: "Internal" });
    await w.processAll();
    expect(await w.inbound(forward.id)).toMatchObject({ kind: "TEST_REPLY", autoReason: "internal", companyId: null, replyScope: "none", assigneeId: null });
    expect(await w.inbound(fromDomain.id)).toMatchObject({ kind: "TEST_REPLY", autoReason: "internal" });
    expect(await w.recipient(a.recipientId)).toMatchObject({ state: "WAITING" });
    expect((await w.notificationsOf(sara.id)).filter((n) => n.type.startsWith("reply."))).toEqual([]);
    expect(await getWaitingReply(owner, forward.id!)).toBeNull();
  });

  it("a test-list mailbox that is also a user's login email answering its campaign email is a reply (REPLY-01)", async () => {
    const { dbWrite } = await import("@/server/db");
    // Someone signs in with their personal Gmail, has a separate reply inbox, and put the Gmail on the test list.
    const gmail = "arslan.personal@gmail.com";
    await dbWrite((c) => c.user.create({ data: { name: "Arslan Personal", email: gmail, role: "MEMBER", replyInbox: "contact@polygonparadise.test" } }));
    await w.setSetting("sending.testList", [gmail]);
    try {
      const testCo = await w.makeCompany("Test – Gmail");
      const mailbox = await w.makePerson(testCo.id, gmail, "Arslan Personal");
      const camp = await w.makeCampaign({ createdById: ali.id, name: "Test list run" });
      const sent = await w.sendEmail(camp, mailbox);
      const posted = await replyTo(mg.fake, sent.emailId, { text: "Got it, this looks good. Can you send prices?" });
      await w.processAll();

      const row = await w.inbound(posted.id);
      expect(row).toMatchObject({
        kind: "REPLY",
        autoReason: null,
        linkMethod: "headers",
        outboundEmailId: sent.emailId,
        companyId: testCo.id,
        replyScope: "real",
        assigneeId: ali.id,
      });
      // The follow-up to the mailbox that replied is cancelled, it waits for an answer, and the sender is told.
      expect(await w.recipient(sent.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "replied" });
      expect(await w.email(sent.queuedId!)).toMatchObject({ status: "SKIPPED" });
      expect(await getWaitingReply(owner, row.id)).not.toBeNull();
      expect(await w.notificationsOf(ali.id)).toContainEqual(
        expect.objectContaining({ type: "reply.received", link: `/notifications?reply=${row.id}#replies` }),
      );

      // The same person forwarding a prospect's reply is still a note from the team: it points at the email to Anna.
      const firma = await w.makeCompany("Firma Dreizehn", { domain: "firma13.de" });
      const anna = await w.makePerson(firma.id, "anna@firma13.de", "Anna Dreizehn");
      const a = await w.sendEmail(camp, anna);
      const forward = await postInbound(mg.fake, {
        from: gmail,
        to: ALI,
        subject: "Fwd: Re: 3D models for your shop",
        text: "FYI, Anna answered.",
        inReplyTo: a.messageId,
        references: [a.messageId],
      });
      await w.processAll();
      expect(await w.inbound(forward.id)).toMatchObject({ kind: "TEST_REPLY", autoReason: "internal", companyId: null });
      expect(await w.recipient(a.recipientId)).toMatchObject({ state: "WAITING" });
    } finally {
      await w.setSetting("sending.testList", []);
    }
  });

  it("a reply-test reply from the test mailbox is a TEST_REPLY; a prospect answering a forwarded test email is linked on", async () => {
    await w.setSetting("sending.testList", ["gmail.tester@gmail.com"]);
    const replyTest = await db.testSend.create({
      data: {
        userId: owner.id,
        to: "gmail.tester@gmail.com",
        subject: "Reply test",
        mode: "LIVE",
        purpose: "REPLY_TEST",
        messageId: w.ourId(),
        status: "SENT",
        sentAt: new Date(Date.now() - 60_000),
      },
    });
    const selfTest = await db.testSend.create({
      data: { userId: ali.id, to: ali.email, subject: "Test", mode: "LIVE", purpose: "SELF", messageId: w.ourId(), status: "SENT" },
    });
    const pros = await w.makeCompany("Prospect Zwölf", { domain: "prospect12.de" });
    const pia = await w.makePerson(pros.id, "pia@prospect12.de", "Pia");
    const camp = await w.makeCampaign({ createdById: ali.id });
    const p = await w.sendEmail(camp, pia, { sentAt: new Date(Date.now() - 2 * w.DAY) });

    const tester = await postInbound(mg.fake, {
      from: "gmail.tester@gmail.com",
      to: owner.address!,
      subject: "Re: Reply test",
      text: "Got it.",
      inReplyTo: replyTest.messageId!,
    });
    const prospect = await postInbound(mg.fake, {
      from: "pia@prospect12.de",
      to: ALI,
      subject: "Re: Test",
      text: "Your colleague forwarded this. Interested!",
      inReplyTo: selfTest.messageId!,
    });
    await w.processAll();
    const testRow = await w.inbound(tester.id);
    expect(testRow).toMatchObject({ kind: "TEST_REPLY", autoReason: null, companyId: null, assigneeId: null });
    // The reply test reads fromEmail and toAddress only: its page still says "Reply reached the app".
    expect(testRow).toMatchObject({ fromEmail: "gmail.tester@gmail.com", toAddress: owner.address });
    const { loadReplyTest } = await import("@/server/services/reply-test");
    expect((await loadReplyTest()).facts.get("gmail.tester@gmail.com")).toMatchObject({ testSendId: replyTest.id, replyStored: true });
    expect(await w.inbound(prospect.id)).toMatchObject({ kind: "REPLY", linkMethod: "from", outboundEmailId: p.emailId });
    expect(await w.recipient(p.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "replied" });
    await w.setSetting("sending.testList", []);
  });
});
