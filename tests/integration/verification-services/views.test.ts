import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma, Risk, VerificationStatus } from "@/generated/prisma/client";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeDraft, makeSentEmail, makeUser, setSettingValue } from "../campaigns/seed";

/**
 * The check services' views on a temp database (M5-DESIGN §2.9, §6.1, §6.3): the Contacts and list counts under the
 * live check context, the Verify step's counts with the free exclusions first, and the Schedule note.
 */

const t = await createTestDb("verification-views");
const { db, dbWrite } = await import("@/server/db");
const { setSecret, deleteSecret } = await import("@/server/secrets");
const { contactsCheckView, campaignCheckView, campaignLaunchCheckNote, campaignCheckTargets } = await import(
  "@/server/services/verification/select"
);
const { NO_CHECK_KEY_TEXT } = await import("@/core/verification/words");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms);

type Check = {
  status: VerificationStatus;
  risk?: Risk;
  at: Date;
  provider?: string;
  unknowns?: number;
  disposable?: boolean;
};

/** Writes a person's latest check result (the fields commitCheckResult writes). */
async function setCheck(personId: number, c: Check) {
  await dbWrite((x) =>
    x.person.update({
      where: { id: personId },
      data: {
        verificationStatus: c.status,
        verificationRisk: c.risk ?? "LOW",
        verifiedAt: c.at,
        verificationProvider: c.provider ?? "mailgun-fake",
        verificationUnknowns: c.unknowns ?? (c.status === "UNKNOWN" ? 1 : 0),
        verificationDisposable: c.disposable ?? false,
      },
    }),
  );
}

let ali: { id: number; name: string };

beforeAll(async () => {
  ali = await makeUser("Ali", { role: "OWNER" });
});

beforeEach(async () => {
  await setSettingValue("practice.copy", false);
  await setSettingValue("sending.mode", "DRY_RUN");
  await setSettingValue("sending.goLive", false);
  await setSettingValue("sending.testList", []);
  await setSettingValue("verification.monthlyLimitUsd", 100);
  await setSettingValue("verification.includedPerMonth", 0);
  await setSecret("mailgun.apiKey", "key-fake-api", null);
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("contactsCheckView (live check context, §6.3)", () => {
  let ids: { a: number; b: number; c: number; d: number };
  let people: Record<string, number>;

  beforeAll(async () => {
    const a = await makeCompany({
      name: "Alpha Check GmbH",
      people: [
        { name: "Fresh" },
        { name: "Waiting" },
        { name: "Unchecked" },
        { name: "No Mail", email: null },
        { name: "Suppressed" },
        { name: "Flagged", unsubscribedAt: ago(DAY) },
        { name: "Removed", deletedAt: ago(DAY) },
      ],
    });
    const b = await makeCompany({ name: "Client Co", status: "CLIENT", people: [{ name: "Client Person" }] });
    const c = await makeCompany({ name: "Deleted Co", deletedAt: ago(DAY), people: [{ name: "Gone" }] });
    const d = await makeCompany({
      name: "Delta Check AS",
      people: [{ name: "Test Checker" }, { name: "Old" }, { name: "Second" }, { name: "Twice" }],
    });
    ids = { a: a.company.id, b: b.company.id, c: c.company.id, d: d.company.id };
    people = {
      fresh: a.people[0]!.id,
      waiting: a.people[1]!.id,
      unchecked: a.people[2]!.id,
      testChecker: d.people[0]!.id,
      old: d.people[1]!.id,
      second: d.people[2]!.id,
      twice: d.people[3]!.id,
    };
    await setCheck(people.fresh!, { status: "VALID", at: ago(10 * DAY) });
    await setCheck(people.waiting!, { status: "UNKNOWN", risk: "UNKNOWN", at: ago(HOUR) });
    await setCheck(people.testChecker!, { status: "VALID", at: ago(DAY), provider: "fake" });
    await setCheck(people.old!, { status: "VALID", at: ago(100 * DAY) });
    await setCheck(people.second!, { status: "UNKNOWN", risk: "UNKNOWN", at: ago(30 * HOUR) });
    await setCheck(people.twice!, { status: "UNKNOWN", risk: "UNKNOWN", at: ago(2 * DAY), unknowns: 2 });
    await dbWrite((x) => x.suppression.create({ data: { emailNorm: a.people[4]!.emailNorm!, reason: "MANUAL", source: "manual" } }));
  });

  it("counts what a live campaign would need, in DRY_RUN mode before go-live", async () => {
    const v = await contactsCheckView({ companyIds: [ids.a, ids.b, ids.c, ids.d, ids.a] }, NOW);
    expect(v).toMatchObject({ companies: 3, addresses: 11, need: 4, recent: 2, wait: 1, cannot: 4, tooMany: false, listName: null });
    expect(v.targets).toEqual([people.unchecked, people.testChecker, people.old, people.second].sort((x, y) => x! - y!));
    expect(v.recentTargets).toEqual([people.fresh, people.waiting, people.twice].sort((x, y) => x! - y!));
    expect(v.estimate).toMatchObject({ count: 4, provider: "mailgun-fake", pricePerCheck: 0.012, aboutUsd: 0.048 });
    expect(v.allEstimate.count).toBe(7);
    expect(v.notReady).toBeNull();
    expect(v.pause.paused).toBe(false);
    expect(v.monthly).toEqual({ limitUsd: 100, spentUsd: 0, wouldPass: false });
  });

  it("counts a list's companies and names the list", async () => {
    const list = await dbWrite((x) => x.list.create({ data: { name: "Germany Q4 checks" } }));
    await dbWrite((x) =>
      x.companyList.createMany({ data: [ids.a, ids.c, ids.d].map((companyId) => ({ companyId, listId: list.id })) }),
    );
    const v = await contactsCheckView({ listId: list.id }, NOW);
    expect(v).toMatchObject({ companies: 2, addresses: 10, need: 4, recent: 2, wait: 1, cannot: 3, listName: "Germany Q4 checks" });
    await expect(contactsCheckView({ listId: 987_654 }, NOW)).rejects.toThrow("That list doesn't exist any more");
  });

  it("says why checks can't start: no key, the monthly limit", async () => {
    await deleteSecret("mailgun.apiKey");
    expect((await contactsCheckView({ companyIds: [ids.a] }, NOW)).notReady).toBe(NO_CHECK_KEY_TEXT);
    await setSecret("mailgun.apiKey", "key-fake-api", null);
    await setSettingValue("verification.monthlyLimitUsd", 0.02);
    const v = await contactsCheckView({ companyIds: [ids.a, ids.d] }, NOW);
    expect(v.monthly).toEqual({ limitUsd: 0.02, spentUsd: 0, wouldPass: true });
  });

  it("refuses more than 10,000 companies and flags more than 5,000 addresses", async () => {
    await expect(contactsCheckView({ companyIds: Array.from({ length: 10_001 }, (_, i) => i + 1) }, NOW)).rejects.toThrow(
      "You can check the addresses of up to 10,000 companies at a time (you ticked 10,001).",
    );
    const big = await makeCompany({ name: "Big Co", domain: "big-check.test", people: [] });
    for (let start = 0; start < 5_001; start += 500) {
      const data: Prisma.PersonCreateManyInput[] = [];
      for (let i = start; i < Math.min(start + 500, 5_001); i++) {
        data.push({ companyId: big.company.id, name: `P${i}`, email: `p${i}@big-check.test`, emailNorm: `p${i}@big-check.test` });
      }
      await dbWrite((x) => x.person.createMany({ data }));
    }
    const v = await contactsCheckView({ companyIds: [big.company.id] }, NOW);
    expect(v).toMatchObject({ need: 5_001, tooMany: true, addresses: 5_001 });
  });
});

describe("campaignCheckView (the Verify step, §6.1)", () => {
  let drafts = 0;
  /** A draft with one ticked person per case; company names are unique per call ("Verify U1" first, then "Verify U1 2"). */
  async function liveDraft() {
    drafts += 1;
    const suffix = drafts === 1 ? "" : ` ${drafts}`;
    const make = async (label: string, check?: Check) => {
      const name = `${label}${suffix}`;
      const c = await makeCompany({ name, people: [{ name: `${label} Person` }] });
      if (check) await setCheck(c.people[0]!.id, check);
      return { companyId: c.company.id, personId: c.people[0]!.id, emailNorm: c.people[0]!.emailNorm! };
    };
    const r = {
      u1: await make("Verify U1"),
      u2: await make("Verify U2"),
      u3: await make("Verify U3"),
      fake: await make("Verify Fake", { status: "VALID", at: ago(DAY), provider: "fake" }),
      old: await make("Verify Old", { status: "VALID", at: ago(100 * DAY) }),
      second: await make("Verify Second", { status: "UNKNOWN", risk: "UNKNOWN", at: ago(30 * HOUR) }),
      waiting: await make("Verify Waiting", { status: "UNKNOWN", risk: "UNKNOWN", at: ago(2 * HOUR) }),
      fine: await make("Verify Fine", { status: "VALID", at: ago(5 * DAY) }),
      emailed: await make("Verify Emailed"),
      invalid: await make("Verify Invalid", { status: "INVALID", risk: "HIGH", at: ago(DAY) }),
      catchAll: await make("Verify CatchAll", { status: "CATCH_ALL", risk: "MEDIUM", at: ago(DAY) }),
      unticked: await make("Verify Unticked"),
    };
    await dbWrite((x) => x.suppression.create({ data: { emailNorm: r.invalid.emailNorm, reason: "INVALID", source: "verification" } }));
    // Emailed live by someone 5 days ago: the 30-day rule leaves it out, so its unchecked address isn't counted.
    await makeSentEmail({
      createdById: ali.id,
      companyId: r.emailed.companyId,
      personId: r.emailed.personId,
      toNorm: r.emailed.emailNorm,
      sentAt: ago(5 * DAY),
    });
    const draft = await makeDraft({
      name: "Germany Q4",
      createdById: ali.id,
      recipients: Object.entries(r).map(([k, v]) => ({ companyId: v.companyId, personId: v.personId, included: k !== "unticked" })),
    });
    return { draft, r };
  }

  it("counts a LIVE draft after go-live, the free exclusions first", async () => {
    await setSettingValue("sending.mode", "LIVE");
    await setSettingValue("sending.goLive", true);
    const { draft, r } = await liveDraft();
    const v = await campaignCheckView(draft.id, NOW);
    expect(v).toMatchObject({
      mode: "LIVE",
      goLive: true,
      practiceCopy: false,
      notReady: null,
      need: { total: 6, notChecked: 3, tooOld: 1, testChecker: 1, secondCheck: 1 },
      tooMany: false,
      waiting: 1,
      fine: 1,
      run: null,
      optional: null,
    });
    expect(v.estimate).toMatchObject({ count: 6, aboutUsd: 0.072, recheckExtraUsd: 0.012 });
    expect(v.monthly.wouldPass).toBe(false);
    expect(v.leftOutByChecks).toEqual([
      { personId: r.invalid.personId, name: "Verify Invalid Person", email: r.invalid.emailNorm, companyName: "Verify Invalid", reason: "doesn't exist" },
      { personId: r.catchAll.personId, name: "Verify CatchAll Person", email: r.catchAll.emailNorm, companyName: "Verify CatchAll", reason: "can't be confirmed" },
    ]);
    const targets = await campaignCheckTargets(draft.id, NOW);
    expect(targets.personIds).toEqual([r.u1, r.u2, r.u3, r.fake, r.old, r.second].map((x) => x.personId).sort((a, b) => a - b));

    // The Schedule note counts in the draft phase among the people who get the email.
    expect(await campaignLaunchCheckNote(draft.id, NOW)).toEqual({ unchecked: 5, secondCheck: 2 });

    // Over the monthly check limit.
    await setSettingValue("verification.monthlyLimitUsd", 0.05);
    expect((await campaignCheckView(draft.id, NOW)).monthly).toEqual({ limitUsd: 0.05, spentUsd: 0, wouldPass: true });
  });

  it("offers a check for results the policy skips once they're older than 90 days (they may have changed)", async () => {
    await setSettingValue("sending.mode", "LIVE");
    await setSettingValue("sending.goLive", true);
    const make = async (label: string, check: Check) => {
      const c = await makeCompany({ name: label, people: [{ name: `${label} Person` }] });
      await setCheck(c.people[0]!.id, check);
      return { companyId: c.company.id, personId: c.people[0]!.id };
    };
    const staleCatchAll = await make("Stale CatchAll", { status: "CATCH_ALL", risk: "MEDIUM", at: ago(100 * DAY) });
    const staleThrowaway = await make("Stale Throwaway", { status: "VALID", at: ago(100 * DAY), disposable: true });
    const freshCatchAll = await make("Fresh CatchAll", { status: "CATCH_ALL", risk: "MEDIUM", at: ago(10 * DAY) });
    const draft = await makeDraft({
      name: "Stale results",
      createdById: ali.id,
      recipients: [staleCatchAll, staleThrowaway, freshCatchAll].map((p) => ({ companyId: p.companyId, personId: p.personId })),
    });
    const v = await campaignCheckView(draft.id, NOW);
    expect(v.need).toEqual({ total: 2, notChecked: 0, tooOld: 2, testChecker: 0, secondCheck: 0 });
    expect(v.leftOutByChecks.map((l) => l.personId)).toEqual([freshCatchAll.personId]);
    expect((await campaignCheckTargets(draft.id, NOW)).personIds).toEqual([staleCatchAll.personId, staleThrowaway.personId]);
  });

  it("offers 'check them anyway' in a dry run, and has nothing to check before go-live", async () => {
    await setSettingValue("sending.mode", "LIVE");
    await setSettingValue("sending.goLive", true);
    const { draft } = await liveDraft();
    await setSettingValue("sending.mode", "DRY_RUN");
    const dry = await campaignCheckView(draft.id, NOW);
    expect(dry.mode).toBe("DRY_RUN");
    expect(dry.need.total).toBe(0);
    // Under the live check context: 3 unchecked, the test checker, the old and the due second check.
    expect(dry.optional).toMatchObject({ count: 6, estimate: { count: 6 } });
    expect(dry.leftOutByChecks.map((l) => l.reason)).toEqual(["got no answer", "got no answer", "doesn't exist", "can't be confirmed"]);
    expect((await campaignCheckTargets(draft.id, NOW)).personIds).toHaveLength(6);
    expect(await campaignLaunchCheckNote(draft.id, NOW)).toEqual({ unchecked: 0, secondCheck: 0 });

    await setSettingValue("sending.mode", "TEST");
    await setSettingValue("sending.goLive", false);
    const test = await campaignCheckView(draft.id, NOW);
    expect(test).toMatchObject({ mode: "TEST", goLive: false, need: { total: 0 }, waiting: 0, fine: 0, optional: null });
  });

  it("uses the test checker in the practice copy", async () => {
    await setSettingValue("sending.mode", "LIVE");
    await setSettingValue("sending.goLive", true);
    await setSettingValue("practice.copy", true);
    const { draft } = await liveDraft();
    const v = await campaignCheckView(draft.id, NOW);
    expect(v).toMatchObject({ practiceCopy: true, notReady: null, estimate: { provider: "fake", free: true, aboutUsd: 0 } });
  });

  it("checks the first 5,000 by person id when a campaign has more (7,210)", async () => {
    await setSettingValue("sending.mode", "LIVE");
    await setSettingValue("sending.goLive", true);
    const co = await makeCompany({ name: "Huge Verify Co", domain: "huge-verify.test", people: [] });
    for (let start = 0; start < 7_210; start += 500) {
      const data: Prisma.PersonCreateManyInput[] = [];
      for (let i = start; i < Math.min(start + 500, 7_210); i++) {
        data.push({ companyId: co.company.id, name: `H${i}`, email: `h${i}@huge-verify.test`, emailNorm: `h${i}@huge-verify.test` });
      }
      await dbWrite((x) => x.person.createMany({ data }));
    }
    const draft = await makeDraft({ name: "Huge", createdById: ali.id });
    const ppl = await db.person.findMany({ where: { companyId: co.company.id }, select: { id: true, emailNorm: true }, orderBy: { id: "asc" } });
    for (let i = 0; i < ppl.length; i += 500) {
      await dbWrite((x) =>
        x.campaignRecipient.createMany({
          data: ppl.slice(i, i + 500).map((p) => ({ campaignId: draft.id, companyId: co.company.id, personId: p.id, emailNorm: p.emailNorm! })),
        }),
      );
    }
    const v = await campaignCheckView(draft.id, NOW);
    expect(v).toMatchObject({ need: { total: 7_210, notChecked: 7_210 }, tooMany: true, estimate: { count: 5_000, aboutUsd: 60 } });
    const targets = await campaignCheckTargets(draft.id, NOW);
    expect(targets.personIds).toHaveLength(5_000);
    expect(targets.personIds[0]).toBe(ppl[0]!.id);
    expect(targets.personIds.at(-1)).toBe(ppl[4_999]!.id);
  }, 120_000);

  it("refuses a campaign that doesn't exist", async () => {
    await expect(campaignCheckView(987_654, NOW)).rejects.toThrow("This campaign doesn't exist any more.");
  });
});
