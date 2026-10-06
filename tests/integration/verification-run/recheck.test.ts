import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, setSettingValue } from "../campaigns/seed";
import { clearPacer, launchTo, resetSendingState, setupM3, tickDeps, worldClock, type M3World, type TestClock } from "../sending-m3/helpers";
import { quiet } from "./harness";

/**
 * The 24-hour re-check (M5-DESIGN §2.7, §2.11, SPEC §7 step 4, B6.4): people whose first check said "no answer" are
 * launched into RECHECK; the sweep enqueues a `recheck` run once their time has come; the second answer releases them
 * (their first email goes out on the next tick) or leaves them out, and the campaign's sender hears who was left out.
 * People checked meanwhile, with three "no answer"s in a row, or under "No answer: Skip" are settled without a call;
 * a wait 72 hours overdue (checks paused) is given up.
 */

const t = await createTestDb("verification-recheck");
let world: M3World;
const { db, dbWrite } = await import("@/server/db");
const loop = await import("@/server/services/sending/loop");
const { enqueueDueRechecks, VERIFY_RECHECK_TASK } = await import("../../../worker/jobs/verify-addresses");
const { pauseChecks } = await import("@/server/services/verification/pause");
const { enqueueJob } = await import("@/server/jobs");
const { getVerifier } = await import("@/server/verification");
const { CLEARED_CHECK_FIELDS } = await import("@/core/verification/types");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

beforeAll(async () => {
  // Live launches need a test list (the reply test's mailboxes); nobody here is on it.
  world = await setupM3({ testList: ["inbox@polygonparadise.test"] });
  await setSettingValue("sending.goLive", true);
});

beforeEach(async () => {
  world.mg.fake.reset();
  await resetSendingState();
  await dbWrite(async (c) => {
    await c.job.deleteMany({});
    await c.notification.deleteMany({});
    await c.systemState.deleteMany({ where: { key: { in: ["checks.pause", "notices"] } } });
  });
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.goLive", true);
  await setSettingValue("verification.policy", {
    deliverableHighRisk: "block",
    catchAllLow: "send",
    catchAllMedium: "block",
    catchAllHigh: "block",
    disposable: "block",
    unknown: "recheck",
  });
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

/** Runs every due job of the checks lane at the clock (the worker's `checks` runner). */
async function runChecks(clock: TestClock): Promise<number> {
  const { claimNextJob, runClaimedJob, WORKER_LANES } = await import("../../../worker/runner");
  const { createVerifyAddressesJob } = await import("../../../worker/jobs/verify-addresses");
  let elapsed = 0;
  const registry = {
    "verify.addresses": createVerifyAddressesJob({
      now: clock.now,
      clockMs: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
      logger: quiet,
      verifier: () => getVerifier({ timeoutMs: 2_000 }),
    }),
  };
  let ran = 0;
  for (;;) {
    const job = await claimNextJob("w-checks", clock.now(), WORKER_LANES.checks);
    if (!job) return ran;
    await runClaimedJob(job, { workerId: "w-checks", registry, signal: new AbortController().signal, logger: quiet, lane: WORKER_LANES.checks, now: clock.now });
    ran += 1;
  }
}

/** A person whose address got a first "no answer" at `at` (as a check would leave it). */
async function unknownPerson(email: string, at: Date, unknowns = 1) {
  const { people } = await makeCompany({ name: `Recheck ${email}`, people: [{ name: email.split("@")[0], email }] });
  await dbWrite((c) =>
    c.person.update({
      where: { id: people[0]!.id },
      data: { verificationStatus: "UNKNOWN", verificationRisk: "UNKNOWN", verifiedAt: at, verificationProvider: "mailgun-fake", verificationUnknowns: unknowns },
    }),
  );
  return people[0]!;
}

async function checkedPerson(email: string, at: Date) {
  const { people } = await makeCompany({ name: `Checked ${email}`, people: [{ name: email.split("@")[0], email }] });
  await dbWrite((c) =>
    c.person.update({
      where: { id: people[0]!.id },
      data: { verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: at, verificationProvider: "mailgun-fake" },
    }),
  );
  return people[0]!;
}

const recipient = (campaignId: number, personId: number) =>
  db.campaignRecipient.findFirstOrThrow({ where: { campaignId, personId } });

describe("the sweep and the recheck run", () => {
  it("greylist passes and is sent on the next tick; timeout is left out and the sender hears", async () => {
    const clock = worldClock(world);
    const t0 = clock.now();
    // The first checks (a Contacts run): anna fine, g and t "no answer".
    const anna = await checkedPerson("anna@recheck-valid.test", t0);
    const g = (await makeCompany({ name: "Greylist Co", people: [{ name: "Greta", email: "g@greylist.test" }] })).people[0]!;
    const tt = (await makeCompany({ name: "Timeout Co", people: [{ name: "Tom", email: "t@timeout.test" }] })).people[0]!;
    await enqueueJob({
      type: "verify.addresses",
      payload: { source: "contacts", personIds: [g.id, tt.id], confirmedCount: 2, recheckRecent: false },
      runAt: t0,
      priority: 10,
      createdById: world.owner.id,
    });
    expect(await runChecks(clock)).toBe(1);
    expect(await db.person.findUniqueOrThrow({ where: { id: g.id } })).toMatchObject({ verificationStatus: "UNKNOWN", verificationUnknowns: 1 });

    const { campaignId } = await launchTo(world, ["anna@recheck-valid.test", "g@greylist.test", "t@timeout.test"], { now: t0, name: "Recheck Q4" });
    const rg = await recipient(campaignId, g.id);
    expect(rg).toMatchObject({ state: "RECHECK", recheckAt: new Date(t0.getTime() + DAY), included: true });
    expect(await db.outboundEmail.findFirstOrThrow({ where: { recipientId: rg.id } })).toMatchObject({ step: 0, status: "QUEUED" });
    expect(await db.companyReservation.count({ where: { campaignId, releasedAt: null } })).toBe(3);

    // Only anna's email goes; nothing is due for the sweep yet.
    for (let i = 0; i < 3; i++) {
      await clearPacer();
      await loop.sendingTick(tickDeps(world, clock));
    }
    expect(world.mg.fake.messages.map((m) => m.fields.to?.[0])).toEqual([anna.email]);
    expect(await enqueueDueRechecks(clock.now())).toBe(false);

    // 24 hours and a minute later: the recheck run.
    clock.set(new Date(t0.getTime() + DAY + 60_000));
    expect(await enqueueDueRechecks(clock.now())).toBe(true);
    const job = await db.job.findFirstOrThrow({ where: { type: "verify.addresses", activeDedupeKey: "verify:recheck" } });
    expect(job).toMatchObject({ priority: 30, maxAttempts: 3, createdById: null });
    expect(await enqueueDueRechecks(clock.now())).toBe(true);
    expect(await db.job.count({ where: { activeDedupeKey: "verify:recheck" } })).toBe(1);
    expect(await runChecks(clock)).toBe(1);

    expect(await recipient(campaignId, g.id)).toMatchObject({ state: "SCHEDULED", recheckAt: new Date(t0.getTime() + DAY) });
    expect(await recipient(campaignId, tt.id)).toMatchObject({
      state: "EXCLUDED",
      included: false,
      exclusionReason: "Address couldn't be checked",
    });
    const counts = world.mg.fake.state().validations.byAddress;
    expect(counts["g@greylist.test"]).toBe(2);
    expect(counts["t@timeout.test"]).toBe(2);
    expect(await db.notification.findFirstOrThrow({ where: { type: "verify.finished", userId: world.member.id } })).toMatchObject({
      title: "Left out after a second address check",
      body: "1 person in Recheck Q4 was left out: their address couldn't be checked. 1 other passed and gets their first email.",
      link: `/campaigns/${campaignId}`,
    });
    expect((await db.activityLog.findFirstOrThrow({ where: { type: "verify.run" }, orderBy: { id: "desc" } })).summary).toBe(
      "The app checked 2 addresses: 1 can be emailed, 1 got no answer.",
    );

    // g's first email goes out on the next tick; t's never.
    await clearPacer();
    await loop.sendingTick(tickDeps(world, clock));
    expect(world.mg.fake.messages.map((m) => m.fields.to?.[0])).toEqual([anna.email, "g@greylist.test"]);
    expect(await enqueueDueRechecks(clock.now())).toBe(false);
    expect(VERIFY_RECHECK_TASK).toBe("verify.recheck");
  });

  it("settles without a call: checked meanwhile, three 'no answer's in a row, or 'No answer' set to Skip", async () => {
    const clock = worldClock(world);
    const t0 = clock.now();
    const meanwhile = await unknownPerson("meanwhile@recheck-a.test", t0);
    const thrice = await unknownPerson("thrice@recheck-b.test", t0);
    const { campaignId } = await launchTo(world, ["meanwhile@recheck-a.test", "thrice@recheck-b.test"], { now: t0, name: "Settle run" });
    expect((await recipient(campaignId, meanwhile.id)).state).toBe("RECHECK");
    // A check after the re-check time (not settled yet), and a third "no answer" in a row.
    await dbWrite(async (c) => {
      await c.person.update({
        where: { id: meanwhile.id },
        data: { verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: new Date(t0.getTime() + DAY + 30_000), verificationUnknowns: 0 },
      });
      await c.person.update({ where: { id: thrice.id }, data: { verificationUnknowns: 3 } });
    });
    clock.set(new Date(t0.getTime() + DAY + 60_000));
    expect(await enqueueDueRechecks(clock.now())).toBe(true);
    await runChecks(clock);
    expect(world.mg.fake.validations).toHaveLength(0);
    expect((await recipient(campaignId, meanwhile.id)).state).toBe("SCHEDULED");
    expect(await recipient(campaignId, thrice.id)).toMatchObject({ state: "EXCLUDED", exclusionReason: "Address couldn't be checked" });
  });

  it("'No answer' switched to Skip leaves them out with the policy sentence, without paying for a re-check", async () => {
    const clock = worldClock(world);
    const t0 = clock.now();
    const p = await unknownPerson("skipme@recheck-c.test", t0);
    const { campaignId } = await launchTo(world, ["skipme@recheck-c.test"], { now: t0, name: "Skip run" });
    expect((await recipient(campaignId, p.id)).state).toBe("RECHECK");
    await setSettingValue("verification.policy", {
      deliverableHighRisk: "block",
      catchAllLow: "send",
      catchAllMedium: "block",
      catchAllHigh: "block",
      disposable: "block",
      unknown: "block",
    });
    clock.set(new Date(t0.getTime() + DAY + 60_000));
    expect(await enqueueDueRechecks(clock.now())).toBe(true);
    await runChecks(clock);
    expect(world.mg.fake.validations).toHaveLength(0);
    expect(await recipient(campaignId, p.id)).toMatchObject({
      state: "EXCLUDED",
      exclusionReason: "The address check got no answer; your check settings skip these",
    });
  });

  it("an address Mailgun refuses on the second check is left out instead of being called every 15 minutes", async () => {
    const clock = worldClock(world);
    const t0 = clock.now();
    const p = await unknownPerson("refused@recheck-d.test", t0);
    const { campaignId } = await launchTo(world, ["refused@recheck-d.test"], { now: t0, name: "Refused run" });
    world.mg.fake.setValidation("refused@recheck-d.test", { status: 400, body: { message: "Invalid address" } });
    clock.set(new Date(t0.getTime() + DAY + 60_000));
    expect(await enqueueDueRechecks(clock.now())).toBe(true);
    await runChecks(clock);
    expect(await recipient(campaignId, p.id)).toMatchObject({ state: "EXCLUDED", exclusionReason: "Address couldn't be checked" });
    expect(await enqueueDueRechecks(clock.now())).toBe(false);
    expect(world.mg.fake.validations).toHaveLength(1);
  });

  it("a re-check whose paid answer can't be read is left out after one call, never bought again every 15 minutes", async () => {
    const clock = worldClock(world);
    const t0 = clock.now();
    // The fake answers `weird…` with result "maybe": a 200 we can't read, billed.
    const p = await unknownPerson("weird1@recheck-w.test", t0);
    const { campaignId } = await launchTo(world, ["weird1@recheck-w.test"], { now: t0, name: "Unreadable run" });
    expect((await recipient(campaignId, p.id)).state).toBe("RECHECK");
    clock.set(new Date(t0.getTime() + DAY + 60_000));
    expect(await enqueueDueRechecks(clock.now())).toBe(true);
    await runChecks(clock);
    expect(await recipient(campaignId, p.id)).toMatchObject({ state: "EXCLUDED", exclusionReason: "Address couldn't be checked" });
    // Six sweeps 15 minutes apart: nothing is due any more, nothing is paid again.
    for (let i = 0; i < 6; i++) {
      clock.advance(15 * 60_000);
      expect(await enqueueDueRechecks(clock.now())).toBe(false);
      await runChecks(clock);
    }
    expect(world.mg.fake.state().validations.byAddress["weird1@recheck-w.test"]).toBe(1);
    expect(await db.verificationCheck.findMany({ where: { emailNorm: "weird1@recheck-w.test" } })).toMatchObject([
      { costUsd: 0.012, reasons: ["app:unreadable_response"], source: "recheck" },
    ]);
    // The person keeps their first "no answer" (an unreadable answer isn't a verdict), and the sender hears.
    expect(await db.person.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ verificationStatus: "UNKNOWN", verificationUnknowns: 1 });
    expect(await db.notification.findFirstOrThrow({ where: { type: "verify.finished", userId: world.member.id } })).toMatchObject({
      title: "Left out after a second address check",
      body: "1 person in Unreadable run was left out: their address couldn't be checked.",
    });
  });

  it("an unreadable answer bought since the re-check fell due (any run) was the re-check: left out without a call", async () => {
    const clock = worldClock(world);
    const t0 = clock.now();
    const p = await unknownPerson("lost@recheck-x.test", t0);
    const { campaignId } = await launchTo(world, ["lost@recheck-x.test"], { now: t0, name: "Lost leave-out" });
    // As if the run that bought it had died before leaving the recipient out.
    await dbWrite((c) =>
      c.verificationCheck.create({
        data: {
          personId: p.id,
          emailNorm: "lost@recheck-x.test",
          provider: "mailgun-fake",
          status: "UNKNOWN",
          risk: "UNKNOWN",
          reasons: ["app:unreadable_response"],
          costUsd: 0.012,
          source: "recheck",
          checkedAt: new Date(t0.getTime() + DAY + 30_000),
        },
      }),
    );
    clock.set(new Date(t0.getTime() + DAY + 60_000));
    expect(await enqueueDueRechecks(clock.now())).toBe(true);
    await runChecks(clock);
    expect(world.mg.fake.validations).toHaveLength(0);
    expect(await recipient(campaignId, p.id)).toMatchObject({ state: "EXCLUDED", exclusionReason: "Address couldn't be checked" });
    expect(await enqueueDueRechecks(clock.now())).toBe(false);
  });

  it("settles without a call when the address was edited, or a verdict came before the re-check time", async () => {
    const clock = worldClock(world);
    const t0 = clock.now();
    const moved = await unknownPerson("moved@recheck-m.test", t0);
    const raced = await unknownPerson("raced@recheck-n.test", t0);
    const { campaignId } = await launchTo(world, ["moved@recheck-m.test", "raced@recheck-n.test"], { now: t0, name: "Edited run" });
    expect((await recipient(campaignId, moved.id)).state).toBe("RECHECK");
    await dbWrite(async (c) => {
      // The address is edited (the six check fields cleared with it, as updatePerson does)…
      await c.person.update({
        where: { id: moved.id },
        data: { email: "moved2@recheck-m.test", emailNorm: "moved2@recheck-m.test", ...CLEARED_CHECK_FIELDS },
      });
      // …and the other got a verdict before its re-check time (the sending loop and a check crossing).
      await c.person.update({
        where: { id: raced.id },
        data: { verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: new Date(t0.getTime() + HOUR), verificationUnknowns: 0 },
      });
    });
    clock.set(new Date(t0.getTime() + DAY + 60_000));
    expect(await enqueueDueRechecks(clock.now())).toBe(true);
    await runChecks(clock);
    expect(world.mg.fake.validations).toHaveLength(0);
    expect(await recipient(campaignId, moved.id)).toMatchObject({
      state: "EXCLUDED",
      exclusionReason: "The email address changed after this email was prepared",
    });
    expect((await recipient(campaignId, raced.id)).state).toBe("SCHEDULED");
  });

  it("a wait 72 hours overdue (checks paused all along) is given up without a call", async () => {
    const clock = worldClock(world);
    const t0 = clock.now();
    const p = await unknownPerson("stale@recheck-e.test", t0);
    const fresh = await unknownPerson("stillfine@recheck-f.test", new Date(t0.getTime() + 2 * DAY));
    const { campaignId } = await launchTo(world, ["stale@recheck-e.test"], { now: t0, name: "Stale run" });
    const later = await launchTo(world, ["stillfine@recheck-f.test"], { now: new Date(t0.getTime() + 2 * DAY), name: "Later run" });
    await pauseChecks("auth", "Address checks paused: test.", null, { now: t0 });
    clock.set(new Date(t0.getTime() + DAY + 72 * HOUR + 60_000));
    // The stale one is left out; the later one is due (and waits for the paused checks).
    expect(await enqueueDueRechecks(clock.now())).toBe(true);
    expect(await recipient(campaignId, p.id)).toMatchObject({ state: "EXCLUDED", exclusionReason: "Address couldn't be checked" });
    expect((await recipient(later.campaignId, fresh.id)).state).toBe("RECHECK");
    await runChecks(clock);
    expect(world.mg.fake.validations).toHaveLength(0);
    expect((await recipient(later.campaignId, fresh.id)).state).toBe("RECHECK");
    // The campaign with nobody left finishes.
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("FINISHED");
  });
});
