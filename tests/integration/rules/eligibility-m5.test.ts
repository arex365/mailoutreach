import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeDraft, makeUser, setSettingValue } from "../campaigns/seed";

/**
 * The eligibility service with address-check phases (M5-DESIGN §2.8): the draft keeps "needs a check" pending and
 * still picks the default person, launch blocks, and the send-time re-check judges the step being sent (freshness at
 * the launch, follow-ups relying on the check judged then, the test-list exception from `launchedGoLive`).
 */

const t = await createTestDb("rules-eligibility-m5");
const { db, dbWrite } = await import("@/server/db");
const { evaluateCompanies, recheckRecipient, loadEligibilitySettings } = await import("@/server/services/eligibility");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let ali: { id: number };

beforeAll(async () => {
  ali = await makeUser("Ali", { role: "OWNER" });
});

beforeEach(async () => {
  await setSettingValue("practice.copy", false);
  await setSettingValue("sending.goLive", true);
  await setSettingValue("sending.testList", []);
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

async function check(personId: number, data: { status: "VALID" | "UNKNOWN" | "CATCH_ALL"; at: Date; provider?: string; unknowns?: number; risk?: "LOW" | "MEDIUM" }) {
  await dbWrite((c) =>
    c.person.update({
      where: { id: personId },
      data: {
        verificationStatus: data.status,
        verificationRisk: data.risk ?? "LOW",
        verifiedAt: data.at,
        verificationProvider: data.provider ?? "mailgun-fake",
        verificationUnknowns: data.unknowns ?? (data.status === "UNKNOWN" ? 1 : 0),
      },
    }),
  );
}

describe("evaluateCompanies with phases", () => {
  it("draft: unchecked people are tickable, pending, and the default pick works as before", async () => {
    const { company, people } = await makeCompany({
      name: "Phase Pick GmbH",
      people: [
        { name: "General inbox", email: "info@phasepick.de", isGeneric: true },
        { name: "Anna" },
        { name: "Old Valid" },
      ],
    });
    await check(people[2]!.id, { status: "VALID", at: ago(120 * DAY) });
    const draft = (await evaluateCompanies([company.id], { mode: "LIVE", now: NOW, phase: "draft" })).get(company.id)!;
    expect(draft.people.map((p) => [p.name, p.eligible, p.pending.map((r) => r.code), p.checkNeed])).toEqual([
      ["General inbox", true, ["not-checked"], "check"],
      ["Anna", true, ["not-checked"], "check"],
      ["Old Valid", true, ["check-too-old"], "check"],
    ]);
    // Pending reasons don't disqualify: the first VALID person is ticked by default (M5-DESIGN §2.8 rule 9).
    expect(draft.defaultPersonIds).toEqual([people[2]!.id]);
    expect(draft.people[2]).toMatchObject({
      verificationStatus: "VALID",
      verificationRisk: "LOW",
      verificationProvider: "mailgun-fake",
      verificationUnknowns: 0,
      verificationDisposable: false,
      blocking: [],
      reason: null,
    });

    // Launch (the default phase): everybody blocks, nobody is picked.
    const launch = (await evaluateCompanies([company.id], { mode: "LIVE", now: NOW })).get(company.id)!;
    expect(launch.people.map((p) => p.reason?.code)).toEqual(["not-checked", "not-checked", "check-too-old"]);
    expect(launch.people.every((p) => p.pending.length === 0)).toBe(true);
    expect(launch.defaultPersonIds).toEqual([]);
  });

  it("picks the first named person when nobody is checked, and keeps blocking reasons blocking", async () => {
    const { company, people } = await makeCompany({
      name: "Named Pick AS",
      people: [
        { name: "General inbox", email: "post@namedpick.no", isGeneric: true },
        { name: "Unsubscribed", unsubscribedAt: ago(DAY) },
        { name: "Ola" },
      ],
    });
    const r = (await evaluateCompanies([company.id], { mode: "LIVE", now: NOW, phase: "draft" })).get(company.id)!;
    expect(r.people[1]!.reason?.code).toBe("unsubscribed");
    expect(r.people[1]!.blocking.map((b) => b.code)).toEqual(["unsubscribed"]);
    expect(r.defaultPersonIds).toEqual([people[2]!.id]);
  });

  it("counts fake-Mailgun results only while the app talks to the fake Mailgun", async () => {
    expect((await loadEligibilitySettings()).realProviders.has("mailgun-fake")).toBe(true);
    const saved = process.env.OUTREACH_MAILGUN_BASE_URL;
    delete process.env.OUTREACH_MAILGUN_BASE_URL;
    try {
      const s = await loadEligibilitySettings();
      expect(s.realProviders.has("mailgun-fake")).toBe(false);
      expect(s.realProviders.has("mailgun")).toBe(true);
      const { company, people } = await makeCompany({ name: "Fake Result Co", people: [{ name: "Fia" }] });
      await check(people[0]!.id, { status: "VALID", at: ago(DAY) });
      const r = (await evaluateCompanies([company.id], { mode: "LIVE", now: NOW, settings: s })).get(company.id)!;
      expect(r.people[0]!.reason?.code).toBe("test-checker");
    } finally {
      process.env.OUTREACH_MAILGUN_BASE_URL = saved;
    }
  });
});

describe("recheckRecipient at send time", () => {
  async function launched(opts: { mode: "TEST" | "LIVE"; launchedAt: Date; launchedGoLive: boolean | null; people: Array<{ name: string }>; name: string }) {
    const { company, people } = await makeCompany({ name: opts.name, people: opts.people });
    const draft = await makeDraft({
      name: `${opts.name} campaign`,
      createdById: ali.id,
      recipients: people.map((p) => ({ companyId: company.id, personId: p.id })),
    });
    await dbWrite((c) =>
      c.campaign.update({
        where: { id: draft.id },
        data: { status: "RUNNING", mode: opts.mode, launchedAt: opts.launchedAt, launchedGoLive: opts.launchedGoLive },
      }),
    );
    const recipients = await db.campaignRecipient.findMany({ where: { campaignId: draft.id }, orderBy: { id: "asc" } });
    return { people, recipients };
  }

  it("first email: freshness at the launch; follow-ups: check age and 'no answer' ignored", async () => {
    const { people, recipients } = await launched({
      name: "Send Steps Co",
      mode: "LIVE",
      launchedAt: ago(10 * DAY),
      launchedGoLive: true,
      people: [{ name: "Aged" }, { name: "Unknown" }, { name: "Catch" }],
    });
    await check(people[0]!.id, { status: "VALID", at: ago(95 * DAY) }); // 85 days old at the launch
    await check(people[1]!.id, { status: "UNKNOWN", at: ago(2 * HOUR) });
    await check(people[2]!.id, { status: "CATCH_ALL", risk: "MEDIUM", at: ago(DAY) });
    const [aged, unknown, catchAll] = recipients;

    expect(await recheckRecipient(aged!.id, { now: NOW, step: 0 })).toMatchObject({ eligible: true, checkNeed: "none" });
    expect((await recheckRecipient(aged!.id, { now: NOW })).eligible).toBe(true);

    const waiting = await recheckRecipient(unknown!.id, { now: NOW, step: 0 });
    expect(waiting).toMatchObject({ eligible: false, reason: { code: "check-waiting" }, checkNeed: "wait" });
    expect(waiting.verifiedAt?.getTime()).toBe(ago(2 * HOUR).getTime());
    expect((await recheckRecipient(unknown!.id, { now: NOW, step: 1 })).eligible).toBe(true);

    // Policy blocks still apply to follow-ups.
    expect((await recheckRecipient(catchAll!.id, { now: NOW, step: 2 })).reason?.code).toBe("policy-blocked");

    // A check that ages out after the launch doesn't block the first email; one too old at the launch does.
    await check(people[0]!.id, { status: "VALID", at: ago(101 * DAY) });
    expect((await recheckRecipient(aged!.id, { now: NOW, step: 0 })).reason?.code).toBe("check-too-old");
    expect((await recheckRecipient(aged!.id, { now: NOW, step: 1 })).eligible).toBe(true);
  });

  it("judges the test-list exception with the go-live of the launch (M6-DESIGN §2.3)", async () => {
    const before = await launched({
      name: "Live Before Co",
      mode: "LIVE",
      launchedAt: ago(DAY),
      launchedGoLive: false,
      people: [{ name: "Tess" }],
    });
    await setSettingValue("sending.testList", [before.people[0]!.emailNorm]);
    // Go-live is on now, but the campaign was launched before it: its first email still counts the address as checked.
    expect(await recheckRecipient(before.recipients[0]!.id, { now: NOW, step: 0 })).toMatchObject({ eligible: true, reason: null });

    const after = await launched({ name: "Live After Co", mode: "LIVE", launchedAt: ago(DAY), launchedGoLive: true, people: [{ name: "Tia" }] });
    const old = await launched({ name: "Live Old Co", mode: "LIVE", launchedAt: ago(DAY), launchedGoLive: null, people: [{ name: "Tom" }] });
    await setSettingValue("sending.testList", [before.people[0]!.emailNorm, after.people[0]!.emailNorm, old.people[0]!.emailNorm]);
    // Launched after go-live: the test list is no longer special, the address needs a real check.
    expect((await recheckRecipient(after.recipients[0]!.id, { now: NOW, step: 0 })).reason?.code).toBe("not-checked");
    // No flag (the M6 migration fills launched campaigns with false): judged as launched before go-live, whatever today says.
    for (const goLive of [true, false]) {
      await setSettingValue("sending.goLive", goLive);
      expect((await recheckRecipient(old.recipients[0]!.id, { now: NOW, step: 0 })).eligible).toBe(true);
      expect((await recheckRecipient(after.recipients[0]!.id, { now: NOW, step: 0 })).reason?.code).toBe("not-checked");
    }
    await setSettingValue("sending.goLive", true);
  });

  it("keeps a campaign launched before go-live on the test list at send time, and test mode for good (M6-DESIGN §2.3)", async () => {
    const live = await launched({ name: "Live Early Co", mode: "LIVE", launchedAt: ago(DAY), launchedGoLive: false, people: [{ name: "Lena" }] });
    const test = await launched({ name: "Test Late Co", mode: "TEST", launchedAt: ago(DAY), launchedGoLive: true, people: [{ name: "Theo" }] });
    await setSettingValue("sending.testList", [live.people[0]!.emailNorm, test.people[0]!.emailNorm]);
    // On the test list: both go, and the test list counts as checked (test mode always, live launched before go-live).
    expect(await recheckRecipient(live.recipients[0]!.id, { now: NOW, step: 0 })).toMatchObject({ eligible: true, notes: ["On test list"] });
    expect(await recheckRecipient(test.recipients[0]!.id, { now: NOW, step: 0 })).toMatchObject({ eligible: true, notes: ["On test list"] });
    // Taken off the test list after go-live: both are left out with the rule's own words.
    await setSettingValue("sending.testList", []);
    expect((await recheckRecipient(live.recipients[0]!.id, { now: NOW, step: 1 })).reason).toMatchObject({
      code: "not-on-test-list",
      text: "Not on the test list (until you go live, only test-list addresses get real email)",
    });
    expect((await recheckRecipient(test.recipients[0]!.id, { now: NOW, step: 1 })).reason).toMatchObject({
      code: "not-on-test-list",
      text: "Not on the test list (Test mode only emails your test list)",
    });
  });

  it("answers for a recipient that is gone", async () => {
    expect(await recheckRecipient(987_654, { now: NOW })).toMatchObject({ eligible: false, reason: { code: "person-removed" }, verifiedAt: null, checkNeed: "none" });
  });
});
