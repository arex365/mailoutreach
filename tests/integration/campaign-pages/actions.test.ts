import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeDraft, makeUser, setSettingValue } from "../campaigns/seed";

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
  const requireUserAction = async () => {
    if (!auth.user) throw new AuthError("Your session has ended. Please sign in again.", 401);
    return auth.user;
  };
  return {
    AuthError,
    getUserOrNull: async () => auth.user,
    requireUserAction,
    requireOwnerAction: async () => {
      const user = await requireUserAction();
      if (user.role !== "OWNER") throw new AuthError("Only the Owner can do this.", 403);
      return user;
    },
  };
});

const t = await createTestDb("campaign-actions");
const { db, dbWrite } = await import("@/server/db");
const { launchCampaign } = await import("@/server/services/campaigns/launch");
const { claimEmail } = await import("@/server/services/sending/claim");
const { markSent } = await import("@/server/services/sending/mark-sent");
const { RECIPIENT_GONE, EMAIL_GONE, SENDING_NOW } = await import("@/server/services/campaigns/errors");
const actions = await import("@/app/(app)/campaigns/[id]/actions");
const { switchToDryRunAction } = await import("@/app/(app)/settings/sending/actions");

let owner: TestUser;
let member: TestUser;
let n = 0;

function asUser(u: { id: number; email: string; name: string; role: "OWNER" | "MEMBER" }): TestUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, timeZone: "Europe/Berlin", sessionId: 1 };
}

beforeAll(async () => {
  owner = asUser(await makeUser("Arslan", { role: "OWNER" }));
  member = asUser(await makeUser("Ali"));
});

beforeEach(async () => {
  auth.user = member;
  await setSettingValue("practice.copy", false);
  await setSettingValue("sending.mode", "DRY_RUN");
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

async function launched(count = 2) {
  n += 1;
  const recipients = [];
  for (let i = 0; i < count; i++) {
    const { company, people } = await makeCompany({ name: `Act ${n}-${i}`, people: [{ name: `Anna ${n}${i}`, email: `anna${i}@act${n}-${i}.de` }] });
    recipients.push({ companyId: company.id, personId: people[0]!.id });
  }
  const draft = await makeDraft({
    name: `Actions ${n}`,
    createdById: owner.id,
    senderId: member.id,
    steps: [
      { step: 0, subject: "Hi {{company}}", body: "Hello" },
      { step: 1, body: "Following up", delayDays: 3 },
    ],
    recipients,
  });
  await launchCampaign(draft.id, owner.id);
  const recs = await db.campaignRecipient.findMany({ where: { campaignId: draft.id }, orderBy: { id: "asc" } });
  return { campaignId: draft.id, recipients: recs };
}

async function firstEmailOf(recipientId: number) {
  return db.outboundEmail.findFirstOrThrow({ where: { recipientId, step: 0 } });
}

describe("signed-in checks and plain input errors", () => {
  it("refuses everything when signed out", async () => {
    const c = await launched(1);
    auth.user = null;
    const res = await actions.pauseCampaignAction({ campaignId: c.campaignId });
    expect(res).toEqual({ ok: false, error: "Your session has ended. Please sign in again." });
    expect(await actions.skipRecipientAction({ campaignId: c.campaignId, recipientId: c.recipients[0]!.id })).toMatchObject({ ok: false });
    expect((await db.campaign.findUniqueOrThrow({ where: { id: c.campaignId } })).status).toBe("RUNNING");
  });

  it("answers bad input in plain words, never with a crash", async () => {
    const res = await actions.pauseCampaignAction({ campaignId: -1 });
    expect(res).toMatchObject({ ok: false, error: "Some details need fixing. Check the highlighted fields." });
    expect(await actions.pauseCampaignAction({ campaignId: 999_999 })).toEqual({
      ok: false,
      error: "This campaign doesn't exist any more. Refresh the page to see the latest.",
    });
  });
});

describe("pause, resume and cancel", () => {
  it("lets a Member pause, resume and cancel, with the engine's words", async () => {
    const c = await launched(1);
    const paused = await actions.pauseCampaignAction({ campaignId: c.campaignId });
    expect(paused).toEqual({ ok: true, data: { status: "PAUSED" }, message: `Paused Actions ${n}. Nothing more is sent until you resume it.` });
    expect(await actions.pauseCampaignAction({ campaignId: c.campaignId })).toEqual({ ok: false, error: "This campaign is already paused." });
    const resumed = await actions.resumeCampaignAction({ campaignId: c.campaignId });
    expect(resumed).toMatchObject({ ok: true, data: { status: "RUNNING", lostCompanies: 0 }, message: `Resumed Actions ${n}.` });
    const cancelled = await actions.cancelCampaignAction({ campaignId: c.campaignId });
    expect(cancelled).toMatchObject({ ok: true, data: { cancelledEmails: 1, stoppedRecipients: 1 } });
    expect(await actions.cancelCampaignAction({ campaignId: c.campaignId })).toEqual({ ok: false, error: "This campaign was cancelled." });
    expect(await actions.resumeCampaignAction({ campaignId: c.campaignId })).toEqual({ ok: false, error: "This campaign was cancelled." });
  });

  it("refuses to pause a finished campaign", async () => {
    const c = await launched(1);
    await dbWrite((x) => x.campaign.update({ where: { id: c.campaignId }, data: { status: "FINISHED", finishedAt: new Date() } }));
    expect(await actions.pauseCampaignAction({ campaignId: c.campaignId })).toEqual({ ok: false, error: "This campaign has already finished." });
  });
});

describe("one person", () => {
  it("skips someone once, and never someone from another campaign", async () => {
    const a = await launched(2);
    const b = await launched(1);
    const wrong = await actions.skipRecipientAction({ campaignId: b.campaignId, recipientId: a.recipients[0]!.id });
    expect(wrong).toEqual({ ok: false, error: RECIPIENT_GONE });
    expect((await db.campaignRecipient.findUniqueOrThrow({ where: { id: a.recipients[0]!.id } })).state).toBe("SCHEDULED");

    const ok = await actions.skipRecipientAction({ campaignId: a.campaignId, recipientId: a.recipients[0]!.id });
    expect(ok).toEqual({
      ok: true,
      data: { skippedEmails: 1, sendingNow: false },
      message: `Skipped Anna ${n - 1}0. They won't get any more emails from this campaign.`,
    });
    expect(await actions.skipRecipientAction({ campaignId: a.campaignId, recipientId: a.recipients[0]!.id })).toEqual({
      ok: false,
      error: `Anna ${n - 1}0's emails have already stopped.`,
    });
  });

  it("edits an email that hasn't been sent, and refuses politely once it's being sent or was sent", async () => {
    const c = await launched(2);
    const [r0, r1] = c.recipients;
    // Follow-up 1 of someone waiting for their first email: fine.
    const saved = await actions.editUnsentEmailAction({ campaignId: c.campaignId, recipientId: r0!.id, step: 1, body: "Just for Anna" });
    expect(saved).toMatchObject({ ok: true, data: { recipientId: r0!.id, step: 1 } });
    expect(saved.ok && saved.message).toContain("gets this version of the follow-up 1");
    expect(await db.recipientEdit.findUnique({ where: { recipientId_step: { recipientId: r0!.id, step: 1 } } })).toMatchObject({
      subject: null,
      body: "Just for Anna",
      editedById: member.id,
    });
    const back = await actions.discardUnsentEditAction({ campaignId: c.campaignId, recipientId: r0!.id, step: 1 });
    expect(back).toMatchObject({ ok: true });
    expect(await db.recipientEdit.count({ where: { recipientId: r0!.id } })).toBe(0);

    // A first-email subject of their own.
    const subject = await actions.editUnsentEmailAction({ campaignId: c.campaignId, recipientId: r0!.id, step: 0, subject: "Only for you", body: "Hello" });
    expect(subject.ok).toBe(true);
    expect((await db.recipientEdit.findUniqueOrThrow({ where: { recipientId_step: { recipientId: r0!.id, step: 0 } } })).subject).toBe("Only for you");

    // The background sender picked it up: refused with the engine's words.
    const row = await firstEmailOf(r1!.id);
    expect(await claimEmail(row.id)).toBe(true);
    expect(await actions.editUnsentEmailAction({ campaignId: c.campaignId, recipientId: r1!.id, step: 0, body: "Too late" })).toEqual({
      ok: false,
      error: SENDING_NOW,
    });
    // Once sent, it can't change either.
    await markSent(row.id, new Date());
    expect(await actions.editUnsentEmailAction({ campaignId: c.campaignId, recipientId: r1!.id, step: 0, body: "Too late" })).toEqual({
      ok: false,
      error: "This email has already been sent, so it can't be changed.",
    });
    // An empty text is refused.
    expect(await actions.editUnsentEmailAction({ campaignId: c.campaignId, recipientId: r0!.id, step: 1, body: "   " })).toEqual({
      ok: false,
      error: "Write the email text before saving.",
    });
    // A step that isn't in the campaign.
    expect(await actions.editUnsentEmailAction({ campaignId: c.campaignId, recipientId: r0!.id, step: 3, body: "x" })).toEqual({
      ok: false,
      error: "This campaign has no follow-up 3.",
    });
  });

  it("tries again only emails that didn't send, from the same campaign", async () => {
    const a = await launched(1);
    const b = await launched(1);
    const row = await firstEmailOf(a.recipients[0]!.id);
    expect(await actions.retryEmailAction({ campaignId: b.campaignId, emailId: row.id })).toEqual({ ok: false, error: EMAIL_GONE });
    expect(await actions.retryEmailAction({ campaignId: a.campaignId, emailId: row.id })).toEqual({
      ok: false,
      error: "This email is already waiting to send.",
    });
    await dbWrite((x) => x.outboundEmail.update({ where: { id: row.id }, data: { status: "FAILED", lastError: "Broken" } }));
    await dbWrite((x) => x.campaignRecipient.update({ where: { id: a.recipients[0]!.id }, data: { state: "STOPPED", stopReason: "failed" } }));
    const retried = await actions.retryEmailAction({ campaignId: a.campaignId, emailId: row.id });
    expect(retried).toMatchObject({ ok: true, data: { status: "QUEUED" } });
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "QUEUED", lastError: null });
  });
});

describe("Settings › Sending", () => {
  it("only the Owner can switch back to dry run", async () => {
    await setSettingValue("sending.mode", "LIVE");
    auth.user = member;
    expect(await switchToDryRunAction()).toEqual({ ok: false, error: "Only the Owner can do this." });
    auth.user = owner;
    const res = await switchToDryRunAction();
    expect(res).toMatchObject({ ok: true, data: { mode: "DRY_RUN" } });
    expect((await db.setting.findUniqueOrThrow({ where: { key: "sending.mode" } })).value).toBe("DRY_RUN");
    const log = await db.activityLog.findFirst({ where: { type: "settings.updated" }, orderBy: { id: "desc" } });
    expect(log).toMatchObject({ actorId: owner.id, summary: "Arslan set sending to dry run" });
  });
});
