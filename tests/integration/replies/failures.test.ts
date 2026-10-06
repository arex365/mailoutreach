import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { postInbound, replyTo } from "../helpers/replies";

/**
 * A message whose processing keeps failing (M4-DESIGN §3.8, D25): retried after 1, 5, 15 and 60 minutes (never 5 times
 * in 5 seconds), then the fail-safe holds the company it points at and lists it for the Owner. Never a release.
 */

const t = await createTestDb("replies-failures");
const mg = await connectFakeMailgun();
const { db } = await import("@/server/db");
const w = await import("./world");
const { processPendingInbound, processInboundMessage, getWaitingReply, applyReplyFailSafe, confirmReply, INBOUND_RETRY_DELAYS_MS } = await import(
  "@/server/services/replies"
);
const { undecidedHolds } = await import("@/server/services/sequences/holds");

/** An unprocessed simulated reply (as the dry-run outbox's "Unclear reply" stores it) to one dry-run email. */
async function storeSimulated(emailId: number, messageId: string, from: string): Promise<number> {
  const { dbWrite } = await import("@/server/db");
  const row = await dbWrite((c) =>
    c.inboundMessage.create({
      data: {
        storageKey: `sim:${emailId}:unclear`,
        messageIdHeader: `sim.${emailId}.unclear@simulated.invalid`,
        receivedAt: new Date(),
        toAddress: "ali@send.example.com",
        fromEmail: from,
        subject: "Re: 3D models for your shop",
        snippet: "I'm out of the office this week, but yes, we're interested.",
        strippedText: "I'm out of the office this week, but yes, we're interested. Please send details.",
        inReplyTo: messageId,
        references: messageId,
        headers: [] as never,
        source: "SIMULATED",
      },
    }),
  );
  return row.id;
}

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

const MIN = 60_000;
const quiet = { error: () => undefined };

/** Processing that throws for the listed ids and works for everything else; counts the tries per id. */
function failingFor(ids: ReadonlySet<number>) {
  const tries = new Map<number, number>();
  return {
    tries,
    processOne: async (id: number, o: { now: Date }) => {
      tries.set(id, (tries.get(id) ?? 0) + 1);
      if (ids.has(id)) throw new Error("database is busy for too long");
      return processInboundMessage(id, o);
    },
  };
}

describe("retries with back-off, then the fail-safe", () => {
  it("retries after 1, 5, 15 and 60 minutes; after the 5th failure the company is held and the Owner is told", async () => {
    expect(INBOUND_RETRY_DELAYS_MS).toEqual([60_000, 300_000, 900_000, 3_600_000]);
    const firma = await w.makeCompany("Firma GmbH", { domain: "firma.de" });
    const anna = await w.makePerson(firma.id, "anna@firma.de", "Anna Berg");
    const ben = await w.makePerson(firma.id, "ben@firma.de", "Ben Braun");
    const camp = await w.makeCampaign({ createdById: ali.id });
    const a = await w.sendEmail(camp, anna);
    const b = await w.sendEmail(camp, ben);
    const posted = await replyTo(mg.fake, a.emailId);
    const id = posted.id!;
    const failures = new Map<number, { count: number; nextTryAt: number }>();
    const run = failingFor(new Set([id]));
    const t0 = Date.now();
    const at = (ms: number) => processPendingInbound({ now: new Date(t0 + ms), failures, processOne: run.processOne, logger: quiet });

    expect(await at(0)).toEqual({ processed: 0, failed: 1 });
    // Five seconds of lane ticks don't use up the tries.
    for (let s = 1; s <= 5; s++) await at(s * 1000);
    expect(run.tries.get(id)).toBe(1);
    await at(30_000);
    expect(run.tries.get(id)).toBe(1);
    await at(1 * MIN + 1); // 2nd try
    await at(1 * MIN + 1 + 4 * MIN); // still waiting (5 minutes)
    expect(run.tries.get(id)).toBe(2);
    await at(6 * MIN + 2); // 3rd try
    await at(21 * MIN + 3); // 4th try
    expect(run.tries.get(id)).toBe(4);
    expect(await w.inbound(id)).toMatchObject({ processedAt: null }); // meanwhile the sending guard holds the company
    await at(81 * MIN + 4); // 5th try: fails for good → fail-safe
    expect(run.tries.get(id)).toBe(5);
    expect(failures.has(id)).toBe(false);

    const row = await w.inbound(id);
    expect(row).toMatchObject({
      kind: "POSSIBLE_REPLY",
      autoReason: "process-failed",
      companyId: firma.id,
      outboundEmailId: a.emailId,
      replyScope: "real",
      assigneeId: owner.id,
    });
    expect(row.processedAt).toBeInstanceOf(Date);
    expect(await w.recipient(a.recipientId)).toMatchObject({ state: "HELD", holdReason: "possible-reply" });
    expect(await w.recipient(b.recipientId)).toMatchObject({ state: "HELD", holdReason: "possible-reply" });
    expect(await w.email(a.queuedId!)).toMatchObject({ status: "QUEUED" });
    // The sending guard's input: an undecided message of Firma in real scope.
    expect(await undecidedHolds(db, [firma.id])).toEqual([{ companyId: firma.id, campaignId: null }]);
    expect(await w.notificationsOf(owner.id)).toContainEqual({
      type: "reply.unlinked",
      title: "A reply we couldn't link to a company",
      body:
        "The app couldn't read a message from anna@firma.de, so it's listed here. Open it in your inbox, then decide on the Notifications page. " +
        "Follow-ups to Firma GmbH wait until you do.",
      link: `/notifications?reply=${id}#replies`,
    });
    const view = await getWaitingReply(owner, id);
    expect(view?.whyLines).toContain("The app couldn't read this message, so it held the company's follow-ups to be safe. Open it in your inbox.");
  });

  it("with no company found the message becomes UNLINKED (process-failed) and the Owner is told", async () => {
    const posted = await postInbound(mg.fake, { from: "stranger@nowhere.example", to: "ali@send.example.com", subject: "Hello", text: "Hi" });
    const id = posted.id!;
    const failures = new Map<number, { count: number; nextTryAt: number }>();
    const run = failingFor(new Set([id]));
    const t0 = Date.now();
    for (const ms of [0, 1 * MIN + 1, 6 * MIN + 2, 21 * MIN + 3, 81 * MIN + 4]) {
      await processPendingInbound({ now: new Date(t0 + ms), failures, processOne: run.processOne, logger: quiet });
    }
    expect(run.tries.get(id)).toBe(5);
    expect(await w.inbound(id)).toMatchObject({ kind: "UNLINKED", autoReason: "process-failed", companyId: null, heldCompanyId: null, assigneeId: owner.id });
    expect(await w.notificationsOf(owner.id)).toContainEqual({
      type: "reply.unlinked",
      title: "A reply we couldn't link to a company",
      body: "The app couldn't read a message from stranger@nowhere.example, so it's listed here. Open it in your inbox, then decide on the Notifications page.",
      link: `/notifications?reply=${id}#replies`,
    });
  });

  it("a simulated reply on real data that keeps failing holds only its dry run's campaign (DATA-06)", async () => {
    const firma = await w.makeCompany("Firma Vier", { domain: "firma4.de" });
    const anna = await w.makePerson(firma.id, "anna@firma4.de", "Anna Vier");
    const live = await w.makeCampaign({ createdById: ali.id, name: "Live Vier" });
    const dry = await w.makeCampaign({ createdById: ali.id, mode: "DRY_RUN", name: "Practice Vier" });
    const liveSent = await w.sendEmail(live, anna);
    const drySent = await w.sendEmail(dry, anna);
    const id = await storeSimulated(drySent.emailId, drySent.messageId, "anna@firma4.de");
    await w.setSetting("sending.goLive", true);
    try {
      expect(await applyReplyFailSafe(id)).toBe(true);
      expect(await w.inbound(id)).toMatchObject({
        kind: "POSSIBLE_REPLY",
        autoReason: "process-failed",
        companyId: firma.id,
        campaignId: dry.id,
        outboundEmailId: drySent.emailId,
        linkMethod: "simulated",
        replyScope: "campaign",
        changesStatus: false,
        assigneeId: owner.id,
      });
      // Only the dry run waits; the live campaign's follow-up to the same company doesn't.
      expect(await w.recipient(drySent.recipientId)).toMatchObject({ state: "HELD", holdReason: "possible-reply" });
      expect(await w.recipient(liveSent.recipientId)).toMatchObject({ state: "WAITING", holdReason: null });
      expect(await undecidedHolds(db, [firma.id])).toEqual([{ companyId: firma.id, campaignId: dry.id }]);

      // "Real reply" then stops only the dry run, and the company's status stays, even after go-live.
      await confirmReply(owner, id, true);
      expect(await w.recipient(drySent.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "replied" });
      expect(await w.recipient(liveSent.recipientId)).toMatchObject({ state: "WAITING" });
      expect(await db.company.findUniqueOrThrow({ where: { id: firma.id } })).toMatchObject({ status: "CONTACTED", repliedAt: null });
    } finally {
      await w.setSetting("sending.goLive", false);
    }
  });

  it("a simulated reply on real data whose dry-run email is gone is only listed: no hold through the contact (DATA-06)", async () => {
    const firma = await w.makeCompany("Firma Fünf", { domain: "firma5.de" });
    const anna = await w.makePerson(firma.id, "anna@firma5.de", "Anna Fünf");
    const live = await w.makeCampaign({ createdById: ali.id });
    const liveSent = await w.sendEmail(live, anna);
    const id = await storeSimulated(999_001, "pp.gone000000000000000000@dry-run.invalid", "anna@firma5.de");
    expect(await applyReplyFailSafe(id)).toBe(true);
    expect(await w.inbound(id)).toMatchObject({ kind: "UNLINKED", autoReason: "process-failed", companyId: null, replyScope: "none", assigneeId: owner.id });
    expect(await w.recipient(liveSent.recipientId)).toMatchObject({ state: "WAITING", holdReason: null });
    expect(await undecidedHolds(db, [firma.id])).toEqual([]);
  });

  it("in the practice copy a simulated reply's fail-safe holds in real scope, as a real one would", async () => {
    const firma = await w.makeCompany("Firma Sechs", { domain: "firma6.de" });
    const anna = await w.makePerson(firma.id, "anna@firma6.de", "Anna Sechs");
    const dry = await w.makeCampaign({ createdById: ali.id, mode: "DRY_RUN" });
    const other = await w.makeCampaign({ createdById: ali.id, mode: "DRY_RUN" });
    const drySent = await w.sendEmail(dry, anna);
    const otherSent = await w.sendEmail(other, anna);
    const id = await storeSimulated(drySent.emailId, drySent.messageId, "anna@firma6.de");
    await w.setSetting("practice.copy", true);
    try {
      expect(await applyReplyFailSafe(id)).toBe(true);
    } finally {
      await w.setSetting("practice.copy", false);
    }
    expect(await w.inbound(id)).toMatchObject({ kind: "POSSIBLE_REPLY", companyId: firma.id, replyScope: "real", changesStatus: true });
    expect(await w.recipient(otherSent.recipientId)).toMatchObject({ state: "HELD", holdReason: "possible-reply" });
  });

  it("forgets a message the other process handled while it waited for its retry", async () => {
    const posted = await postInbound(mg.fake, { from: "later@nowhere2.example", to: "ali@send.example.com", subject: "Y", text: "Y" });
    const id = posted.id!;
    const failures = new Map<number, { count: number; nextTryAt: number }>();
    const t0 = Date.now();
    await processPendingInbound({ now: new Date(t0), failures, processOne: failingFor(new Set([id])).processOne, logger: quiet });
    expect(failures.get(id)?.count).toBe(1);
    await processInboundMessage(id); // e.g. the web process
    await processPendingInbound({ now: new Date(t0 + 2 * MIN), failures, logger: quiet });
    expect(failures.has(id)).toBe(false);
    expect(await w.inbound(id)).toMatchObject({ kind: "UNLINKED" });
  });

  it("other messages keep being processed while one is waiting for its retry", async () => {
    const firma = await w.makeCompany("Firma Drei", { domain: "firma3.de" });
    const anna = await w.makePerson(firma.id, "anna@firma3.de", "Anna Drei");
    const camp = await w.makeCampaign({ createdById: ali.id });
    const a = await w.sendEmail(camp, anna);
    const bad = await postInbound(mg.fake, { from: "broken@nowhere3.example", to: "ali@send.example.com", subject: "X", text: "X" });
    const good = await replyTo(mg.fake, a.emailId);
    const run = failingFor(new Set([bad.id!]));
    const res = await processPendingInbound({ now: new Date(), failures: new Map(), processOne: run.processOne, logger: quiet });
    expect(res).toEqual({ processed: 1, failed: 1 });
    expect(await w.inbound(good.id)).toMatchObject({ kind: "REPLY" });
    expect(await w.inbound(bad.id)).toMatchObject({ processedAt: null });
  });
});
