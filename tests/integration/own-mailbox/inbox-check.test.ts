import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { StepSeed } from "../campaigns/seed";
import { makeCompany, setSettingValue } from "../campaigns/seed";
import { createTestDb } from "../helpers/test-db";
import { clearPacer, render, resetSendingState, tickDeps, worldClock, type M3World, type TestClock } from "../sending-m3/helpers";
import { ALI_LINE, OWN, launchOwn, passReplyTest, setupOwnMailbox, storeCheck } from "./p1-setup";

/**
 * The daily inbox check (docs/dev/MAIN-DOMAIN-DESIGN.md O33, §2.9, §3.9, §8 P1): in own-mailbox mode a LIVE follow-up
 * goes only once someone has clicked "I've read contact@…" inside today's cap day and after that person's last email.
 * A first email waits too when its company got a live email before today (review SEND-1); other first emails, test mode
 * and app mode never wait. The Owner hears once a day; the loop's final check, Retry and the campaign page's waiting line
 * see it too. A check stamped in the future never counts, and the next click replaces it (review SECURITY-02). Held rows
 * never crowd first emails out of the candidates (review SEND-3). The check is mostly written straight to SystemState here.
 */

const t = await createTestDb("own-mailbox-inbox-check");
const { db, dbWrite } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");
const { setState } = await import("@/server/state");
const { explainCampaignWaiting, GATED_CANDIDATE_LIMIT, inboxCheckHeldIds, pendingProblemIds, pickCandidates } = await import(
  "@/server/services/sending/gates"
);
const { pauseCampaign, resumeCampaign, retryEmail, retryInboxCheckText } = await import("@/server/services/campaigns/control");
const { markInboxChecked } = await import("@/server/services/sending/inbox-check");
const { getTodayCap } = await import("@/server/services/sending/usage");
const { INBOX_CHECK_TEXTS } = await import("@/core/sending/own-mailbox");
const { DEFAULT_WINDOW } = await import("@/core/sending/window");

const LIST = Array.from({ length: 20 }, (_, i) => `i${i}@team-${i}.de`);
const MIN = 60_000;
const DAY = 86_400_000;
/** A follow-up 3 "days" after the first email; the campaigns run with days as minutes. */
const FOLLOW_UP: StepSeed[] = [
  { step: 0, subject: "Hello", body: "First" },
  { step: 1, body: "Second", delayDays: 3 },
];

let world: M3World;

async function rowOf(campaignId: number, step = 0) {
  return db.outboundEmail.findFirstOrThrow({ where: { campaignId, step } });
}

async function checkAt(at: Date | null): Promise<void> {
  if (at === null) await dbWrite((c) => c.systemState.deleteMany({ where: { key: "sending.inboxCheck" } }));
  else await setState("sending.inboxCheck", { at: at.toISOString(), byUserId: world.owner.id });
}

async function inboxNotices(): Promise<number> {
  return db.notification.count({ where: { type: "reply.inboxCheck", userId: world.owner.id } });
}

/**
 * A campaign to one address whose first email went out; its follow-up is then made due a few minutes later, the same
 * cap day (written directly: a live campaign's delay is in calendar days, `daysAsMinutes` is for dry runs only), and
 * the clock is moved past it.
 */
async function followUpDue(address: string, clock: TestClock, mode: "LIVE" | "TEST" = "LIVE"): Promise<{ campaignId: number; first: Date }> {
  await setSettingValue("sending.mode", mode);
  const { campaignId } = await launchOwn(world, [address], { now: clock.now(), steps: FOLLOW_UP });
  await clearPacer();
  const sent = await loop.sendingTick(tickDeps(world, clock));
  expect(sent.sent, "the first email goes").toBe(1);
  const first = (await rowOf(campaignId, 0)).sentAt!;
  const next = await rowOf(campaignId, 1);
  await dbWrite((c) => c.outboundEmail.update({ where: { id: next.id }, data: { dueAt: new Date(first.getTime() + 2 * MIN) } }));
  clock.set(new Date(first.getTime() + 5 * MIN));
  await clearPacer();
  return { campaignId, first };
}

beforeAll(async () => {
  world = await setupOwnMailbox({ testList: LIST });
});

beforeEach(async () => {
  world.mg.fake.reset();
  await resetSendingState();
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("mailgun.replies", "own-mailbox");
  await setSettingValue("mailgun.fromAddress", OWN);
  await passReplyTest(world.owner.id);
  await storeCheck();
  await checkAt(null);
  await dbWrite(async (c) => {
    await c.notification.deleteMany({ where: { type: "reply.inboxCheck" } });
    await c.outboundEmail.updateMany({ where: { status: "SENT" }, data: { sentAt: new Date("2020-01-01T00:00:00Z") } });
  });
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("live follow-ups wait for today's inbox check", () => {
  it("no check: the follow-up waits, another person's first email goes; the Owner hears once in 24 hours", async () => {
    const clock = worldClock(world);
    const a = await followUpDue(LIST[0]!, clock);
    const b = await launchOwn(world, [LIST[1]!], { now: clock.now() });

    const r = await loop.sendingTick(tickDeps(world, clock));
    expect(r).toMatchObject({ sent: 1, waiting: { reason: "inbox-check", until: null } });
    expect((await rowOf(b.campaignId)).status).toBe("SENT");
    expect((await rowOf(a.campaignId, 1)).status).toBe("QUEUED");
    const notices = await db.notification.findMany({ where: { type: "reply.inboxCheck" } });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      userId: world.owner.id,
      title: INBOX_CHECK_TEXTS.notificationTitle,
      body: INBOX_CHECK_TEXTS.notificationBody(OWN),
      link: "/notifications#inbox-check",
    });

    // Later ticks keep holding it and say nothing more within 24 hours.
    clock.advance(10 * MIN);
    await clearPacer();
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ sent: 0, waiting: { reason: "inbox-check" } });
    expect(await inboxNotices()).toBe(1);
    expect(await explainCampaignWaiting(a.campaignId, clock.now(), { mailgun: world.mailgun })).toEqual({ reason: "inbox-check", until: null });
  });

  it("a check dated yesterday, or today but before the person's email, keeps it waiting; a check after it lets it go", async () => {
    const clock = worldClock(world);
    const a = await followUpDue(LIST[2]!, clock);
    // Yesterday (the cap day, Asia/Karachi, began at 19:00 UTC the day before).
    await checkAt(new Date("2026-09-22T18:00:00Z"));
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ sent: 0, waiting: { reason: "inbox-check" } });
    // Today, but before (or exactly at) the first email.
    await checkAt(new Date(a.first.getTime() - MIN));
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(0);
    await checkAt(a.first);
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(0);
    // After it.
    await checkAt(new Date(a.first.getTime() + MIN));
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect((await rowOf(a.campaignId, 1)).status).toBe("SENT");
  });

  it("test-mode follow-ups never wait (Mailgun's test mode delivers nothing)", async () => {
    const clock = worldClock(world);
    const a = await followUpDue(LIST[3]!, clock, "TEST");
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect((await rowOf(a.campaignId, 1)).status).toBe("SENT");
    expect(await inboxNotices()).toBe(0);
  });

  it("the loop's final check puts back a follow-up the pick let through when the check is withdrawn meanwhile", async () => {
    const clock = worldClock(world);
    const a = await followUpDue(LIST[4]!, clock);
    await checkAt(new Date(a.first.getTime() + MIN));
    const withdrawing = async (args: { recipientId: number; step: number; purpose: "send" }) => {
      await checkAt(null);
      return render(args);
    };
    const r = await loop.sendingTick(tickDeps(world, clock, { render: withdrawing }));
    expect(r).toMatchObject({ sent: 0, held: 1 });
    expect(world.mg.fake.messages.filter((m) => m.fields.to?.[0] === LIST[4])).toHaveLength(1);
    expect(await rowOf(a.campaignId, 1)).toMatchObject({ status: "QUEUED", attempts: 0 });
  });

  it("a paused campaign resumed with an overdue follow-up waits for today's check too", async () => {
    const clock = worldClock(world);
    const a = await followUpDue(LIST[5]!, clock);
    await pauseCampaign(a.campaignId, world.owner.id, { now: clock.now() });
    clock.advance(60 * MIN);
    await resumeCampaign(a.campaignId, world.owner.id, { now: clock.now() });
    await clearPacer();
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ sent: 0, waiting: { reason: "inbox-check" } });
    await checkAt(clock.now());
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
  });

  it("Retry of a failed live follow-up says it waits for today's inbox check", async () => {
    const clock = worldClock(world);
    const a = await followUpDue(LIST[6]!, clock);
    const next = await rowOf(a.campaignId, 1);
    await dbWrite(async (c) => {
      await c.outboundEmail.update({ where: { id: next.id }, data: { status: "FAILED", lastError: "Mailgun refused this email." } });
      await c.campaignRecipient.update({ where: { id: next.recipientId }, data: { state: "STOPPED", stopReason: "failed" } });
    });
    const res = await retryEmail(next.id, world.owner.id, { now: clock.now() });
    expect(res.message).toBe(retryInboxCheckText(`The follow-up 1 to ${LIST[6]}`));
    expect(res.message).toBe(`The follow-up 1 to ${LIST[6]} will be tried again once today's inbox check is done (Notifications › Inbox check).`);
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ sent: 0, waiting: { reason: "inbox-check" } });
  });
});

describe("what never waits for it", () => {
  it("first emails, dry runs and app mode", async () => {
    const clock = worldClock(world);
    const a = await followUpDue(LIST[7]!, clock);
    const next = await rowOf(a.campaignId, 1);
    const cand = { id: next.id, campaignId: a.campaignId, recipientId: next.recipientId, companyId: next.companyId, toNorm: next.toNorm, mode: next.mode, step: 1 };
    expect([...(await inboxCheckHeldIds([cand], clock.now()))]).toEqual([next.id]);
    expect([...((await pendingProblemIds([cand], clock.now())).inboxCheck ?? [])]).toEqual([next.id]);
    // The same row as a first email, or as a dry run: never held.
    expect((await inboxCheckHeldIds([{ ...cand, step: 0 }], clock.now())).size).toBe(0);
    expect((await inboxCheckHeldIds([{ ...cand, mode: "DRY_RUN" }], clock.now())).size).toBe(0);
    expect((await inboxCheckHeldIds([{ ...cand, mode: "TEST" }], clock.now())).size).toBe(0);
    // App mode: nothing is ever held for it.
    await setSettingValue("mailgun.replies", "app");
    expect((await inboxCheckHeldIds([cand], clock.now())).size).toBe(0);
    expect((await pendingProblemIds([cand], clock.now())).inboxCheck?.size ?? 0).toBe(0);
    await setSettingValue("mailgun.replies", "own-mailbox");
  });
});

describe("a check stamped in the future (review SECURITY-02)", () => {
  it("never counts, so the follow-up waits; a check a few seconds ahead still counts; the next click replaces it", async () => {
    const clock = worldClock(world);
    const a = await followUpDue(LIST[8]!, clock);
    const next = await rowOf(a.campaignId, 1);
    const cand = { id: next.id, campaignId: a.campaignId, recipientId: next.recipientId, companyId: next.companyId, toNorm: next.toNorm, mode: next.mode, step: 1 };

    // A click while the PC clock ran 30 days ahead (a reset BIOS clock, corrected later).
    await checkAt(new Date(clock.now().getTime() + 30 * DAY));
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ sent: 0, waiting: { reason: "inbox-check" } });
    expect([...(await inboxCheckHeldIds([cand], clock.now()))]).toEqual([next.id]);
    // Two minutes ahead is still a wrong clock; 30 seconds ahead is another reading of the same one.
    await checkAt(new Date(clock.now().getTime() + 2 * MIN));
    expect([...(await inboxCheckHeldIds([cand], clock.now()))]).toEqual([next.id]);
    await checkAt(new Date(clock.now().getTime() + 30_000));
    expect((await inboxCheckHeldIds([cand], clock.now())).size).toBe(0);

    // Back to the stamp 30 days ahead: clicking with the right clock replaces it, and the follow-up goes.
    await checkAt(new Date(clock.now().getTime() + 30 * DAY));
    expect(await markInboxChecked(world.owner, clock.now())).toMatchObject({ at: clock.now() });
    expect((await db.systemState.findUniqueOrThrow({ where: { key: "sending.inboxCheck" } })).value).toEqual({
      at: clock.now().toISOString(),
      byUserId: world.owner.id,
    });
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect((await rowOf(a.campaignId, 1)).status).toBe("SENT");
  });
});

describe("first emails at a company emailed before today (review SEND-1)", () => {
  it("wait for today's check; a company nobody emailed before today, or a colleague the same day, goes", async () => {
    const clock = worldClock(world);
    const now = clock.now();
    const { dayStart } = await getTodayCap(now);
    // Acme: Anna and Bob. Anna's first email goes; then it is dated yesterday (as if Bob's was pushed to a later day).
    await makeCompany({ name: "Acme Colleagues", people: [{ name: "Anna", email: LIST[9] }, { name: "Bob", email: LIST[10] }] });
    const acme = await launchOwn(world, [LIST[9]!, LIST[10]!], { now });
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    const acmeRows = await db.outboundEmail.findMany({ where: { campaignId: acme.campaignId, step: 0 }, orderBy: { id: "asc" } });
    const anna = acmeRows.find((r) => r.status === "SENT")!;
    const bob = acmeRows.find((r) => r.status === "QUEUED")!;
    await dbWrite((c) => c.outboundEmail.update({ where: { id: anna.id }, data: { sentAt: new Date(dayStart.getTime() - 60 * MIN) } }));

    // Carl and Dora (colleagues, both first emailed today) and Eve (a company nobody emailed): all go, Bob waits.
    await makeCompany({ name: "Same Day Studio", people: [{ name: "Carl", email: LIST[11] }, { name: "Dora", email: LIST[12] }] });
    const sameDay = await launchOwn(world, [LIST[11]!, LIST[12]!], { now });
    const eve = await launchOwn(world, [LIST[13]!], { now });
    for (let i = 0; i < 3; i++) {
      await clearPacer();
      expect(await loop.sendingTick(tickDeps(world, clock)), `tick ${i + 1}`).toMatchObject({ sent: 1, waiting: { reason: "inbox-check" } });
    }
    expect((await db.outboundEmail.findMany({ where: { campaignId: sameDay.campaignId, step: 0 } })).map((r) => r.status)).toEqual(["SENT", "SENT"]);
    expect((await rowOf(eve.campaignId)).status).toBe("SENT");
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: bob.id } })).status).toBe("QUEUED");
    await clearPacer();
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ sent: 0, waiting: { reason: "inbox-check" } });

    const bobCand = { id: bob.id, campaignId: acme.campaignId, recipientId: bob.recipientId, companyId: bob.companyId, toNorm: bob.toNorm, mode: bob.mode, step: 0 };
    expect([...(await inboxCheckHeldIds([bobCand], clock.now()))]).toEqual([bob.id]);
    expect(await explainCampaignWaiting(acme.campaignId, clock.now(), { mailgun: world.mailgun })).toEqual({ reason: "inbox-check", until: null });
    // A test-mode first email there, or app mode, never waits.
    expect((await inboxCheckHeldIds([{ ...bobCand, mode: "TEST" }], clock.now())).size).toBe(0);
    await setSettingValue("mailgun.replies", "app");
    expect((await inboxCheckHeldIds([bobCand], clock.now())).size).toBe(0);
    await setSettingValue("mailgun.replies", "own-mailbox");

    // Yesterday's check doesn't cover today; today's check (any time today) does: Bob's first email goes.
    await checkAt(new Date(dayStart.getTime() - 30 * MIN));
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(0);
    await checkAt(clock.now());
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: bob.id } })).status).toBe("SENT");
  });

  it("the same person in a later campaign waits too", async () => {
    const clock = worldClock(world);
    const now = clock.now();
    const { dayStart } = await getTodayCap(now);
    const first = await launchOwn(world, [LIST[14]!], { now });
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
    await dbWrite((c) => c.outboundEmail.updateMany({ where: { campaignId: first.campaignId, status: "SENT" }, data: { sentAt: new Date(dayStart.getTime() - DAY) } }));
    await dbWrite((c) => c.campaign.update({ where: { id: first.campaignId }, data: { status: "FINISHED" } }));
    const later = await launchOwn(world, [LIST[14]!], { now });
    const row = await rowOf(later.campaignId);
    expect(row.status).toBe("QUEUED");
    await clearPacer();
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ sent: 0, waiting: { reason: "inbox-check" } });
    await checkAt(clock.now());
    await clearPacer();
    expect((await loop.sendingTick(tickDeps(world, clock))).sent).toBe(1);
  });
});

describe("held live emails never crowd first emails out of the candidates (review SEND-3)", () => {
  it("with more held follow-ups than one candidate page, a first email still goes and the waiting line still names the check", async () => {
    const clock = worldClock(world);
    const now = clock.now();
    // One running live campaign with 501 follow-ups due an hour ago (written directly), none of them checked today.
    const { company, people } = await makeCompany({ name: "Crowd", people: [{ name: "Crowd", email: "crowd@crowd.de" }] });
    const crowd = await dbWrite(async (c) => {
      const campaign = await c.campaign.create({
        data: {
          name: "Crowd",
          createdById: world.owner.id,
          senderId: world.member.id,
          status: "RUNNING",
          mode: "LIVE",
          launchedAt: new Date(now.getTime() - 5 * DAY),
          launchedGoLive: false,
          fromName: "Ali from Polygon Paradise",
          fromAddress: OWN,
          replyTo: null,
        },
      });
      const recipient = await c.campaignRecipient.create({
        data: { campaignId: campaign.id, companyId: company.id, personId: people[0]!.id, emailNorm: "crowd@crowd.de", state: "WAITING", currentStep: 1 },
      });
      await c.outboundEmail.createMany({
        data: Array.from({ length: GATED_CANDIDATE_LIMIT + 1 }, (_, i) => ({
          campaignId: campaign.id,
          recipientId: recipient.id,
          personId: people[0]!.id,
          companyId: company.id,
          senderId: world.member.id,
          step: 1,
          mode: "LIVE" as const,
          toEmail: `crowd${i}@crowd.de`,
          toNorm: `crowd${i}@crowd.de`,
          companyName: "Crowd",
          fromAddress: ALI_LINE,
          subject: "s",
          text: "t",
          html: "h",
          messageId: `pp.crowd${i}@example.com`,
          sendId: `crowd-${i}`,
          dueAt: new Date(now.getTime() - 60 * MIN),
          status: "QUEUED" as const,
        })),
      });
      return campaign;
    });

    const first = await launchOwn(world, [LIST[15]!], { now });
    await clearPacer();
    expect(await loop.sendingTick(tickDeps(world, clock))).toMatchObject({ sent: 1, waiting: { reason: "inbox-check" } });
    expect((await rowOf(first.campaignId)).status).toBe("SENT");
    expect(await db.outboundEmail.count({ where: { campaignId: crowd.id, status: "QUEUED" } })).toBe(GATED_CANDIDATE_LIMIT + 1);
    expect(await inboxNotices()).toBe(1);

    // The candidates: every first email that may go, plus the first held follow-up (for the line and the notice).
    const another = await launchOwn(world, [LIST[16]!], { now });
    const picked = await pickCandidates(now, { window: DEFAULT_WINDOW, defaultZone: "Europe/Berlin", practiceCopy: false });
    const live = picked.gated.filter((c) => c.mode === "LIVE");
    expect(live.filter((c) => c.campaignId === crowd.id)).toHaveLength(1);
    expect(live.map((c) => c.campaignId)).toContain(another.campaignId);

    // Once today's check is done, the page is read as before: follow-ups first, a full page of them.
    await checkAt(clock.now());
    const checked = await pickCandidates(now, { window: DEFAULT_WINDOW, defaultZone: "Europe/Berlin", practiceCopy: false });
    expect(checked.gated.filter((c) => c.campaignId === crowd.id)).toHaveLength(GATED_CANDIDATE_LIMIT);
  });
});
