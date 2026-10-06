import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeDraft, setSettingValue } from "./seed";
import { resetSendingState, setupM3, WEDNESDAY_10_BERLIN, type M3World } from "../sending-m3/helpers";

/**
 * Launch and address checks (M5-DESIGN §2.8 rule 3, §6.1, D31): a first "no answer" launches into RECHECK (reserved,
 * with a waiting first-email row), people who still need a check are left out "Address not checked", a second "no
 * answer" "Address couldn't be checked"; the launch keeps go-live's value; it waits while the campaign's checks run; a
 * dry run leaves a "no answer" out with its own sentence; the test-list exception before go-live is unchanged.
 */

const t = await createTestDb("launch-checks");
let world: M3World;
const { db, dbWrite } = await import("@/server/db");
const { launchCampaign } = await import("@/server/services/campaigns/launch");
const { enqueueJob } = await import("@/server/jobs");

const NOW = WEDNESDAY_10_BERLIN;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

type Check = { status: "VALID" | "UNKNOWN"; at: Date; provider?: string; unknowns?: number };

let seq = 0;
async function person(email: string, check: Check | null) {
  seq += 1;
  const { company, people } = await makeCompany({ name: `Launch check ${seq}`, people: [{ name: `P${seq}`, email }] });
  if (check) {
    await dbWrite((c) =>
      c.person.update({
        where: { id: people[0]!.id },
        data: {
          verificationStatus: check.status,
          verificationRisk: check.status === "UNKNOWN" ? "UNKNOWN" : "LOW",
          verifiedAt: check.at,
          verificationProvider: check.provider ?? "mailgun-fake",
          verificationUnknowns: check.unknowns ?? (check.status === "UNKNOWN" ? 1 : 0),
        },
      }),
    );
  }
  return { companyId: company.id, personId: people[0]!.id, email };
}

async function draftOf(name: string, list: Array<{ companyId: number; personId: number }>) {
  return makeDraft({ name, createdById: world.owner.id, senderId: world.member.id, recipients: list });
}

const recipient = (campaignId: number, personId: number) => db.campaignRecipient.findFirstOrThrow({ where: { campaignId, personId } });

beforeAll(async () => {
  world = await setupM3({ testList: ["listed@launch-checks.test"] });
});

beforeEach(async () => {
  await resetSendingState();
  await dbWrite((c) => c.job.deleteMany({}));
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.goLive", true);
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("a live launch after go-live", () => {
  it("waits for re-checks, leaves out who still needs a check, and keeps go-live's value", async () => {
    const valid = await person("valid@launch-a.test", { status: "VALID", at: ago(DAY) });
    const waiting = await person("waiting@launch-b.test", { status: "UNKNOWN", at: ago(HOUR) });
    const overdue = await person("overdue@launch-c.test", { status: "UNKNOWN", at: ago(30 * HOUR) });
    const notChecked = await person("never@launch-d.test", null);
    const testChecker = await person("fakechecked@launch-e.test", { status: "VALID", at: ago(DAY), provider: "fake" });
    const tooOld = await person("old@launch-f.test", { status: "VALID", at: ago(100 * DAY) });
    const twice = await person("twice@launch-g.test", { status: "UNKNOWN", at: ago(2 * DAY), unknowns: 2 });
    const draft = await draftOf("Checks Q4", [valid, waiting, overdue, notChecked, testChecker, tooOld, twice]);

    const res = await launchCampaign(draft.id, world.owner.id, { now: NOW, mailgun: world.mailgun });
    expect(res).toMatchObject({ status: "RUNNING", queued: 1, rechecking: 2, newlyExcluded: 4 });
    expect(res.message).toBe(
      "Launched Checks Q4. 1 first email is on the way. They go out inside each recipient's sending hours, a few minutes apart." +
        " 2 people wait for a second address check. Their first email goes out once it passes." +
        " 4 people were left out because their addresses weren't checked.",
    );
    expect(res.excludedReasons).toEqual([
      { code: "not-checked", text: "Address not checked", count: 3 },
      { code: "check-unknown", text: "Address couldn't be checked", count: 1 },
    ]);

    expect((await recipient(draft.id, valid.personId)).state).toBe("SCHEDULED");
    const w = await recipient(draft.id, waiting.personId);
    expect(w).toMatchObject({ state: "RECHECK", included: true, currentStep: 0, nextDueAt: NOW, recheckAt: new Date(NOW.getTime() + 23 * HOUR) });
    // An overdue re-check is due at once.
    expect((await recipient(draft.id, overdue.personId)).recheckAt).toEqual(NOW);
    // Launched like a scheduled person: a waiting first email and a reserved company.
    expect(await db.outboundEmail.findMany({ where: { recipientId: w.id } })).toMatchObject([{ step: 0, status: "QUEUED", dueAt: NOW, toNorm: waiting.email }]);
    expect(await db.companyReservation.count({ where: { campaignId: draft.id, companyId: waiting.companyId, releasedAt: null } })).toBe(1);

    for (const p of [notChecked, testChecker, tooOld]) {
      expect(await recipient(draft.id, p.personId)).toMatchObject({ state: "EXCLUDED", included: false, exclusionReason: "Address not checked" });
    }
    expect(await recipient(draft.id, twice.personId)).toMatchObject({ state: "EXCLUDED", exclusionReason: "Address couldn't be checked" });
    expect(await db.outboundEmail.count({ where: { campaignId: draft.id, status: "QUEUED" } })).toBe(3);
    expect(await db.companyReservation.count({ where: { campaignId: draft.id, companyId: notChecked.companyId, releasedAt: null } })).toBe(0);

    const campaign = await db.campaign.findUniqueOrThrow({ where: { id: draft.id } });
    expect(campaign.launchedGoLive).toBe(true);
    expect((await db.activityLog.findFirstOrThrow({ where: { type: "campaign.launched", campaignId: draft.id } })).summary).toBe(
      "Arslan launched Checks Q4 (live) with 3 people",
    );
  });

  it("a campaign whose only person waits for a re-check still launches, reserved", async () => {
    const waiting = await person("only@launch-h.test", { status: "UNKNOWN", at: ago(HOUR) });
    const draft = await draftOf("Only waiting", [waiting]);
    const res = await launchCampaign(draft.id, world.owner.id, { now: NOW, mailgun: world.mailgun });
    expect(res).toMatchObject({ queued: 0, rechecking: 1 });
    expect(res.message).toBe("Launched Only waiting. 1 person waits for a second address check. Their first email goes out once it passes.");
    expect((await recipient(draft.id, waiting.personId)).state).toBe("RECHECK");
    expect(await db.companyReservation.count({ where: { campaignId: draft.id, releasedAt: null } })).toBe(1);
  });

  it("refuses while the campaign's own check run is queued or running", async () => {
    const a = await person("run-a@launch-i.test", null);
    const b = await person("run-b@launch-j.test", null);
    const draft = await draftOf("Checking now", [a, b]);
    const job = await enqueueJob({
      type: "verify.addresses",
      payload: { source: "wizard", campaignId: draft.id, personIds: [a.personId, b.personId], confirmedCount: 2 },
      priority: 20,
      dedupeKey: `verify:campaign:${draft.id}`,
      runAt: NOW,
    });
    await expect(launchCampaign(draft.id, world.owner.id, { now: NOW, mailgun: world.mailgun })).rejects.toMatchObject({
      code: "checks-running",
      message: "Address checks for this campaign are still running (0 of 2 done). Launch when they've finished, or stop them on the Verify step.",
    });
    await dbWrite((c) => c.job.update({ where: { id: job.id }, data: { status: "RUNNING", progressDone: 1, progressTotal: 2 } }));
    await expect(launchCampaign(draft.id, world.owner.id, { now: NOW, mailgun: world.mailgun })).rejects.toMatchObject({
      message: "Address checks for this campaign are still running (1 of 2 done). Launch when they've finished, or stop them on the Verify step.",
    });
    expect((await db.campaign.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("DRAFT");
    // Done: the launch goes ahead (nobody was checked, so nobody can be emailed).
    await dbWrite((c) => c.job.update({ where: { id: job.id }, data: { status: "DONE", activeDedupeKey: null } }));
    await expect(launchCampaign(draft.id, world.owner.id, { now: NOW, mailgun: world.mailgun })).rejects.toMatchObject({ code: "nobody-left" });
  });
});

describe("dry runs and go-live", () => {
  it("a dry run leaves a first 'no answer' out with its own sentence (no re-checks) and never needs a check", async () => {
    await setSettingValue("sending.mode", "DRY_RUN");
    const unknown = await person("dryunknown@launch-k.test", { status: "UNKNOWN", at: ago(HOUR) });
    const unchecked = await person("dryunchecked@launch-l.test", null);
    const draft = await draftOf("Dry checks", [unknown, unchecked]);
    const res = await launchCampaign(draft.id, world.owner.id, { now: NOW, mailgun: world.mailgun });
    expect(res).toMatchObject({ queued: 1, rechecking: 0 });
    expect(await recipient(draft.id, unknown.personId)).toMatchObject({
      state: "EXCLUDED",
      exclusionReason: "The address check got no answer. Dry runs don't check addresses again, so this person is left out.",
    });
    expect((await recipient(draft.id, unchecked.personId)).state).toBe("SCHEDULED");
  });

  it("before go-live the test list still counts as checked, and the launch says go-live was off", async () => {
    await setSettingValue("sending.goLive", false);
    const listed = await person("listed@launch-checks.test", null);
    const draft = await draftOf("Test list run", [listed]);
    const res = await launchCampaign(draft.id, world.owner.id, { now: NOW, mailgun: world.mailgun });
    expect(res).toMatchObject({ queued: 1, rechecking: 0, newlyExcluded: 0 });
    expect((await db.campaign.findUniqueOrThrow({ where: { id: draft.id } })).launchedGoLive).toBe(false);
  });
});
