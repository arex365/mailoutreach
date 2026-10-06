import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { daysAgo, makeCompany, makeDraft, makeSentEmail, makeUser, setSettingValue } from "../campaigns/seed";

const t = await createTestDb("rules-eligibility");
const { db, dbWrite } = await import("@/server/db");
const { evaluateCompanies, recheckRecipient, loadEligibilitySettings } = await import("@/server/services/eligibility");
const { findActiveReservations, takeReservations, releaseCompanyIfDone, releaseDraftReservations, LAUNCH_HOLD_MS } = await import(
  "@/server/services/reservations"
);
const { dbTx } = await import("@/server/db");

let ali: { id: number; name: string };
let sara: { id: number; name: string };

beforeAll(async () => {
  ali = await makeUser("Ali", { role: "OWNER" });
  sara = await makeUser("Sara");
});

beforeEach(async () => {
  await setSettingValue("practice.copy", false);
  await setSettingValue("teamRule.days", 30);
  // The history below stands for live campaigns after go-live (M3-DESIGN §1.7: before go-live a
  // live send only reaches the test list and doesn't count as "emailed"; tested on its own below).
  await setSettingValue("sending.goLive", true);
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

async function evalOne(companyId: number, opts: Partial<Parameters<typeof evaluateCompanies>[1]> = {}) {
  const res = await evaluateCompanies([companyId], { mode: "DRY_RUN", ...opts });
  return res.get(companyId)!;
}

describe("evaluateCompanies", () => {
  it("evaluates every person and picks who to tick by default", async () => {
    const { company, people } = await makeCompany({
      name: "Default Pick GmbH",
      people: [
        { name: "General inbox", email: "info@defaultpick.de", isGeneric: true },
        { name: "No Mail", email: null },
        { name: "Anna", email: "anna@defaultpick.de" },
        { name: "Checked", email: "checked@defaultpick.de", verificationStatus: "VALID", verifiedAt: new Date() },
      ],
    });
    const r = await evalOne(company.id);
    expect(r.blocked).toBeNull();
    expect(r.people.map((p) => [p.name, p.eligible, p.reason?.code ?? null])).toEqual([
      ["General inbox", true, null],
      ["No Mail", false, "no-email"],
      ["Anna", true, null],
      ["Checked", true, null],
    ]);
    expect(r.defaultPersonIds).toEqual([people[3]!.id]);
  });

  it("blocks a company emailed live by anyone in the last 30 days, with the reason in words", async () => {
    const { company, people } = await makeCompany({ name: "Acme", domain: "acme-live.de", people: [{ name: "Anna", email: "anna@acme-live.de" }] });
    const sent = await makeSentEmail({
      campaignName: "Germany Q4",
      createdById: ali.id,
      senderId: ali.id,
      companyId: company.id,
      personId: people[0]!.id,
      toNorm: "anna@acme-live.de",
      companyDomain: "acme-live.de",
      sentAt: daysAgo(12),
      step: 1,
    });
    const r = await evalOne(company.id);
    expect(r.blocked).toMatchObject({ code: "team-rule", text: "Emailed by Ali 12 days ago (Germany Q4, follow-up 1)" });
    expect(r.people[0]).toMatchObject({ eligible: false, reason: { code: "team-rule" } });
    expect(r.defaultPersonIds).toEqual([people[0]!.id]);
    // The same campaign is never blocked by its own emails.
    expect((await evalOne(company.id, { campaignId: sent.campaignId })).blocked).toBeNull();
    // A shorter rule lets it through.
    await setSettingValue("teamRule.days", 10);
    expect((await evalOne(company.id)).blocked).toBeNull();
  });

  it("matches another record on the same domain, and a person's address, but never a shared domain", async () => {
    const original = await makeCompany({ name: "Druck Original", domain: "druck-x.de", people: [{ name: "Max", email: "max@druck-x.de" }] });
    await makeSentEmail({
      createdById: sara.id,
      companyId: original.company.id,
      personId: original.people[0]!.id,
      toNorm: "max@druck-x.de",
      companyDomain: "druck-x.de",
      sentAt: daysAgo(3),
    });
    const twin = await makeCompany({ name: "Druck Twin", domain: "druck-x.de", people: [{ name: "Eva", email: "eva@druck-x.de" }] });
    expect((await evalOne(twin.company.id)).blocked?.text).toBe("Someone at druck-x.de was emailed by Sara 3 days ago (Old campaign, first email)");

    // A freelancer on gmail who moved to another company: matched by address, never by gmail.com.
    const agency = await makeCompany({ name: "Agency", domain: "agency-y.de", people: [{ name: "Free", email: "free.lancer@gmail.com" }] });
    const other = await makeCompany({ name: "Other", domain: null, people: [{ name: "Someone", email: "someone.else@gmail.com" }] });
    const moved = await makeCompany({ name: "Moved to", domain: "moved-z.de", people: [] });
    const freelancer = agency.people[0]!;
    await makeSentEmail({
      createdById: ali.id,
      companyId: agency.company.id,
      personId: freelancer.id,
      toNorm: "free.lancer@gmail.com",
      companyDomain: null,
      sentAt: daysAgo(5),
    });
    await dbWrite((c) => c.person.update({ where: { id: freelancer.id }, data: { companyId: moved.company.id } }));
    expect((await evalOne(moved.company.id)).blocked?.text).toBe("free.lancer@gmail.com was emailed by Ali 5 days ago (Old campaign, first email)");
    // Someone else on gmail.com is not blocked by the freelancer's email.
    expect((await evalOne(other.company.id)).blocked).toBeNull();
  });

  it("counts dry runs only in the practice copy, and never test mode", async () => {
    const { company, people } = await makeCompany({ name: "Dry Co", people: [{ name: "Dora" }] });
    await makeSentEmail({ mode: "DRY_RUN", createdById: ali.id, companyId: company.id, personId: people[0]!.id, toNorm: people[0]!.emailNorm!, sentAt: daysAgo(1) });
    const test = await makeCompany({ name: "Test Co", people: [{ name: "Tess" }] });
    await makeSentEmail({ mode: "TEST", createdById: ali.id, companyId: test.company.id, personId: test.people[0]!.id, toNorm: test.people[0]!.emailNorm!, sentAt: daysAgo(1) });
    expect((await evalOne(company.id)).blocked).toBeNull();
    await setSettingValue("practice.copy", true);
    expect((await evalOne(company.id)).blocked?.code).toBe("team-rule");
    expect((await evalOne(test.company.id)).blocked).toBeNull();
  });

  it("live sends of a campaign launched before go-live (test-list mailboxes only) never count for the 30-day rule (§1.7, M6-DESIGN §2.2)", async () => {
    const { company, people } = await makeCompany({ name: "Test Mailbox Co", people: [{ name: "Tia" }] });
    const early = { mode: "LIVE" as const, launchedGoLive: false, createdById: ali.id, sentAt: daysAgo(1) };
    await makeSentEmail({ ...early, companyId: company.id, personId: people[0]!.id, toNorm: people[0]!.emailNorm! });
    const maybe = await makeCompany({ name: "Test Mailbox Maybe Co", people: [{ name: "Mo" }] });
    await makeSentEmail({ ...early, status: "UNKNOWN", companyId: maybe.company.id, personId: maybe.people[0]!.id, toNorm: maybe.people[0]!.emailNorm! });
    await setSettingValue("sending.goLive", false);
    expect((await evalOne(company.id)).blocked).toBeNull();
    expect((await evalOne(maybe.company.id)).blocked).toBeNull();
    expect((await evalOne(company.id, { mode: "LIVE" })).blocked).toBeNull();
    // The practice copy still counts its dry runs, but not the live ones.
    await setSettingValue("practice.copy", true);
    expect((await evalOne(company.id)).blocked).toBeNull();
    // Going live changes nothing for them: "emailed" is judged by the campaign's launch flag, never today's switch.
    await setSettingValue("sending.goLive", true);
    expect((await evalOne(company.id)).blocked).toBeNull();
    expect((await evalOne(maybe.company.id)).blocked).toBeNull();
    await setSettingValue("practice.copy", false);
    expect((await evalOne(company.id)).blocked).toBeNull();
  });

  it("live sends of a campaign launched after go-live count, whatever today's switch says (M6-DESIGN §2.2)", async () => {
    const { company, people } = await makeCompany({ name: "Live Prospect Co", people: [{ name: "Lia" }] });
    await makeSentEmail({ mode: "LIVE", launchedGoLive: true, createdById: ali.id, companyId: company.id, personId: people[0]!.id, toNorm: people[0]!.emailNorm!, sentAt: daysAgo(2) });
    const maybe = await makeCompany({ name: "Live Prospect Maybe Co", people: [{ name: "Mia" }] });
    await makeSentEmail({ mode: "LIVE", launchedGoLive: true, status: "UNCONFIRMED", createdById: ali.id, companyId: maybe.company.id, personId: maybe.people[0]!.id, toNorm: maybe.people[0]!.emailNorm!, sentAt: daysAgo(2) });
    for (const goLive of [true, false]) {
      await setSettingValue("sending.goLive", goLive);
      expect((await evalOne(company.id)).blocked?.code).toBe("team-rule");
      expect((await evalOne(maybe.company.id)).blocked?.code).toBe("team-rule");
    }
  });

  it("counts emails that may have gone out, Mailgun's logs and the old tool", async () => {
    const maybe = await makeCompany({ name: "Maybe Co", people: [{ name: "May" }] });
    await makeSentEmail({ status: "UNKNOWN", createdById: ali.id, companyId: maybe.company.id, personId: maybe.people[0]!.id, toNorm: maybe.people[0]!.emailNorm!, sentAt: daysAgo(1) });
    expect((await evalOne(maybe.company.id)).blocked?.code).toBe("team-rule");

    const logged = await makeCompany({ name: "Logged Co", domain: "logged-co.de", people: [{ name: "Lou" }] });
    await dbWrite((c) => c.externalSend.create({ data: { toNorm: "someone@logged-co.de", companyDomain: "logged-co.de", sentAt: daysAgo(2), source: "RESTORE" } }));
    expect((await evalOne(logged.company.id)).blocked?.text).toBe("Emailed 2 days ago (found in Mailgun's logs)");

    const old = await makeCompany({ name: "Old Tool Co", importedLastContactAt: daysAgo(12), people: [{ name: "Olga" }] });
    expect((await evalOne(old.company.id)).blocked?.text).toBe("Contacted in the old tool 12 days ago");
  });

  it("blocks companies waiting in another active campaign, but not expired or ended reservations", async () => {
    const { company, people } = await makeCompany({ name: "Reserved Co", people: [{ name: "Rita" }] });
    const holder = await makeDraft({ name: "Norway prints", createdById: sara.id, senderId: sara.id });
    await dbWrite((c) => c.campaign.update({ where: { id: holder.id }, data: { status: "RUNNING", mode: "LIVE" } }));
    await dbTx((tx) => takeReservations(tx, holder.id, [company.id]));
    const r = await evalOne(company.id);
    expect(r.blocked).toMatchObject({ code: "reserved", text: "Waiting in Sara's campaign 'Norway prints'" });
    expect(r.people[0]!.reason?.code).toBe("reserved");
    // The holder itself is never blocked by its own reservation.
    expect((await evalOne(company.id, { campaignId: holder.id })).blocked).toBeNull();

    // Expired while paused → free.
    await dbWrite((c) => c.companyReservation.updateMany({ where: { campaignId: holder.id }, data: { expiresAt: daysAgo(1) } }));
    expect((await evalOne(company.id)).blocked).toBeNull();
    await dbWrite((c) => c.companyReservation.updateMany({ where: { campaignId: holder.id }, data: { expiresAt: null } }));
    expect((await evalOne(company.id)).blocked?.code).toBe("reserved");
    // The campaign finished without releasing (shouldn't happen) → free anyway.
    await dbWrite((c) => c.campaign.update({ where: { id: holder.id }, data: { status: "FINISHED" } }));
    expect((await evalOne(company.id)).blocked).toBeNull();
    expect(people).toHaveLength(1);
  });

  it("applies suppressions, statuses and deletions", async () => {
    const { company, people } = await makeCompany({
      name: "Mixed Co",
      people: [{ name: "Sup", email: "sup@mixed.de" }, { name: "Ok", email: "ok@mixed.de" }],
    });
    await dbWrite((c) => c.suppression.create({ data: { emailNorm: "sup@mixed.de", reason: "BOUNCED", source: "manual" } }));
    const r = await evalOne(company.id);
    expect(r.people.map((p) => p.reason?.code ?? null)).toEqual(["bounced", null]);
    expect(r.defaultPersonIds).toEqual([people[1]!.id]);

    await dbWrite((c) => c.company.update({ where: { id: company.id }, data: { status: "DO_NOT_CONTACT" } }));
    expect((await evalOne(company.id)).blocked).toMatchObject({ code: "company-status", text: "Company status is Do not contact" });
    await dbWrite((c) => c.company.update({ where: { id: company.id }, data: { status: "REPLIED" } }));
    const replied = await evalOne(company.id);
    expect(replied.blocked).toMatchObject({ code: "company-replied", overridable: true });
    const overridden = await evalOne(company.id, {
      recipients: new Map([[people[1]!.id, { overrides: new Set(["company-replied"] as const) }]]),
    });
    expect(overridden.people[1]!.eligible).toBe(true);

    await dbWrite((c) => c.company.update({ where: { id: company.id }, data: { status: "NOT_CONTACTED", deletedAt: new Date() } }));
    const deleted = await evalOne(company.id);
    expect(deleted.deleted).toBe(true);
    expect(deleted.blocked?.code).toBe("company-deleted");
    // Unknown ids are simply left out.
    expect((await evaluateCompanies([999_999], { mode: "DRY_RUN" })).size).toBe(0);
  });

  it("evaluates many companies at once with few queries", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 30; i++) ids.push((await makeCompany({ name: `Bulk ${i}`, people: [{ name: `P${i}` }] })).company.id);
    const res = await evaluateCompanies(ids, { mode: "DRY_RUN" });
    expect(res.size).toBe(30);
    expect([...res.values()].every((c) => c.people.length === 1 && c.people[0]!.eligible)).toBe(true);
  });
});

describe("recheckRecipient (send time)", () => {
  it("re-checks one recipient on fresh data, with its overrides and the address the email was made for", async () => {
    const { company, people } = await makeCompany({ name: "Recheck Co", status: "REPLIED", people: [{ name: "Rex", email: "rex@recheck.de" }] });
    const draft = await makeDraft({
      name: "Recheck campaign",
      createdById: ali.id,
      recipients: [{ companyId: company.id, personId: people[0]!.id, warnings: { overrides: ["company-replied"] } }],
    });
    const rec = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: draft.id } });
    expect(await recheckRecipient(rec.id, { toNorm: "rex@recheck.de" })).toMatchObject({ eligible: true, reason: null });
    expect((await recheckRecipient(rec.id, { toNorm: "old@recheck.de" })).reason?.code).toBe("email-changed");

    await dbWrite((c) => c.campaignRecipient.update({ where: { id: rec.id }, data: { warnings: {} } }));
    expect((await recheckRecipient(rec.id)).reason?.code).toBe("company-replied");

    await dbWrite((c) => c.person.update({ where: { id: people[0]!.id }, data: { deletedAt: new Date() } }));
    expect((await recheckRecipient(rec.id)).reasons.map((r) => r.code)).toContain("person-removed");
    expect((await recheckRecipient(987_654)).reason?.code).toBe("person-removed");
  });
});

describe("reservations", () => {
  it("takes, reports the holder, and releases when the company is done", async () => {
    const { company, people } = await makeCompany({ name: "Hold Co", people: [{ name: "Hal" }] });
    const a = await makeDraft({ name: "Campaign A", createdById: ali.id, recipients: [{ companyId: company.id, personId: people[0]!.id }] });
    const b = await makeDraft({ name: "Campaign B", createdById: sara.id, senderId: sara.id });
    await dbWrite((c) => c.campaign.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { status: "RUNNING", mode: "LIVE" } }));

    expect(await dbTx((tx) => takeReservations(tx, a.id, [company.id]))).toEqual({ taken: [company.id], lost: [] });
    // Again for the same campaign: still held, no second row.
    expect((await dbTx((tx) => takeReservations(tx, a.id, [company.id]))).taken).toEqual([company.id]);
    expect(await db.companyReservation.count({ where: { companyId: company.id, releasedAt: null } })).toBe(1);

    const lost = await dbTx((tx) => takeReservations(tx, b.id, [company.id]));
    expect(lost.taken).toEqual([]);
    expect(lost.lost[0]).toMatchObject({ campaignId: a.id, text: "Waiting in Ali's campaign 'Campaign A'" });
    expect((await findActiveReservations(db, [company.id])).get(company.id)?.campaignId).toBe(a.id);

    // Not done while its recipient is still scheduled.
    await dbWrite((c) => c.campaignRecipient.updateMany({ where: { campaignId: a.id }, data: { state: "SCHEDULED" } }));
    expect(await dbTx((tx) => releaseCompanyIfDone(tx, a.id, company.id))).toBe(false);
    await dbWrite((c) => c.campaignRecipient.updateMany({ where: { campaignId: a.id }, data: { state: "FINISHED" } }));
    expect(await dbTx((tx) => releaseCompanyIfDone(tx, a.id, company.id))).toBe(true);
    expect((await dbTx((tx) => takeReservations(tx, b.id, [company.id]))).taken).toEqual([company.id]);
  });

  it("two launches racing for the same company: exactly one gets it", async () => {
    const { company } = await makeCompany({ name: "Race Co", people: [{ name: "Ray" }] });
    const x = await makeDraft({ name: "X", createdById: ali.id });
    const y = await makeDraft({ name: "Y", createdById: sara.id, senderId: sara.id });
    await dbWrite((c) => c.campaign.updateMany({ where: { id: { in: [x.id, y.id] } }, data: { status: "RUNNING", mode: "LIVE" } }));
    const [rx, ry] = await Promise.all([
      dbTx((tx) => takeReservations(tx, x.id, [company.id])),
      dbTx((tx) => takeReservations(tx, y.id, [company.id])),
    ]);
    expect(rx.taken.length + ry.taken.length).toBe(1);
    expect(rx.lost.length + ry.lost.length).toBe(1);
    expect(await db.companyReservation.count({ where: { companyId: company.id, releasedAt: null } })).toBe(1);
  });

  it("a draft's reservation counts only while its launch is in progress", async () => {
    const { company } = await makeCompany({ name: "Launching Co", people: [{ name: "Lana" }] });
    const launching = await makeDraft({ name: "Launching", createdById: sara.id, senderId: sara.id });
    const other = await makeDraft({ name: "Other", createdById: ali.id });
    const now = new Date();
    await dbTx((tx) => takeReservations(tx, launching.id, [company.id], now));
    expect((await findActiveReservations(db, [company.id], now)).get(company.id)?.text).toBe("Waiting in Sara's campaign 'Launching'");
    expect((await dbTx((tx) => takeReservations(tx, other.id, [company.id], now))).lost).toHaveLength(1);
    // A launch cut short 20 minutes ago holds nothing any more.
    const later = new Date(now.getTime() + LAUNCH_HOLD_MS + 60_000);
    expect((await findActiveReservations(db, [company.id], later)).size).toBe(0);
    // A failed launch gives its reservations back straight away (drafts only).
    expect(await releaseDraftReservations(launching.id, now)).toBe(1);
    expect((await findActiveReservations(db, [company.id], now)).size).toBe(0);
  });

  it("loads the settings with safe defaults", async () => {
    await setSettingValue("sending.testList", ["Anna@Test.de", "not an address"]);
    const s = await loadEligibilitySettings();
    expect([...s.testList]).toEqual(["anna@test.de"]);
    expect(s.days).toBe(30);
    expect(s.policy.catchAllLow).toBe("send");
  });
});
