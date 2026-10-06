import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { replyTo } from "../helpers/replies";
import { makeCompany, makeDraft, setSettingValue } from "../campaigns/seed";
import { clearPacer, launchTo, resetSendingState, setupM3, tickDeps, worldClock, type M3World, type TestClock } from "../sending-m3/helpers";

/**
 * The "emailed" rule and the test-list guard across the go-live flip (M6-DESIGN §2.2, §2.3, G2, G11), through the real
 * sending loop and the fake Mailgun on real-data settings. `sending.goLive` is set directly: these tests are about the
 * rules, not the switch. Nothing reaches a real host.
 */

const t = await createTestDb("go-live-flip");
const { db, dbWrite } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");
const queries = await import("@/server/services/campaigns/queries");
const { companySequenceLabel } = await import("@/components/campaigns/format");
const { evaluateCompanies } = await import("@/server/services/eligibility");
const { launchCampaign, MADE_BEFORE_GO_LIVE_LAUNCH_TEXT } = await import("@/server/services/campaigns/launch");
const { CampaignError } = await import("@/server/services/campaigns/errors");
const { processPendingInbound } = await import("@/server/services/replies");
const { MailgunTransport } = await import("@/server/services/sending/mailgun-transport");
const { DryRunTransport } = await import("@/server/services/sending/transport");
type OutgoingMessage = import("@/server/services/sending/transport").OutgoingMessage;
type EmailTransport = import("@/server/services/sending/transport").EmailTransport;

const TZ = "Europe/Berlin";
const DAY = 86_400_000;
const TESS = "tess@test-mailbox.example";
const TWO_STEPS = [
  { step: 0, subject: "Hello", body: "First" },
  { step: 1, body: "Second", delayDays: 1 },
];

let world: M3World;

beforeAll(async () => {
  world = await setupM3({ testList: [TESS] });
});

beforeEach(async () => {
  world.mg.fake.reset();
  await resetSendingState();
  await setSettingValue("practice.copy", false);
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.goLive", false);
  await setSettingValue("sending.goLiveAt", null);
  await setSettingValue("sending.testList", [TESS]);
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

/** One tick after forgetting the pacer's gap, so the next gated email may go at once. */
async function tick(clock: TestClock, extra: Record<string, unknown> = {}) {
  await clearPacer();
  return loop.sendingTick(tickDeps(world, clock, extra));
}

/** Moves the clock to the due time of the step's email row and returns that row. */
async function toDueStep(clock: TestClock, campaignId: number, step: number) {
  const row = await db.outboundEmail.findFirstOrThrow({ where: { campaignId, step } });
  clock.set(new Date(Math.max(row.dueAt.getTime(), clock.now().getTime())));
  return row;
}

/** A company with one person whose address was checked (fresh, by a real provider): eligible for live after go-live. */
async function checkedProspect(name: string, email: string, clock: TestClock) {
  const { company, people } = await makeCompany({
    name,
    domain: email.split("@")[1]!,
    people: [{ name: `${name} contact`, email, verificationStatus: "VALID", verifiedAt: new Date(clock.now().getTime() - DAY) }],
  });
  return { companyId: company.id, personId: people[0]!.id };
}

/** Company-level result of a new LIVE draft with this company (the audience's rules). */
async function draftVerdict(companyId: number, clock: TestClock) {
  const draft = await makeDraft({ name: `Draft ${companyId}-${clock.now().getTime()}`, createdById: world.owner.id, senderId: world.member.id });
  const r = (await evaluateCompanies([companyId], { mode: "LIVE", phase: "draft", campaignId: draft.id, now: clock.now() })).get(companyId)!;
  return r.blocked;
}

describe("a live campaign launched before go-live, sending across the flip (G2)", () => {
  it("stays a test-list send: no reservation, not Contacted, no lastEmailed, ' (test list)', no 30-day block, a late reply changes no status", async () => {
    const clock = worldClock(world);
    const pre = await launchTo(world, [TESS], { now: clock.now(), name: "Test run", steps: TWO_STEPS });
    const companyId = pre.companyIds[0]!;
    expect((await db.campaign.findUniqueOrThrow({ where: { id: pre.campaignId } })).launchedGoLive).toBe(false);
    expect((await tick(clock)).sent).toBe(1);
    const first = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: pre.campaignId, step: 0 } });
    expect(first.status).toBe("SENT");

    // Go-live is switched on while the campaign still runs.
    await setSettingValue("sending.goLive", true);
    await toDueStep(clock, pre.campaignId, 1);
    expect((await tick(clock)).sent).toBe(1);
    expect(world.mg.fake.messages.map((m) => m.fields.to?.[0])).toEqual([TESS, TESS]);
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: pre.campaignId, step: 1 } })).status).toBe("SENT");

    // Still a test-list send after the flip.
    expect(await db.companyReservation.count({ where: { campaignId: pre.campaignId } })).toBe(0);
    expect(await db.company.findUniqueOrThrow({ where: { id: companyId } })).toMatchObject({
      status: "NOT_CONTACTED",
      lastEmailedAt: null,
      firstContactedAt: null,
    });
    expect((await db.person.findUniqueOrThrow({ where: { id: pre.personIds[0]! } })).lastEmailedAt).toBeNull();
    const sequences = (await queries.companySequences([companyId])).get(companyId)!;
    expect(sequences[0]).toMatchObject({ campaignId: pre.campaignId, countsAsEmailed: false });
    expect(companySequenceLabel(sequences, TZ, clock.now())?.text).toMatch(/ \(test list\)$/);
    // A new draft isn't blocked by the 30-day rule for those test emails.
    expect(await draftVerdict(companyId, clock)).toBeNull();

    // A reply to the old email, processed after the flip, doesn't make the test mailbox Replied.
    const posted = await replyTo(world.mg.fake, first.id);
    expect(posted.status).toBe(200);
    await processPendingInbound({ now: clock.now(), limit: 50, failures: new Map() });
    expect(await db.inboundMessage.findUniqueOrThrow({ where: { id: posted.id! } })).toMatchObject({
      kind: "REPLY",
      outboundEmailId: first.id,
      replyScope: "real",
      changesStatus: false,
    });
    expect(await db.company.findUniqueOrThrow({ where: { id: companyId } })).toMatchObject({ status: "NOT_CONTACTED", repliedAt: null });
  });

  it("a live campaign launched after the flip counts: reservation, Contacted, lastEmailed*, and a second draft is blocked", async () => {
    const clock = worldClock(world);
    await setSettingValue("sending.goLive", true);
    const prospect = await checkedProspect("Firma GmbH", "anna@firma.example", clock);
    const post = await launchTo(world, ["anna@firma.example"], { now: clock.now(), name: "Germany Q4" });
    expect((await db.campaign.findUniqueOrThrow({ where: { id: post.campaignId } })).launchedGoLive).toBe(true);
    expect(await db.companyReservation.count({ where: { campaignId: post.campaignId, companyId: prospect.companyId, releasedAt: null } })).toBe(1);

    expect((await tick(clock)).sent).toBe(1);
    expect(world.mg.fake.messages.map((m) => m.fields.to?.[0])).toEqual(["anna@firma.example"]);
    expect(world.mg.fake.messages[0]!.fields["o:testmode"]).toBeUndefined();
    const company = await db.company.findUniqueOrThrow({ where: { id: prospect.companyId } });
    expect(company).toMatchObject({ status: "CONTACTED", lastEmailedById: world.member.id, lastEmailedCampaignId: post.campaignId, firstContactedById: world.member.id });
    expect(company.lastEmailedAt).not.toBeNull();
    expect((await db.person.findUniqueOrThrow({ where: { id: prospect.personId } })).lastEmailedAt).not.toBeNull();
    const sequences = (await queries.companySequences([prospect.companyId])).get(prospect.companyId)!;
    expect(sequences[0]).toMatchObject({ countsAsEmailed: true });
    expect(companySequenceLabel(sequences, TZ, clock.now())?.text).not.toMatch(/\(test list\)/);

    // The 30-day rule blocks a second draft (the campaign finished and let the company go: the send itself blocks it).
    expect(await db.companyReservation.count({ where: { companyId: prospect.companyId, releasedAt: null } })).toBe(0);
    expect(await draftVerdict(prospect.companyId, clock)).toMatchObject({ code: "team-rule" });
    // It stays "emailed" whatever today's switch says.
    await setSettingValue("sending.goLive", false);
    expect(await draftVerdict(prospect.companyId, clock)).toMatchObject({ code: "team-rule" });
  });
});

describe("test-list only across the flip (§2.3)", () => {
  it("someone taken off the test list after go-live is skipped by the re-check; the Mailgun client guard stops a test-list-only email on its own", async () => {
    const clock = worldClock(world);
    const TESS2 = "tess2@test-mailbox.example";
    const TESS3 = "tess3@test-mailbox.example";
    await setSettingValue("sending.testList", [TESS, TESS2, TESS3]);
    const threeSteps = [...TWO_STEPS, { step: 2, body: "Third", delayDays: 2 }];
    const offList = await launchTo(world, [TESS2], { now: clock.now(), name: "Three steps", steps: threeSteps });
    const guarded = await launchTo(world, [TESS3], { now: clock.now(), name: "Guard check", steps: TWO_STEPS });
    expect((await tick(clock)).sent).toBe(1);
    expect((await tick(clock)).sent).toBe(1);
    expect(world.mg.fake.messages).toHaveLength(2);

    // Go-live, and Tess 2 leaves the test list. Tess 3 stays on it.
    await setSettingValue("sending.goLive", true);
    await setSettingValue("sending.testList", [TESS, TESS3]);

    // The Mailgun client gets a guard whose test list is empty, as if the re-check and the final check had let an
    // address through wrongly: only the flag on the claimed email (testListOnly) can stop it there.
    const context = await world.mailgun();
    if (!context.connected) throw new Error(context.text);
    const seen: OutgoingMessage[] = [];
    const transportFor = (mode: "DRY_RUN" | "TEST" | "LIVE"): EmailTransport => {
      if (mode === "DRY_RUN") return new DryRunTransport(clock.now);
      const real = new MailgunTransport({ mode, context, guard: { goLive: true, testList: new Set() }, now: clock.now });
      return {
        mode,
        send: (m) => {
          seen.push(m);
          return real.send(m);
        },
      };
    };

    await toDueStep(clock, offList.campaignId, 1);
    await toDueStep(clock, guarded.campaignId, 1);
    const results = [await tick(clock, { transportFor }), await tick(clock, { transportFor })];
    expect(results.reduce((n, r) => n + r.skipped, 0)).toBe(2);
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(0);
    // Nothing more reached Mailgun.
    expect(world.mg.fake.messages).toHaveLength(2);

    // Tess 2: the re-check (by the campaign's launch flag, not today's switch) left her out before any hand-over.
    const skipped = await db.outboundEmail.findFirstOrThrow({ where: { campaignId: offList.campaignId, step: 1 } });
    expect(skipped).toMatchObject({ status: "SKIPPED", lastError: "Not on the test list (until you go live, only test-list addresses get real email)" });
    expect(seen.some((m) => m.campaignId === offList.campaignId)).toBe(false);
    expect(await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: offList.campaignId } })).toMatchObject({ state: "STOPPED" });

    // Tess 3: every earlier check passed, the claimed email said test-list only, and the client's guard refused it.
    const handed = seen.find((m) => m.campaignId === guarded.campaignId)!;
    expect(handed).toMatchObject({ toNorm: TESS3, testListOnly: true });
    expect(await db.outboundEmail.findFirstOrThrow({ where: { campaignId: guarded.campaignId, step: 1 } })).toMatchObject({
      status: "SKIPPED",
      lastError: "Not on the test list (until you go live, only test-list addresses get real email)",
      providerId: null,
    });

    // The same guard lets a campaign launched after go-live reach its prospect (the email says testListOnly: false).
    const prospect = await checkedProspect("Studio Nord", "ola@nord.example", clock);
    const live = await launchTo(world, ["ola@nord.example"], { now: clock.now(), name: "After the flip" });
    expect((await tick(clock, { transportFor })).sent).toBe(1);
    expect(seen.find((m) => m.campaignId === live.campaignId)).toMatchObject({ toNorm: "ola@nord.example", testListOnly: false });
    expect(world.mg.fake.messages.map((m) => m.fields.to?.[0])).toContain("ola@nord.example");
    expect((await db.company.findUniqueOrThrow({ where: { id: prospect.companyId } })).status).toBe("CONTACTED");
  });
});

describe("a draft made before go-live (G11)", () => {
  it("refuses a live launch without the tick, and launches with it", async () => {
    const clock = worldClock(world);
    const prospect = await checkedProspect("Made Early", "mia@early.example", clock);
    const early = await makeDraft({
      name: "Made early",
      createdById: world.owner.id,
      senderId: world.member.id,
      recipients: [{ companyId: prospect.companyId, personId: prospect.personId }],
    });
    await dbWrite((c) => c.campaign.update({ where: { id: early.id }, data: { createdAt: new Date(clock.now().getTime() - DAY) } }));
    await setSettingValue("sending.goLive", true);
    await setSettingValue("sending.goLiveAt", clock.now().toISOString());

    const err = await launchCampaign(early.id, world.owner.id, { now: clock.now(), mailgun: world.mailgun }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CampaignError);
    expect((err as InstanceType<typeof CampaignError>).code).toBe("made-before-go-live");
    expect((err as Error).message).toBe("Tick the box to confirm that this draft now sends real email.");
    expect(MADE_BEFORE_GO_LIVE_LAUNCH_TEXT).toBe("Tick the box to confirm that this draft now sends real email.");
    // Nothing launched.
    expect(await db.campaign.findUniqueOrThrow({ where: { id: early.id } })).toMatchObject({ status: "DRAFT", launchedAt: null, launchedGoLive: null });
    expect(await db.outboundEmail.count({ where: { campaignId: early.id } })).toBe(0);
    expect(await db.companyReservation.count({ where: { campaignId: early.id } })).toBe(0);
    expect(await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: early.id } })).toMatchObject({ included: true, state: "PENDING" });

    const launched = await launchCampaign(early.id, world.owner.id, { now: clock.now(), mailgun: world.mailgun, confirmMadeBeforeGoLive: true });
    expect(launched).toMatchObject({ mode: "LIVE", queued: 1 });
    expect(await db.campaign.findUniqueOrThrow({ where: { id: early.id } })).toMatchObject({ status: "RUNNING", launchedGoLive: true });
  });

  it("needs no tick for a draft made after go-live, for a dry run, or while not live", async () => {
    const clock = worldClock(world);
    const draftFor = async (name: string, email: string, createdAt: Date) => {
      const p = await checkedProspect(name, email, clock);
      const d = await makeDraft({ name, createdById: world.owner.id, senderId: world.member.id, recipients: [{ companyId: p.companyId, personId: p.personId }] });
      await dbWrite((c) => c.campaign.update({ where: { id: d.id }, data: { createdAt } }));
      return d.id;
    };
    const goLiveAt = clock.now();
    await setSettingValue("sending.goLive", true);
    await setSettingValue("sending.goLiveAt", goLiveAt.toISOString());

    const after = await draftFor("Made Later", "lia@later.example", new Date(goLiveAt.getTime() + 60_000));
    expect((await launchCampaign(after, world.owner.id, { now: clock.now(), mailgun: world.mailgun })).mode).toBe("LIVE");

    await setSettingValue("sending.mode", "DRY_RUN");
    const dry = await draftFor("Dry Early", "dan@dry-early.example", new Date(goLiveAt.getTime() - DAY));
    expect((await launchCampaign(dry, world.owner.id, { now: clock.now(), mailgun: world.mailgun })).mode).toBe("DRY_RUN");

    // Before go-live nothing is asked (live then only reaches the test list).
    await setSettingValue("sending.mode", "LIVE");
    await setSettingValue("sending.goLive", false);
    await setSettingValue("sending.testList", [TESS, "tom@test-mailbox.example"]);
    const early = await draftFor("Test Early", "tom@test-mailbox.example", new Date(goLiveAt.getTime() - DAY));
    expect(await launchCampaign(early, world.owner.id, { now: clock.now(), mailgun: world.mailgun })).toMatchObject({ mode: "LIVE", queued: 1 });
  });
});
