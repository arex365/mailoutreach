import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeDraft, makeUser, setSettingValue } from "../campaigns/seed";

/**
 * The Audience step judges address checks in the draft phase (M5-DESIGN §2.8 rules 3 and 9, §6.2): an address that
 * still needs a check (or waits for its re-check) is tickable, counted as getting the email, shown as the person's
 * note, and may be the default pick; a result that blocks (doesn't exist, the policy, twice no answer) stays the
 * person's reason; a dry run never checks again, so its "no answer" blocks.
 */

const t = await createTestDb("audience-checks");
const { db, dbWrite } = await import("@/server/db");
const audience = await import("@/server/services/campaigns/audience");

const NOW = new Date("2026-09-23T08:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let actor: { id: number; name: string };

beforeAll(async () => {
  const u = await makeUser("Ali", { role: "OWNER" });
  actor = { id: u.id, name: u.name };
});

beforeEach(async () => {
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.goLive", true);
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

type Check = { status: "VALID" | "UNKNOWN" | "INVALID"; at: Date; unknowns?: number; provider?: string };

async function company(name: string, people: Array<{ name: string; email: string; check?: Check }>) {
  const made = await makeCompany({ name, people: people.map((p) => ({ name: p.name, email: p.email })) });
  for (const [i, p] of people.entries()) {
    if (!p.check) continue;
    await dbWrite((c) =>
      c.person.update({
        where: { id: made.people[i]!.id },
        data: {
          verificationStatus: p.check!.status,
          verificationRisk: p.check!.status === "VALID" ? "LOW" : p.check!.status === "INVALID" ? "HIGH" : "UNKNOWN",
          verifiedAt: p.check!.at,
          verificationProvider: p.check!.provider ?? "mailgun-fake",
          verificationUnknowns: p.check!.unknowns ?? (p.check!.status === "UNKNOWN" ? 1 : 0),
        },
      }),
    );
  }
  return made;
}

let n = 0;
async function draftWith(...companyIds: number[]) {
  n += 1;
  const draft = await makeDraft({ name: `Audience checks ${n}`, createdById: actor.id });
  await audience.addCompaniesToAudience(actor, draft.id, companyIds, { kind: "selection", label: "Selected" }, { now: NOW });
  return draft;
}

async function viewOf(campaignId: number, companyId: number) {
  const snap = await audience.loadAudienceSnapshot(campaignId, { now: NOW });
  return { company: snap.companies.find((c) => c.companyId === companyId)!, totals: snap.totals };
}

describe("a live draft after go-live", () => {
  it("an unchecked person is tickable, gets the email, shows the note, and is picked by default", async () => {
    const solo = await company("Unchecked Solo", [{ name: "Una", email: "una@aud-solo.test" }]);
    const draft = await draftWith(solo.company.id);
    const { company: view, totals } = await viewOf(draft.id, solo.company.id);
    expect(view.section).toBe("included");
    expect(view.people[0]).toMatchObject({ ticked: true, eligible: true, willGet: true, canTick: true, reason: null, notes: ["Address not checked yet"] });
    expect(totals).toMatchObject({ people: 1, companies: 1, excludedCompanies: 0 });
  });

  it("the default pick still prefers a checked address; the unchecked colleague can be ticked", async () => {
    const two = await company("Two People", [
      { name: "Anna", email: "anna@aud-two.test" },
      { name: "Ben", email: "ben@aud-two.test", check: { status: "VALID", at: new Date(NOW.getTime() - DAY) } },
    ]);
    const draft = await draftWith(two.company.id);
    let { company: view } = await viewOf(draft.id, two.company.id);
    expect(view.people.map((p) => [p.name, p.ticked, p.canTick, p.notes])).toEqual([
      ["Anna", false, true, ["Address not checked yet"]],
      ["Ben", true, true, []],
    ]);
    await audience.setPersonTicked(actor, draft.id, two.people[0]!.id, true);
    ({ company: view } = await viewOf(draft.id, two.company.id));
    expect(view.people.map((p) => p.willGet)).toEqual([true, true]);
  });

  it("the test checker, an old check and a first 'no answer' are notes too; blocking results stay reasons", async () => {
    const mixed = await company("Mixed Checks", [
      { name: "Tess", email: "tess@aud-mixed.test", check: { status: "VALID", at: new Date(NOW.getTime() - DAY), provider: "fake" } },
      { name: "Olga", email: "olga@aud-mixed.test", check: { status: "VALID", at: new Date(NOW.getTime() - 100 * DAY) } },
      { name: "Wai", email: "wai@aud-mixed.test", check: { status: "UNKNOWN", at: new Date(NOW.getTime() - HOUR) } },
      { name: "Ivan", email: "ivan@aud-mixed.test", check: { status: "INVALID", at: new Date(NOW.getTime() - DAY) } },
      { name: "Twyla", email: "twyla@aud-mixed.test", check: { status: "UNKNOWN", at: new Date(NOW.getTime() - 2 * DAY), unknowns: 2 } },
    ]);
    const draft = await draftWith(mixed.company.id);
    const { company: view } = await viewOf(draft.id, mixed.company.id);
    const byName = new Map(view.people.map((p) => [p.name, p]));
    expect(byName.get("Tess")).toMatchObject({ canTick: true, reason: null, notes: ["Only checked by the test checker"] });
    expect(byName.get("Olga")).toMatchObject({ canTick: true, reason: null, notes: ["Last checked more than 90 days ago"] });
    expect(byName.get("Wai")).toMatchObject({
      canTick: true,
      reason: null,
      notes: ["Waiting for re-check: the address check got no answer, so it's checked again 24 hours later"],
    });
    expect(byName.get("Ivan")).toMatchObject({ canTick: false, reason: "The address check said this address doesn't exist" });
    expect(byName.get("Twyla")).toMatchObject({ canTick: false, reason: "Couldn't be checked: the address check got no answer twice" });
    await expect(audience.setPersonTicked(actor, draft.id, mixed.people[3]!.id, true)).rejects.toMatchObject({ code: "not-eligible" });
  });

  it("a Replied company with only unchecked people can still be put back", async () => {
    const replied = await makeCompany({ name: "Replied Unchecked", status: "REPLIED", people: [{ name: "Rita", email: "rita@aud-replied.test" }] });
    const draft = await draftWith(replied.company.id);
    let { company: view } = await viewOf(draft.id, replied.company.id);
    expect(view).toMatchObject({ section: "excluded", canPutBack: true });
    await audience.setCompanyPutBack(actor, draft.id, replied.company.id, true);
    ({ company: view } = await viewOf(draft.id, replied.company.id));
    expect(view.people[0]).toMatchObject({ ticked: true, willGet: true, notes: ["Address not checked yet"] });
  });

  it("syncExclusionReasons leaves ticked unchecked people without a reason", async () => {
    const solo = await company("Sync Unchecked", [{ name: "Sid", email: "sid@aud-sync.test" }]);
    const draft = await draftWith(solo.company.id);
    await audience.syncExclusionReasons(draft.id, { now: NOW });
    expect(await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: draft.id } })).toMatchObject({ included: true, exclusionReason: null });
  });
});

describe("a dry run", () => {
  it("never needs a check, but a 'no answer' blocks (dry runs don't check again)", async () => {
    await setSettingValue("sending.mode", "DRY_RUN");
    const dry = await company("Dry Checks", [
      { name: "Nell", email: "nell@aud-dry.test" },
      { name: "Wendy", email: "wendy@aud-dry.test", check: { status: "UNKNOWN", at: new Date(NOW.getTime() - HOUR) } },
    ]);
    const draft = await draftWith(dry.company.id);
    const { company: view } = await viewOf(draft.id, dry.company.id);
    expect(view.people[0]).toMatchObject({ canTick: true, notes: [] });
    expect(view.people[1]).toMatchObject({
      canTick: false,
      reason: "The address check got no answer. Dry runs don't check addresses again, so this person is left out.",
    });
  });
});
