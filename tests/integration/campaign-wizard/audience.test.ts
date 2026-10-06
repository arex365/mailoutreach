import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { daysAgo, makeCompany, makeSentEmail, makeUser, setSettingValue } from "../campaigns/seed";

const t = await createTestDb("wizard-audience");
const { db, dbWrite } = await import("@/server/db");
const { createDraft } = await import("@/server/services/campaigns/draft");
const audience = await import("@/server/services/campaigns/audience");
const { CampaignError } = await import("@/server/services/campaigns/errors");
const { readRecipientOverrides } = await import("@/core/rules/eligibility");

let arslan: { id: number; name: string };
let ali: { id: number; name: string };

beforeAll(async () => {
  arslan = await makeUser("Arslan", { role: "OWNER", email: "arslan@polygonparadise.test" });
  ali = await makeUser("Ali", { email: "ali@polygonparadise.test" });
});

beforeEach(async () => {
  await setSettingValue("practice.copy", false);
  await setSettingValue("sending.mode", "DRY_RUN");
  // The seeded live history stands for sends after go-live (before it, live sends don't count as "emailed", §1.7).
  await setSettingValue("sending.goLive", true);
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

async function refusal(p: Promise<unknown>, code: string): Promise<Error> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CampaignError);
  expect((err as InstanceType<typeof CampaignError>).code).toBe(code);
  return err as Error;
}

describe("the audience with the engine's rules", () => {
  let draftId: number;
  let ids: Record<string, { companyId: number; people: number[] }>;

  beforeAll(async () => {
    const ok = await makeCompany({
      name: "Aurora Prints",
      people: [
        { name: "Anna Berg", email: "anna@aurora.de", verificationStatus: "VALID", verifiedAt: new Date() },
        { name: "Ben", email: "ben@aurora.de" },
      ],
    });
    const client = await makeCompany({ name: "Clientia", status: "CLIENT", people: [{ name: "Cleo", email: "cleo@clientia.de" }] });
    const replied = await makeCompany({ name: "Replyco", status: "REPLIED", people: [{ name: "Rita", email: "rita@replyco.de" }] });
    const noEmail = await makeCompany({ name: "Silent GmbH", people: [{ name: "Sam", email: null }] });
    const emailed = await makeCompany({ name: "Emailed AS", domain: "emailed-as.no", people: [{ name: "Emil", email: "emil@emailed-as.no" }] });
    await makeSentEmail({
      campaignName: "Norway prints",
      createdById: ali.id,
      companyId: emailed.company.id,
      personId: emailed.people[0]!.id,
      toNorm: "emil@emailed-as.no",
      companyDomain: "emailed-as.no",
      sentAt: daysAgo(5),
      mode: "LIVE",
      // A live campaign launched after go-live: its sends count as "emailed" (M6-DESIGN §2.2).
      launchedGoLive: true,
    });
    const unsub = await makeCompany({
      name: "Unsub Studio",
      people: [
        { name: "Una", email: "una@unsub.de", unsubscribedAt: new Date() },
        { name: "Vera", email: "vera@unsub.de" },
      ],
    });
    ids = {
      ok: { companyId: ok.company.id, people: ok.people.map((p) => p.id) },
      client: { companyId: client.company.id, people: client.people.map((p) => p.id) },
      replied: { companyId: replied.company.id, people: replied.people.map((p) => p.id) },
      noEmail: { companyId: noEmail.company.id, people: noEmail.people.map((p) => p.id) },
      emailed: { companyId: emailed.company.id, people: emailed.people.map((p) => p.id) },
      unsub: { companyId: unsub.company.id, people: unsub.people.map((p) => p.id) },
    };
    const d = await createDraft(arslan, { companyIds: Object.values(ids).map((v) => v.companyId) });
    draftId = d.id;
  });

  it("splits companies into 'will get the email' and 'Excluded', with each reason in words", async () => {
    const snap = await audience.loadAudienceSnapshot(draftId);
    expect(snap.totals).toEqual({ people: 2, companies: 2, excludedCompanies: 4, includedCompanies: 2, nobodyTicked: 0, all: 6 });
    const by = new Map(snap.companies.map((c) => [c.companyId, c]));

    const ok = by.get(ids.ok!.companyId)!;
    expect(ok.section).toBe("included");
    expect(ok.people.map((p) => [p.name, p.ticked, p.willGet, p.canTick])).toEqual([
      ["Anna Berg", true, true, true],
      ["Ben", false, false, true],
    ]);
    expect(ok.warning).toBeNull();

    const client = by.get(ids.client!.companyId)!;
    expect(client).toMatchObject({ section: "excluded", blockedReason: "Company status is Client", canPutBack: false });
    expect(client.people[0]).toMatchObject({ ticked: false, eligible: false, canTick: false, reason: null });

    const replied = by.get(ids.replied!.companyId)!;
    expect(replied).toMatchObject({ section: "excluded", canPutBack: true, putBack: false });
    expect(replied.blockedReason).toMatch(/^Company status is Replied/);

    const silent = by.get(ids.noEmail!.companyId)!;
    expect(silent).toMatchObject({ section: "excluded", blockedReason: null, emptyReason: "Nobody here has an email address" });
    expect(silent.people[0]).toMatchObject({ recipientId: null, reason: "No email address" });

    const emailed = by.get(ids.emailed!.companyId)!;
    expect(emailed.section).toBe("excluded");
    expect(emailed.blockedReason).toBe("Emailed by Ali 5 days ago (Norway prints, first email)");

    const unsub = by.get(ids.unsub!.companyId)!;
    expect(unsub.section).toBe("included");
    expect(unsub.people.map((p) => [p.name, p.ticked, p.reason])).toEqual([
      ["Una", false, "Unsubscribed"],
      ["Vera", true, null],
    ]);
  });

  it("pages and searches each section", async () => {
    const included = await audience.loadAudiencePage(draftId, { section: "included" });
    expect(included.companies.map((c) => c.name)).toEqual(["Aurora Prints", "Unsub Studio"]);
    const excluded = await audience.loadAudiencePage(draftId, { section: "excluded", q: "reply" });
    expect(excluded.companies.map((c) => c.name)).toEqual(["Replyco"]);
    const byPerson = await audience.loadAudiencePage(draftId, { section: "included", q: "anna@aurora" });
    expect(byPerson.total).toBe(1);
    const tooFar = await audience.loadAudiencePage(draftId, { section: "included", page: 9 });
    expect(tooFar.page).toBe(1);
  });

  it("ticks a second person with a warning, and refuses anyone who can't be emailed", async () => {
    const [anna, ben] = ids.ok!.people;
    const res = await audience.setPersonTicked(ali, draftId, ben!, true);
    expect(res.company.willGet).toBe(2);
    expect(res.company.warning).toBe("2 people at this company are ticked. Each of them gets the emails.");
    const off = await audience.setPersonTicked(ali, draftId, anna!, false);
    expect(off.company.people.find((p) => p.personId === anna)?.ticked).toBe(false);
    expect(off.company.warning).toBeNull();

    const una = ids.unsub!.people[0]!;
    const err = await refusal(audience.setPersonTicked(ali, draftId, una, true), "not-eligible");
    expect(err.message).toBe("Una can't be emailed: unsubscribed.");
    const cleo = ids.client!.people[0]!;
    const err2 = await refusal(audience.setPersonTicked(ali, draftId, cleo, true), "not-eligible");
    expect(err2.message).toBe("Cleo can't be emailed: company status is Client.");
    // Back to the start for the next tests.
    await audience.setPersonTicked(ali, draftId, anna!, true);
    await audience.setPersonTicked(ali, draftId, ben!, false);
  });

  it("puts a Replied company back in by hand (and out again); other reasons have no override", async () => {
    const replied = ids.replied!;
    const on = await audience.setCompanyPutBack(ali, draftId, replied.companyId, true);
    expect(on.company).toMatchObject({ section: "included", putBack: true, willGet: 1, blockedReason: null });
    const row = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: draftId, personId: replied.people[0]! } });
    expect(row.included).toBe(true);
    expect([...readRecipientOverrides(row.warnings)]).toEqual(["company-replied"]);
    const log = await db.activityLog.findFirst({ where: { campaignId: draftId, type: "campaign.putBack", companyId: replied.companyId } });
    expect(log?.summary).toMatch(/^Ali put Replyco back into .* although the company replied$/);
    expect((await audience.audienceTotals(draftId)).people).toBe(3);

    const out = await audience.setCompanyPutBack(ali, draftId, replied.companyId, false);
    expect(out.company).toMatchObject({ section: "excluded", putBack: false, canPutBack: true, willGet: 0 });
    const after = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: draftId, personId: replied.people[0]! } });
    expect(after.included).toBe(false);
    expect(readRecipientOverrides(after.warnings).size).toBe(0);

    const err = await refusal(audience.setCompanyPutBack(ali, draftId, ids.client!.companyId, true), "not-overridable");
    expect(err.message).toBe("Clientia can't be put back: company status is Client.");
    await refusal(audience.setCompanyPutBack(ali, draftId, ids.emailed!.companyId, true), "not-overridable");
  });

  it("shows people added to a company later, unticked, and ticks them on request", async () => {
    const ok = ids.ok!;
    const late = await dbWrite((c) =>
      c.person.create({ data: { companyId: ok.companyId, name: "Late Lina", email: "lina@aurora.de", emailNorm: "lina@aurora.de" } }),
    );
    const view = await audience.loadAudienceCompany(draftId, ok.companyId);
    expect(view.people.find((p) => p.personId === late.id)).toMatchObject({ recipientId: null, ticked: false, canTick: true });
    const res = await audience.setPersonTicked(ali, draftId, late.id, true);
    expect(res.company.people.find((p) => p.personId === late.id)).toMatchObject({ ticked: true, willGet: true });
    expect(await db.campaignRecipient.count({ where: { campaignId: draftId, personId: late.id, included: true } })).toBe(1);
    await audience.setPersonTicked(ali, draftId, late.id, false);
  });
});

describe("adding and removing companies", () => {
  it("adds by filter with a live preview, skipping companies already in", async () => {
    const de1 = await makeCompany({ name: "Filter DE One", people: [{ name: "Dana", email: "dana@de1.de" }] });
    const de2 = await makeCompany({ name: "Filter DE Two", people: [{ name: "Dirk", email: "dirk@de2.de" }] });
    const no = await makeCompany({ name: "Filter NO", people: [{ name: "Nils", email: "nils@no.no" }] });
    for (const [c, country, niche] of [
      [de1, "DE", "Figurines"],
      [de2, "DE", "Busts"],
      [no, "NO", "Figurines"],
    ] as const) {
      await dbWrite((x) => x.company.update({ where: { id: c.company.id }, data: { country, niche } }));
    }
    const d = await createDraft(ali, { companyIds: [de1.company.id] });

    expect(await audience.previewAudienceFilter(d.id, {})).toEqual({ matching: 0, alreadyIn: 0, toAdd: 0, capped: 0 });
    const preview = await audience.previewAudienceFilter(d.id, { countries: ["de"], status: "NOT_CONTACTED" });
    expect(preview).toEqual({ matching: 2, alreadyIn: 1, toAdd: 1, capped: 0 });

    const added = await audience.addAudienceByFilter(ali, d.id, { countries: ["DE"], status: "NOT_CONTACTED" });
    expect(added).toMatchObject({ added: 1, alreadyIn: 1, ticked: 1, total: 2, label: "Status: Not contacted · Country: Germany" });
    const byNiche = await audience.addAudienceByFilter(ali, d.id, { niches: ["Figurines"] });
    expect(byNiche).toMatchObject({ added: 1, alreadyIn: 1, label: "Niche: Figurines" });

    const json = audience.readAudienceJson((await db.campaign.findUniqueOrThrow({ where: { id: d.id } })).audience);
    expect(json.companyIds).toEqual([de1.company.id, de2.company.id, no.company.id]);
    expect(json.sources.map((s) => s.kind)).toEqual(["selection", "filter", "filter"]);

    await refusal(audience.addAudienceByFilter(ali, d.id, {}), "empty-filter");
    await refusal(audience.addAudienceByFilter(ali, d.id, { countries: ["JP"] }), "no-match");
    const log = await db.activityLog.findFirst({ where: { campaignId: d.id, type: "campaign.audience" }, orderBy: { id: "asc" } });
    expect(log?.summary).toBe(`Ali added 1 company to ${d.name} (Status: Not contacted · Country: Germany)`);
  });

  it("removes a company with its people's rows and edits, and can start over", async () => {
    const a = await makeCompany({ name: "Remove A", people: [{ name: "Ada", email: "ada@remove-a.de" }] });
    const b = await makeCompany({ name: "Remove B", people: [{ name: "Bea", email: "bea@remove-b.de" }] });
    const d = await createDraft(ali, { companyIds: [a.company.id, b.company.id] });
    const row = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: d.id, companyId: a.company.id } });
    await dbWrite((c) => c.recipientEdit.create({ data: { recipientId: row.id, step: 0, body: "Hi Ada" } }));

    expect(await audience.removeCompaniesFromAudience(ali, d.id, [a.company.id])).toEqual({ removed: 1 });
    expect(await db.campaignRecipient.count({ where: { campaignId: d.id, companyId: a.company.id } })).toBe(0);
    expect(await db.recipientEdit.count({ where: { recipientId: row.id } })).toBe(0);
    const snap = await audience.loadAudienceSnapshot(d.id);
    expect(snap.companies.map((c) => c.name)).toEqual(["Remove B"]);
    const log = await db.activityLog.findFirst({ where: { campaignId: d.id, type: "campaign.audience", companyId: a.company.id } });
    expect(log?.summary).toBe(`Ali removed Remove A from ${d.name}`);

    expect(await audience.clearAudience(ali, d.id)).toEqual({ removed: 1 });
    expect((await audience.loadAudienceSnapshot(d.id)).totals.all).toBe(0);
  });

  it("refuses changes once the campaign is no longer a draft", async () => {
    const a = await makeCompany({ name: "Locked A", people: [{ name: "Lou", email: "lou@locked.de" }] });
    const d = await createDraft(ali, { companyIds: [a.company.id] });
    await dbWrite((c) => c.campaign.update({ where: { id: d.id }, data: { status: "RUNNING" } }));
    await refusal(audience.addAudienceByFilter(ali, d.id, { niches: ["x"] }), "not-draft");
    await refusal(audience.setPersonTicked(ali, d.id, a.people[0]!.id, false), "not-draft");
    await refusal(audience.removeCompaniesFromAudience(ali, d.id, [a.company.id]), "not-draft");
  });

  it("counts a draft made elsewhere (no stored audience) from its recipient rows", async () => {
    const a = await makeCompany({ name: "Legacy A", people: [{ name: "Leni", email: "leni@legacy.de" }] });
    const c = await dbWrite((x) => x.campaign.create({ data: { name: "Legacy", createdById: ali.id, senderId: ali.id } }));
    await dbWrite((x) =>
      x.campaignRecipient.create({ data: { campaignId: c.id, companyId: a.company.id, personId: a.people[0]!.id, emailNorm: "leni@legacy.de" } }),
    );
    const snap = await audience.loadAudienceSnapshot(c.id);
    expect(snap.totals).toMatchObject({ people: 1, companies: 1, all: 1 });
  });
});

describe("before launch", () => {
  it("writes the reason for everyone unticked, and clears it for the ticked", async () => {
    const a = await makeCompany({
      name: "Sync A",
      people: [
        { name: "Sia", email: "sia@sync-a.de" },
        { name: "Uli", email: "uli@sync-a.de", unsubscribedAt: new Date() },
        { name: "Sol", email: "sol@sync-a.de" },
      ],
    });
    const b = await makeCompany({ name: "Sync Client", status: "CLIENT", people: [{ name: "Cid", email: "cid@sync-b.de" }] });
    const d = await createDraft(ali, { companyIds: [a.company.id, b.company.id] });
    const changed = await audience.syncExclusionReasons(d.id);
    expect(changed).toBe(3);
    const rows = await db.campaignRecipient.findMany({ where: { campaignId: d.id }, include: { person: true }, orderBy: { id: "asc" } });
    expect(rows.map((r) => [r.person.name, r.included, r.exclusionReason])).toEqual([
      ["Sia", true, null],
      ["Uli", false, "Unsubscribed"],
      ["Sol", false, "Not ticked"],
      ["Cid", false, "Company status is Client"],
    ]);
    expect(await audience.syncExclusionReasons(d.id)).toBe(0);
    // Ticking Sol later clears the reason again.
    await audience.setPersonTicked(ali, d.id, a.people[2]!.id, true);
    expect(await audience.syncExclusionReasons(d.id)).toBe(1);
    expect((await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: d.id, personId: a.people[2]!.id } })).exclusionReason).toBeNull();
  });
});
