import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { setSettingValue } from "../campaigns/seed";
import { billed, resultOf, setupCheckWorld, VALIDATE, type CheckWorld } from "./harness";

/**
 * The check job's pauses (M5-DESIGN §2.5 steps 1, 5, 6; §2.12): Mailgun refusing the key or the account pauses every
 * check run (one Owner notice a day) after the calls in flight were stored; the monthly check limit stops a run before
 * the call that would pass it (calls in flight reserved) until the next office month; a missing key fails a run (or,
 * for the re-check sweep, pauses).
 */

const t = await createTestDb("verification-run-pauses");
let world: CheckWorld;
const { db } = await import("@/server/db");
const { resumeChecks, getChecksPause } = await import("@/server/services/verification/pause");
const { startCheckRun, CheckRunError } = await import("@/server/services/verification/start");
const { setSecret, deleteSecret } = await import("@/server/secrets");
const { checkPauseText } = await import("@/core/verification/words");

beforeAll(async () => {
  world = await setupCheckWorld();
});

beforeEach(async () => {
  await world.reset();
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

const contacts = (personIds: number[]) => ({ source: "contacts", personIds, confirmedCount: personIds.length, recheckRecent: false });
const owner = () => ({ id: world.owner.id, name: world.owner.name });

describe("Mailgun refuses the key or the account", () => {
  it("401: stores the answers in flight, pauses every run once a day for the Owner, waits; Resume lets it go on", async () => {
    const people = [];
    for (const a of ["key1@valid.test", "key2@valid.test", "key3@valid.test"]) people.push(await world.person(a));
    const job = await world.enqueue(contacts(people.map((p) => p.personId)));
    world.mg.fake.failNext(VALIDATE, { kind: "status", status: 401, body: { message: "Invalid private key" } });

    expect(await world.run()).toMatchObject({ outcome: "deferred", deferReason: "paused" });
    const text = checkPauseText("auth");
    expect(await getChecksPause(world.clock.now())).toMatchObject({ paused: true, kind: "auth", text });
    const waiting = await world.job(job.id);
    expect(waiting.runAt).toEqual(new Date(world.clock.now().getTime() + 3_600_000));
    expect(resultOf(waiting).summary).toBe(text);
    // The call already in flight was answered and stored before the run stopped; the third never started.
    expect(await db.verificationCheck.count({ where: { jobId: job.id } })).toBe(1);
    expect(world.mg.fake.validations).toHaveLength(2);
    expect(await db.notification.findMany({ where: { type: "verify.paused" } })).toMatchObject([
      { userId: world.owner.id, title: "Address checks paused", body: text, link: "/settings/deliverability#checks" },
    ]);

    // While paused, a run waits without calling.
    world.clock.advance(3_600_000);
    expect(await world.run()).toMatchObject({ outcome: "deferred", deferReason: "paused" });
    expect(world.mg.fake.validations).toHaveLength(2);

    // Resumed, it fails again: paused again, but the Owner isn't told twice within 24 hours.
    await resumeChecks(owner(), { now: world.clock.now() });
    world.mg.fake.failNext(VALIDATE, { kind: "status", status: 401, body: { message: "Invalid private key" } });
    expect(await world.run()).toMatchObject({ outcome: "deferred", deferReason: "paused" });
    expect(await db.notification.count({ where: { type: "verify.paused" } })).toBe(1);

    await resumeChecks(owner(), { now: world.clock.now() });
    expect((await world.run())?.outcome).toBe("done");
    for (const p of people) expect(billed(world)[p.emailNorm]).toBe(1);
    expect(resultOf(await world.job(job.id)).counts).toMatchObject({ checked: 3, canEmail: 3 });
  });

  it.each([
    ["payment", { kind: "status", status: 402, body: { message: "Payment required" } }],
    ["auth", { kind: "status", status: 403, body: { Error: "Forbidden" } }],
    ["not-allowed", { kind: "status", status: 403, body: { message: "Account suspended" } }],
    ["business-verification", { kind: "businessVerification" }],
  ] as const)("pauses with the %s sentence", async (kind, fault) => {
    const p = await world.person(`pause-${kind}@valid.test`);
    await world.enqueue(contacts([p.personId]));
    world.mg.fake.failNext(VALIDATE, fault as never);
    expect(await world.run()).toMatchObject({ outcome: "deferred", deferReason: "paused" });
    const pause = await getChecksPause(world.clock.now());
    expect(pause).toMatchObject({ paused: true, kind, text: checkPauseText(kind) });
    expect((await db.person.findUniqueOrThrow({ where: { id: p.personId } })).verificationStatus).toBeNull();
  });
});

describe("the monthly check limit", () => {
  it("stops before the call that would pass it (calls in flight reserved), until the next office month", async () => {
    await setSettingValue("verification.monthlyLimitUsd", 0.05);
    const people = [];
    for (let i = 1; i <= 12; i++) people.push(await world.person(`mo${i}@valid.test`));
    const job = await world.enqueue(contacts(people.map((p) => p.personId)));

    expect(await world.run()).toMatchObject({ outcome: "deferred", deferReason: "paused" });
    // $0.012 × 4 = $0.048; a fifth would pass $0.05.
    expect(world.mg.fake.state().validations.billableThisMonth).toBe(4);
    const until = new Date("2026-09-30T19:00:00.000Z"); // 1 Oct 00:00 in Karachi
    const text = "Address checks stopped: this month's check limit of $0.05 is reached. Raise it in Settings › Deliverability or wait until 1 October.";
    expect(await getChecksPause(world.clock.now())).toMatchObject({ paused: true, kind: "monthly_limit", text, until: until.toISOString() });
    expect((await world.job(job.id)).runAt).toEqual(until);
    expect(await db.notification.findFirstOrThrow({ where: { type: "verify.paused" } })).toMatchObject({ title: "Address checks stopped", body: text });

    // A Contacts start that would pass the limit is refused (Owner wording), once the pause is gone too.
    await resumeChecks(owner(), { now: world.clock.now() });
    const extra = await world.person("mo-extra@valid.test");
    await expect(
      startCheckRun({ ...owner(), role: "OWNER" }, { source: "contacts", companyIds: [extra.companyId], recheckRecent: false, confirmedCount: 1 }, { now: world.clock.now() }),
    ).rejects.toMatchObject({ code: "monthly-limit" });
    await expect(
      startCheckRun({ ...owner(), role: "OWNER" }, { source: "contacts", companyIds: [extra.companyId], recheckRecent: false, confirmedCount: 1 }, { now: world.clock.now() }),
    ).rejects.toBeInstanceOf(CheckRunError);

    // The run itself stops again at once (still over the limit this month)…
    await db.job.update({ where: { id: job.id }, data: { runAt: world.clock.now() } });
    expect(await world.run()).toMatchObject({ outcome: "deferred", deferReason: "paused" });
    expect(world.mg.fake.state().validations.billableThisMonth).toBe(4);
    // …and goes on in October: the pause lifts by itself, and October has its own $0.05.
    world.clock.set(until);
    expect((await getChecksPause(world.clock.now())).paused).toBe(false);
    expect(await world.run()).toMatchObject({ outcome: "deferred", deferReason: "paused" });
    // (The fake counts months in UTC; the office month is Karachi's, so count the stored rows.)
    expect(await db.verificationCheck.count({ where: { jobId: job.id, checkedAt: { gte: until } } })).toBe(4);
    expect((await getChecksPause(world.clock.now())).until).toBe("2026-10-31T19:00:00.000Z");
    // The Owner raises the limit and resumes: the rest are checked.
    await setSettingValue("verification.monthlyLimitUsd", 100);
    await resumeChecks(owner(), { now: world.clock.now() });
    expect((await world.run())?.outcome).toBe("done");
    expect(Object.values(billed(world)).reduce((a, b) => a + b, 0)).toBe(12);
    expect(resultOf(await world.job(job.id)).counts).toMatchObject({ checked: 12, costUsd: 0.144 });
  });

  it("checks inside the plan's included checks cost nothing and never reach the limit", async () => {
    await setSettingValue("verification.monthlyLimitUsd", 0.01);
    await setSettingValue("verification.includedPerMonth", 3);
    const people = [];
    for (let i = 1; i <= 3; i++) people.push(await world.person(`inc${i}@valid.test`));
    const job = await world.enqueue(contacts(people.map((p) => p.personId)));
    expect((await world.run())?.outcome).toBe("done");
    const rows = await db.verificationCheck.findMany({ where: { jobId: job.id } });
    expect(rows.map((r) => r.costUsd)).toEqual([0, 0, 0]);
    expect(resultOf(await world.job(job.id)).summary).toBe("3 addresses checked: 3 can be emailed. Cost $0.");
  });
});

describe("no usable key", () => {
  it("a started run fails with the sentence (nothing was charged); the re-check sweep's run pauses instead", async () => {
    await deleteSecret("mailgun.apiKey");
    try {
      const p = await world.person("nokey1@valid.test");
      const job = await world.enqueue(contacts([p.personId]));
      expect(await world.run()).toMatchObject({
        outcome: "retry",
        error: "Address checks need a Mailgun key. The Owner can connect Mailgun in Settings › Sending & Mailgun.",
      });
      expect((await world.job(job.id)).status).toBe("QUEUED");
      await db.job.update({ where: { id: job.id }, data: { status: "CANCELLED", activeDedupeKey: null } });

      const sweep = await world.enqueue({ source: "recheck" }, { createdById: null, priority: 30, dedupeKey: "verify:recheck" });
      expect(await world.run()).toMatchObject({ outcome: "deferred", deferReason: "paused" });
      expect(await getChecksPause(world.clock.now())).toMatchObject({ paused: true, kind: "auth" });
      expect((await world.job(sweep.id)).status).toBe("QUEUED");
      expect(world.mg.fake.validations).toHaveLength(0);
    } finally {
      await setSecret("mailgun.apiKey", world.mg.apiKey, null);
    }
  });
});
