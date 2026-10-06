import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { daysAgo, makeCompany, makeDraft, makeUser, setSettingValue, type StepSeed } from "./seed";

const t = await createTestDb("campaign-control");
const { db, dbWrite } = await import("@/server/db");
const { launchCampaign } = await import("@/server/services/campaigns/launch");
const control = await import("@/server/services/campaigns/control");
const { CampaignError, SENDING_NOW } = await import("@/server/services/campaigns/errors");
const { claimEmail } = await import("@/server/services/sending/claim");
const { markSent } = await import("@/server/services/sending/mark-sent");
const { expirePausedReservations } = await import("@/server/services/reservations");

const DAY = 86_400_000;
let arslan: { id: number };
let ali: { id: number };
let sara: { id: number };
let n = 0;

beforeAll(async () => {
  arslan = await makeUser("Arslan", { role: "OWNER" });
  ali = await makeUser("Ali");
  sara = await makeUser("Sara");
});

beforeEach(async () => {
  await setSettingValue("practice.copy", false);
  await setSettingValue("reservations.pausedExpiryDays", 14);
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

async function launched(count = 2, opts: { steps?: StepSeed[]; launcherId?: number } = {}) {
  n += 1;
  const recipients = [];
  for (let i = 0; i < count; i++) {
    const { company, people } = await makeCompany({ name: `Ctl ${n}-${i}`, people: [{ name: `Anna ${i}`, email: `anna${i}@ctl${n}-${i}.de` }] });
    recipients.push({ companyId: company.id, personId: people[0]!.id });
  }
  const draft = await makeDraft({ name: `Control ${n}`, createdById: arslan.id, senderId: ali.id, steps: opts.steps, recipients });
  await launchCampaign(draft.id, opts.launcherId ?? arslan.id);
  const recs = await db.campaignRecipient.findMany({ where: { campaignId: draft.id }, orderBy: { id: "asc" } });
  return { campaignId: draft.id, recipients: recs };
}

async function refusal(p: Promise<unknown>): Promise<InstanceType<typeof CampaignError>> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CampaignError);
  return err as InstanceType<typeof CampaignError>;
}

describe("pause, resume and cancel", () => {
  it("pauses and resumes, logging who did it", async () => {
    const { campaignId } = await launched();
    const p = await control.pauseCampaign(campaignId, sara.id);
    expect(p).toEqual({ status: "PAUSED", message: `Paused Control ${n}. Nothing more is sent until you resume it.` });
    const paused = await db.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(paused).toMatchObject({ status: "PAUSED", pauseReason: "Paused by Sara" });
    expect(paused.pausedAt).not.toBeNull();
    expect((await refusal(control.pauseCampaign(campaignId, sara.id))).code).toBe("already-paused");

    const r = await control.resumeCampaign(campaignId, ali.id);
    expect(r).toMatchObject({ status: "RUNNING", lostCompanies: 0, message: `Resumed Control ${n}.` });
    expect(await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).toMatchObject({ status: "RUNNING", pausedAt: null, pauseReason: null });
    expect((await refusal(control.resumeCampaign(campaignId, ali.id))).message).toBe("This campaign isn't paused.");
    const types = (await db.activityLog.findMany({ where: { campaignId }, orderBy: { id: "asc" } })).map((a) => [a.type, a.actorId, a.summary]);
    expect(types).toContainEqual(["campaign.paused", sara.id, `Sara paused Control ${n}`]);
    expect(types).toContainEqual(["campaign.resumed", ali.id, `Ali resumed Control ${n}`]);
  });

  it("paused reservations expire after the setting, and the launcher and Owner are told", async () => {
    await setSettingValue("practice.copy", true);
    const { campaignId } = await launched(2, { launcherId: sara.id });
    const now = new Date();
    await control.pauseCampaign(campaignId, sara.id, { now });
    const held = await db.companyReservation.findMany({ where: { campaignId, releasedAt: null } });
    expect(held).toHaveLength(2);
    expect(held.every((h) => h.expiresAt?.getTime() === now.getTime() + 14 * DAY)).toBe(true);

    expect((await expirePausedReservations(new Date(now.getTime() + 13 * DAY))).released).toBe(0);
    const res = await expirePausedReservations(new Date(now.getTime() + 15 * DAY));
    expect(res).toEqual({ released: 2, campaigns: [campaignId] });
    const notes = await db.notification.findMany({ where: { type: "campaign.reservationsExpired" }, orderBy: { userId: "asc" } });
    expect(notes.map((x) => x.userId)).toEqual([arslan.id, sara.id]);
    expect(notes[0]!.title).toBe(`Control ${n} no longer holds its companies`);
    expect(notes[0]!.body).toMatch(/^It has been paused for more than 14 days, so its 2 companies are free for other campaigns again\./);

    // Resuming takes them back where nobody else has.
    const r = await control.resumeCampaign(campaignId, sara.id, { now: new Date(now.getTime() + 16 * DAY) });
    expect(r.lostCompanies).toBe(0);
    const again = await db.companyReservation.findMany({ where: { campaignId, releasedAt: null } });
    expect(again).toHaveLength(2);
    expect(again.every((h) => h.expiresAt === null)).toBe(true);
  });

  it("another campaign taking a company whose paused hold expired leaves the release, and the message, to the sweep", async () => {
    await setSettingValue("practice.copy", true);
    const a = await launched(1, { launcherId: sara.id });
    const companyId = a.recipients[0]!.companyId;
    const now = new Date();
    await control.pauseCampaign(a.campaignId, sara.id, { now });
    // 15 days later, before the worker's sweep ran, a teammate launches a campaign with the same company.
    const later = new Date(now.getTime() + 15 * DAY);
    const bea = await dbWrite((c) =>
      c.person.create({ data: { companyId, name: "Bea", email: `bea@expired-${n}.de`, emailNorm: `bea@expired-${n}.de` } }),
    );
    const b = await makeDraft({ name: `Takes over ${n}`, createdById: ali.id, senderId: ali.id, recipients: [{ companyId, personId: bea.id }] });
    expect((await launchCampaign(b.id, ali.id, { now: later })).queued).toBe(1);
    // A's expired hold is still there, no longer blocking anyone: the sweep releases it and tells people.
    expect(await db.companyReservation.count({ where: { campaignId: a.campaignId, releasedAt: null } })).toBe(1);
    const notesBefore = await db.notification.count({ where: { type: "campaign.reservationsExpired", link: `/campaigns/${a.campaignId}` } });
    expect(notesBefore).toBe(0);
    expect(await expirePausedReservations(later)).toEqual({ released: 1, campaigns: [a.campaignId] });
    const notes = await db.notification.findMany({ where: { type: "campaign.reservationsExpired", link: `/campaigns/${a.campaignId}` } });
    expect(notes.map((x) => x.userId).sort()).toEqual([arslan.id, sara.id].sort());
    expect(await db.activityLog.count({ where: { campaignId: a.campaignId, type: "campaign.reservationsExpired" } })).toBe(1);
    // Only B holds the company.
    const active = await db.companyReservation.findMany({ where: { companyId, releasedAt: null } });
    expect(active.map((r) => r.campaignId)).toEqual([b.id]);
  });

  it("resuming before the sweep never leaves a company held by two campaigns", async () => {
    await setSettingValue("practice.copy", true);
    const a = await launched(2, { launcherId: sara.id });
    const taken = a.recipients[0]!.companyId;
    const free = a.recipients[1]!.companyId;
    const now = new Date();
    await control.pauseCampaign(a.campaignId, sara.id, { now });
    const later = new Date(now.getTime() + 15 * DAY);
    const bea = await dbWrite((c) =>
      c.person.create({ data: { companyId: taken, name: "Bea", email: `bea@resume-${n}.de`, emailNorm: `bea@resume-${n}.de` } }),
    );
    const b = await makeDraft({ name: `Took one ${n}`, createdById: ali.id, senderId: ali.id, recipients: [{ companyId: taken, personId: bea.id }] });
    expect((await launchCampaign(b.id, ali.id, { now: later })).queued).toBe(1);

    const r = await control.resumeCampaign(a.campaignId, sara.id, { now: new Date(later.getTime() + 60_000) });
    expect(r.lostCompanies).toBe(1);
    expect(r.message).toMatch(/1 company is now in other campaigns, so its next email will be skipped\.$/);
    const onTaken = await db.companyReservation.findMany({ where: { companyId: taken, releasedAt: null } });
    expect(onTaken.map((x) => x.campaignId)).toEqual([b.id]);
    const onFree = await db.companyReservation.findMany({ where: { companyId: free, releasedAt: null } });
    expect(onFree.map((x) => [x.campaignId, x.expiresAt])).toEqual([[a.campaignId, null]]);
  });

  it("cancels: waiting emails are cancelled, people stopped, reservations released", async () => {
    await setSettingValue("practice.copy", true);
    const { campaignId } = await launched(3);
    const r = await control.cancelCampaign(campaignId, arslan.id);
    expect(r).toMatchObject({ cancelledEmails: 3, stoppedRecipients: 3, message: `Cancelled Control ${n}. 3 emails that were waiting won't be sent.` });
    expect(await db.outboundEmail.count({ where: { campaignId, status: "CANCELLED", lastError: "Cancelled by Arslan" } })).toBe(3);
    expect(await db.campaignRecipient.count({ where: { campaignId, state: "STOPPED", stopReason: "campaign_cancelled" } })).toBe(3);
    expect(await db.companyReservation.count({ where: { campaignId, releasedAt: null } })).toBe(0);
    const c = await db.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(c.status).toBe("CANCELLED");
    expect((await refusal(control.cancelCampaign(campaignId, arslan.id))).code).toBe("ended");
    expect((await refusal(control.pauseCampaign(campaignId, arslan.id))).message).toBe("This campaign was cancelled.");
    const draft = await makeDraft({ name: "Just a draft", createdById: arslan.id });
    expect((await refusal(control.cancelCampaign(draft.id, arslan.id))).message).toBe("This campaign hasn't been launched yet. Delete the draft instead.");
    expect((await refusal(control.pauseCampaign(424_242, arslan.id))).code).toBe("not-found");
  });
});

describe("one recipient, one email", () => {
  it("skips a recipient, and finishes the campaign when nobody is left", async () => {
    const { campaignId, recipients } = await launched(2);
    const s = await control.skipRecipient(recipients[0]!.id, sara.id);
    expect(s).toEqual({ skippedEmails: 1, sendingNow: false, message: "Skipped Anna 0. They won't get any more emails from this campaign." });
    expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: recipients[0]!.id } })).toMatchObject({
      state: "STOPPED",
      stopReason: "Skipped by Sara",
    });
    expect(await db.outboundEmail.findFirstOrThrow({ where: { recipientId: recipients[0]!.id } })).toMatchObject({
      status: "SKIPPED",
      lastError: "Skipped by Sara",
    });
    expect((await refusal(control.skipRecipient(recipients[0]!.id, sara.id))).message).toBe("Anna 0's emails have already stopped.");
    await control.skipRecipient(recipients[1]!.id, sara.id);
    const c = await db.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(c.status).toBe("FINISHED");
    expect(await db.activityLog.count({ where: { campaignId, type: "campaign.recipientSkipped", actorId: sara.id } })).toBe(2);
  });

  it("skipping while an email is being sent lets that one go out, and nothing after it", async () => {
    const { recipients } = await launched(1, {
      steps: [
        { step: 0, subject: "Hi", body: "First" },
        { step: 1, body: "Second", delayDays: 3 },
      ],
    });
    const row = await db.outboundEmail.findFirstOrThrow({ where: { recipientId: recipients[0]!.id } });
    expect(await claimEmail(row.id)).toBe(true);
    const s = await control.skipRecipient(recipients[0]!.id, ali.id);
    expect(s.sendingNow).toBe(true);
    expect(s.message).toBe("Skipped Anna 0. The email being sent right now will still go out; nothing after it will.");
    const res = await markSent(row.id, new Date());
    expect(res.next).toBeNull();
    expect(await db.outboundEmail.count({ where: { recipientId: recipients[0]!.id } })).toBe(1);
  });

  it("retries an email that didn't send, reopening a finished campaign", async () => {
    const { campaignId, recipients } = await launched(1);
    const row = await db.outboundEmail.findFirstOrThrow({ where: { campaignId } });
    await dbWrite((c) => c.outboundEmail.update({ where: { id: row.id }, data: { status: "FAILED", lastError: "Couldn't send this email" } }));
    await dbWrite((c) => c.campaignRecipient.update({ where: { id: recipients[0]!.id }, data: { state: "STOPPED", stopReason: control.FAILED_STOP_REASON } }));
    await control.finishCheck(campaignId);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("FINISHED");

    // It used up all its tries.
    await dbWrite((c) => c.outboundEmail.update({ where: { id: row.id }, data: { attempts: 5 } }));

    const r = await control.retryEmail(row.id, sara.id);
    expect(r.status).toBe("QUEUED");
    expect(r.message).toMatch(/^The first email to anna0@ctl\d+-0\.de will be tried again in a moment\.$/);
    // A fresh set of tries, so the usual waits between tries apply again.
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: "QUEUED",
      lastError: null,
      messageId: row.messageId,
      attempts: 0,
    });
    expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: recipients[0]!.id } })).toMatchObject({ state: "SCHEDULED", stopReason: null });
    expect(await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).toMatchObject({ status: "RUNNING", finishedAt: null });
    expect((await refusal(control.retryEmail(row.id, sara.id))).code).toBe("queued");
  });

  it("trying an email again while paused keeps the reservations expiring (practice copy)", async () => {
    await setSettingValue("practice.copy", true);
    const { campaignId, recipients } = await launched(2);
    const rows = await db.outboundEmail.findMany({ where: { campaignId }, orderBy: { recipientId: "asc" } });
    // The first person's email failed for good: they stopped, and their company was let go.
    await dbWrite((c) => c.outboundEmail.update({ where: { id: rows[0]!.id }, data: { status: "FAILED", attempts: 5 } }));
    await dbWrite((c) => c.campaignRecipient.update({ where: { id: recipients[0]!.id }, data: { state: "STOPPED", stopReason: control.FAILED_STOP_REASON } }));
    await dbWrite((c) =>
      c.companyReservation.updateMany({ where: { campaignId, companyId: recipients[0]!.companyId }, data: { releasedAt: new Date() } }),
    );
    // The second person's email didn't send either, but their company is still held.
    await dbWrite((c) => c.outboundEmail.update({ where: { id: rows[1]!.id }, data: { status: "FAILED", attempts: 5 } }));

    const now = new Date();
    await control.pauseCampaign(campaignId, arslan.id, { now });
    await control.retryEmail(rows[0]!.id, ali.id, { now });
    await control.retryEmail(rows[1]!.id, ali.id, { now });
    // Nothing is held without an expiry: no new reservation, and the kept one still expires.
    const held = await db.companyReservation.findMany({ where: { campaignId, releasedAt: null } });
    expect(held.map((h) => [h.companyId, h.expiresAt?.getTime()])).toEqual([[recipients[1]!.companyId, now.getTime() + 14 * DAY]]);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("PAUSED");

    // Paused too long: the sweep lets the company go as usual.
    expect(await expirePausedReservations(new Date(now.getTime() + 15 * DAY))).toEqual({ released: 1, campaigns: [campaignId] });
    expect(await db.companyReservation.count({ where: { campaignId, releasedAt: null } })).toBe(0);
    // Resuming takes both companies back (nobody else has them).
    const r = await control.resumeCampaign(campaignId, arslan.id, { now: new Date(now.getTime() + 16 * DAY) });
    expect(r.lostCompanies).toBe(0);
    const again = await db.companyReservation.findMany({ where: { campaignId, releasedAt: null }, orderBy: { companyId: "asc" } });
    expect(again.map((h) => [h.companyId, h.expiresAt])).toEqual([
      [recipients[0]!.companyId, null],
      [recipients[1]!.companyId, null],
    ]);
  });

  it("refuses to retry sent emails, emails of stopped people and cancelled campaigns", async () => {
    const { campaignId, recipients } = await launched(2);
    const rows = await db.outboundEmail.findMany({ where: { campaignId }, orderBy: { id: "asc" } });
    await dbWrite((c) => c.outboundEmail.update({ where: { id: rows[0]!.id }, data: { status: "SENT", sentAt: new Date() } }));
    expect((await refusal(control.retryEmail(rows[0]!.id, ali.id))).code).toBe("sent");
    await dbWrite((c) => c.outboundEmail.update({ where: { id: rows[1]!.id }, data: { status: "FAILED" } }));
    await dbWrite((c) => c.campaignRecipient.update({ where: { id: recipients[1]!.id }, data: { state: "STOPPED", stopReason: "replied" } }));
    expect((await refusal(control.retryEmail(rows[1]!.id, ali.id))).code).toBe("stopped");
    await dbWrite((c) => c.campaign.update({ where: { id: campaignId }, data: { status: "CANCELLED" } }));
    expect((await refusal(control.retryEmail(rows[1]!.id, ali.id))).code).toBe("cancelled");
    expect((await refusal(control.retryEmail(999_999, ali.id))).code).toBe("not-found");
  });
});

describe("editing an email that hasn't been sent", () => {
  it("saves this person's version while the email waits, and refuses once the worker has it", async () => {
    const { campaignId, recipients } = await launched(1, {
      steps: [
        { step: 0, subject: "Hi", body: "First" },
        { step: 1, body: "Second", delayDays: 3 },
      ],
    });
    const rid = recipients[0]!.id;
    const e = await control.editUnsentEmail(rid, 0, { subject: "  A better   subject ", body: "Hello Anna,\r\n\r\nNew text.  \n" }, sara.id);
    expect(e).toEqual({ recipientId: rid, step: 0, message: "Saved. Anna 0 gets this version of the first email." });
    const edit = await db.recipientEdit.findUniqueOrThrow({ where: { recipientId_step: { recipientId: rid, step: 0 } } });
    expect(edit).toMatchObject({ subject: "A better subject", body: "Hello Anna,\n\nNew text.", editedById: sara.id });
    expect((await db.campaignRecipient.findUniqueOrThrow({ where: { id: rid } })).hasEdits).toBe(true);

    // A follow-up that has no row yet can be edited too (the subject stays the first email's).
    await control.editUnsentEmail(rid, 1, { subject: "ignored", body: "Second, my way" }, sara.id);
    expect(await db.recipientEdit.findUniqueOrThrow({ where: { recipientId_step: { recipientId: rid, step: 1 } } })).toMatchObject({
      subject: null,
      body: "Second, my way",
    });

    // The worker claims the first email: editing is refused.
    const row = await db.outboundEmail.findFirstOrThrow({ where: { campaignId, step: 0 } });
    expect(await claimEmail(row.id)).toBe(true);
    const busy = await refusal(control.editUnsentEmail(rid, 0, { body: "Too late" }, sara.id));
    expect(busy.message).toBe(SENDING_NOW);
    expect(busy.message).toMatch(/^This email is being sent right now/);
    expect((await refusal(control.discardUnsentEdit(rid, 0, sara.id))).code).toBe("sending-now");
    await markSent(row.id, new Date());
    expect((await refusal(control.editUnsentEmail(rid, 0, { body: "Too late" }, sara.id))).code).toBe("sent");

    // Going back to the campaign's text for the follow-up (its row now waits).
    const d = await control.discardUnsentEdit(rid, 1, sara.id);
    expect(d.message).toBe("Anna 0 gets the campaign's follow-up 1 again.");
    expect(await db.recipientEdit.count({ where: { recipientId: rid, step: 1 } })).toBe(0);
    expect((await db.campaignRecipient.findUniqueOrThrow({ where: { id: rid } })).hasEdits).toBe(true); // the first email's edit remains
    expect(await db.activityLog.count({ where: { campaignId, type: "campaign.emailEdited" } })).toBe(3);
  });

  it("checks the text and the step", async () => {
    const { recipients } = await launched(1);
    const rid = recipients[0]!.id;
    expect((await refusal(control.editUnsentEmail(rid, 0, { body: "   " }, ali.id))).code).toBe("empty-body");
    expect((await refusal(control.editUnsentEmail(rid, 0, { subject: " ", body: "x" }, ali.id))).code).toBe("empty-subject");
    expect((await refusal(control.editUnsentEmail(rid, 2, { body: "x" }, ali.id))).message).toBe("This campaign has no follow-up 2.");
    expect((await refusal(control.editUnsentEmail(rid, 7, { body: "x" }, ali.id))).code).toBe("bad-step");
    expect((await refusal(control.editUnsentEmail(rid, 0, { body: "x".repeat(20_001) }, ali.id))).code).toBe("too-long");
    await control.skipRecipient(rid, ali.id);
    expect((await refusal(control.editUnsentEmail(rid, 0, { body: "x" }, ali.id))).code).toBe("ended");
  });

  it("works on a draft's recipients too (review edits)", async () => {
    const { company, people } = await makeCompany({ name: "Draft edit", people: [{ name: "Dee", email: "dee@draft-edit.de" }] });
    const draft = await makeDraft({ name: "Draft", createdById: arslan.id, recipients: [{ companyId: company.id, personId: people[0]!.id }] });
    const rec = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: draft.id } });
    expect((await control.editUnsentEmail(rec.id, 0, { body: "Draft text" }, arslan.id)).message).toBe("Saved. Dee gets this version of the first email.");
  });
});

describe("finishCheck", () => {
  it("doesn't finish while people wait for a follow-up", async () => {
    const { campaignId } = await launched(1, {
      steps: [
        { step: 0, subject: "Hi", body: "First" },
        { step: 1, body: "Second", delayDays: 3 },
      ],
    });
    const row = await db.outboundEmail.findFirstOrThrow({ where: { campaignId } });
    await claimEmail(row.id);
    await markSent(row.id, daysAgo(0));
    expect(await control.finishCheck(campaignId)).toBe(false);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("RUNNING");
  });

  it("finishes once, telling the sender and the creator", async () => {
    const { campaignId } = await launched(1);
    const row = await db.outboundEmail.findFirstOrThrow({ where: { campaignId } });
    await claimEmail(row.id);
    await markSent(row.id, new Date());
    expect(await control.finishCheck(campaignId)).toBe(true);
    expect(await control.finishCheck(campaignId)).toBe(false);
    const notes = await db.notification.findMany({ where: { type: "campaign.finished", link: `/campaigns/${campaignId}` }, orderBy: { userId: "asc" } });
    expect(notes.map((x) => [x.userId, x.title, x.body])).toEqual([
      [arslan.id, `Control ${n} finished`, "1 email went to the dry-run outbox."],
      [ali.id, `Control ${n} finished`, "1 email went to the dry-run outbox."],
    ]);
    const log = await db.activityLog.findFirstOrThrow({ where: { campaignId, type: "campaign.finished" } });
    expect(log.summary).toBe(`Control ${n} finished: 1 email went to the dry-run outbox`);
  });
});
