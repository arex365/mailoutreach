import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeDraft, makeSentEmail, makeUser, setSettingValue, type StepSeed } from "../campaigns/seed";

const t = await createTestDb("campaign-pages");
const { db, dbWrite } = await import("@/server/db");
const { launchCampaign } = await import("@/server/services/campaigns/launch");
const control = await import("@/server/services/campaigns/control");
const { sendOneEmail } = await import("@/server/services/sending/loop");
const q = await import("@/server/services/campaigns/queries");
const { listCompanies } = await import("@/server/services/companies/query");
const { parseCompanyFilters } = await import("@/server/services/companies/filters");
const { toContactRow } = await import("@/components/contacts/format");
const { companySequenceLabel, stepProgressText, stepsSummary } = await import("@/components/campaigns/format");

const DAY = 86_400_000;
const TZ = "Europe/Berlin";
let arslan: { id: number };
let ali: { id: number };
let n = 0;

/** A fake render (the real one is tested by the templates package): predictable text per person. */
const render = async (args: { recipientId: number; step: number }) => ({
  subject: `Subject ${args.recipientId}/${args.step}`,
  text: `Hello ${args.recipientId}\n\n--\nPolygon Paradise`,
  html: `<p>Hello ${args.recipientId}</p>`,
  warnings: [],
});

beforeAll(async () => {
  arslan = await makeUser("Arslan", { role: "OWNER" });
  ali = await makeUser("Ali");
});

beforeEach(async () => {
  await setSettingValue("practice.copy", false);
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

const TWO_STEPS: StepSeed[] = [
  { step: 0, subject: "3D models for {{company}}", body: "Hi {{first_name|there}}" },
  { step: 1, body: "Following up", delayDays: 3 },
];

/** Launches a dry-run campaign for `count` new companies (one person each), names "<prefix> A", "<prefix> B"… */
async function launched(count: number, opts: { steps?: StepSeed[]; prefix?: string } = {}) {
  n += 1;
  const prefix = opts.prefix ?? `Pages${n}`;
  const recipients = [];
  const companies = [];
  for (let i = 0; i < count; i++) {
    const letter = String.fromCharCode(65 + i);
    const { company, people } = await makeCompany({
      name: `${prefix} ${letter}`,
      people: [{ name: `Person ${letter}${n}`, email: `p${i}@${prefix.toLowerCase()}-${letter.toLowerCase()}.de` }],
    });
    companies.push(company);
    recipients.push({ companyId: company.id, personId: people[0]!.id });
  }
  const draft = await makeDraft({ name: `Campaign ${prefix}`, createdById: arslan.id, senderId: ali.id, steps: opts.steps ?? TWO_STEPS, recipients });
  await launchCampaign(draft.id, arslan.id);
  const recs = await db.campaignRecipient.findMany({ where: { campaignId: draft.id }, orderBy: { id: "asc" } });
  return { campaignId: draft.id, recipients: recs, companies };
}

async function firstEmailOf(recipientId: number) {
  return db.outboundEmail.findFirstOrThrow({ where: { recipientId, step: 0 } });
}

async function send(recipientId: number) {
  const row = await firstEmailOf(recipientId);
  const outcome = await sendOneEmail(row.id, { render });
  expect(outcome).toBe("sent");
  return db.outboundEmail.findUniqueOrThrow({ where: { id: row.id } });
}

describe("the Campaigns list", () => {
  it("counts every tab and lists each campaign with its audience and progress", async () => {
    const before = await q.countCampaignsByTab();
    // A draft with one ticked and one unticked person.
    const { company, people } = await makeCompany({ name: "Draft Co", people: [{ name: "Dora" }, { name: "Dan" }] });
    const draft = await makeDraft({
      name: "A draft",
      createdById: arslan.id,
      senderId: null,
      recipients: [
        { companyId: company.id, personId: people[0]!.id },
        { companyId: company.id, personId: people[1]!.id, included: false },
      ],
    });
    const running = await launched(3);
    await send(running.recipients[0]!.id);
    await send(running.recipients[1]!.id);
    const paused = await launched(1);
    await control.pauseCampaign(paused.campaignId, ali.id);
    const cancelled = await launched(1);
    await control.cancelCampaign(cancelled.campaignId, ali.id);

    const counts = await q.countCampaignsByTab();
    expect(counts.drafts - before.drafts).toBe(1);
    expect(counts.running - before.running).toBe(1);
    expect(counts.paused - before.paused).toBe(1);
    expect(counts.cancelled - before.cancelled).toBe(1);

    const runningList = await q.listCampaigns("running");
    const item = runningList.items.find((i) => i.id === running.campaignId)!;
    expect(item).toMatchObject({
      name: `Campaign Pages${n - 2}`,
      status: "RUNNING",
      mode: "DRY_RUN",
      senderName: "Ali",
      createdByName: "Arslan",
      audience: 3,
      excluded: 0,
      sent: 2,
      firstEmail: { sent: 2, planned: 3 },
      enabledSteps: 2,
      // 3 people × 2 steps, 2 first emails sent.
      progress: { done: 2, total: 6 },
    });

    const drafts = await q.listCampaigns("drafts");
    expect(drafts.items.find((i) => i.id === draft.id)).toMatchObject({ audience: 1, excluded: 1, senderName: null, sent: 0 });

    const cancelledItem = (await q.listCampaigns("cancelled")).items.find((i) => i.id === cancelled.campaignId)!;
    // The cancelled first email counts as dealt with: 100%.
    expect(cancelledItem.progress).toEqual({ done: 1, total: 1 });
  });

  it("pages through a tab, newest change first for drafts", async () => {
    const a = await makeDraft({ name: "Page draft 1", createdById: arslan.id });
    const b = await makeDraft({ name: "Page draft 2", createdById: arslan.id });
    await dbWrite((c) => c.campaign.update({ where: { id: a.id }, data: { name: "Page draft 1 (renamed)" } }));
    const total = (await q.countCampaignsByTab()).drafts;
    const first = await q.listCampaigns("drafts", { page: 1, pageSize: 1 });
    expect(first).toMatchObject({ total, page: 1, pageCount: total, pageSize: 1 });
    expect(first.items[0]!.id).toBe(a.id);
    const second = await q.listCampaigns("drafts", { page: 2, pageSize: 1 });
    expect(second.items[0]!.id).toBe(b.id);
    // A page past the end shows the last page.
    expect((await q.listCampaigns("drafts", { page: 999, pageSize: 1 })).page).toBe(total);
  });
});

describe("one campaign", () => {
  it("shows progress per step, the counts and who is where", async () => {
    const c = await launched(3);
    const s1 = await send(c.recipients[0]!.id);
    await send(c.recipients[1]!.id);
    const o = (await q.getCampaignOverview(c.campaignId))!;
    expect(o).toMatchObject({
      status: "RUNNING",
      mode: "DRY_RUN",
      sender: { id: ali.id, name: "Ali", active: true },
      fromName: "Ali from Polygon Paradise",
      fromAddress: "ali@your-sending-domain",
      createdBy: { id: arslan.id, name: "Arslan" },
      countsAsReal: false,
      audience: 3,
      excluded: 0,
      hasFollowUps: true,
      emailsWaiting: 3,
      results: { sent: 2, delivered: 0, bounced: 0, replied: 0, unsubscribed: 0, complained: 0 },
      recipientCounts: { all: 3, active: 3, finished: 0, stopped: 0, problems: 0, excluded: 0, edited: 0 },
      progress: { done: 2, total: 6 },
    });
    expect(o.steps.map((s) => [s.step, s.enabled, s.planned, s.sent, s.waiting])).toEqual([
      [0, true, 3, 2, 1],
      [1, true, 0, 0, 2],
    ]);
    // The follow-ups are due 3 days after the first email went out.
    const due = new Date(s1.sentAt!.getTime() + 3 * DAY);
    expect(o.steps[1]!.nextDueAt?.getTime()).toBe(due.getTime());
    const now = new Date(s1.sentAt!.getTime() + 1000);
    expect(stepProgressText(o.steps[0]!, TZ, now)).toBe("First email 2 of 3 sent");
    // (en-GB writes September as "Sept".)
    expect(stepsSummary(o.steps, TZ, now)).toMatch(/^First email 2 of 3 sent · Follow-up 1: 2 waiting, next on \d{1,2} \w{3,4}$/);

    // Skipping someone stops them and counts their skipped email as dealt with.
    await control.skipRecipient(c.recipients[2]!.id, arslan.id);
    const after = (await q.getCampaignOverview(c.campaignId))!;
    expect(after.recipientCounts).toMatchObject({ active: 2, stopped: 1 });
    expect(after.steps[0]).toMatchObject({ sent: 2, waiting: 0, skipped: 1 });
    expect(after.progress).toEqual({ done: 3, total: 5 });
  });

  it("counts problems and edits, and knows the practice copy", async () => {
    const c = await launched(2, { steps: [{ step: 0, subject: "Hi", body: "Hello" }] });
    const row = await firstEmailOf(c.recipients[0]!.id);
    await dbWrite((x) => x.outboundEmail.update({ where: { id: row.id }, data: { status: "FAILED", lastError: "Broken" } }));
    await control.editUnsentEmail(c.recipients[1]!.id, 0, { body: "Just for you" }, ali.id);
    const o = (await q.getCampaignOverview(c.campaignId))!;
    expect(o.recipientCounts).toMatchObject({ problems: 1, edited: 1 });
    expect(o.steps[0]).toMatchObject({ failed: 1, waiting: 1 });
    expect(o.hasFollowUps).toBe(false);
    await setSettingValue("practice.copy", true);
    expect((await q.getCampaignOverview(c.campaignId))!.countsAsReal).toBe(true);
    expect(await q.getCampaignOverview(999_999)).toBeNull();
    expect(await q.getCampaignOverview(0)).toBeNull();
    expect(await q.getCampaignName(c.campaignId)).toBe(`Campaign Pages${n}`);
    expect(await q.getCampaignName(999_999)).toBeNull();
  });
});

describe("the people in a campaign", () => {
  it("filters by state, searches, and pages in company order", async () => {
    const c = await launched(4, { prefix: "Zeta" });
    await send(c.recipients[0]!.id);
    await control.skipRecipient(c.recipients[1]!.id, ali.id);
    await control.editUnsentEmail(c.recipients[2]!.id, 1, { body: "Edited follow-up" }, ali.id);
    const failed = await firstEmailOf(c.recipients[3]!.id);
    await dbWrite((x) => x.outboundEmail.update({ where: { id: failed.id }, data: { status: "UNCONFIRMED" } }));

    const all = await q.listCampaignRecipients(c.campaignId);
    expect(all.total).toBe(4);
    expect(all.rows.map((r) => r.companyName)).toEqual(["Zeta A", "Zeta B", "Zeta C", "Zeta D"]);
    expect(all.rows[0]).toMatchObject({ name: `Person A${n}`, state: "WAITING", currentStep: 1, included: true });
    expect(all.rows[0]!.emails.map((e) => [e.step, e.status])).toEqual([
      [0, "SENT"],
      [1, "QUEUED"],
    ]);

    const ids = async (filter: Parameters<typeof q.listCampaignRecipients>[1]) =>
      (await q.listCampaignRecipients(c.campaignId, filter)).rows.map((r) => r.id);
    expect(await ids({ filter: "stopped" })).toEqual([c.recipients[1]!.id]);
    expect(await ids({ filter: "edited" })).toEqual([c.recipients[2]!.id]);
    expect(await ids({ filter: "problems" })).toEqual([c.recipients[3]!.id]);
    expect(await ids({ filter: "active" })).toEqual([c.recipients[0]!.id, c.recipients[2]!.id, c.recipients[3]!.id]);
    expect(await ids({ filter: "excluded" })).toEqual([]);
    expect(await ids({ q: "zeta c" })).toEqual([c.recipients[2]!.id]);
    expect(await ids({ q: "P0@ZETA" })).toEqual([c.recipients[0]!.id]);
    expect(await ids({ q: "nobody-here" })).toEqual([]);

    const page2 = await q.listCampaignRecipients(c.campaignId, { page: 2, pageSize: 3 });
    expect(page2).toMatchObject({ total: 4, page: 2, pageCount: 2 });
    expect(page2.rows.map((r) => r.companyName)).toEqual(["Zeta D"]);
  });

  it("lists people left out, with the reason", async () => {
    const { company, people } = await makeCompany({ name: "Leftout Co", people: [{ name: "Lena" }, { name: "Lars" }] });
    const draft = await makeDraft({
      name: "With left out",
      createdById: arslan.id,
      senderId: ali.id,
      recipients: [
        { companyId: company.id, personId: people[0]!.id },
        { companyId: company.id, personId: people[1]!.id, included: false },
      ],
    });
    await launchCampaign(draft.id, arslan.id);
    const left = await q.listCampaignRecipients(draft.id, { filter: "excluded" });
    expect(left.rows).toHaveLength(1);
    expect(left.rows[0]).toMatchObject({ name: "Lars", included: false, state: "EXCLUDED", exclusionReason: "Excluded by hand" });
    expect((await q.getCampaignOverview(draft.id))!.recipientCounts).toMatchObject({ all: 2, excluded: 1, active: 1 });
  });

  it("gives one person's emails, texts, edits and timeline", async () => {
    const c = await launched(2);
    await send(c.recipients[0]!.id);
    await control.editUnsentEmail(c.recipients[0]!.id, 1, { body: "A follow-up just for this person" }, arslan.id);
    const d = (await q.getRecipientDetail(c.campaignId, c.recipients[0]!.id))!;
    expect(d.person).toMatchObject({ name: `Person A${n}`, displayName: `Person A${n}`, isGeneric: false, deleted: false });
    expect(d.company.name).toBe(`Pages${n} A`);
    expect(d.emails.map((e) => [e.step, e.status])).toEqual([
      [0, "SENT"],
      [1, "QUEUED"],
    ]);
    expect(d.emails[0]).toMatchObject({ subject: `Subject ${c.recipients[0]!.id}/0`, mode: "DRY_RUN" });
    expect(d.steps.map((s) => [s.step, s.enabled, s.edit?.body ?? null])).toEqual([
      [0, true, null],
      [1, true, "A follow-up just for this person"],
    ]);
    expect(d.steps[1]!.edit?.editedByName).toBe("Arslan");
    expect(d.activity.map((a) => a.summary)).toEqual([
      `Arslan edited the follow-up 1 to Person A${n} (Campaign Pages${n})`,
      `First email sent to p0@pages${n}-a.de (Campaign Pages${n})`,
    ]);
    expect(d.activity[1]).toMatchObject({ actorName: "Ali", mode: "DRY_RUN" });
    // Only within its own campaign.
    const other = await launched(1);
    expect(await q.getRecipientDetail(other.campaignId, c.recipients[0]!.id)).toBeNull();
    expect(await q.getRecipientDetail(c.campaignId, 0)).toBeNull();
  });
});

describe("the dry-run outbox", () => {
  it("holds every dry-run email that went out, newest first, filterable by campaign", async () => {
    const before = await q.listOutbox();
    const a = await launched(2, { prefix: "Outbox" });
    const b = await launched(1, { prefix: "Outbox2" });
    const first = await send(a.recipients[0]!.id);
    const second = await send(b.recipients[0]!.id);
    // Waiting, live and failed emails are not in the outbox.
    const { company, people } = await makeCompany({ name: "Live Co", people: [{ name: "Liv" }] });
    await makeSentEmail({ createdById: arslan.id, companyId: company.id, personId: people[0]!.id, toNorm: "liv@live.de", sentAt: new Date(), mode: "LIVE" });

    const all = await q.listOutbox();
    expect(all.total).toBe(before.total + 2);
    expect(all.rows.slice(0, 2).map((r) => r.id)).toEqual([second.id, first.id]);
    expect(all.rows[1]).toMatchObject({
      campaignId: a.campaignId,
      campaignName: "Campaign Outbox",
      step: 0,
      toEmail: "p0@outbox-a.de",
      companyName: "Outbox A",
      subject: `Subject ${a.recipients[0]!.id}/0`,
      fromAddress: "Ali from Polygon Paradise <ali@your-sending-domain>",
      senderName: "Ali",
    });

    const onlyA = await q.listOutbox({ campaignId: a.campaignId });
    expect(onlyA.rows.map((r) => r.id)).toEqual([first.id]);
    const campaigns = await q.listOutboxCampaigns();
    expect(campaigns.find((x) => x.id === a.campaignId)).toEqual({ id: a.campaignId, name: "Campaign Outbox", count: 1 });
    expect(campaigns.find((x) => x.id === b.campaignId)?.count).toBe(1);

    const full = (await q.getOutboxEmail(first.id))!;
    expect(full).toMatchObject({
      text: `Hello ${a.recipients[0]!.id}\n\n--\nPolygon Paradise`,
      html: `<p>Hello ${a.recipients[0]!.id}</p>`,
      recipientId: a.recipients[0]!.id,
      inReplyTo: null,
    });
    expect(full.messageId).toMatch(/^pp\.[0-9a-f]{24}@dry-run\.invalid$/);
    const waiting = await firstEmailOf(a.recipients[1]!.id);
    expect(await q.getOutboxEmail(waiting.id)).toBeNull();

    const paged = await q.listOutbox({ page: 2, pageSize: 1 });
    expect(paged.rows[0]!.id).toBe(first.id);
  });
});

describe("the Contacts Sequence column", () => {
  it("shows the latest sequence of each company, skipping drafts, marked as a dry run on real data", async () => {
    const c = await launched(2, { prefix: "Seq" });
    const sent = await send(c.recipients[0]!.id);
    const [companyA, companyB] = c.companies;
    // A draft for company A doesn't count.
    await makeDraft({ name: "Seq draft", createdById: arslan.id, recipients: [{ companyId: companyA!.id, personId: c.recipients[0]!.personId }] });

    const map = await q.companySequences([companyA!.id, companyB!.id, 999_999]);
    expect(map.get(companyA!.id)!.map((s) => [s.campaignId, s.state, s.currentStep, s.countsAsEmailed])).toEqual([[c.campaignId, "WAITING", 1, false]]);
    expect(map.get(companyB!.id)!.map((s) => s.state)).toEqual(["SCHEDULED"]);
    expect(map.has(999_999)).toBe(false);

    const now = new Date(sent.sentAt!.getTime() + 1000);
    const label = companySequenceLabel(map.get(companyA!.id)!, TZ, now)!;
    expect(label.text).toMatch(/^Waiting for follow-up 1 on \d{1,2} \w{3,4} \(dry run\)$/);
    expect(label.title).toBe(`Campaign Seq · a dry run: nothing was really sent`);

    // Through the Contacts query: one row per company, labelled.
    const listed = await listCompanies(parseCompanyFilters({ sort: "created", dir: "desc", size: "200" }));
    const rowB = listed.rows.find((r) => r.id === companyB!.id)!;
    expect(rowB.sequences?.map((s) => s.state)).toEqual(["SCHEDULED"]);
    expect(toContactRow(rowB, { timeZone: TZ }, now).sequenceLabel).toBe("First email waiting to send (dry run)");

    // In the practice copy a dry run is real contact: no "(dry run)".
    await setSettingValue("practice.copy", true);
    const practice = await q.companySequences([companyB!.id]);
    expect(practice.get(companyB!.id)![0]!.countsAsEmailed).toBe(true);
    expect(companySequenceLabel(practice.get(companyB!.id)!, TZ, now)!.text).toBe("First email waiting to send");
  });

  it("keeps what's still in progress plus only the latest finished one", async () => {
    const old = await launched(1, { prefix: "Hist", steps: [{ step: 0, subject: "Hi", body: "Hello" }] });
    await send(old.recipients[0]!.id);
    const company = old.companies[0]!;
    const personId = old.recipients[0]!.personId;
    const again = await makeDraft({
      name: "Hist again",
      createdById: arslan.id,
      senderId: ali.id,
      steps: [{ step: 0, subject: "Hi", body: "Hello" }],
      recipients: [{ companyId: company.id, personId }],
    });
    // Launch by hand (the 30-day rule doesn't apply to dry runs on real data).
    await launchCampaign(again.id, arslan.id);
    const map = await q.companySequences([company.id]);
    expect(map.get(company.id)!.map((s) => [s.campaignId, s.state])).toEqual([
      [again.id, "SCHEDULED"],
      [old.campaignId, "FINISHED"],
    ]);
    expect(companySequenceLabel(map.get(company.id)!, TZ)!.title).toBe("Hist again · a dry run: nothing was really sent");
  });
});
