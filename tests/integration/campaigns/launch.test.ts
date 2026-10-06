import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { daysAgo, makeCompany, makeDraft, makeSentEmail, makeUser, setSettingValue } from "./seed";

const t = await createTestDb("campaign-launch");
const { db, dbWrite } = await import("@/server/db");
const { launchCampaign } = await import("@/server/services/campaigns/launch");
const { CampaignError } = await import("@/server/services/campaigns/errors");

let arslan: { id: number };
let ali: { id: number };

beforeAll(async () => {
  arslan = await makeUser("Arslan", { role: "OWNER", email: "arslan@polygonparadise.test" });
  ali = await makeUser("Ali", { email: "Ali.Khan@polygonparadise.test", senderDisplayName: "Ali from Polygon Paradise" });
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

async function expectRefusal(p: Promise<unknown>, code: string, message?: RegExp) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CampaignError);
  expect((err as InstanceType<typeof CampaignError>).code).toBe(code);
  if (message) expect((err as Error).message).toMatch(message);
}

async function twoCompanyDraft(name: string, opts: { senderId?: number | null; steps?: Parameters<typeof makeDraft>[0]["steps"] } = {}) {
  const a = await makeCompany({ name: `${name} A`, people: [{ name: "Anna", email: `anna@${name.toLowerCase().replace(/\W/g, "")}-a.de` }] });
  const b = await makeCompany({ name: `${name} B`, people: [{ name: "Bob", email: `bob@${name.toLowerCase().replace(/\W/g, "")}-b.de` }] });
  const draft = await makeDraft({
    name,
    createdById: arslan.id,
    senderId: opts.senderId === undefined ? ali.id : opts.senderId,
    steps: opts.steps,
    recipients: [
      { companyId: a.company.id, personId: a.people[0]!.id },
      { companyId: b.company.id, personId: b.people[0]!.id },
    ],
  });
  return { draft, a, b };
}

describe("launch checks", () => {
  it("refuses a draft without a sender, first email, follow-up text or ticked people", async () => {
    const noSender = await twoCompanyDraft("No sender", { senderId: null });
    await expectRefusal(launchCampaign(noSender.draft.id, arslan.id), "no-sender", /Choose who sends this campaign/);

    const noSubject = await twoCompanyDraft("No subject", { steps: [{ step: 0, subject: " ", body: "Hello" }] });
    await expectRefusal(launchCampaign(noSubject.draft.id, arslan.id), "no-first-email", /first email's subject and text/);

    const emptyFollowUp = await twoCompanyDraft("Empty follow-up", {
      steps: [{ step: 0 }, { step: 1, body: "Hi again" }, { step: 2, body: "   " }],
    });
    await expectRefusal(launchCampaign(emptyFollowUp.draft.id, arslan.id), "empty-follow-up", /^Follow-up 2 has no text/);
    // A switched-off follow-up may be empty.
    await dbWrite((c) => c.campaignStep.updateMany({ where: { campaignId: emptyFollowUp.draft.id, step: 2 }, data: { enabled: false } }));
    expect((await launchCampaign(emptyFollowUp.draft.id, arslan.id)).queued).toBe(2);

    const nobody = await makeDraft({ name: "Nobody", createdById: arslan.id, senderId: ali.id });
    await expectRefusal(launchCampaign(nobody.id, arslan.id), "no-recipients", /Tick at least one person/);

    await dbWrite((c) => c.user.update({ where: { id: ali.id }, data: { active: false } }));
    const off = await twoCompanyDraft("Sender off");
    await expectRefusal(launchCampaign(off.draft.id, arslan.id), "sender-off", /Ali's account is switched off/);
    await dbWrite((c) => c.user.update({ where: { id: ali.id }, data: { active: true } }));
  });

  it("refuses test and live mode while Mailgun isn't connected (Milestone 3)", async () => {
    const { draft } = await twoCompanyDraft("Live refusal");
    await setSettingValue("sending.mode", "LIVE");
    await expectRefusal(launchCampaign(draft.id, arslan.id), "mailgun-not-connected", /^Test mode and live sending need Mailgun\./);
    await setSettingValue("sending.mode", "TEST");
    await expectRefusal(launchCampaign(draft.id, arslan.id), "mailgun-not-connected");
    await setSettingValue("practice.copy", true);
    await expectRefusal(launchCampaign(draft.id, arslan.id), "practice-copy", /^The practice copy never sends real email/);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("DRAFT");
    expect(await db.outboundEmail.count({ where: { campaignId: draft.id } })).toBe(0);
  });

  it("refuses a second launch, and a launch already in progress", async () => {
    const { draft } = await twoCompanyDraft("Twice");
    const [first, second] = await Promise.allSettled([launchCampaign(draft.id, arslan.id), launchCampaign(draft.id, arslan.id)]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    expect(((second as PromiseRejectedResult).reason as InstanceType<typeof CampaignError>).code).toBe("busy");
    await expectRefusal(launchCampaign(draft.id, arslan.id), "not-draft", /already been launched/);
    expect(await db.outboundEmail.count({ where: { campaignId: draft.id } })).toBe(2);
  });
});

describe("a dry-run launch", () => {
  it("creates one waiting first email per person, with the sender snapshot, and starts the campaign", async () => {
    const now = new Date();
    const { draft, a, b } = await twoCompanyDraft("Germany Q4");
    const res = await launchCampaign(draft.id, arslan.id, { now });
    expect(res).toMatchObject({ campaignId: draft.id, status: "RUNNING", mode: "DRY_RUN", queued: 2, newlyExcluded: 0, excludedTotal: 0, lost: [] });
    expect(res.message).toBe("Launched Germany Q4 in dry run. 2 first emails are on the way to the dry-run outbox.");

    const campaign = await db.campaign.findUniqueOrThrow({ where: { id: draft.id } });
    expect(campaign).toMatchObject({
      status: "RUNNING",
      mode: "DRY_RUN",
      fromName: "Ali from Polygon Paradise",
      fromAddress: "ali.khan@your-sending-domain",
      sendingDomainId: null,
    });
    expect(campaign.launchedAt?.getTime()).toBe(now.getTime());
    expect(campaign.startAt?.getTime()).toBe(now.getTime());

    const rows = await db.outboundEmail.findMany({ where: { campaignId: draft.id }, orderBy: { id: "asc" } });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        step: 0,
        status: "QUEUED",
        mode: "DRY_RUN",
        senderId: ali.id,
        fromAddress: "Ali from Polygon Paradise <ali.khan@your-sending-domain>",
        subject: "",
        text: "",
        html: "",
        inReplyTo: null,
        references: null,
        attempts: 0,
      });
      expect(row.messageId).toMatch(/^pp\.[0-9a-f]{24}@dry-run\.invalid$/);
      expect(row.sendId).toMatch(/^[0-9a-f]{32}$/);
      expect(row.dueAt.getTime()).toBe(now.getTime());
    }
    expect(rows.map((r) => [r.toEmail, r.toNorm, r.companyId, r.companyName, r.companyDomain])).toEqual([
      [a.people[0]!.email, a.people[0]!.emailNorm, a.company.id, a.company.name, a.company.domain],
      [b.people[0]!.email, b.people[0]!.emailNorm, b.company.id, b.company.name, b.company.domain],
    ]);
    const recipients = await db.campaignRecipient.findMany({ where: { campaignId: draft.id } });
    expect(recipients.every((r) => r.state === "SCHEDULED" && r.currentStep === 0 && r.nextDueAt?.getTime() === now.getTime())).toBe(true);

    const activity = await db.activityLog.findFirstOrThrow({ where: { campaignId: draft.id, type: "campaign.launched" } });
    expect(activity).toMatchObject({ actorId: arslan.id, mode: "DRY_RUN", summary: "Arslan launched Germany Q4 (dry run) with 2 people" });
    // The chosen sender is told (they didn't launch it themselves).
    const note = await db.notification.findFirstOrThrow({ where: { userId: ali.id, type: "campaign.sender", link: `/campaigns/${draft.id}` } });
    expect(note).toMatchObject({ title: "Arslan launched Germany Q4 with you as the sender", link: `/campaigns/${draft.id}` });
    // A dry run on real data takes no reservations.
    expect(await db.companyReservation.count({ where: { campaignId: draft.id } })).toBe(0);
  });

  it("schedules for a later start", async () => {
    const now = new Date();
    const later = new Date(now.getTime() + 3 * 3_600_000);
    const { draft } = await twoCompanyDraft("Later");
    const res = await launchCampaign(draft.id, ali.id, { now, startAt: later });
    expect(res.status).toBe("SCHEDULED");
    expect(res.message).toMatch(/^Scheduled Later in dry run\. 2 first emails go to the dry-run outbox from the start time you chose\.$/);
    const rows = await db.outboundEmail.findMany({ where: { campaignId: draft.id } });
    expect(rows.every((r) => r.dueAt.getTime() === later.getTime())).toBe(true);
    // Ali launched his own campaign: no "you're the sender" notification.
    expect(await db.notification.count({ where: { userId: ali.id, type: "campaign.sender", link: `/campaigns/${draft.id}` } })).toBe(0);

    // A saved start in the past means now.
    const { draft: past } = await twoCompanyDraft("Past start");
    await dbWrite((c) => c.campaign.update({ where: { id: past.id }, data: { startAt: daysAgo(1, now) } }));
    const r2 = await launchCampaign(past.id, ali.id, { now });
    expect(r2.status).toBe("RUNNING");
    expect(r2.startAt.getTime()).toBe(now.getTime());
  });

  it("re-checks everyone and excludes people who can't be emailed any more, with the reason", async () => {
    const { draft, a, b } = await twoCompanyDraft("Recheck");
    const c = await makeCompany({ name: "Recheck C", people: [{ name: "Cleo", email: "cleo@recheck-c.de" }, { name: "Unticked", email: "un@recheck-c.de" }] });
    await dbWrite((x) =>
      x.campaignRecipient.createMany({
        data: [
          { campaignId: draft.id, companyId: c.company.id, personId: c.people[0]!.id, emailNorm: "cleo@recheck-c.de" },
          { campaignId: draft.id, companyId: c.company.id, personId: c.people[1]!.id, emailNorm: "un@recheck-c.de", included: false },
        ],
      }),
    );
    // Since they were ticked: Anna unsubscribed; B was emailed live by someone else.
    await dbWrite((x) => x.person.update({ where: { id: a.people[0]!.id }, data: { unsubscribedAt: new Date() } }));
    await makeSentEmail({
      campaignName: "Norway prints",
      createdById: ali.id,
      companyId: b.company.id,
      personId: b.people[0]!.id,
      toNorm: b.people[0]!.emailNorm!,
      sentAt: daysAgo(2),
    });

    const res = await launchCampaign(draft.id, arslan.id);
    expect(res.queued).toBe(1);
    expect(res.newlyExcluded).toBe(2);
    expect(res.excludedTotal).toBe(3);
    expect(res.excludedReasons.map((r) => r.code).sort()).toEqual(["team-rule", "unsubscribed"]);
    expect(res.message).toMatch(/2 people were left out because something changed since they were ticked\.$/);

    const recs = await db.campaignRecipient.findMany({ where: { campaignId: draft.id }, orderBy: { id: "asc" } });
    expect(recs.map((r) => [r.included, r.state, r.exclusionReason])).toEqual([
      [false, "EXCLUDED", "Unsubscribed"],
      [false, "EXCLUDED", "Emailed by Ali 2 days ago (Norway prints, first email)"],
      [true, "SCHEDULED", null],
      [false, "EXCLUDED", "Excluded by hand"],
    ]);
    const rows = await db.outboundEmail.findMany({ where: { campaignId: draft.id } });
    expect(rows.map((r) => r.toNorm)).toEqual(["cleo@recheck-c.de"]);
  });

  it("keeps a Replied company that was included by hand, and follows changed addresses", async () => {
    const r = await makeCompany({ name: "Replied Co", status: "REPLIED", people: [{ name: "Rae", email: "rae@replied.de" }] });
    const n = await makeCompany({ name: "Not overridden", status: "REPLIED", people: [{ name: "Ned", email: "ned@replied2.de" }] });
    const draft = await makeDraft({
      name: "Overrides",
      createdById: arslan.id,
      senderId: ali.id,
      recipients: [
        { companyId: r.company.id, personId: r.people[0]!.id, warnings: { overrides: ["company-replied"] } },
        { companyId: n.company.id, personId: n.people[0]!.id },
      ],
    });
    await dbWrite((x) => x.person.update({ where: { id: r.people[0]!.id }, data: { email: "rae.new@replied.de", emailNorm: "rae.new@replied.de" } }));
    const res = await launchCampaign(draft.id, arslan.id);
    expect(res.queued).toBe(1);
    const rec = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: draft.id, personId: r.people[0]!.id } });
    expect(rec).toMatchObject({ included: true, state: "SCHEDULED", emailNorm: "rae.new@replied.de" });
    const row = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: draft.id } });
    expect(row.toNorm).toBe("rae.new@replied.de");
    const excluded = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: draft.id, personId: n.people[0]!.id } });
    expect(excluded.exclusionReason).toBe("Company status is Replied (you can include it by hand)");
  });

  it("refuses when nobody is left, without changing the draft", async () => {
    const { draft, a, b } = await twoCompanyDraft("Nobody left");
    await dbWrite((x) => x.company.updateMany({ where: { id: { in: [a.company.id, b.company.id] } }, data: { status: "CLIENT" } }));
    await expectRefusal(launchCampaign(draft.id, arslan.id), "nobody-left", /Company status is Client/);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("DRAFT");
    expect(await db.campaignRecipient.count({ where: { campaignId: draft.id, included: true } })).toBe(2);
  });
});

describe("reservations at launch", () => {
  it("are taken only in the practice copy, and a second campaign then finds the company taken", async () => {
    await setSettingValue("practice.copy", true);
    const { draft, a, b } = await twoCompanyDraft("Practice one");
    await launchCampaign(draft.id, arslan.id);
    const held = await db.companyReservation.findMany({ where: { campaignId: draft.id, releasedAt: null } });
    expect(held.map((h) => h.companyId).sort()).toEqual([a.company.id, b.company.id].sort());

    const second = await makeDraft({
      name: "Practice two",
      createdById: ali.id,
      senderId: ali.id,
      recipients: [{ companyId: a.company.id, personId: a.people[0]!.id }],
    });
    const other = await makeCompany({ name: "Practice free", people: [{ name: "Fay", email: "fay@practice-free.de" }] });
    await dbWrite((x) =>
      x.campaignRecipient.create({ data: { campaignId: second.id, companyId: other.company.id, personId: other.people[0]!.id, emailNorm: "fay@practice-free.de" } }),
    );
    const res = await launchCampaign(second.id, ali.id);
    expect(res.queued).toBe(1);
    expect(res.excludedReasons).toEqual([{ code: "reserved", text: "Waiting in Ali's campaign 'Practice one'", count: 1 }]);
    expect(await db.companyReservation.count({ where: { campaignId: second.id, releasedAt: null } })).toBe(1);
  });

  it("two launches at the same moment never both get a company", async () => {
    await setSettingValue("practice.copy", true);
    const shared = await makeCompany({ name: "Contested", people: [{ name: "Cora", email: "cora@contested.de" }, { name: "Carl", email: "carl@contested.de" }] });
    const own1 = await makeCompany({ name: "Own one", people: [{ name: "Olli", email: "olli@own-one.de" }] });
    const own2 = await makeCompany({ name: "Own two", people: [{ name: "Otto", email: "otto@own-two.de" }] });
    const first = await makeDraft({
      name: "Race one",
      createdById: arslan.id,
      senderId: ali.id,
      recipients: [
        { companyId: shared.company.id, personId: shared.people[0]!.id },
        { companyId: own1.company.id, personId: own1.people[0]!.id },
      ],
    });
    const second = await makeDraft({
      name: "Race two",
      createdById: ali.id,
      senderId: ali.id,
      recipients: [
        { companyId: shared.company.id, personId: shared.people[1]!.id },
        { companyId: own2.company.id, personId: own2.people[0]!.id },
      ],
    });
    const [r1, r2] = await Promise.all([launchCampaign(first.id, arslan.id), launchCampaign(second.id, ali.id)]);
    expect(r1.queued + r2.queued).toBe(3);
    const loser = r1.queued === 1 ? r1 : r2;
    // Whether it lost during the re-check or at the reservation itself, the reason is the same.
    const reason = loser.lost[0]?.reason ?? loser.excludedReasons.find((e) => e.code === "reserved")?.text;
    expect(reason).toMatch(/^Waiting in Ali's campaign 'Race (one|two)'$/);
    expect(await db.companyReservation.count({ where: { companyId: shared.company.id, releasedAt: null } })).toBe(1);
    expect(await db.outboundEmail.count({ where: { companyId: shared.company.id, status: "QUEUED" } })).toBe(1);
  });

  it("an interrupted launch can simply be run again", async () => {
    const { draft } = await twoCompanyDraft("Interrupted");
    // A crashed earlier attempt left one row and a recipient still ticked; the draft is still a draft.
    const rec = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: draft.id }, orderBy: { id: "asc" } });
    const person = await db.person.findUniqueOrThrow({ where: { id: rec.personId } });
    await dbWrite((x) =>
      x.outboundEmail.create({
        data: {
          campaignId: draft.id,
          recipientId: rec.id,
          personId: rec.personId,
          companyId: rec.companyId,
          senderId: ali.id,
          step: 0,
          mode: "DRY_RUN",
          toEmail: person.email!,
          toNorm: person.emailNorm!,
          companyName: "Old",
          fromAddress: "x",
          subject: "",
          text: "",
          html: "",
          messageId: "pp.leftover@dry-run.invalid",
          sendId: "leftover",
          dueAt: daysAgo(1),
        },
      }),
    );
    const res = await launchCampaign(draft.id, arslan.id);
    expect(res.queued).toBe(2);
    const rows = await db.outboundEmail.findMany({ where: { campaignId: draft.id } });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.messageId === "pp.leftover@dry-run.invalid")?.companyName).not.toBe("Old");
  });
});
