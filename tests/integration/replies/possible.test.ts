import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { postInbound, vectorInput } from "../helpers/replies";
import { A, vector } from "../../unit/replies-core/vectors";

/**
 * Possible replies (PLAN B12 "possible replies"; M4-DESIGN §2.8.2, §3.4 rule 3/4, §3.5): the company waits (HELD
 * "possible-reply") in every campaign until someone chooses Real reply or It was an auto-reply.
 */

const t = await createTestDb("replies-possible");
const mg = await connectFakeMailgun();
const { db } = await import("@/server/db");
const w = await import("./world");
const { confirmReply, getWaitingReply, markReplyAnswered } = await import("@/server/services/replies");
const { applyPendingPossibleReplyHolds, undecidedHolds } = await import("@/server/services/sequences/holds");

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

/** A company with one emailed person in a LIVE campaign and in a dry run. */
async function world(name: string, domain: string, local = "anna") {
  const company = await w.makeCompany(name, { domain });
  const person = await w.makePerson(company.id, `${local}@${domain}`, `${local[0]!.toUpperCase()}${local.slice(1)} ${name.split(" ")[0]}`);
  const live = await w.makeCampaign({ createdById: ali.id, name: `${name} live` });
  const dry = await w.makeCampaign({ createdById: ali.id, mode: "DRY_RUN", name: `${name} practice` });
  const sent = await w.sendEmail(live, person);
  const drySent = await w.sendEmail(dry, person);
  return { company, person, live, dry, sent, drySent };
}

describe("a possible reply holds the company until someone decides", () => {
  it("V09 (human mentions being away): held in every campaign, notified; Real reply stops it and makes it Replied", async () => {
    // Launched after go-live, so its live email counts as emailed (M6-DESIGN §2.2: the launch flag decides).
    await w.setSetting("sending.goLive", true);
    let posted;
    let x: Awaited<ReturnType<typeof world>>;
    try {
      x = await world("Firma GmbH", "firma.de");
      posted = await postInbound(mg.fake, vectorInput(vector("V09"), { ids: { [A]: x.sent.messageId } }));
      await w.processAll();
    } finally {
      await w.setSetting("sending.goLive", false);
    }
    const row = await w.inbound(posted.id);
    expect(row).toMatchObject({
      kind: "POSSIBLE_REPLY",
      autoReason: "out-of-office",
      linkMethod: "headers",
      companyId: x.company.id,
      replyScope: "real",
      changesStatus: true,
    });
    expect(await w.recipient(x.sent.recipientId)).toMatchObject({ state: "HELD", holdReason: "possible-reply" });
    expect(await w.recipient(x.drySent.recipientId)).toMatchObject({ state: "HELD", holdReason: "possible-reply" });
    expect(await w.email(x.sent.queuedId!)).toMatchObject({ status: "QUEUED" });
    expect(await w.notificationsOf(ali.id)).toContainEqual({
      type: "reply.possible",
      title: "Did Firma GmbH really reply?",
      body: "The app can't tell whether Anna Firma's message is a real reply or an automatic one. Their follow-ups wait until you choose.",
      link: `/notifications?reply=${row.id}#replies`,
    });
    const [act] = (await w.activities("reply.possible")).filter((a) => a.companyId === x.company.id);
    expect(act?.summary).toBe("Message from anna@firma.de may be a reply: follow-ups wait until someone checks it");
    const view = await getWaitingReply(owner, row.id);
    expect(view).toMatchObject({ kind: "POSSIBLE_REPLY" });
    expect(view?.whyLines).toContain("It says they're away, but it may also contain a real answer.");
    expect(await undecidedHolds(db, [x.company.id])).toEqual([{ companyId: x.company.id, campaignId: null }]);

    // Answered can't skip the decision.
    await expect(markReplyAnswered(ali, row.id)).rejects.toThrow("Choose Real reply or It was an auto-reply first.");

    // The stored scope decides (go-live is off again now; the reply was processed after go-live).
    const res = await confirmReply(sara, row.id, true);
    expect(res.message).toBe("Marked as a real reply. Follow-ups to Firma GmbH stopped and it's now Replied.");
    expect(await db.company.findUniqueOrThrow({ where: { id: x.company.id } })).toMatchObject({ status: "REPLIED", repliedAt: row.receivedAt });
    expect((await db.person.findUniqueOrThrow({ where: { id: x.person.id } })).repliedAt).toEqual(row.receivedAt);
    const after = await w.inbound(row.id);
    expect(after).toMatchObject({ kind: "REPLY", confirmedById: sara.id, answeredAt: null });
    expect(await w.recipient(x.sent.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "replied", holdReason: null });
    expect(await w.recipient(x.drySent.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "replied" });
    const confirmed = (await w.activities("reply.confirmed")).filter((a) => a.companyId === x.company.id);
    expect(confirmed.map((a) => [a.summary, a.actorId])).toEqual([["Sara marked the message from anna@firma.de as a real reply", sara.id]]);
    expect(await getWaitingReply(owner, row.id)).toMatchObject({ kind: "REPLY" }); // stays until answered
  });
});

describe("It was an auto-reply", () => {
  it("releases the company only when no other undecided message still holds it (V30 and a log-only row)", async () => {
    const x = await world("Firma Zwei", "firma2.de");
    const v30 = await postInbound(
      mg.fake,
      vectorInput(vector("V30"), { ids: { [A]: x.sent.messageId }, overrides: { from: "anna@firma2.de" } }),
    );
    // A reply the M3 catch-up recovered from Mailgun's log only (no text at all).
    const logOnly = await w.storeM3Reply({
      fromEmail: "anna@firma2.de",
      subject: "Re: 3D models for your shop",
      snippet: "",
      receivedAt: new Date(Date.now() - w.HOUR),
      source: "CATCHUP",
      bodyAvailable: false,
    });
    await w.processAll();
    expect(await w.inbound(v30.id)).toMatchObject({ kind: "POSSIBLE_REPLY", autoReason: "auto-reply" });
    expect(await w.inbound(logOnly.id)).toMatchObject({ kind: "POSSIBLE_REPLY", linkMethod: "from", bodyAvailable: false });
    const view = await getWaitingReply(owner, logOnly.id);
    expect(view?.whyLines[0]).toBe("It was recovered from Mailgun's log without its text, because the PC was off too long.");

    const first = await confirmReply(ali, v30.id!, false);
    expect(first.message).toBe("Marked as automatic. Follow-ups to Firma Zwei still wait for another message to be checked.");
    expect(await w.inbound(v30.id)).toMatchObject({ kind: "AUTO_REPLY", autoReason: "auto-reply", confirmedById: ali.id });
    expect(await w.recipient(x.sent.recipientId)).toMatchObject({ state: "HELD", holdReason: "possible-reply" });

    const second = await confirmReply(ali, logOnly.id, false);
    expect(second.message).toBe("Marked as automatic. Follow-ups to Firma Zwei continue.");
    expect(await w.recipient(x.sent.recipientId)).toMatchObject({ state: "WAITING", holdReason: null, heldAt: null });
    expect(await w.recipient(x.drySent.recipientId)).toMatchObject({ state: "WAITING", holdReason: null });
    expect(await getWaitingReply(owner, logOnly.id)).toBeNull();
    const confirmed = (await w.activities("reply.confirmed")).filter((a) => a.companyId === x.company.id);
    expect(confirmed.at(-1)?.summary).toBe("Ali marked the message from anna@firma2.de as an automatic reply: follow-ups continue");

    // Deciding twice: the second person is told who already did.
    await expect(confirmReply(sara, logOnly.id, true)).rejects.toThrow("This reply was already handled by Ali. Refresh the page to see it.");
  });

  it("a campaign launched while a possible reply is undecided is held too", async () => {
    const x = await world("Firma Drei", "firma3.de");
    const posted = await postInbound(
      mg.fake,
      vectorInput(vector("V09"), { ids: { [A]: x.sent.messageId }, overrides: { from: "anna@firma3.de" } }),
    );
    await w.processAll();
    expect(await w.inbound(posted.id)).toMatchObject({ kind: "POSSIBLE_REPLY" });
    const colleague = await w.makePerson(x.company.id, "ben@firma3.de", "Ben Drei");
    const launched = await w.makeCampaign({ createdById: sara.id, senderId: sara.id });
    const scheduled = await w.schedule(launched, colleague);
    expect(await w.recipient(scheduled.recipientId)).toMatchObject({ state: "SCHEDULED" });
    // What the launch and the 5-minute maintenance do (P3 calls it): the undecided message holds the new recipient.
    await applyPendingPossibleReplyHolds({ companyIds: [x.company.id], now: new Date() });
    expect(await w.recipient(scheduled.recipientId)).toMatchObject({ state: "HELD", holdReason: "possible-reply" });
    await confirmReply(ali, posted.id!, false);
    expect(await w.recipient(scheduled.recipientId)).toMatchObject({ state: "SCHEDULED", holdReason: null });
  });

  it("a twin (the same message to two of our addresses) never keeps the hold after the decision", async () => {
    const x = await world("Firma Vier", "firma4.de");
    const input = vectorInput(vector("V09"), {
      ids: { [A]: x.sent.messageId },
      overrides: { from: "anna@firma4.de", messageId: "twin-1@firma4.de" },
    });
    const toAli = await postInbound(mg.fake, input);
    const toSara = await postInbound(mg.fake, { ...input, to: sara.address! });
    await w.processAll();
    const first = await w.inbound(toAli.id);
    const twin = await w.inbound(toSara.id);
    expect(first).toMatchObject({ kind: "POSSIBLE_REPLY", answeredAt: null, answerOutcome: null });
    expect(twin).toMatchObject({
      kind: "POSSIBLE_REPLY",
      answerOutcome: "duplicate",
      companyId: x.company.id,
      outboundEmailId: x.sent.emailId,
      assigneeId: first.assigneeId,
    });
    expect(twin.answeredAt).toBeInstanceOf(Date);
    // One notification per reply per person: the twin gives none (not even to Sara, whose address it reached).
    const possible = (await w.notificationsOf(ali.id)).filter((n) => n.link === `/notifications?reply=${first.id}#replies`);
    expect(possible.length).toBe(1);
    expect((await w.notificationsOf(sara.id)).filter((n) => n.type.startsWith("reply."))).toEqual([]);
    expect((await w.activities("reply.possible")).filter((a) => a.companyId === x.company.id).length).toBe(1);
    expect(await getWaitingReply(owner, twin.id)).toBeNull();

    const res = await confirmReply(ali, first.id, false);
    expect(res.message).toBe("Marked as automatic. Follow-ups to Firma Vier continue.");
    expect(await w.recipient(x.sent.recipientId)).toMatchObject({ state: "WAITING" });
    expect(await w.inbound(twin.id)).toMatchObject({ kind: "AUTO_REPLY", answerOutcome: "duplicate", confirmedById: ali.id });
  });
});
