import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { makeCompany, makeUser, setSettingValue } from "../campaigns/seed";

/**
 * "They replied" (MAIN-DOMAIN-DESIGN O17, §2.9, §3.8, §8 P6): the one door for a reply the app never sees. Every follow-up
 * to the company stops with the reply codes (no InboundMessage); the status and `repliedAt` change only for a click that
 * counts as a real reply (a campaign that counts as emailed, or nothing open once the app has been live, or the practice
 * copy), so a rehearsal click never makes a test mailbox Replied. Own-mailbox mode against the free-plan fake.
 */

type TestUser = { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number };
const auth = vi.hoisted(() => ({ user: null as TestUser | null }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
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
  const requireUserAction = async () => {
    if (!auth.user) throw new AuthError("Your session has ended. Please sign in again.", 401);
    return auth.user;
  };
  return { AuthError, getUserOrNull: async () => auth.user, requireUserAction, requireUser: requireUserAction };
});

const t = await createTestDb("own-they-replied");
const { db, dbWrite } = await import("@/server/db");
const { markRepliedByHand, loadMarkRepliedFacts, theyRepliedShown } = await import("@/server/services/companies/replied-by-hand");
const { markRepliedAction } = await import("@/components/company-panel/actions");
const { evaluateCompanies } = await import("@/server/services/eligibility");
const { loadPipeline } = await import("@/server/services/dashboard/pipeline");
const { THEY_REPLIED_TEXTS } = await import("@/core/sending/own-mailbox");
const { STOP_SKIP_TEXT } = await import("@/server/services/mail-events/stops");

const DAY = 86_400_000;
let mg: FakeConnection;
let owner: { id: number; name: string };
let member: TestUser;
let seq = 0;

type Who = { companyId: number; personId: number; emailNorm: string };

/** A launched campaign where everyone got the first email and waits for a follow-up (QUEUED, due in two days). */
async function campaignWithFollowUps(opts: {
  name: string;
  mode?: "LIVE" | "TEST" | "DRY_RUN";
  launchedGoLive: boolean;
  status?: "RUNNING" | "PAUSED";
  people: Who[];
}) {
  const now = Date.now();
  return dbWrite(async (c) => {
    const campaign = await c.campaign.create({
      data: {
        name: opts.name,
        createdById: owner.id,
        senderId: owner.id,
        status: opts.status ?? "RUNNING",
        mode: opts.mode ?? "LIVE",
        launchedGoLive: opts.launchedGoLive,
        launchedAt: new Date(now - 3 * DAY),
        steps: { create: [{ step: 0, subject: "Hi", body: "Hi" }, { step: 1, body: "Following up", delayDays: 3 }] },
      },
    });
    for (const p of opts.people) {
      const r = await c.campaignRecipient.create({
        data: {
          campaignId: campaign.id,
          companyId: p.companyId,
          personId: p.personId,
          emailNorm: p.emailNorm,
          state: "WAITING",
          currentStep: 1,
          nextDueAt: new Date(now + 2 * DAY),
        },
      });
      for (const step of [0, 1]) {
        seq += 1;
        const sent = step === 0;
        await c.outboundEmail.create({
          data: {
            campaignId: campaign.id,
            recipientId: r.id,
            personId: p.personId,
            companyId: p.companyId,
            senderId: owner.id,
            step,
            mode: opts.mode ?? "LIVE",
            toEmail: p.emailNorm,
            toNorm: p.emailNorm,
            companyName: "Snapshot",
            fromAddress: "contact@example.com",
            subject: "Hi",
            text: "t",
            html: "h",
            messageId: `pp.they${seq}@example.com`,
            sendId: `they-${seq}`,
            dueAt: sent ? new Date(now - 3 * DAY) : new Date(now + 2 * DAY),
            status: sent ? "SENT" : "QUEUED",
            sentAt: sent ? new Date(now - 3 * DAY) : null,
            claimedAt: sent ? new Date(now - 3 * DAY) : null,
          },
        });
      }
    }
    return campaign;
  });
}

function who(company: { id: number }, person: { id: number; emailNorm: string | null }): Who {
  return { companyId: company.id, personId: person.id, emailNorm: person.emailNorm! };
}

async function recipientsOf(companyId: number) {
  return db.campaignRecipient.findMany({
    where: { companyId },
    orderBy: { id: "asc" },
    select: { id: true, campaignId: true, personId: true, state: true, stopReason: true, stoppedByInboundId: true },
  });
}

async function goLive(on: boolean) {
  await setSettingValue("sending.goLive", on);
  if (on) await setSettingValue("sending.goLiveAt", new Date(Date.now() - 5 * DAY).toISOString());
  else await dbWrite((c) => c.setting.deleteMany({ where: { key: "sending.goLiveAt" } }));
}

beforeAll(async () => {
  mg = await connectFakeMailgun({
    domain: "example.com",
    region: "US",
    replies: "own-mailbox",
    fromAddress: "contact@example.com",
    plan: "free",
    fake: { domain: "example.com", region: "US", plan: "free", receivesMail: false },
  });
  const o = await makeUser("Arslan", { role: "OWNER" });
  owner = { id: o.id, name: o.name };
  const m = await makeUser("Ali");
  member = { id: m.id, email: m.email, name: m.name, role: "MEMBER", timeZone: "Europe/Berlin", sessionId: 1 };
});

beforeEach(() => {
  auth.user = null;
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("before go-live: a click during the rehearsal", () => {
  it("stops the test company's follow-up but keeps its status and repliedAt, and the next live test still includes it", async () => {
    await goLive(false);
    await setSettingValue("sending.testList", ["tess@testbox.example"]);
    const { company, people } = await makeCompany({
      name: "Test Mailbox Tess",
      domain: "testbox.example",
      people: [{ name: "Tess", email: "tess@testbox.example" }],
    });
    // The reply rate below counts it only if the click had counted (it was "emailed" for the sake of that check).
    await dbWrite((c) => c.company.update({ where: { id: company.id }, data: { firstContactedAt: new Date(Date.now() - 3 * DAY) } }));
    const rehearsal = await campaignWithFollowUps({ name: "Live test", launchedGoLive: false, people: [who(company, people[0]!)] });

    const facts = await loadMarkRepliedFacts(company.id);
    expect(facts).toEqual({ countsAsReply: false, status: "NOT_CONTACTED", practiceCopy: false, replies: "own-mailbox" });

    const res = await markRepliedByHand(owner, { companyId: company.id, personId: people[0]!.id });
    expect(res).toEqual({ stopped: 1, statusChanged: false, companyName: "Test Mailbox Tess" });

    const [r] = await recipientsOf(company.id);
    expect(r).toMatchObject({ state: "STOPPED", stopReason: "replied", stoppedByInboundId: null });
    const followUp = await db.outboundEmail.findFirstOrThrow({ where: { recipientId: r!.id, step: 1 } });
    expect(followUp).toMatchObject({ status: "SKIPPED", lastError: STOP_SKIP_TEXT.replied });
    const after = await db.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(after.status).toBe("NOT_CONTACTED");
    expect(after.repliedAt).toBeNull();
    expect((await db.person.findUniqueOrThrow({ where: { id: people[0]!.id } })).repliedAt).toBeNull();
    // Nothing left in the rehearsal campaign: it finished.
    expect((await db.campaign.findUniqueOrThrow({ where: { id: rehearsal.id } })).status).toBe("FINISHED");

    const logged = await db.activityLog.findMany({ where: { companyId: company.id }, orderBy: { id: "asc" } });
    expect(logged.map((a) => a.type)).toEqual(["company.markedReplied"]);
    expect(logged[0]).toMatchObject({ actorId: owner.id, personId: people[0]!.id, summary: "Arslan marked Tess (Test Mailbox Tess) as replied" });
    expect(logged[0]!.data).toMatchObject({ personId: people[0]!.id, stopped: 1, statusFrom: "NOT_CONTACTED", statusTo: "NOT_CONTACTED", countsAsReply: false });

    // The next live test still includes the test mailbox (a status of Replied would leave it out).
    const next = (await evaluateCompanies([company.id], { mode: "LIVE" })).get(company.id)!;
    expect(next.status).toBe("NOT_CONTACTED");
    expect(next.companyReasons.map((x) => x.code)).not.toContain("company-replied");
    expect(next.blocked).toBeNull();
  });
});

describe("after go-live", () => {
  let acme: Awaited<ReturnType<typeof makeCompany>>;
  let beta: Awaited<ReturnType<typeof makeCompany>>;
  let first: { id: number };
  let second: { id: number };

  beforeAll(async () => {
    await goLive(true);
    acme = await makeCompany({
      name: "Acme Studio",
      domain: "acme.example",
      status: "CONTACTED",
      people: [
        { name: "Anna Berg", email: "anna@acme.example" },
        { name: "Ben Colleague", email: "ben@acme.example" },
      ],
    });
    await dbWrite((c) => c.company.update({ where: { id: acme.company.id }, data: { firstContactedAt: new Date(Date.now() - 3 * DAY) } }));
    // Already Replied and put back into a later campaign by hand.
    beta = await makeCompany({ name: "Beta Prints", domain: "beta.example", status: "REPLIED", people: [{ name: "Bo", email: "bo@beta.example" }] });
    first = await campaignWithFollowUps({
      name: "Germany Q4",
      launchedGoLive: true,
      people: [who(acme.company, acme.people[0]!), who(acme.company, acme.people[1]!)],
    });
    second = await campaignWithFollowUps({
      name: "Norway Q4",
      launchedGoLive: true,
      people: [who(acme.company, acme.people[0]!), who(beta.company, beta.people[0]!)],
    });
  });

  it("stops every follow-up in both campaigns with the reply codes, sets Replied and repliedAt, logs both activities and finishes a campaign left empty", async () => {
    const facts = await loadMarkRepliedFacts(acme.company.id);
    expect(facts).toMatchObject({ countsAsReply: true, status: "CONTACTED" });

    const at = new Date();
    const res = await markRepliedByHand(owner, { companyId: acme.company.id, personId: acme.people[0]!.id }, at);
    expect(res).toEqual({ stopped: 3, statusChanged: true, companyName: "Acme Studio" });

    const rows = await recipientsOf(acme.company.id);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      const anna = r.personId === acme.people[0]!.id;
      expect(r).toMatchObject({ state: "STOPPED", stopReason: anna ? "replied" : "company_replied", stoppedByInboundId: null });
      const followUp = await db.outboundEmail.findFirstOrThrow({ where: { recipientId: r.id, step: 1 } });
      expect(followUp).toMatchObject({ status: "SKIPPED", lastError: anna ? STOP_SKIP_TEXT.replied : STOP_SKIP_TEXT.company_replied });
    }

    const company = await db.company.findUniqueOrThrow({ where: { id: acme.company.id } });
    expect(company.status).toBe("REPLIED");
    expect(company.repliedAt?.getTime()).toBe(at.getTime());
    expect((await db.person.findUniqueOrThrow({ where: { id: acme.people[0]!.id } })).repliedAt?.getTime()).toBe(at.getTime());
    // Only the person named replied.
    expect((await db.person.findUniqueOrThrow({ where: { id: acme.people[1]!.id } })).repliedAt).toBeNull();

    const logged = await db.activityLog.findMany({ where: { companyId: acme.company.id }, orderBy: { id: "asc" } });
    expect(logged.map((a) => a.type)).toEqual(["company.status", "company.markedReplied"]);
    expect(logged[0]).toMatchObject({ actorId: owner.id, summary: "Arslan set status to Replied" });
    expect(logged[0]!.data).toEqual({ from: "CONTACTED", to: "REPLIED", markedReplied: true });
    expect(logged[1]).toMatchObject({ summary: "Arslan marked Anna Berg (Acme Studio) as replied" });
    expect(logged[1]!.data).toEqual({
      personId: acme.people[0]!.id,
      stopped: 3,
      statusFrom: "CONTACTED",
      statusTo: "REPLIED",
      at: at.toISOString(),
      countsAsReply: true,
    });

    // Germany Q4 had only Acme's people: it finished. Norway Q4 still has Beta.
    expect((await db.campaign.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("FINISHED");
    expect((await db.campaign.findUniqueOrThrow({ where: { id: second.id } })).status).toBe("RUNNING");
  });

  it("a second click stops nothing new and changes neither the status nor the stop codes", async () => {
    const before = await recipientsOf(acme.company.id);
    const res = await markRepliedByHand(owner, { companyId: acme.company.id, personId: acme.people[0]!.id }, new Date(Date.now() + 60_000));
    expect(res).toEqual({ stopped: 0, statusChanged: false, companyName: "Acme Studio" });
    expect(await recipientsOf(acme.company.id)).toEqual(before);
    expect((await db.company.findUniqueOrThrow({ where: { id: acme.company.id } })).status).toBe("REPLIED");
    // No second status activity.
    expect(await db.activityLog.count({ where: { companyId: acme.company.id, type: "company.status" } })).toBe(1);
  });

  it("a company already Replied (put back by hand) is stopped too, without a status change", async () => {
    const res = await markRepliedByHand(owner, { companyId: beta.company.id });
    expect(res).toEqual({ stopped: 1, statusChanged: false, companyName: "Beta Prints" });
    const [r] = await recipientsOf(beta.company.id);
    // Without a person, everyone gets "someone at the company replied".
    expect(r).toMatchObject({ state: "STOPPED", stopReason: "company_replied", stoppedByInboundId: null });
    const company = await db.company.findUniqueOrThrow({ where: { id: beta.company.id } });
    expect(company.status).toBe("REPLIED");
    expect(company.repliedAt).not.toBeNull();
    const logged = await db.activityLog.findMany({ where: { companyId: beta.company.id }, orderBy: { id: "asc" } });
    expect(logged.map((a) => a.type)).toEqual(["company.markedReplied"]);
    expect(logged[0]!.summary).toBe("Arslan marked Beta Prints as replied");
    expect((await db.campaign.findUniqueOrThrow({ where: { id: second.id } })).status).toBe("FINISHED");
  });

  it("a company with nothing open becomes Replied once the app has been live", async () => {
    const { company } = await makeCompany({ name: "Quiet Co", domain: "quiet.example", people: [{ name: "Q" }] });
    expect(await loadMarkRepliedFacts(company.id)).toMatchObject({ countsAsReply: true, status: "NOT_CONTACTED" });
    const res = await markRepliedByHand(owner, { companyId: company.id });
    expect(res).toEqual({ stopped: 0, statusChanged: true, companyName: "Quiet Co" });
    const after = await db.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(after.status).toBe("REPLIED");
    expect(after.repliedAt).not.toBeNull();
  });

  it("refuses a company marked Do not contact, a deleted company and a person of another company", async () => {
    const dnc = await makeCompany({ name: "Never Co", domain: "never.example", status: "DO_NOT_CONTACT", people: [{ name: "N" }] });
    await expect(markRepliedByHand(owner, { companyId: dnc.company.id })).rejects.toThrow(THEY_REPLIED_TEXTS.doNotContact);
    expect(await loadMarkRepliedFacts(dnc.company.id)).toBeNull();

    const gone = await makeCompany({ name: "Gone Co", domain: "gone.example", deletedAt: new Date(), people: [{ name: "G" }] });
    await expect(markRepliedByHand(owner, { companyId: gone.company.id })).rejects.toThrow("This company was deleted. Restore it first to make changes.");
    expect(await loadMarkRepliedFacts(gone.company.id)).toBeNull();

    const other = await makeCompany({ name: "Other Co", domain: "other.example", people: [{ name: "O" }] });
    await expect(markRepliedByHand(owner, { companyId: other.company.id, personId: acme.people[0]!.id })).rejects.toThrow(
      THEY_REPLIED_TEXTS.personGone,
    );
    const removed = await makeCompany({ name: "Removed Co", domain: "removed.example", people: [{ name: "R", deletedAt: new Date() }] });
    await expect(markRepliedByHand(owner, { companyId: removed.company.id, personId: removed.people[0]!.id })).rejects.toThrow(
      THEY_REPLIED_TEXTS.personGone,
    );
    // Nothing was written for the refusals.
    expect(await db.activityLog.count({ where: { companyId: { in: [dnc.company.id, gone.company.id, other.company.id, removed.company.id] } } })).toBe(0);
  });

  it("a Member may do it through the action, which answers with the toast", async () => {
    const { company, people } = await makeCompany({ name: "Gamma Goods", domain: "gamma.example", people: [{ name: "Gil", email: "gil@gamma.example" }] });
    await campaignWithFollowUps({ name: "Gamma run", launchedGoLive: true, people: [who(company, people[0]!)] });
    auth.user = member;
    const res = await markRepliedAction({ companyId: company.id, personId: people[0]!.id });
    expect(res).toMatchObject({ ok: true, message: "Marked as replied. Follow-ups to 1 person stopped." });
    const logged = await db.activityLog.findFirstOrThrow({ where: { companyId: company.id, type: "company.markedReplied" } });
    expect(logged).toMatchObject({ actorId: member.id, summary: "Ali marked Gil (Gamma Goods) as replied" });
    expect(await markRepliedAction({ companyId: company.id })).toMatchObject({ ok: true, message: "Marked as replied. No follow-ups were waiting." });
    expect(await markRepliedAction({ companyId: 0 })).toMatchObject({ ok: false });
    auth.user = null;
    expect(await markRepliedAction({ companyId: company.id })).toEqual({ ok: false, error: "Your session has ended. Please sign in again." });
  });

  it("the dashboard's reply rate counts only the clicks that count as a real reply", async () => {
    // Acme (a real reply, emailed) and the rehearsal's test mailbox (not a real reply) are the only "emailed" companies.
    const rate = (await loadPipeline(new Date())).replyRate;
    expect(rate.emailed).toBe(2);
    expect(rate.replied).toBe(1);
  });
});

describe("the practice copy", () => {
  it("shows the button and a dry-run company becomes Replied", async () => {
    await goLive(false);
    await setSettingValue("practice.copy", true);
    try {
      const { company, people } = await makeCompany({
        name: "Practice Prints",
        domain: "practice.example",
        status: "CONTACTED",
        people: [{ name: "Pia", email: "pia@practice.example" }],
      });
      await campaignWithFollowUps({ name: "Dry run", mode: "DRY_RUN", launchedGoLive: false, people: [who(company, people[0]!)] });
      expect(await loadMarkRepliedFacts(company.id)).toMatchObject({ countsAsReply: true, practiceCopy: true });
      const res = await markRepliedByHand(owner, { companyId: company.id, personId: people[0]!.id });
      expect(res).toEqual({ stopped: 1, statusChanged: true, companyName: "Practice Prints" });
      expect((await db.company.findUniqueOrThrow({ where: { id: company.id } })).status).toBe("REPLIED");
    } finally {
      await setSettingValue("practice.copy", false);
    }
  });
});

describe("where the button shows", () => {
  it("own-mailbox mode, shared-From mode and the practice copy; never real per-person mode", async () => {
    expect(theyRepliedShown({ replies: "own-mailbox", address: null }, false)).toBe(true);
    expect(theyRepliedShown({ replies: "app", address: "contact@example.com" }, false)).toBe(true);
    expect(theyRepliedShown({ replies: "app", address: null }, true)).toBe(true);
    expect(theyRepliedShown({ replies: "app", address: null }, false)).toBe(false);

    const { company } = await makeCompany({ name: "Per Person Co", domain: "perperson.example", people: [{ name: "P" }] });
    expect(await loadMarkRepliedFacts(company.id)).not.toBeNull();
    // Real per-person mode: the app mode without a shared From.
    await setSettingValue("mailgun.replies", "app");
    await setSettingValue("mailgun.fromAddress", "");
    try {
      expect(await loadMarkRepliedFacts(company.id)).toBeNull();
    } finally {
      await setSettingValue("mailgun.replies", "own-mailbox");
      await setSettingValue("mailgun.fromAddress", "contact@example.com");
    }
  });
});
