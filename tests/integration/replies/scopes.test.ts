import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { postInbound, replyTo, vectorInput } from "../helpers/replies";
import { A, vector } from "../../unit/replies-core/vectors";

/**
 * Reply scope (M4-DESIGN §3.6, §7.2, D23): which recipients a reply may change and whether it may make the company
 * Replied, fixed when the reply is processed and used by every later decision.
 */

const t = await createTestDb("replies-scopes");
const mg = await connectFakeMailgun();
const { db } = await import("@/server/db");
const w = await import("./world");
const { applyReplyFailSafe, confirmReply, getWaitingReply, linkReply, listWaitingReplies } = await import("@/server/services/replies");
const { simulateReply } = await import("@/server/services/mail-events/simulate");
const { waitingReplyCount } = await import("@/server/notifications");

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

async function withSettings<T>(values: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  for (const [k, v] of Object.entries(values)) await w.setSetting(k, v);
  try {
    return await fn();
  } finally {
    await w.setSetting("sending.goLive", false);
    await w.setSetting("practice.copy", false);
  }
}

async function world(name: string, domain: string, mode: "LIVE" | "DRY_RUN" = "LIVE") {
  const company = await w.makeCompany(name, { domain });
  const person = await w.makePerson(company.id, `anna@${domain}`, "Anna Berg");
  const colleague = await w.makePerson(company.id, `ben@${domain}`, "Ben Braun");
  const camp = await w.makeCampaign({ createdById: ali.id, mode, name: `${name} campaign` });
  const other = await w.makeCampaign({ createdById: ali.id, mode, name: `${name} other` });
  const sent = await w.sendEmail(camp, person);
  const elsewhere = await w.sendEmail(other, colleague);
  return { company, person, colleague, camp, other, sent, elsewhere };
}

describe("LIVE replies", () => {
  it("after go-live: every campaign stops and the company becomes Replied", async () => {
    // Campaigns launched after go-live (M6-DESIGN §2.2: the launch flag decides whether a live email counts as emailed).
    const { x, posted } = await withSettings({ "sending.goLive": true }, async () => {
      const x = await world("After Golive", "aftergolive.de");
      const p = await replyTo(mg.fake, x.sent.emailId);
      await w.processAll();
      return { x, posted: p };
    });
    const row = await w.inbound(posted.id);
    expect(row).toMatchObject({ kind: "REPLY", replyScope: "real", changesStatus: true });
    expect(await db.company.findUniqueOrThrow({ where: { id: x.company.id } })).toMatchObject({ status: "REPLIED", repliedAt: row.receivedAt });
    expect((await db.person.findUniqueOrThrow({ where: { id: x.person.id } })).repliedAt).toEqual(row.receivedAt);
    expect((await db.person.findUniqueOrThrow({ where: { id: x.colleague.id } })).repliedAt).toBeNull();
    expect(await w.recipient(x.elsewhere.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "company_replied" });
  });

  it("before go-live (a test-list mailbox): stops, keeps the status, and still keeps it when confirmed after go-live", async () => {
    const x = await world("Before Golive", "beforegolive.de");
    const posted = await postInbound(
      mg.fake,
      vectorInput(vector("V09"), { ids: { [A]: x.sent.messageId }, overrides: { from: "anna@beforegolive.de" } }),
    );
    await w.processAll();
    expect(await w.inbound(posted.id)).toMatchObject({ kind: "POSSIBLE_REPLY", replyScope: "real", changesStatus: false });
    await withSettings({ "sending.goLive": true }, () => confirmReply(ali, posted.id!, true));
    expect(await w.recipient(x.sent.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "replied" });
    expect(await w.recipient(x.elsewhere.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "company_replied" });
    expect(await db.company.findUniqueOrThrow({ where: { id: x.company.id } })).toMatchObject({ status: "CONTACTED", repliedAt: null });
  });

  it("M6-DESIGN §2.2: a reply to a test email sent before go-live, processed after the flip, never makes the company Replied", async () => {
    const x = await world("Flip Co", "flipco.de");
    const posted = await withSettings({ "sending.goLive": true }, async () => {
      const p = await replyTo(mg.fake, x.sent.emailId);
      await w.processAll();
      return p;
    });
    expect(await w.inbound(posted.id)).toMatchObject({ kind: "REPLY", replyScope: "real", changesStatus: false });
    // The replies still stop the test campaigns, but the test mailbox keeps its status.
    expect(await w.recipient(x.sent.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "replied" });
    expect(await db.company.findUniqueOrThrow({ where: { id: x.company.id } })).toMatchObject({ status: "CONTACTED", repliedAt: null });
  });

  it("a Client company keeps its status, but its follow-ups still stop and the sender is told", async () => {
    const x = await world("Client Co", "clientco.de");
    await db.company.update({ where: { id: x.company.id }, data: { status: "CLIENT" } });
    const posted = await withSettings({ "sending.goLive": true }, async () => {
      const p = await replyTo(mg.fake, x.sent.emailId);
      await w.processAll();
      return p;
    });
    expect(await db.company.findUniqueOrThrow({ where: { id: x.company.id } })).toMatchObject({ status: "CLIENT" });
    expect(await w.recipient(x.sent.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "replied" });
    expect(await w.notificationsOf(ali.id)).toContainEqual(expect.objectContaining({ type: "reply.received", link: `/notifications?reply=${posted.id}#replies` }));
    expect(await getWaitingReply(owner, posted.id!)).toMatchObject({ kind: "REPLY" });
  });
});

describe("a reply linked only to the company after a domain change ended go-live (review GOLIVE-01)", () => {
  const GO_LIVE_AT = "2026-06-01T08:00:00.000Z";
  const ALI = "ali@send.example.com";

  /** Live, a company emailed by a campaign launched after go-live 105 days ago (outside the 90-day window), then the
   * sending domain changes: go-live off, its time kept (G8). */
  async function emailedThenDomainChange(name: string, domain: string) {
    await w.setSetting("sending.goLive", true);
    await w.setSetting("sending.goLiveAt", GO_LIVE_AT);
    const company = await w.makeCompany(name, { domain });
    const anna = await w.makePerson(company.id, `anna@${domain}`, "Anna Berg");
    const camp = await w.makeCampaign({ createdById: ali.id, name: `${name} campaign` });
    await w.sendEmail(camp, anna, { sentAt: new Date(Date.now() - 105 * w.DAY), next: false });
    await w.setSetting("sending.goLive", false);
    return { company, anna };
  }

  async function reset() {
    await w.setSetting("sending.goLive", false);
    await w.setSetting("sending.goLiveAt", null);
  }

  it("a known contact writing a new email still makes the company Replied", async () => {
    try {
      const { company } = await emailedThenDomainChange("Domain Change Co", "domainchange.de");
      const posted = await postInbound(mg.fake, { from: "anna@domainchange.de", to: ALI, subject: "Still interested", text: "Can we talk next week?" });
      await w.processAll();
      const row = await w.inbound(posted.id);
      expect(row).toMatchObject({ kind: "REPLY", linkMethod: "person", outboundEmailId: null, companyId: company.id, replyScope: "real", changesStatus: true });
      expect(await db.company.findUniqueOrThrow({ where: { id: company.id } })).toMatchObject({ status: "REPLIED", repliedAt: row.receivedAt });
    } finally {
      await reset();
    }
  });

  it("before the app was ever live, the same reply changes no status (unchanged)", async () => {
    const company = await w.makeCompany("Never Live Co", { domain: "neverlive.de" });
    await w.makePerson(company.id, "anna@neverlive.de", "Anna Berg");
    const posted = await postInbound(mg.fake, { from: "anna@neverlive.de", to: ALI, subject: "Hello", text: "Can we talk next week?" });
    await w.processAll();
    expect(await w.inbound(posted.id)).toMatchObject({ kind: "REPLY", companyId: company.id, replyScope: "real", changesStatus: false });
    expect(await db.company.findUniqueOrThrow({ where: { id: company.id } })).toMatchObject({ status: "CONTACTED", repliedAt: null });
  });

  it("linking a reply by hand to such a company makes it Replied", async () => {
    try {
      const { company } = await emailedThenDomainChange("Linked Co", "linkedco.de");
      const posted = await postInbound(mg.fake, { from: "jonas@elsewhere-unknown.de", to: ALI, subject: "Your offer", text: "I work with Anna, is this still valid?" });
      await w.processAll();
      expect(await w.inbound(posted.id)).toMatchObject({ kind: "UNLINKED", companyId: null });
      await linkReply(owner, posted.id!, { companyId: company.id });
      expect(await w.inbound(posted.id)).toMatchObject({ kind: "REPLY", linkMethod: "manual", outboundEmailId: null, companyId: company.id, changesStatus: true });
      expect(await db.company.findUniqueOrThrow({ where: { id: company.id } })).toMatchObject({ status: "REPLIED" });
    } finally {
      await reset();
    }
  });

  it("the fail-safe stores such a reply as able to change the status", async () => {
    try {
      const { company } = await emailedThenDomainChange("Fail Safe Co", "failsafeco.de");
      const posted = await postInbound(mg.fake, { from: "anna@failsafeco.de", to: ALI, subject: "Question", text: "Is this still valid?" });
      expect(await applyReplyFailSafe(posted.id!)).toBe(true);
      expect(await w.inbound(posted.id)).toMatchObject({ kind: "POSSIBLE_REPLY", autoReason: "process-failed", companyId: company.id, replyScope: "real", changesStatus: true });
    } finally {
      await reset();
    }
  });
});

describe("dry runs", () => {
  it("in the practice copy a simulated reply makes the company Replied and stops every campaign", async () => {
    const x = await world("Practice Co", "practiceco.de", "DRY_RUN");
    const res = await withSettings({ "practice.copy": true }, () => simulateReply(ali, x.sent.emailId, "reply"));
    expect(res.message).toBe("Simulated a reply from anna@practiceco.de: Practice Co is now Replied and its follow-ups stopped in every campaign.");
    const row = await db.inboundMessage.findFirstOrThrow({ where: { storageKey: `sim:${x.sent.emailId}:reply` } });
    expect(row).toMatchObject({ kind: "REPLY", source: "SIMULATED", linkMethod: "simulated", replyScope: "real", changesStatus: true });
    expect(await db.company.findUniqueOrThrow({ where: { id: x.company.id } })).toMatchObject({ status: "REPLIED" });
    expect(await w.recipient(x.elsewhere.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "company_replied" });
    const note = (await w.notificationsOf(ali.id)).find((n) => n.link === `/notifications?reply=${row.id}#replies`);
    expect(note?.title).toBe("New reply from Practice Co");
    expect(await waitingReplyCount(ali.id)).toBeGreaterThan(0);
  });

  it("in the practice copy a signed reply webhook to a dry-run email is a real-scope REPLY (PLAN B12)", async () => {
    const x = await world("Practice Hook", "practicehook.de", "DRY_RUN");
    const posted = await withSettings({ "practice.copy": true }, async () => {
      const p = await replyTo(mg.fake, x.sent.emailId);
      await w.processAll();
      return p;
    });
    expect(await w.inbound(posted.id)).toMatchObject({ kind: "REPLY", linkMethod: "headers", outboundEmailId: x.sent.emailId, replyScope: "real", changesStatus: true });
    expect(await db.company.findUniqueOrThrow({ where: { id: x.company.id } })).toMatchObject({ status: "REPLIED" });
  });

  it("on real data a simulated reply changes only that campaign: 'Dry run:' labels, listed but not counted", async () => {
    const x = await world("Real Data Co", "realdata.de", "DRY_RUN");
    const before = await waitingReplyCount(ali.id);
    const res = await simulateReply(ali, x.sent.emailId, "reply");
    expect(res.message).toBe(
      "Simulated a reply from anna@realdata.de. In a dry run it only stops this campaign's emails to Real Data Co; statuses don't change.",
    );
    const row = await db.inboundMessage.findFirstOrThrow({ where: { storageKey: `sim:${x.sent.emailId}:reply` } });
    expect(row).toMatchObject({ kind: "REPLY", replyScope: "campaign", changesStatus: false, campaignId: x.camp.id });
    expect(await w.recipient(x.sent.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "replied" });
    expect(await w.recipient(x.elsewhere.recipientId)).toMatchObject({ state: "WAITING" });
    expect(await db.company.findUniqueOrThrow({ where: { id: x.company.id } })).toMatchObject({ status: "CONTACTED", repliedAt: null });
    const note = (await w.notificationsOf(ali.id)).find((n) => n.link === `/notifications?reply=${row.id}#replies`);
    expect(note?.title).toBe("Dry run: New reply from Real Data Co");
    const [act] = (await w.activities("reply.received")).filter((a) => a.companyId === x.company.id);
    expect(act).toMatchObject({ mode: "DRY_RUN", campaignId: x.camp.id });
    expect(act!.data).toMatchObject({ simulated: true, linkMethod: "simulated" });
    const list = await listWaitingReplies(ali, { scope: "mine" });
    expect(list.rows.find((r) => r.id === row.id)).toMatchObject({ label: "Dry run", kind: "REPLY" });
    expect(await waitingReplyCount(ali.id)).toBe(before);
  });
});
