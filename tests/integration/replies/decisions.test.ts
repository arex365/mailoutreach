import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { postInbound, replyTo, vectorInput } from "../helpers/replies";
import { vector } from "../../unit/replies-core/vectors";

/**
 * The decisions on "Replies waiting for an answer" (M4-DESIGN §3.5 "Decisions", §4, D17): everyone may act on any
 * waiting reply, every action is logged with who did it, and each error says what to do.
 */

const t = await createTestDb("replies-decisions");
const mg = await connectFakeMailgun();
const { db } = await import("@/server/db");
const w = await import("./world");
const r = await import("@/server/services/replies");

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

async function emailed(domain: string, name = "Anna Berg") {
  const company = await w.makeCompany(`Company ${domain}`, { domain: null });
  const person = await w.makePerson(company.id, `anna@${domain}`, name);
  const camp = await w.makeCampaign({ createdById: ali.id, name: `Campaign ${domain}` });
  const sent = await w.sendEmail(camp, person);
  return { company, person, camp, sent };
}

/** A processed reply from a stranger that nobody could link. */
async function unlinked(from: string, subject = "Your 3D offer") {
  const posted = await postInbound(mg.fake, { from, fromName: "Jonas Klein", to: "ali@send.example.com", subject, text: "Do you also do busts?" });
  await w.processAll();
  return posted.id!;
}

describe("Answered, No answer needed and Undo", () => {
  it("a Member answers a teammate's reply: allowed and logged with the Member's name; twice → who did it", async () => {
    const x = await emailed("answered.de");
    const posted = await replyTo(mg.fake, x.sent.emailId);
    await w.processAll();
    const id = posted.id!;
    expect(await r.markReplyAnswered(sara, id)).toEqual({ message: "Marked as answered." });
    expect(await w.inbound(id)).toMatchObject({ answeredById: sara.id, answerOutcome: "answered" });
    const [act] = (await w.activities("reply.answered")).filter((a) => a.companyId === x.company.id);
    expect(act).toMatchObject({ actorId: sara.id, summary: "Sara answered the reply from anna@answered.de", personId: x.person.id });
    await expect(r.markReplyAnswered(ali, id)).rejects.toThrow("This reply was already handled by Sara. Refresh the page to see it.");
    await expect(r.markReplyNotNeeded(ali, id)).rejects.toThrow("This reply was already handled by Sara. Refresh the page to see it.");
    expect(await r.getWaitingReply(owner, id)).toBeNull();

    expect(await r.reopenReply(ali, id)).toEqual({ message: "The reply is back on the waiting list." });
    expect(await w.inbound(id)).toMatchObject({ answeredAt: null, answeredById: null, answerOutcome: null });
    const [reopened] = (await w.activities("reply.reopened")).filter((a) => a.companyId === x.company.id);
    expect(reopened?.summary).toBe("Ali put the reply from anna@answered.de back on the waiting list");
    await expect(r.reopenReply(ali, id)).rejects.toThrow("This reply is already waiting for an answer.");

    expect(await r.markReplyNotNeeded(ali, id)).toEqual({ message: "Marked as needing no answer." });
    const [notNeeded] = (await w.activities("reply.notNeeded")).filter((a) => a.companyId === x.company.id);
    expect(notNeeded?.summary).toBe("Ali marked the reply from anna@answered.de as needing no answer");
  });

  it("an unlinked reply may be answered too; a message that isn't waiting is refused plainly", async () => {
    const id = await unlinked("jonas@unlinked-answer.de");
    expect(await r.markReplyAnswered(ali, id)).toEqual({ message: "Marked as answered." });
    await expect(r.markReplyAnswered(ali, 999_999)).rejects.toThrow("This reply isn't on the list any more. Refresh the page.");
    const x = await emailed("auto-only.de");
    const auto = await postInbound(mg.fake, vectorInput(vector("V03"), { overrides: { from: "anna@auto-only.de", inReplyTo: x.sent.messageId, references: [x.sent.messageId] } }));
    await w.processAll();
    expect(await w.inbound(auto.id)).toMatchObject({ kind: "AUTO_REPLY" });
    await expect(r.markReplyAnswered(ali, auto.id!)).rejects.toThrow("This reply isn't on the list any more. Refresh the page.");
    await expect(r.confirmReply(ali, auto.id!, true)).rejects.toThrow("This reply isn't on the list any more. Refresh the page.");
  });
});

describe("Link to a company", () => {
  it("with Add as a person: the sender becomes a contact, the company stops, the email's person and sender are used", async () => {
    const x = await emailed("link-add.de");
    const id = await unlinked("jonas@link-add.de");
    expect(await w.inbound(id)).toMatchObject({ kind: "UNLINKED", assigneeId: ali.id });
    const res = await r.linkReply(sara, id, { companyId: x.company.id, personId: null, addPerson: true });
    expect(res).toEqual({ message: `Linked to ${x.company.name}. Its follow-ups stopped.` });
    const jonas = await db.person.findUniqueOrThrow({ where: { emailNorm: "jonas@link-add.de" } });
    expect(jonas).toMatchObject({ companyId: x.company.id, name: "Jonas Klein" });
    expect(await w.inbound(id)).toMatchObject({
      kind: "REPLY",
      linkMethod: "manual",
      companyId: x.company.id,
      personId: x.person.id, // "Not one of these people": the person the email went to
      outboundEmailId: x.sent.emailId,
      campaignId: x.camp.id,
      replyScope: "real",
      changesStatus: false, // from the email: LIVE before go-live
      assigneeId: ali.id,
      confirmedById: sara.id,
    });
    // Jonas (now a contact) is the replier; Anna the colleague.
    expect(await w.recipient(x.sent.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "company_replied" });
    const linked = (await w.activities("reply.linked")).filter((a) => a.companyId === x.company.id);
    expect(linked.map((a) => [a.summary, a.actorId])).toEqual([[`Sara linked the reply from jonas@link-add.de to ${x.company.name}`, sara.id]]);
    const [received] = (await w.activities("reply.received")).filter((a) => a.companyId === x.company.id);
    expect(received?.summary).toBe("Jonas Klein replied (linked by Sara): “Your 3D offer”");
    expect(await r.getWaitingReply(owner, id)).toMatchObject({ kind: "REPLY", fromIsContact: true, fromName: "Jonas Klein", canAddPerson: false });
  });

  it("the chosen person is kept; without Add the sender stays unknown", async () => {
    const x = await emailed("link-person.de");
    const ben = await w.makePerson(x.company.id, "ben@link-person.de", "Ben Braun");
    const id = await unlinked("jonas@link-person.de");
    await r.linkReply(ali, id, { companyId: x.company.id, personId: ben.id, addPerson: false });
    expect(await w.inbound(id)).toMatchObject({ kind: "REPLY", personId: ben.id, outboundEmailId: x.sent.emailId });
    expect(await db.person.count({ where: { emailNorm: "jonas@link-person.de" } })).toBe(0);
    expect(await r.getWaitingReply(owner, id)).toMatchObject({ canAddPerson: true, fromIsContact: false });
  });

  it("when the app wasn't sure: 'No, it was automatic' files it as an automatic reply, off the list, nothing stops", async () => {
    const x = await emailed("link-auto.de");
    const posted = await postInbound(mg.fake, {
      from: "jonas@link-auto.de",
      to: "ali@send.example.com",
      subject: "Your offer",
      text: "Thanks, what are your rates?",
      // One medium signal only: the app isn't sure (a "don't auto-reply" marker some mail programs add to normal mail).
      headers: [["X-Auto-Response-Suppress", "All"]],
    });
    await w.processAll();
    const id = posted.id!;
    const view = await r.getWaitingReply(owner, id);
    expect(view?.kind).toBe("UNLINKED");
    expect(view!.whyLines.length).toBeGreaterThan(0); // the dialog asks "Is it a real reply?"
    const res = await r.linkReply(ali, id, { companyId: x.company.id, addPerson: false, real: false });
    expect(res).toEqual({ message: `Linked to ${x.company.name} as an automatic message.` });
    expect(await w.inbound(id)).toMatchObject({ kind: "AUTO_REPLY", linkMethod: "manual", companyId: x.company.id });
    expect(await w.recipient(x.sent.recipientId)).toMatchObject({ state: "WAITING" });
    expect(await r.getWaitingReply(owner, id)).toBeNull();
    expect((await w.activities("reply.auto")).filter((a) => a.companyId === x.company.id).length).toBe(1);
  });

  it("refuses without a company, a deleted company, and an address that belongs to another company", async () => {
    const x = await emailed("link-errors.de");
    const deleted = await w.makeCompany("Deleted Co", { domain: null });
    await db.company.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
    const other = await emailed("link-other.de");
    const id = await unlinked("jonas@link-errors.de");
    // Someone adds the address to another company while the Link dialog is open.
    await w.makePerson(other.company.id, "jonas@link-errors.de", "Jonas Elsewhere");
    await expect(r.linkReply(ali, id, { companyId: 0 })).rejects.toThrow("Pick a company first.");
    await expect(r.linkReply(ali, id, { companyId: deleted.id })).rejects.toThrow("This company was deleted. Pick another one.");
    await expect(r.linkReply(ali, id, { companyId: x.company.id, addPerson: true })).rejects.toThrow(
      `jonas@link-errors.de already belongs to C-${other.company.id}. Link the reply there instead.`,
    );
    expect(await w.inbound(id)).toMatchObject({ kind: "UNLINKED" });
  });
});

describe("Add the sender as a person", () => {
  it("adds an unknown colleague to the reply's company; a second time names the company it belongs to", async () => {
    const x = await emailed("add-sender.de");
    const posted = await postInbound(mg.fake, {
      from: "jonas@add-sender.de",
      fromName: "Jonas Klein",
      to: "ali@send.example.com",
      subject: "Re: 3D models for your shop",
      text: "Anna forwarded me your email.",
      references: [x.sent.messageId],
      inReplyTo: x.sent.messageId,
    });
    await w.processAll();
    expect(await r.getWaitingReply(owner, posted.id!)).toMatchObject({ canAddPerson: true });
    expect(await r.addReplySender(sara, posted.id!)).toEqual({ message: `Added jonas@add-sender.de to ${x.company.name}.` });
    expect(await db.person.findUniqueOrThrow({ where: { emailNorm: "jonas@add-sender.de" } })).toMatchObject({ companyId: x.company.id });
    await expect(r.addReplySender(sara, posted.id!)).rejects.toThrow(`jonas@add-sender.de already belongs to C-${x.company.id}. Link the reply there instead.`);
    expect(await r.getWaitingReply(owner, posted.id!)).toMatchObject({ canAddPerson: false, fromIsContact: true });
  });
});

describe("the waiting list", () => {
  it("oldest first, Yours vs Everyone's, with the assignee's name on Everyone's", async () => {
    await db.inboundMessage.updateMany({ where: { answeredAt: null }, data: { answeredAt: new Date(), answerOutcome: "not-needed" } });
    const x = await emailed("list-a.de");
    const y = await emailed("list-b.de");
    const saraCamp = await w.makeCampaign({ createdById: sara.id, fromAddress: `Sara <${sara.address}>` });
    const z = await w.makeCompany("List C", { domain: null });
    const zp = await w.makePerson(z.id, "anna@list-c.de", "Anna C");
    const zs = await w.sendEmail(saraCamp, zp);
    const now = Date.now();
    mg.fake.setNow(() => new Date(now - 3 * w.HOUR));
    const second = await replyTo(mg.fake, y.sent.emailId);
    mg.fake.setNow(() => new Date(now - 5 * w.HOUR));
    const first = await replyTo(mg.fake, x.sent.emailId);
    mg.fake.setNow(() => new Date(now - 1 * w.HOUR));
    const third = await replyTo(mg.fake, zs.emailId);
    mg.fake.setNow(() => new Date());
    await w.processAll();

    const everyone = await r.listWaitingReplies(owner, { scope: "everyone" });
    expect(everyone.rows.map((v) => v.id)).toEqual([first.id, second.id, third.id]);
    expect(everyone).toMatchObject({ total: 3, everyone: 3, mine: 0, page: 1, pageCount: 1 });
    expect(everyone.rows[0]).toMatchObject({
      kind: "REPLY",
      label: "",
      fromEmail: "anna@list-a.de",
      fromName: "Anna Berg",
      fromIsContact: true,
      person: { id: x.person.id, name: "Anna Berg" },
      campaign: { id: x.camp.id, name: x.camp.name, step: 0 },
      senderName: "Ali",
      assigneeName: "Ali",
      subject: "Re: 3D models for your shop",
      quietLine: null,
      whyLines: [],
      hints: [],
    });
    const aliList = await r.listWaitingReplies(ali, { scope: "mine" });
    expect(aliList.rows.map((v) => v.id)).toEqual([first.id, second.id]);
    expect(aliList).toMatchObject({ mine: 2, everyone: 3 });
    const saraList = await r.listWaitingReplies(sara, { scope: "mine" });
    expect(saraList.rows.map((v) => v.id)).toEqual([third.id]);
  });
});
