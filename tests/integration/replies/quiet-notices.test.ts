import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTO_SUMMARY_LINK, replyAutoSummaryCopy, replySummaryCopy } from "@/core/replies/copy";
import { ATTENTION_SENT_SIGNAL } from "@/core/replies/types";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { postInbound, replyTo, vectorInput } from "../helpers/replies";
import { A, vector } from "../../unit/replies-core/vectors";
import type { SentEmail } from "./world";

/**
 * Quiet rows and the "once per person and reason per 30 days" rule (M4-DESIGN §3.7, §5.1, §5.5; review NOTIFY-02,
 * SPEC-05, REPLY-02, NOTIFY-03): a delivery failure notice or an automatic reply that needs attention, processed more
 * than 3 days after it arrived, gets a grouped notice that says what it is (never "They're on Replies waiting for an
 * answer"), and only notices that really went out count for the 30-day rule.
 */

const t = await createTestDb("replies-quiet-notices");
const mg = await connectFakeMailgun();
const { db, dbWrite } = await import("@/server/db");
const w = await import("./world");
const { processPendingInbound } = await import("@/server/services/replies");
const { waitingReplyCount } = await import("@/server/notifications");

let ali: Awaited<ReturnType<typeof w.makeSender>>;
let firma: { id: number };
let anna: { id: number; companyId: number; email: string | null };
let camp: Awaited<ReturnType<typeof w.makeCampaign>>;
let annaSent: SentEmail;

const TEN_DAYS_AGO = () => new Date(Date.now() - 10 * w.DAY);

beforeAll(async () => {
  await w.makeSender("Arslan", { role: "OWNER", local: "arslan" });
  ali = await w.makeSender("Ali");
  firma = await w.makeCompany("Firma GmbH", { domain: "firma.de" });
  anna = await w.makePerson(firma.id, "anna@firma.de", "Anna Berg");
  camp = await w.makeCampaign({ createdById: ali.id, name: "Germany Q4" });
  annaSent = await w.sendEmail(camp, anna, { sentAt: TEN_DAYS_AGO() });
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

/** The reply.* notifications of a user, oldest first. */
async function replyNotes(userId: number) {
  return (await w.notificationsOf(userId)).filter((n) => n.type.startsWith("reply."));
}

/** Makes a stored message look as if it arrived `ms` ago (a catch-up recovery after the PC was off). */
async function arrivedAgo(id: number | null, ms: number) {
  await dbWrite((c) => c.inboundMessage.update({ where: { id: id! }, data: { receivedAt: new Date(Date.now() - ms) } }));
}

function carriesMarker(signals: unknown): boolean {
  return Array.isArray(signals) && signals.includes(ATTENTION_SENT_SIGNAL);
}

/** A delivery failure notice (research V14's shape) for one of our emails, naming the address that failed. */
function bounceNotice(sent: SentEmail, address: string) {
  const body =
    `Delivery has failed to these recipients or groups:\n\n${address}\nThe email address you entered couldn't be found.\n\n` +
    `Original message headers:\n\nMessage-ID: <${sent.messageId}>`;
  return vectorInput(vector("V14"), { overrides: { text: body, bodyPlain: body } });
}

describe("quiet rows that aren't on the waiting list (NOTIFY-02, SPEC-05)", () => {
  it("a quiet delivery failure notice stops the address and says 'older automatic messages', not 'waiting for an answer'", async () => {
    await w.clearNotifications();
    const ben = await w.makePerson(firma.id, "ben@firma.de", "Ben Braun");
    const benSent = await w.sendEmail(camp, ben, { sentAt: TEN_DAYS_AGO() });
    const posted = await postInbound(mg.fake, bounceNotice(benSent, "ben@firma.de"));
    await arrivedAgo(posted.id, 4 * w.DAY);
    await w.processAll();

    expect(await w.inbound(posted.id)).toMatchObject({ kind: "BOUNCE_NOTICE", linkMethod: "body-id", outboundEmailId: benSent.emailId, assigneeId: ali.id });
    expect(await w.recipient(benSent.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "bounced" });
    const notes = await replyNotes(ali.id);
    expect(notes).toEqual([replyAutoSummaryCopy()]);
    expect(notes[0]).toMatchObject({ title: "Older automatic messages were found", link: AUTO_SUMMARY_LINK });
    expect(notes.some((n) => n.body?.includes("waiting for an answer"))).toBe(false);
    expect(await waitingReplyCount(ali.id)).toBe(0);
  });

  it("quiet replies and quiet automatic messages each get their own grouped notice, once while it is unread", async () => {
    await w.clearNotifications();
    const one = await w.makeCompany("Quiet One", { domain: "quiet1.de" });
    const two = await w.makeCompany("Quiet Two", { domain: "quiet2.de" });
    const three = await w.makeCompany("Quiet Three", { domain: "quiet3.de" });
    const four = await w.makeCompany("Quiet Four", { domain: "quiet4.de" });
    const kim = await w.makePerson(one.id, "kim@quiet1.de", "Kim Quiet");
    const tom = await w.makePerson(two.id, "tom@quiet2.de", "Tom Quiet");
    const uwe = await w.makePerson(three.id, "uwe@quiet3.de", "Uwe Quiet");
    const vera = await w.makePerson(four.id, "vera@quiet4.de", "Vera Quiet");
    const kimSent = await w.sendEmail(camp, kim, { sentAt: TEN_DAYS_AGO() });
    const tomSent = await w.sendEmail(camp, tom, { sentAt: TEN_DAYS_AGO() });
    const uweSent = await w.sendEmail(camp, uwe, { sentAt: TEN_DAYS_AGO() });
    const veraSent = await w.sendEmail(camp, vera, { sentAt: TEN_DAYS_AGO() });

    const reply = await replyTo(mg.fake, kimSent.emailId);
    const bounce = await postInbound(mg.fake, bounceNotice(tomSent, "tom@quiet2.de"));
    const reply2 = await replyTo(mg.fake, uweSent.emailId);
    const bounce2 = await postInbound(mg.fake, bounceNotice(veraSent, "vera@quiet4.de"));
    await arrivedAgo(reply.id, 7 * w.DAY);
    await arrivedAgo(bounce.id, 6 * w.DAY);
    await arrivedAgo(reply2.id, 5 * w.DAY);
    await arrivedAgo(bounce2.id, 4 * w.DAY);
    await w.processAll();

    expect(await w.inbound(reply.id)).toMatchObject({ kind: "REPLY" });
    expect(await w.inbound(bounce.id)).toMatchObject({ kind: "BOUNCE_NOTICE" });
    expect(await w.inbound(reply2.id)).toMatchObject({ kind: "REPLY" });
    expect(await w.inbound(bounce2.id)).toMatchObject({ kind: "BOUNCE_NOTICE" });
    expect(await w.recipient(veraSent.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "bounced" });
    // One of each while it is unread, whatever the order the rows came in.
    expect(await replyNotes(ali.id)).toEqual([replySummaryCopy(), replyAutoSummaryCopy()]);
    expect(await waitingReplyCount(ali.id)).toBe(2);
  });
});

describe("reply.attention is repeated only after 30 days without a notice that really went out (REPLY-02, NOTIFY-03)", () => {
  it("a quiet 'left the company' auto-reply doesn't silence the next one; a repeat within 30 days of a sent notice is skipped", async () => {
    await w.clearNotifications();
    const quiet = await postInbound(mg.fake, vectorInput(vector("V38")));
    await arrivedAgo(quiet.id, 4 * w.DAY);
    await w.processAll();
    const q = await w.inbound(quiet.id);
    expect(q).toMatchObject({ kind: "AUTO_REPLY", autoReason: "left-company", personId: anna.id, linkMethod: "from" });
    expect(carriesMarker(q.signals)).toBe(false);
    expect(await replyNotes(ali.id)).toEqual([replyAutoSummaryCopy()]);

    // The next follow-up gets the same auto-reply, right away: now the sender hears that Anna left.
    const fresh = await postInbound(mg.fake, vectorInput(vector("V38")));
    await w.processAll();
    expect(carriesMarker((await w.inbound(fresh.id)).signals)).toBe(true);
    const attention = (await replyNotes(ali.id)).filter((n) => n.type === "reply.attention");
    expect(attention).toEqual([
      {
        type: "reply.attention",
        title: "Anna Berg has left Firma GmbH",
        body: "Their automatic reply suggests info@firma.de instead. Follow-ups to Anna continue unless you skip them in the campaign.",
        link: `/campaigns/${camp.id}?recipient=${annaSent.recipientId}`,
      },
    ]);

    // Another one within 30 days of that notice: one is enough (the timeline still gets it).
    const again = await postInbound(mg.fake, vectorInput(vector("V38")));
    await w.processAll();
    expect(await w.inbound(again.id)).toMatchObject({ kind: "AUTO_REPLY", autoReason: "left-company" });
    expect(carriesMarker((await w.inbound(again.id)).signals)).toBe(false);
    expect((await replyNotes(ali.id)).filter((n) => n.type === "reply.attention")).toHaveLength(1);
    const timeline = (await w.activities("reply.auto")).filter((a) => (a.data as { autoReason?: string }).autoReason === "left-company");
    expect(timeline).toHaveLength(3);
  });

  it("a skipped repeat doesn't stretch the 30 days: a spam filter answering every 20 days is reported every 40", async () => {
    await w.clearNotifications();
    const mia = await w.makePerson(firma.id, "mia@firma.de", "Mia Filter");
    await w.sendEmail(camp, mia, { sentAt: TEN_DAYS_AGO() });
    const t0 = Date.now();
    const challengeAt = async (days: number) => {
      const now = new Date(t0 + days * w.DAY);
      const posted = await postInbound(mg.fake, vectorInput(vector("V20"), { overrides: { subject: "Please confirm your message to mia@firma.de" } }));
      await dbWrite((c) => c.inboundMessage.update({ where: { id: posted.id! }, data: { receivedAt: new Date(now.getTime() - w.HOUR) } }));
      await processPendingInbound({ now, failures: new Map() });
      return w.inbound(posted.id);
    };
    const rows = [await challengeAt(0), await challengeAt(20), await challengeAt(40)];
    expect(rows.map((r) => [r.kind, r.autoReason, r.linkMethod, carriesMarker(r.signals)])).toEqual([
      ["AUTO_REPLY", "challenge", "named-address", true],
      ["AUTO_REPLY", "challenge", "named-address", false],
      ["AUTO_REPLY", "challenge", "named-address", true],
    ]);
    expect((await replyNotes(ali.id)).map((n) => [n.type, n.title])).toEqual([
      ["reply.attention", "Mia Filter's spam filter is holding your email"],
      ["reply.attention", "Mia Filter's spam filter is holding your email"],
    ]);
  });

  it("a possible reply that only mentions someone leaving sent 'Did … really reply?', so it doesn't count either", async () => {
    await w.clearNotifications();
    const other = await w.makeCompany("Leaving AG", { domain: "leaving.de" });
    const lena = await w.makePerson(other.id, "lena@leaving.de", "Lena Kurz");
    const lenaSent = await w.sendEmail(camp, lena, { sentAt: TEN_DAYS_AGO() });
    const successor = await postInbound(
      mg.fake,
      vectorInput(vector("V39"), { ids: { [A]: lenaSent.messageId }, overrides: { from: "jonas@leaving.de" } }),
    );
    await w.processAll();
    expect(await w.inbound(successor.id)).toMatchObject({ kind: "POSSIBLE_REPLY", autoReason: "left-company", personId: lena.id });
    expect((await replyNotes(ali.id)).map((n) => n.type)).toEqual(["reply.possible"]);

    const auto = await postInbound(mg.fake, vectorInput(vector("V38"), { overrides: { from: "lena@leaving.de" } }));
    await w.processAll();
    expect(await w.inbound(auto.id)).toMatchObject({ kind: "AUTO_REPLY", autoReason: "left-company", personId: lena.id });
    expect((await replyNotes(ali.id)).map((n) => [n.type, n.title])).toEqual([
      ["reply.possible", "Did Leaving AG really reply?"],
      ["reply.attention", "Lena Kurz has left Leaving AG"],
    ]);
  });
});
