import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeDraft, makeUser, setSettingValue, type StepSeed } from "../campaigns/seed";

/**
 * Launch and the wizard with follow-ups (M4-DESIGN §2.11, §2.13, §9.4): follow-ups stay on, a campaign launched in
 * Milestone 3 with its follow-ups switched off still finishes after its first emails, the first-subject rule on the
 * Message step, per-person edits and at launch (drafts saved before it), and a possible reply nobody has decided puts
 * the people of a Retry (and of a launch) on hold straight away.
 */

const t = await createTestDb("sequences-launch");
const { db, dbWrite } = await import("@/server/db");
const { launchCampaign, RE_SUBJECT_LAUNCH_TEXT } = await import("@/server/services/campaigns/launch");
const draft = await import("@/server/services/campaigns/draft");
const control = await import("@/server/services/campaigns/control");
const { CampaignError } = await import("@/server/services/campaigns/errors");
const loop = await import("@/server/services/sending/loop");
const { FIRST_SUBJECT_REPLY_ERROR } = await import("@/core/templates/subject-rules");

const STEPS: StepSeed[] = [
  { step: 0, subject: "3D models for your shop", body: "First" },
  { step: 1, body: "Second", delayDays: 3 },
  { step: 2, body: "Third", delayDays: 4 },
];

let arslan: { id: number; name: string };
let n = 0;

beforeAll(async () => {
  const u = await makeUser("Arslan", { role: "OWNER" });
  arslan = { id: u.id, name: u.name };
});

beforeEach(async () => {
  await setSettingValue("practice.copy", false);
  await dbWrite((c) => c.campaign.updateMany({ where: { status: { in: ["RUNNING", "SCHEDULED"] } }, data: { status: "CANCELLED" } }));
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

async function aDraft(steps: StepSeed[] = STEPS, people = 1) {
  n += 1;
  const { company, people: ps } = await makeCompany({
    name: `Launch M4 ${n}`,
    people: Array.from({ length: people }, (_, i) => ({ name: `P${i}`, email: `p${i}@launch-m4-${n}.de` })),
  });
  const d = await makeDraft({ name: `Launch M4 ${n}`, createdById: arslan.id, steps, recipients: ps.map((p) => ({ companyId: company.id, personId: p.id })) });
  return { id: d.id, companyId: company.id };
}

async function refusal(p: Promise<unknown>): Promise<{ message: string; code: string }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof CampaignError) return { message: err.message, code: err.code };
    throw err;
  }
  throw new Error("Expected a CampaignError");
}

describe("follow-ups at launch", () => {
  it("keeps every follow-up switched on and logs no switch-off", async () => {
    const d = await aDraft();
    await launchCampaign(d.id, arslan.id);
    const steps = await db.campaignStep.findMany({ where: { campaignId: d.id }, orderBy: { step: "asc" } });
    expect(steps.map((s) => s.enabled)).toEqual([true, true, true]);
    const activity = await db.activityLog.findFirstOrThrow({ where: { campaignId: d.id, type: "campaign.launched" } });
    expect(activity.data).not.toHaveProperty("followUpsOff");
  });

  it("a campaign launched in Milestone 3 (follow-ups switched off) finishes after its first emails", async () => {
    const d = await aDraft();
    await launchCampaign(d.id, arslan.id);
    // What Milestone 3's launch did to test-mode and live campaigns.
    await dbWrite((c) => c.campaignStep.updateMany({ where: { campaignId: d.id, step: { gt: 0 } }, data: { enabled: false } }));
    const r = await loop.sendingTick();
    expect(r.finished).toEqual([d.id]);
    expect(await db.outboundEmail.count({ where: { campaignId: d.id } })).toBe(1);
  });

  it("the Schedule step's summary no longer talks about switching follow-ups off", async () => {
    const d = await aDraft();
    const summary = await draft.loadLaunchSummary(d.id);
    expect(summary).not.toHaveProperty("followUpsOff");
    expect(summary.followUps).toBe(2);
    expect(summary.problems).toEqual([]);
  });
});

describe("the first-subject rule (§2.13)", () => {
  it("the Message step refuses a first subject that starts with 'Re:', on the subject field; a warning never blocks", async () => {
    const d = await aDraft([{ step: 0, subject: "Re: our call", body: "First" }]);
    const checked = await draft.checkDraftMessage(d.id);
    expect(checked).toEqual({
      ok: false,
      error: "Some details need fixing in the first email. Check the highlighted fields.",
      fieldErrors: { "step0.subject": [FIRST_SUBJECT_REPLY_ERROR] },
    });
    const art = await aDraft([{ step: 0, subject: "Art: new 3D models", body: "First" }]);
    expect((await draft.checkDraftMessage(art.id)).ok).toBe(true);
    // The text problems keep their own fields next to it.
    const both = await aDraft([{ step: 0, subject: "Fwd: prices", body: "" }]);
    const res = await draft.checkDraftMessage(both.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(Object.keys(res.fieldErrors).sort()).toEqual(["step0.body", "step0.subject"]);
  });

  it("a draft saved before the rule can't launch: the campaign's subject, or one person's edit from Review", async () => {
    const own = await aDraft([{ step: 0, subject: "FW: 3D models", body: "First" }]);
    expect(await refusal(launchCampaign(own.id, arslan.id))).toEqual({ message: RE_SUBJECT_LAUNCH_TEXT, code: "re-subject" });
    expect(await refusal(draft.launchDraft(arslan, own.id))).toEqual({ message: RE_SUBJECT_LAUNCH_TEXT, code: "re-subject" });
    const summary = await draft.loadLaunchSummary(own.id);
    expect(summary.problems).toContainEqual({ step: "message", text: FIRST_SUBJECT_REPLY_ERROR });

    const edited = await aDraft(STEPS, 2);
    const recipient = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: edited.id } });
    // Saved directly, as an older version could.
    await dbWrite((c) => c.recipientEdit.create({ data: { recipientId: recipient.id, step: 0, subject: "Re: your shop", body: "First" } }));
    expect(await refusal(launchCampaign(edited.id, arslan.id))).toEqual({ message: RE_SUBJECT_LAUNCH_TEXT, code: "re-subject" });
    expect((await draft.loadLaunchSummary(edited.id)).problems).toContainEqual({ step: "review", text: RE_SUBJECT_LAUNCH_TEXT });
    expect((await db.campaign.findUniqueOrThrow({ where: { id: edited.id } })).status).toBe("DRAFT");
  });

  it("editing one person's first email refuses a 'Fwd:' subject; an 'Art:' one saves", async () => {
    const d = await aDraft();
    await launchCampaign(d.id, arslan.id);
    const recipient = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: d.id } });
    expect(await refusal(control.editUnsentEmail(recipient.id, 0, { subject: "Fwd: our catalogue", body: "Hi" }, arslan.id))).toEqual({
      message: FIRST_SUBJECT_REPLY_ERROR,
      code: "re-subject",
    });
    expect(await refusal(control.editUnsentEmail(recipient.id, 0, { subject: "re : our catalogue", body: "Hi" }, arslan.id))).toMatchObject({ code: "re-subject" });
    await control.editUnsentEmail(recipient.id, 0, { subject: "Art: our catalogue", body: "Hi" }, arslan.id);
    expect(await db.recipientEdit.findFirstOrThrow({ where: { recipientId: recipient.id, step: 0 } })).toMatchObject({ subject: "Art: our catalogue" });
  });
});

describe("possible replies nobody has decided (§2.8.2)", () => {
  async function undecided(companyId: number) {
    await dbWrite((c) =>
      c.inboundMessage.create({
        data: {
          receivedAt: new Date(),
          toAddress: "arslan@send.example.com",
          fromEmail: "maybe@elsewhere.de",
          subject: "Out of office?",
          source: "NOTIFY",
          kind: "POSSIBLE_REPLY",
          companyId,
          replyScope: "real",
          processedAt: new Date(),
        },
      }),
    );
  }

  it("a launch holds the people of a company with one", async () => {
    const d = await aDraft(STEPS, 2);
    await undecided(d.companyId);
    await launchCampaign(d.id, arslan.id);
    const recipients = await db.campaignRecipient.findMany({ where: { campaignId: d.id } });
    expect(recipients.map((r) => [r.state, r.holdReason])).toEqual([
      ["HELD", "possible-reply"],
      ["HELD", "possible-reply"],
    ]);
    expect((await loop.sendingTick()).sent).toBe(0);
  });

  it("Retry reopens the person on hold straight away", async () => {
    const d = await aDraft();
    await launchCampaign(d.id, arslan.id);
    const row = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: d.id } });
    await dbWrite(async (c) => {
      await c.outboundEmail.update({ where: { id: row.id }, data: { status: "FAILED", attempts: 5 } });
      await c.campaignRecipient.updateMany({ where: { campaignId: d.id }, data: { state: "STOPPED", stopReason: "failed" } });
    });
    await undecided(d.companyId);
    await control.retryEmail(row.id, arslan.id);
    expect(await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: d.id } })).toMatchObject({ state: "HELD", holdReason: "possible-reply" });
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "QUEUED" });
    expect((await loop.sendingTick()).sent).toBe(0);
  });
});
