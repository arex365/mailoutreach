import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeMember, makeOwner, seedEmail, setSetting } from "./seed";

/**
 * "Simulate a reply" in the dry-run outbox (M4-DESIGN §7.1, §7.2, §9.5): Reply, Out-of-office and Unclear reply, stored
 * as SIMULATED replies and processed at once, like a real one.
 */

type TestUser = { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number };
const auth = vi.hoisted(() => ({ user: null as TestUser | null }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/dal", () => {
  class AuthError extends Error {
    constructor(
      message: string,
      readonly status: 401 | 403,
    ) {
      super(message);
      this.name = "AuthError";
    }
  }
  return {
    AuthError,
    getUserOrNull: async () => auth.user,
    requireUserAction: async () => {
      if (!auth.user) throw new AuthError("Your session has ended. Please sign in again.", 401);
      return auth.user;
    },
  };
});

const t = await createTestDb("mail-simulate-reply");
const { db, dbWrite } = await import("@/server/db");
const { simulateReply, simulatedReplyMessage, loadSimulation, simulateEmailEvent, ALREADY_SIMULATED } = await import(
  "@/server/services/mail-events/simulate"
);
const { ServiceError } = await import("@/server/services/companies/mutations");
const outbox = await import("@/app/(app)/campaigns/outbox/actions");

let actor: { id: number; name: string };
let member: TestUser;

beforeAll(async () => {
  const o = await makeOwner();
  actor = { id: o.id, name: o.name };
  const m = await makeMember("Ali", "ali@polygonparadise.test");
  member = { id: m.id, email: m.email, name: m.name, role: "MEMBER", timeZone: "Europe/Berlin", sessionId: 1 };
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

async function companyName(companyId: number) {
  return (await db.company.findUniqueOrThrow({ where: { id: companyId } })).name;
}

describe("simulateReply on real data (campaign scope)", () => {
  it("Reply: only this campaign's emails to the company stop; statuses don't change", async () => {
    const s = await seedEmail({ createdById: actor.id, mode: "DRY_RUN" });
    const res = await simulateReply(actor, s.emailId, "reply");
    const company = await companyName(s.companyId);
    expect(res.message).toBe(`Simulated a reply from ${s.toNorm}. In a dry run it only stops this campaign's emails to ${company}; statuses don't change.`);
    const row = await db.inboundMessage.findUniqueOrThrow({ where: { storageKey: `sim:${s.emailId}:reply` } });
    expect(row).toMatchObject({
      source: "SIMULATED",
      kind: "REPLY",
      fromEmail: s.toNorm,
      toAddress: "arslan@send.example.com",
      inReplyTo: s.messageId,
      messageIdHeader: `sim.${s.emailId}.reply@simulated.invalid`,
      subject: "Re: Hello",
      replyScope: "campaign",
      changesStatus: false,
      outboundEmailId: s.emailId,
      assigneeId: actor.id,
    });
    expect(row.bodyText).toBe("Hi Arslan,\n\nThanks, this sounds interesting. Could you send a few examples and your prices?\n\nBest,\nPerson");
    expect(row.snippet).toBe("Hi Arslan, Thanks, this sounds interesting. Could you send a few examples and your prices?");
    expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: s.recipientId } })).toMatchObject({ state: "STOPPED", stopReason: "replied" });
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: s.followUpId! } })).toMatchObject({ status: "SKIPPED" });
    expect(await db.company.findUniqueOrThrow({ where: { id: s.companyId } })).toMatchObject({ status: "NOT_CONTACTED", repliedAt: null });

    expect(await simulateReply(actor, s.emailId, "reply")).toEqual({ message: ALREADY_SIMULATED });
    expect(await db.inboundMessage.count({ where: { outboundEmailId: s.emailId } })).toBe(1);
    expect(await loadSimulation(s.emailId)).toMatchObject({ done: [], repliesDone: ["reply"], resultLine: "Replied (simulated)" });
  });

  it("Out-of-office: logged as automatic, follow-ups continue", async () => {
    const s = await seedEmail({ createdById: actor.id, mode: "DRY_RUN" });
    const res = await simulateReply(actor, s.emailId, "out-of-office");
    expect(res.message).toBe(`Simulated an out-of-office reply from ${s.toNorm}. It's logged as automatic, so follow-ups continue.`);
    const row = await db.inboundMessage.findUniqueOrThrow({ where: { storageKey: `sim:${s.emailId}:out-of-office` } });
    expect(row).toMatchObject({ kind: "AUTO_REPLY", autoReason: "out-of-office", subject: "Automatic reply: Hello", envelopeSender: "" });
    expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: s.recipientId } })).toMatchObject({ state: "WAITING" });
  });

  it("Unclear reply: the company's follow-ups in this campaign wait for a decision", async () => {
    const s = await seedEmail({ createdById: actor.id, mode: "DRY_RUN" });
    const other = await seedEmail({ createdById: actor.id, mode: "DRY_RUN", email: s.toNorm, status: "QUEUED", followUp: false });
    const res = await simulateReply(actor, s.emailId, "unclear");
    const company = await companyName(s.companyId);
    expect(res.message).toBe(
      `Simulated an unclear reply from ${s.toNorm}. Follow-ups to ${company} wait until someone chooses Real reply or It was an auto-reply on the Notifications page.`,
    );
    const row = await db.inboundMessage.findUniqueOrThrow({ where: { storageKey: `sim:${s.emailId}:unclear` } });
    expect(row).toMatchObject({ kind: "POSSIBLE_REPLY", replyScope: "campaign", campaignId: s.campaignId });
    expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: s.recipientId } })).toMatchObject({ state: "HELD", holdReason: "possible-reply" });
    expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: other.recipientId } })).toMatchObject({ state: "SCHEDULED" });
  });

  it("the results line lists Mailgun's reports and the replies linked to the email", async () => {
    const s = await seedEmail({ createdById: actor.id, mode: "DRY_RUN" });
    await simulateEmailEvent(actor, s.emailId, "delivered");
    await simulateReply(actor, s.emailId, "out-of-office");
    await simulateReply(actor, s.emailId, "unclear");
    await simulateReply(actor, s.emailId, "reply");
    expect(await loadSimulation(s.emailId)).toMatchObject({
      done: ["delivered"],
      repliesDone: ["reply", "out-of-office", "unclear"],
      resultLine: "Delivered · Replied · Automatic reply · Possible reply (simulated)",
    });
  });

  it("a dry run to a teammate's own address is answered like any other (REPLY-01)", async () => {
    const s = await seedEmail({ createdById: actor.id, mode: "DRY_RUN", email: "ali@polygonparadise.test" });
    const res = await simulateReply(actor, s.emailId, "reply");
    const company = await companyName(s.companyId);
    expect(res.message).toBe(
      `Simulated a reply from ali@polygonparadise.test. In a dry run it only stops this campaign's emails to ${company}; statuses don't change.`,
    );
    const row = await db.inboundMessage.findUniqueOrThrow({ where: { storageKey: `sim:${s.emailId}:reply` } });
    expect(row).toMatchObject({ kind: "REPLY", autoReason: null, replyScope: "campaign", outboundEmailId: s.emailId });
    expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: s.recipientId } })).toMatchObject({ state: "STOPPED", stopReason: "replied" });
  });

  it("says what the app decided when it filed the message differently", () => {
    const base = { from: "anna@firma.de", company: "Firma GmbH", scope: "campaign", statusBefore: "CONTACTED", statusAfter: "CONTACTED" } as const;
    expect(simulatedReplyMessage({ ...base, kind: "reply", filed: "TEST_REPLY" })).toBe(
      "Simulated a message from anna@firma.de; the app filed it as a reply to a test email.",
    );
    expect(simulatedReplyMessage({ ...base, kind: "unclear", filed: "REPLY" })).toBe("Simulated a message from anna@firma.de; the app filed it as a reply.");
    expect(simulatedReplyMessage({ ...base, kind: "reply", filed: null })).toBe(
      "Simulated a message from anna@firma.de; the app filed it as a message it couldn't read.",
    );
  });

  it("refuses real emails, emails that haven't gone out, and emails that are gone", async () => {
    const live = await seedEmail({ createdById: actor.id, mode: "LIVE" });
    await expect(simulateReply(actor, live.emailId, "reply")).rejects.toThrow(
      "Only dry-run emails can be simulated. Real emails get their replies from real mailboxes.",
    );
    const queued = await seedEmail({ createdById: actor.id, mode: "DRY_RUN", status: "QUEUED", followUp: false });
    await expect(simulateReply(actor, queued.emailId, "unclear")).rejects.toThrow("This email hasn't gone out yet, so there's nothing to reply to.");
    await expect(simulateReply(actor, 999_999, "reply")).rejects.toBeInstanceOf(ServiceError);
    expect(await db.inboundMessage.count({ where: { outboundEmailId: { in: [live.emailId, queued.emailId] } } })).toBe(0);
  });
});

describe("simulateReply in the practice copy (real scope)", () => {
  it("Reply: the company is Replied and its follow-ups stop in every campaign", async () => {
    await setSetting("practice.copy", true);
    try {
      const s = await seedEmail({ createdById: actor.id, mode: "DRY_RUN" });
      const other = await seedEmail({ createdById: actor.id, mode: "DRY_RUN", email: s.toNorm, status: "QUEUED", followUp: false });
      const res = await simulateReply(actor, s.emailId, "reply");
      const company = await companyName(s.companyId);
      expect(res.message).toBe(`Simulated a reply from ${s.toNorm}: ${company} is now Replied and its follow-ups stopped in every campaign.`);
      expect(await db.company.findUniqueOrThrow({ where: { id: s.companyId } })).toMatchObject({ status: "REPLIED" });
      expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: other.recipientId } })).toMatchObject({ state: "STOPPED", stopReason: "replied" });
      const o = await seedEmail({ createdById: actor.id, mode: "DRY_RUN" });
      expect((await simulateReply(actor, o.emailId, "out-of-office")).message).toBe(
        `Simulated an out-of-office reply from ${o.toNorm}. It's logged as automatic, so follow-ups continue.`,
      );
      expect((await loadSimulation(o.emailId))?.practiceCopy).toBe(true);
    } finally {
      await setSetting("practice.copy", false);
    }
  });

  it("Reply to a Client, Not interested or Do not contact company: the toast says the status stays (SPEC-06)", async () => {
    await setSetting("practice.copy", true);
    try {
      for (const [status, label] of [
        ["CLIENT", "Client"],
        ["NOT_INTERESTED", "Not interested"],
        ["DO_NOT_CONTACT", "Do not contact"],
      ] as const) {
        const s = await seedEmail({ createdById: actor.id, mode: "DRY_RUN" });
        await dbWrite((c) => c.company.update({ where: { id: s.companyId }, data: { status } }));
        const res = await simulateReply(actor, s.emailId, "reply");
        const company = await companyName(s.companyId);
        expect(res.message).toBe(`Simulated a reply from ${s.toNorm}: ${company} stays ${label} and its follow-ups stopped in every campaign.`);
        expect(await db.company.findUniqueOrThrow({ where: { id: s.companyId } })).toMatchObject({ status });
        expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: s.recipientId } })).toMatchObject({ state: "STOPPED", stopReason: "replied" });
      }
    } finally {
      await setSetting("practice.copy", false);
    }
  });

  it("Reply to a company that already replied: no 'is now'", async () => {
    await setSetting("practice.copy", true);
    try {
      const s = await seedEmail({ createdById: actor.id, mode: "DRY_RUN" });
      await dbWrite((c) => c.company.update({ where: { id: s.companyId }, data: { status: "REPLIED" } }));
      const res = await simulateReply(actor, s.emailId, "reply");
      const company = await companyName(s.companyId);
      expect(res.message).toBe(`Simulated a reply from ${s.toNorm}: ${company} was already Replied and its follow-ups stopped in every campaign.`);
    } finally {
      await setSetting("practice.copy", false);
    }
  });
});

describe("simulateReplyAction (the outbox's buttons)", () => {
  it("is for everyone signed in, and checks its input", async () => {
    const s = await seedEmail({ createdById: actor.id, mode: "DRY_RUN" });
    auth.user = member;
    const ok = await outbox.simulateReplyAction({ emailId: s.emailId, kind: "out-of-office" });
    expect(ok).toMatchObject({ ok: true, data: { message: expect.stringContaining("It's logged as automatic") } });
    expect(await outbox.simulateReplyAction({ emailId: s.emailId, kind: "nonsense" as never })).toMatchObject({ ok: false });
    const live = await seedEmail({ createdById: actor.id, mode: "LIVE" });
    expect(await outbox.simulateReplyAction({ emailId: live.emailId, kind: "reply" })).toEqual({
      ok: false,
      error: "Only dry-run emails can be simulated. Real emails get their replies from real mailboxes.",
    });
    auth.user = null;
    expect((await outbox.simulateReplyAction({ emailId: s.emailId, kind: "reply" })).ok).toBe(false);
    expect(await db.inboundMessage.count({ where: { storageKey: `sim:${s.emailId}:reply` } })).toBe(0);
  });
});
