import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { daysAgo, makeCompany, makeDraft, makeUser, setSettingValue, type StepSeed } from "../campaigns/seed";

const t = await createTestDb("sending-mark-sent");
const { db, dbWrite } = await import("@/server/db");
const { launchCampaign } = await import("@/server/services/campaigns/launch");
const { claimEmail } = await import("@/server/services/sending/claim");
const { markSent, sweepFollowUps } = await import("@/server/services/sending/mark-sent");

const DAY = 86_400_000;
/** Monday 21 Sep 2026, 10:00 in Berlin: no daylight-saving change in the next weeks, so calendar days are 24 hours. */
const MONDAY = new Date("2026-09-21T08:00:00Z");
let ali: { id: number };
let sara: { id: number };
let n = 0;

beforeAll(async () => {
  ali = await makeUser("Ali", { role: "OWNER" });
  sara = await makeUser("Sara");
});

beforeEach(async () => {
  await setSettingValue("practice.copy", false);
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

/** A launched one-person campaign; returns its first email (claimed, as the loop would). */
async function launched(opts: { steps?: StepSeed[]; daysAsMinutes?: boolean; status?: "NOT_CONTACTED" | "REPLIED"; importedLastContactAt?: Date } = {}) {
  n += 1;
  const { company, people } = await makeCompany({
    name: `Mark ${n}`,
    status: opts.status,
    importedLastContactAt: opts.importedLastContactAt,
    people: [{ name: "Anna", email: `anna@mark${n}.de` }],
  });
  const draft = await makeDraft({
    name: `Campaign ${n}`,
    createdById: ali.id,
    senderId: sara.id,
    steps: opts.steps,
    daysAsMinutes: opts.daysAsMinutes,
    recipients: [{ companyId: company.id, personId: people[0]!.id, warnings: { overrides: ["company-replied"] } }],
  });
  await launchCampaign(draft.id, ali.id);
  const email = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: draft.id, step: 0 } });
  expect(await claimEmail(email.id)).toBe(true);
  return { company, person: people[0]!, campaignId: draft.id, email };
}

describe("markSent", () => {
  it("in a dry run on real data, changes only the campaign (no emailed fields, no status)", async () => {
    const { company, person, email, campaignId } = await launched();
    const at = new Date();
    const res = await markSent(email.id, at, { providerId: "dry-run:x" });
    expect(res).toMatchObject({ alreadySent: false, counted: false, finished: true, next: null });
    const row = await db.outboundEmail.findUniqueOrThrow({ where: { id: email.id } });
    expect(row).toMatchObject({ status: "SENT", providerId: "dry-run:x", lastError: null });
    expect(row.sentAt?.getTime()).toBe(at.getTime());
    const c = await db.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(c).toMatchObject({ status: "NOT_CONTACTED", lastEmailedAt: null, firstContactedById: null, lastContactAt: null });
    expect((await db.person.findUniqueOrThrow({ where: { id: person.id } })).lastEmailedAt).toBeNull();
    const rec = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } });
    expect(rec.state).toBe("FINISHED");
    const activity = await db.activityLog.findFirstOrThrow({ where: { campaignId, type: "email.sent" } });
    expect(activity).toMatchObject({ actorId: sara.id, mode: "DRY_RUN", companyId: company.id, personId: person.id });
    expect(activity.summary).toBe(`First email sent to anna@mark${n}.de (Campaign ${n})`);
  });

  it("in the practice copy, behaves like live: emailed fields, first contacted, Contacted status", async () => {
    await setSettingValue("practice.copy", true);
    const imported = daysAgo(60);
    const { company, person, email } = await launched({ importedLastContactAt: imported });
    const at = new Date();
    const res = await markSent(email.id, at);
    expect(res.counted).toBe(true);
    const c = await db.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(c).toMatchObject({
      status: "CONTACTED",
      lastEmailedById: sara.id,
      lastEmailedStep: 0,
      firstContactedById: sara.id,
    });
    expect(c.lastEmailedAt?.getTime()).toBe(at.getTime());
    expect(c.lastContactAt?.getTime()).toBe(at.getTime());
    expect(c.firstContactedAt?.getTime()).toBe(at.getTime());
    const p = await db.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(p).toMatchObject({ lastEmailedById: sara.id, lastEmailedStep: 0 });
    const statusLog = await db.activityLog.findFirstOrThrow({ where: { companyId: company.id, type: "company.status" } });
    expect(statusLog.summary).toBe(`Status changed to Contacted: the first email went to anna@mark${n}.de`);
  });

  it("never overwrites first contacted, a later email date, or a status other than Not contacted", async () => {
    await setSettingValue("practice.copy", true);
    const { company, email } = await launched({ status: "REPLIED" });
    const later = new Date(Date.now() + DAY);
    await dbWrite((c) =>
      c.company.update({ where: { id: company.id }, data: { firstContactedById: ali.id, firstContactedAt: daysAgo(100), lastEmailedAt: later } }),
    );
    await markSent(email.id, new Date());
    const c = await db.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(c.status).toBe("REPLIED");
    expect(c.firstContactedById).toBe(ali.id);
    expect(c.lastEmailedAt?.getTime()).toBe(later.getTime());
  });

  it("is safe to call twice", async () => {
    const { email, campaignId } = await launched();
    await markSent(email.id, new Date());
    const again = await markSent(email.id, new Date());
    expect(again.alreadySent).toBe(true);
    expect(await db.activityLog.count({ where: { type: "email.sent", campaignId } })).toBe(1);
  });

  it("creates the next enabled step's email in the same thread, due after its delay", async () => {
    const { email, campaignId } = await launched({
      steps: [
        { step: 0, subject: "Hello", body: "First" },
        { step: 1, body: "Second", delayDays: 3, enabled: false },
        { step: 2, body: "Third", delayDays: 4 },
        { step: 3, body: "Fourth", delayDays: 7 },
      ],
    });
    // A dry run with "Ignore sending hours" (the default): calendar days, no move into sending hours.
    const at = MONDAY;
    const res = await markSent(email.id, at);
    expect(res.finished).toBe(false);
    expect(res.next?.step).toBe(2);
    expect(res.next?.dueAt.getTime()).toBe(at.getTime() + 4 * DAY);
    const next = await db.outboundEmail.findUniqueOrThrow({ where: { id: res.next!.emailId } });
    expect(next).toMatchObject({
      step: 2,
      status: "QUEUED",
      mode: "DRY_RUN",
      toNorm: email.toNorm,
      fromAddress: email.fromAddress,
      senderId: email.senderId,
      inReplyTo: email.messageId,
      references: email.messageId,
      subject: "",
    });
    expect(next.messageId).toMatch(/^pp\.[0-9a-f]{24}@dry-run\.invalid$/);
    expect(next.messageId).not.toBe(email.messageId);
    const rec = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } });
    expect(rec).toMatchObject({ state: "WAITING", currentStep: 2 });
    expect(rec.nextDueAt?.getTime()).toBe(at.getTime() + 4 * DAY);

    // Sending that one threads onwards.
    await dbWrite((c) => c.outboundEmail.update({ where: { id: next.id }, data: { status: "SENDING" } }));
    const third = await markSent(next.id, new Date(at.getTime() + 4 * DAY));
    const row3 = await db.outboundEmail.findUniqueOrThrow({ where: { id: third.next!.emailId } });
    expect(row3).toMatchObject({ step: 3, inReplyTo: next.messageId, references: `${email.messageId} ${next.messageId}` });
    expect(row3.dueAt.getTime()).toBe(at.getTime() + 11 * DAY);
  });

  it("treats follow-up days as minutes for practice dry runs", async () => {
    const { email } = await launched({
      daysAsMinutes: true,
      steps: [
        { step: 0, subject: "Hello", body: "First" },
        { step: 1, body: "Second", delayDays: 3 },
      ],
    });
    const at = new Date();
    const res = await markSent(email.id, at);
    expect(res.next?.dueAt.getTime()).toBe(at.getTime() + 3 * 60_000);
  });

  it("releases the company's reservation when its last recipient finishes (practice copy)", async () => {
    await setSettingValue("practice.copy", true);
    const { email, campaignId, company } = await launched();
    expect(await db.companyReservation.count({ where: { campaignId, companyId: company.id, releasedAt: null } })).toBe(1);
    await markSent(email.id, new Date());
    expect(await db.companyReservation.count({ where: { campaignId, companyId: company.id, releasedAt: null } })).toBe(0);
  });

  it("leaves a stopped recipient stopped, with no next email", async () => {
    const { email, campaignId } = await launched({
      steps: [
        { step: 0, subject: "Hello", body: "First" },
        { step: 1, body: "Second", delayDays: 3 },
      ],
    });
    await dbWrite((c) => c.campaignRecipient.updateMany({ where: { campaignId }, data: { state: "STOPPED", stopReason: "replied" } }));
    const res = await markSent(email.id, new Date());
    expect(res.next).toBeNull();
    expect(await db.outboundEmail.count({ where: { campaignId } })).toBe(1);
    expect((await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } })).state).toBe("STOPPED");
  });
});

describe("the follow-up sweeper", () => {
  it("creates a missing next email, or finishes recipients with no more steps", async () => {
    const withNext = await launched({
      steps: [
        { step: 0, subject: "Hello", body: "First" },
        { step: 1, body: "Second", delayDays: 2 },
      ],
    });
    const lastStep = await launched();
    // Simulate an older version that marked the emails sent without moving the recipients on.
    const sentAt = MONDAY;
    await dbWrite((c) =>
      c.outboundEmail.updateMany({ where: { id: { in: [withNext.email.id, lastStep.email.id] } }, data: { status: "SENT", sentAt } }),
    );
    const res = await sweepFollowUps(new Date());
    expect(res).toMatchObject({ created: 1, finished: 1 });
    const next = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: withNext.campaignId, step: 1 } });
    expect(next.dueAt.getTime()).toBe(sentAt.getTime() + 2 * DAY);
    expect(next.inReplyTo).toBe(withNext.email.messageId);
    expect((await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: withNext.campaignId } })).state).toBe("WAITING");
    expect((await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: lastStep.campaignId } })).state).toBe("FINISHED");
    // Nothing left to repair.
    expect(await sweepFollowUps(new Date())).toMatchObject({ checked: 0, created: 0, finished: 0 });
  });

  it("leaves alone people with an email on its way, a later email that won't be sent, a stop, or a cancelled campaign", async () => {
    const steps: StepSeed[] = [
      { step: 0, subject: "Hello", body: "First" },
      { step: 1, body: "Second", delayDays: 2 },
      { step: 2, body: "Third", delayDays: 2 },
    ];
    const sentAt = new Date(Date.now() - 60_000);
    const markStepSent = async (emailId: number) =>
      dbWrite((c) => c.outboundEmail.update({ where: { id: emailId }, data: { status: "SENT", sentAt } }));

    // Normal: first email sent, follow-up 1 waiting.
    const waiting = await launched({ steps });
    await markSent(waiting.email.id, sentAt);
    // Follow-up 1 was skipped by hand after the first email went: not ours to repair.
    const laterSkipped = await launched({ steps });
    await markSent(laterSkipped.email.id, sentAt);
    await dbWrite((c) => c.outboundEmail.updateMany({ where: { campaignId: laterSkipped.campaignId, step: 1 }, data: { status: "SKIPPED" } }));
    // Stopped person.
    const stopped = await launched({ steps });
    await markStepSent(stopped.email.id);
    await dbWrite((c) => c.campaignRecipient.updateMany({ where: { campaignId: stopped.campaignId }, data: { state: "STOPPED" } }));
    // Cancelled campaign.
    const cancelled = await launched({ steps });
    await markStepSent(cancelled.email.id);
    await dbWrite((c) => c.campaign.update({ where: { id: cancelled.campaignId }, data: { status: "CANCELLED" } }));
    // The one that needs repairing: sent, but moved on nowhere.
    const stuck = await launched({ steps });
    await markStepSent(stuck.email.id);

    const before = await db.outboundEmail.count();
    expect(await sweepFollowUps(new Date())).toEqual({ checked: 1, created: 1, finished: 0 });
    expect(await db.outboundEmail.count()).toBe(before + 1);
    const created = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: stuck.campaignId, step: 1 } });
    expect(created).toMatchObject({ status: "QUEUED", recipientId: stuck.email.recipientId });
    for (const c of [laterSkipped, stopped, cancelled]) {
      expect(await db.outboundEmail.count({ where: { campaignId: c.campaignId, status: "QUEUED" } })).toBe(0);
    }
  });

  it("repairs a few at a time across campaigns", async () => {
    const stuck = [];
    for (let i = 0; i < 3; i++) {
      const s = await launched();
      await dbWrite((c) => c.outboundEmail.update({ where: { id: s.email.id }, data: { status: "SENT", sentAt: new Date() } }));
      stuck.push(s);
    }
    expect(await sweepFollowUps(new Date(), 2)).toEqual({ checked: 2, created: 0, finished: 2 });
    expect(await sweepFollowUps(new Date(), 2)).toEqual({ checked: 1, created: 0, finished: 1 });
    for (const s of stuck) {
      expect((await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: s.campaignId } })).state).toBe("FINISHED");
    }
  });

  it("stays quick with thousands of people waiting for a follow-up (the usual state of a dry run)", async () => {
    const PEOPLE = 3_000;
    const STUCK = 4;
    const { company } = await makeCompany({ name: "Big sweep", people: [] });
    const campaign = await dbWrite((c) =>
      c.campaign.create({
        data: {
          name: "Big sweep",
          createdById: ali.id,
          senderId: sara.id,
          status: "RUNNING",
          mode: "DRY_RUN",
          steps: { create: [{ step: 0, subject: "Hello", body: "First" }, { step: 1, body: "Second", delayDays: 3 }] },
        },
      }),
    );
    for (let i = 0; i < PEOPLE; i += 500) {
      const data = Array.from({ length: Math.min(500, PEOPLE - i) }, (_, k) => {
        const email = `p${i + k}@big-sweep.de`;
        return { companyId: company.id, name: `P ${i + k}`, email, emailNorm: email };
      });
      await dbWrite((c) => c.person.createMany({ data }));
    }
    const people = await db.person.findMany({ where: { companyId: company.id }, select: { id: true, emailNorm: true }, orderBy: { id: "asc" } });
    for (let i = 0; i < people.length; i += 500) {
      const data = people.slice(i, i + 500).map((p) => ({
        campaignId: campaign.id,
        companyId: company.id,
        personId: p.id,
        emailNorm: p.emailNorm!,
        state: "WAITING" as const,
        currentStep: 1,
      }));
      await dbWrite((c) => c.campaignRecipient.createMany({ data }));
    }
    const recipients = await db.campaignRecipient.findMany({ where: { campaignId: campaign.id }, select: { id: true, personId: true, emailNorm: true }, orderBy: { id: "asc" } });
    const text = "Lorem ipsum dolor sit amet. ".repeat(55); // ~1.5 KB, like a real email
    const sentAt = new Date(Date.now() - 60_000);
    const rows = recipients.flatMap((r, i) => {
      const base = {
        campaignId: campaign.id,
        recipientId: r.id,
        personId: r.personId,
        companyId: company.id,
        senderId: sara.id,
        mode: "DRY_RUN" as const,
        toEmail: r.emailNorm,
        toNorm: r.emailNorm,
        companyName: "Big sweep",
        fromAddress: "Sara <sara@your-sending-domain>",
      };
      const first = {
        ...base,
        step: 0,
        subject: "Hello",
        text,
        html: `<p>${text}</p>`,
        messageId: `pp.big${r.id}s0@dry-run.invalid`,
        sendId: `big-${r.id}-0`,
        dueAt: sentAt,
        sentAt,
        status: "SENT" as const,
      };
      // The last few people never got their follow-up row (what the sweeper repairs).
      if (i >= recipients.length - STUCK) return [first];
      const next = {
        ...base,
        step: 1,
        subject: "",
        text: "",
        html: "",
        messageId: `pp.big${r.id}s1@dry-run.invalid`,
        sendId: `big-${r.id}-1`,
        dueAt: new Date(sentAt.getTime() + 3 * DAY),
        status: "QUEUED" as const,
      };
      return [first, next];
    });
    for (let i = 0; i < rows.length; i += 500) {
      const data = rows.slice(i, i + 500);
      await dbWrite((c) => c.outboundEmail.createMany({ data }));
    }

    const started = performance.now();
    const res = await sweepFollowUps(new Date());
    const took = performance.now() - started;
    expect(res).toEqual({ checked: STUCK, created: STUCK, finished: 0 });
    // The old per-person search took tens of seconds at this size once the table outgrew the cache.
    expect(took).toBeLessThan(3_000);
    expect(await db.outboundEmail.count({ where: { campaignId: campaign.id, step: 1 } })).toBe(PEOPLE);
    // A second run finds nothing and is just as quick.
    const again = performance.now();
    expect(await sweepFollowUps(new Date())).toEqual({ checked: 0, created: 0, finished: 0 });
    expect(performance.now() - again).toBeLessThan(3_000);
  }, 120_000);
});
