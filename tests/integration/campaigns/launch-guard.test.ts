import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeDraft, makeUser, setSettingValue } from "./seed";

/**
 * A launch that is under way or fails half-way (review findings SEC-3 and SEND-3). Two hooks make
 * the timing exact: one runs inside the launch just before it re-checks everyone (the launch has
 * already read the draft by then), the other replaces the answer of the reservation step.
 */
const hooks = vi.hoisted(() => ({
  duringRecheck: null as null | (() => Promise<void>),
  reservations: null as null | ((companyIds: readonly number[]) => { taken: number[]; lost: unknown[] }),
}));

vi.mock("@/server/services/eligibility", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/services/eligibility")>();
  return {
    ...real,
    evaluateCompanies: async (...args: Parameters<typeof real.evaluateCompanies>) => {
      const hook = hooks.duringRecheck;
      hooks.duringRecheck = null;
      if (hook) await hook();
      return real.evaluateCompanies(...args);
    },
  };
});

vi.mock("@/server/services/reservations", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/services/reservations")>();
  return {
    ...real,
    takeReservations: async (...args: Parameters<typeof real.takeReservations>) => {
      if (hooks.reservations) return hooks.reservations(args[2]);
      return real.takeReservations(...args);
    },
  };
});

const t = await createTestDb("campaign-launch-guard");
const { db, dbWrite } = await import("@/server/db");
const { isLaunching, launchCampaign, LAUNCHING_TEXT } = await import("@/server/services/campaigns/launch");
const { loadDraftForChange } = await import("@/server/services/campaigns/audience");
const { deleteDraft, saveDraftSteps, setDraftSender } = await import("@/server/services/campaigns/draft");
const control = await import("@/server/services/campaigns/control");
const { CampaignError } = await import("@/server/services/campaigns/errors");

let arslan: { id: number; name: string };
let ali: { id: number; name: string };
let sara: { id: number; name: string };
let n = 0;

beforeAll(async () => {
  arslan = await makeUser("Arslan", { role: "OWNER" });
  ali = await makeUser("Ali");
  sara = await makeUser("Sara");
});

beforeEach(async () => {
  hooks.duringRecheck = null;
  hooks.reservations = null;
  await setSettingValue("practice.copy", false);
  await setSettingValue("sending.mode", "DRY_RUN");
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

async function refusal(p: Promise<unknown>): Promise<InstanceType<typeof CampaignError>> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CampaignError);
  return err as InstanceType<typeof CampaignError>;
}

/** A draft with two ticked people (own companies) and one unticked person. */
async function draft() {
  n += 1;
  const a = await makeCompany({ name: `Guard ${n} A`, people: [{ name: "Anna", email: `anna@guard${n}-a.de` }, { name: "Uli", email: `uli@guard${n}-a.de` }] });
  const b = await makeCompany({ name: `Guard ${n} B`, people: [{ name: "Bob", email: `bob@guard${n}-b.de` }] });
  const d = await makeDraft({
    name: `Guard ${n}`,
    createdById: arslan.id,
    senderId: ali.id,
    recipients: [
      { companyId: a.company.id, personId: a.people[0]!.id },
      { companyId: a.company.id, personId: a.people[1]!.id, included: false },
      { companyId: b.company.id, personId: b.people[0]!.id },
    ],
  });
  await dbWrite((c) => c.campaignRecipient.updateMany({ where: { campaignId: d.id, included: false }, data: { exclusionReason: "Not ticked" } }));
  const recipients = await db.campaignRecipient.findMany({ where: { campaignId: d.id }, orderBy: { id: "asc" } });
  return { draft: d, a, b, recipients };
}

async function selection(campaignId: number) {
  return (await db.campaignRecipient.findMany({ where: { campaignId }, orderBy: { id: "asc" } })).map((r) => [
    r.included,
    r.state,
    r.exclusionReason,
  ]);
}

describe("while a draft is being launched", () => {
  it("every change to it is refused, and the launch uses what it checked", async () => {
    const { draft: d, recipients } = await draft();
    const actor = { id: arslan.id, name: arslan.name };
    const refused: Array<InstanceType<typeof CampaignError>> = [];
    hooks.duringRecheck = async () => {
      expect(isLaunching(d.id)).toBe(true);
      refused.push(await refusal(loadDraftForChange(db, d.id)));
      refused.push(await refusal(setDraftSender(actor, d.id, sara.id)));
      refused.push(
        await refusal(saveDraftSteps(actor, d.id, [{ step: 0, enabled: true, subject: "Changed", body: "Changed text", delayDays: 0 }])),
      );
      refused.push(await refusal(control.editUnsentEmail(recipients[0]!.id, 0, { body: "My own text" }, arslan.id)));
      refused.push(await refusal(deleteDraft(actor, d.id)));
    };
    const res = await launchCampaign(d.id, arslan.id);
    expect(res).toMatchObject({ status: "RUNNING", queued: 2 });
    expect(refused).toHaveLength(5);
    for (const err of refused) {
      expect(err.code).toBe("launching");
      expect(err.message).toBe(LAUNCHING_TEXT);
    }
    expect(LAUNCHING_TEXT).toBe("This campaign is being launched right now. Wait a moment, then open the campaign page.");
    expect(isLaunching(d.id)).toBe(false);
    const c = await db.campaign.findUniqueOrThrow({ where: { id: d.id } });
    expect(c.senderId).toBe(ali.id);
    expect(await db.recipientEdit.count({ where: { recipientId: recipients[0]!.id } })).toBe(0);
    const first = await db.campaignStep.findFirstOrThrow({ where: { campaignId: d.id, step: 0 } });
    expect(first.subject).not.toBe("Changed");
  });

  it("a sender changed behind its back (not through the app) stops the launch, and the draft stays as it was", async () => {
    await setSettingValue("practice.copy", true);
    const { draft: d } = await draft();
    const before = await selection(d.id);
    hooks.duringRecheck = async () => {
      await dbWrite((c) => c.campaign.update({ where: { id: d.id }, data: { senderId: sara.id } }));
    };
    const err = await refusal(launchCampaign(d.id, arslan.id));
    expect(err.code).toBe("changed");
    expect(err.message).toBe("This campaign changed while it was being launched. Refresh the page and check it.");
    const c = await db.campaign.findUniqueOrThrow({ where: { id: d.id } });
    expect(c).toMatchObject({ status: "DRAFT", senderId: sara.id, fromName: null, launchedAt: null });
    // Nothing is held for a draft, and every tick is as it was.
    expect(await db.companyReservation.count({ where: { campaignId: d.id, releasedAt: null } })).toBe(0);
    expect((await selection(d.id)).map(([included, , reason]) => [included, reason])).toEqual(before.map(([included, , reason]) => [included, reason]));
    // Launching again (with the new sender) works.
    expect((await launchCampaign(d.id, arslan.id)).queued).toBe(2);
    const rows = await db.outboundEmail.findMany({ where: { campaignId: d.id } });
    expect(rows.every((r) => r.senderId === sara.id && r.status === "QUEUED")).toBe(true);
  });
});

describe("a launch that fails half-way", () => {
  it("gives back the ticks it removed, so the Audience step shows the selection as it was", async () => {
    await setSettingValue("practice.copy", true);
    const { draft: d, a, recipients } = await draft();
    const before = await selection(d.id);
    // Anna unsubscribed since she was ticked; Bob's company goes to another campaign at that very moment.
    await dbWrite((c) => c.person.update({ where: { id: a.people[0]!.id }, data: { unsubscribedAt: new Date() } }));
    hooks.reservations = (companyIds) => ({
      taken: [],
      lost: companyIds.map((companyId) => ({
        reservationId: 0,
        companyId,
        campaignId: 0,
        campaignName: "Race",
        ownerName: "Sara",
        text: "Waiting in Sara's campaign 'Race'",
      })),
    });
    const err = await refusal(launchCampaign(d.id, arslan.id));
    expect(err.code).toBe("nobody-left");
    expect(err.message).toMatch(/^Nobody could be added: every ticked company is now waiting in another campaign\./);

    expect((await db.campaign.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("DRAFT");
    expect(await selection(d.id)).toEqual(before);
    expect(before).toEqual([
      [true, "PENDING", null],
      [false, "PENDING", "Not ticked"],
      [true, "PENDING", null],
    ]);
    expect(await db.outboundEmail.count({ where: { campaignId: d.id, status: "QUEUED" } })).toBe(0);
    expect(recipients).toHaveLength(3);

    // Once the other campaign lets go, launching again works (Anna is still left out, with the reason).
    hooks.reservations = null;
    const res = await launchCampaign(d.id, arslan.id);
    expect(res.queued).toBe(1);
    const after = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: d.id, personId: a.people[0]!.id } });
    expect(after).toMatchObject({ included: false, state: "EXCLUDED", exclusionReason: "Unsubscribed" });
  });
});
