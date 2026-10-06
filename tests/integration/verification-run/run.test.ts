import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeDraft, setSettingValue } from "../campaigns/seed";
import { billed, DAY, HOUR, requestsFor, resultOf, setupCheckWorld, VALIDATE, type CheckWorld } from "./harness";

/**
 * The check job `verify.addresses` against the fake Mailgun (M5-DESIGN §2.5, §2.5.1, SPEC §7 step 4, B6.4, B6.9): a
 * wizard run of the §9.3 Part B addresses, 429s, 5xx with an in-pass retry and 10-minute retries, time-outs that may
 * have been billed, unreadable answers, a commit that fails after a paid answer, the skip rules, and the panel's and
 * Settings' one-address runs.
 */

const t = await createTestDb("verification-run");
let world: CheckWorld;
const { db, dbWrite } = await import("@/server/db");
const { startCheckRun } = await import("@/server/services/verification/start");
const { commitCheckResult } = await import("@/server/services/verification/commit");
const { checkRunView } = await import("@/server/services/verification/runs");
const { createMailgunVerifier } = await import("@/server/verification/mailgun-verifier");

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

const contacts = (personIds: number[], recheckRecent = false) => ({
  source: "contacts",
  personIds,
  confirmedCount: personIds.length,
  recheckRecent,
});

describe("a wizard run of the §9.3 Part B addresses", () => {
  it("checks each address once, 2 at a time, stores every verdict, and says what it found", async () => {
    const addresses = [
      "anna@valid.test",
      "medium1@valid.test",
      "risky1@valid.test",
      "ok@catchall-low.test",
      "ok@catchall-medium.test",
      "temp1@valid.test",
      "bad1@valid.test",
      "x@disposable.test",
      "g@greylist.test",
      "t@timeout.test",
      "info@role.test",
      "flaky2@valid.test",
    ];
    const people = [];
    for (const a of addresses) people.push(await world.person(a));
    const fresh = await world.person("f@fresh.test", { status: "VALID", verifiedAt: new Date(world.clock.now().getTime() - 10 * DAY) });
    const draft = await makeDraft({
      name: "Germany Q4",
      createdById: world.owner.id,
      senderId: world.member.id,
      recipients: [...people, fresh].map((p) => ({ companyId: p.companyId, personId: p.personId })),
    });
    world.mg.fake.setValidation("flaky2@valid.test", { status: 500, times: 2 });

    const { jobId, count } = await startCheckRun(
      { id: world.owner.id, name: world.owner.name, role: "OWNER" },
      { source: "wizard", campaignId: draft.id, confirmedCount: 12 },
      { now: world.clock.now() },
    );
    expect(count).toBe(12);

    // First pass: flaky2 answers 500, is tried again once 2 s later (500 again), then waits for the next pass.
    const first = await world.run();
    expect(first).toMatchObject({ outcome: "deferred", deferReason: "retry-later" });
    expect(world.sleeps).toContain(2_000);
    const waiting = await world.job(jobId);
    expect(waiting.status).toBe("QUEUED");
    expect(waiting.runAt).toEqual(new Date(world.clock.now().getTime() + 10 * 60_000));
    expect(resultOf(waiting).summary).toBe("Waiting: some checks will be tried again at 13:10.");
    expect(requestsFor(world, "flaky2@valid.test")).toBe(2);

    // Nothing is due before the 10 minutes are over.
    expect(await world.run()).toBeNull();
    world.clock.advance(10 * 60_000);
    const second = await world.run();
    expect(second).toMatchObject({ outcome: "done" });

    const done = await world.job(jobId);
    const result = resultOf(done);
    expect(result.counts).toEqual({
      checked: 12,
      canEmail: 5,
      lowRiskCatchAll: 1,
      invalid: 1,
      doNotSend: 1,
      risky: 1,
      catchAllBlocked: 1,
      disposable: 1,
      unknown: 2,
      refused: 0,
      notReached: 0,
      mayBeCharged: 0,
      skipped: { fresh: 0, suppressed: 0, noEmail: 0, neverEmailed: 0 },
      costUsd: 0.144,
    });
    expect(result.summary).toBe(
      "12 addresses checked: 5 can be emailed, 1 doesn't exist, 1 shouldn't be emailed, 1 is rated high risk, 1 can't be confirmed, 1 is a throwaway address, 2 got no answer. Cost $0.14.",
    );
    expect(done.progressDone).toBe(12);
    expect(done.progressTotal).toBe(12);

    // Each address billed once (the 500s weren't), 2 in flight at most, never the v3 endpoints, never the fresh one.
    const counts = billed(world);
    for (const a of addresses) expect(counts[a]).toBe(1);
    expect(counts["f@fresh.test"]).toBeUndefined();
    expect(world.mg.fake.state().validations.peakInFlight).toBeLessThanOrEqual(2);
    expect(world.mg.fake.requests.some((r) => r.path.startsWith("/v3/address"))).toBe(false);

    // Verdicts stored on the people; undeliverable and do-not-send on the do-not-email list (never pushed).
    const byEmail = new Map(
      (await db.person.findMany({ where: { id: { in: people.map((p) => p.personId) } } })).map((p) => [p.emailNorm, p]),
    );
    expect(byEmail.get("medium1@valid.test")).toMatchObject({ verificationStatus: "VALID", verificationRisk: "MEDIUM", verificationProvider: "mailgun-fake" });
    expect(byEmail.get("temp1@valid.test")).toMatchObject({ verificationStatus: "VALID", verificationDisposable: true });
    expect(byEmail.get("g@greylist.test")).toMatchObject({ verificationStatus: "UNKNOWN", verificationUnknowns: 1 });
    const sups = await db.suppression.findMany({ where: { emailNorm: { in: ["bad1@valid.test", "x@disposable.test"] } } });
    expect(sups.map((s) => [s.emailNorm, s.reason, s.source, s.pushedToMailgunAt !== null]).sort()).toEqual([
      ["bad1@valid.test", "INVALID", "verification", true],
      ["x@disposable.test", "INVALID", "verification", true],
    ]);
    const rows = await db.verificationCheck.findMany({ where: { jobId } });
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => r.source === "wizard" && r.costUsd === 0.012 && r.provider === "mailgun-fake")).toBe(true);

    // The requester hears, and the Activity page has one entry.
    const note = await db.notification.findFirstOrThrow({ where: { type: "verify.finished" } });
    expect(note).toMatchObject({
      userId: world.owner.id,
      title: "Address checks finished for Germany Q4",
      body: result.summary,
      link: `/campaigns/${draft.id}/setup/verify`,
    });
    const activity = await db.activityLog.findFirstOrThrow({ where: { type: "verify.run" } });
    expect(activity).toMatchObject({
      actorId: world.owner.id,
      campaignId: draft.id,
      summary: "Arslan checked 12 addresses for Germany Q4: 5 can be emailed, 1 doesn't exist, 1 shouldn't be emailed.",
    });
    // The screen reads the same counts and who is left out.
    const view = await checkRunView(jobId, world.clock.now());
    expect(view.counts?.checked).toBe(12);
    expect(view.leftOut.map((l) => l.email).sort()).toEqual([
      "bad1@valid.test",
      "ok@catchall-medium.test",
      "risky1@valid.test",
      "temp1@valid.test",
      "x@disposable.test",
    ]);
  });
});

describe("a Verify-step run and the launch", () => {
  async function wizardRun(emails: string[]) {
    const people = [];
    for (const e of emails) people.push(await world.person(e));
    const draft = await makeDraft({
      name: `Launch race ${emails[0]}`,
      createdById: world.owner.id,
      recipients: people.map((p) => ({ companyId: p.companyId, personId: p.personId })),
    });
    const job = await world.enqueue(
      { source: "wizard", campaignId: draft.id, personIds: people.map((p) => p.personId), confirmedCount: people.length },
      { priority: 20, dedupeKey: `verify:campaign:${draft.id}` },
    );
    return { draft, job, people };
  }

  it("stops without paying once the campaign isn't a draft any more (launched while the run was queued)", async () => {
    const { draft, job } = await wizardRun(["gone1@valid.test", "gone2@valid.test"]);
    await dbWrite((c) => c.campaign.update({ where: { id: draft.id }, data: { status: "RUNNING" } }));
    expect((await world.run())?.outcome).toBe("done");
    expect(world.mg.fake.validations).toHaveLength(0);
    const result = resultOf(await world.job(job.id));
    expect(result).toMatchObject({ stopped: true, summary: "Stopped after 0 of 2 addresses." });
    expect(await db.notification.count({ where: { type: "verify.finished" } })).toBe(0);
  });

  it("skips, without paying, a person the launch has already handled; the others are checked", async () => {
    const { draft, job, people } = await wizardRun(["mid1@valid.test", "mid2@valid.test"]);
    // A launch writing its chunks: the first person is already left out "Address not checked".
    await dbWrite((c) =>
      c.campaignRecipient.updateMany({
        where: { campaignId: draft.id, personId: people[0]!.personId },
        data: { included: false, state: "EXCLUDED", exclusionReason: "Address not checked" },
      }),
    );
    expect((await world.run())?.outcome).toBe("done");
    expect(world.mg.fake.validations.map((v) => v.address)).toEqual(["mid2@valid.test"]);
    expect(resultOf(await world.job(job.id)).counts).toMatchObject({ checked: 1, canEmail: 1 });
  });
});

describe("rate limits (429)", () => {
  it("drops to one at a time, waits (2 s × 2^n), and still bills each address once", async () => {
    world.mg.fake.setSwitches({ validateNoRateHeaders: true });
    const people = [];
    for (const a of ["rl1@valid.test", "rl2@valid.test", "rl3@valid.test", "rl4@valid.test"]) people.push(await world.person(a));
    await world.enqueue(contacts(people.map((p) => p.personId)));
    world.mg.fake.failNext(VALIDATE, { kind: "status", status: 429, body: { message: "Too many requests" } }, 3);
    const res = await world.run();
    expect(res?.outcome).toBe("done");
    expect(world.sleeps.some((ms) => ms >= 2_000)).toBe(true);
    expect(world.mg.fake.validations.filter((v) => v.status === 429)).toHaveLength(3);
    for (const p of people) expect(billed(world)[p.emailNorm]).toBe(1);
    expect(await db.verificationCheck.count({ where: { emailNorm: { in: people.map((p) => p.emailNorm) } } })).toBe(4);
  });

  it("a server that takes one at a time answers 429 to the rest: they wait their turn, billed once each", async () => {
    world.mg.fake.setSwitches({ validateMaxActive: 1, validateSlowMs: 60, validateNoRateHeaders: true });
    const people = [];
    for (const a of ["slow1@valid.test", "slow2@valid.test", "slow3@valid.test"]) people.push(await world.person(a));
    await world.enqueue(contacts(people.map((p) => p.personId)));
    const res = await world.run();
    expect(res?.outcome).toBe("done");
    expect(world.mg.fake.validations.some((v) => v.status === 429)).toBe(true);
    for (const p of people) expect(billed(world)[p.emailNorm]).toBe(1);
    const view = await db.person.findMany({ where: { id: { in: people.map((p) => p.personId) } } });
    expect(view.every((p) => p.verificationStatus === "VALID")).toBe(true);
  });
});

describe("server errors and time-outs", () => {
  it("an address that keeps answering 500 is tried in 7 passes (2 requests each), then counts as not reached", async () => {
    const boom = await world.person("boom1@valid.test");
    const ok = await world.person("fine1@valid.test");
    const job = await world.enqueue(contacts([boom.personId, ok.personId]));
    for (let pass = 1; pass <= 6; pass++) {
      const res = await world.run();
      expect(res).toMatchObject({ outcome: "deferred", deferReason: "retry-later" });
      world.clock.advance(10 * 60_000);
    }
    expect((await world.run())?.outcome).toBe("done");
    expect(requestsFor(world, "boom1@valid.test")).toBe(14);
    expect(billed(world)["boom1@valid.test"]).toBeUndefined();
    const result = resultOf(await world.job(job.id));
    expect(result.counts).toMatchObject({ checked: 1, canEmail: 1, notReached: 1, mayBeCharged: 0 });
    expect(result.summary).toBe("1 address checked: 1 can be emailed. 1 couldn't be checked right now. Cost $0.01.");
    expect((await db.person.findUniqueOrThrow({ where: { id: boom.personId } })).verificationStatus).toBeNull();
  });

  it("a time-out is never retried in the same pass; after two the address may have been charged", async () => {
    const slow = await world.person("late1@valid.test");
    const job = await world.enqueue(contacts([slow.personId]));
    world.mg.fake.failNext(VALIDATE, { kind: "delay", ms: 400 }, 2);
    const fast = world.deps({ verifier: async () => (await import("@/server/verification")).getVerifier({ timeoutMs: 100 }) });
    expect(await world.run({ deps: fast })).toMatchObject({ outcome: "deferred", deferReason: "retry-later" });
    const carry = resultOf(await world.job(job.id)).carry as { timeouts: Record<string, number>; pending: number[]; passQueue: number[]; retries: number };
    expect(carry.timeouts[String(slow.personId)]).toBe(1);
    // Waiting for the next pass (10 minutes later).
    expect(carry).toMatchObject({ pending: [], passQueue: [slow.personId], retries: 1 });
    world.clock.advance(10 * 60_000);
    expect((await world.run({ deps: fast }))?.outcome).toBe("done");
    const result = resultOf(await world.job(job.id));
    expect(result.counts).toMatchObject({ checked: 0, notReached: 1, mayBeCharged: 1 });
    expect(result.summary).toBe("No addresses were checked. 1 couldn't be checked right now. It may have been charged. Cost $0.");
    expect(world.mg.fake.requests.filter((r) => r.path === "/v4/address/validate")).toHaveLength(2);
    // Let the fake's delayed answers finish before the next test resets it.
    await new Promise((r) => setTimeout(r, 450));
  });
});

describe("unreadable answers", () => {
  it("three in a row: charged rows, people untouched, every check run paused", async () => {
    const people = [];
    for (const a of ["v3shape1@valid.test", "v3shape2@valid.test", "v3shape3@valid.test"]) people.push(await world.person(a));
    const job = await world.enqueue(contacts(people.map((p) => p.personId)));
    const res = await world.run();
    expect(res).toMatchObject({ outcome: "deferred", deferReason: "paused" });
    const rows = await db.verificationCheck.findMany({ where: { jobId: job.id } });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.costUsd === 0.012 && JSON.stringify(r.reasons) === '["app:unreadable_response"]')).toBe(true);
    const persons = await db.person.findMany({ where: { id: { in: people.map((p) => p.personId) } } });
    expect(persons.every((p) => p.verificationStatus === null)).toBe(true);
    const pause = await db.systemState.findUniqueOrThrow({ where: { key: "checks.pause" } });
    expect(pause.value).toMatchObject({ paused: true, kind: "unreadable" });
    expect(resultOf(await world.job(job.id)).summary).toBe(
      "Address checks paused: Mailgun's answers couldn't be read. Run update.bat, then click Resume checks.",
    );
    expect(await db.notification.count({ where: { type: "verify.paused", userId: world.owner.id } })).toBe(1);
  });
});

describe("an answer that breaks off", () => {
  it("a 200 whose body breaks off is stored with its cost as couldn't be read, and never asked again at once", async () => {
    const p = await world.person("cut1@valid.test");
    const job = await world.enqueue(contacts([p.personId]));
    let requests = 0;
    const fetchImpl = (async () => {
      requests += 1;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"result":"deliv'));
          controller.error(new TypeError("terminated"));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const verifier = async () => ({
      ok: true as const,
      verifier: createMailgunVerifier({ apiKey: world.mg.apiKey, region: "EU", baseUrl: "http://127.0.0.1:9", pricePerCheck: 0.012, fetchImpl }),
    });
    expect((await world.run({ deps: { verifier } }))?.outcome).toBe("done");
    expect(requests).toBe(1);
    expect(world.sleeps).not.toContain(2_000);
    expect(await db.verificationCheck.findMany({ where: { jobId: job.id } })).toMatchObject([
      { emailNorm: "cut1@valid.test", costUsd: 0.012, status: "UNKNOWN", reasons: ["app:unreadable_response"] },
    ]);
    expect((await db.person.findUniqueOrThrow({ where: { id: p.personId } })).verificationStatus).toBeNull();
    expect(resultOf(await world.job(job.id)).counts).toMatchObject({ checked: 0, notReached: 1, costUsd: 0.012 });
  });
});

describe("an answer that couldn't be stored", () => {
  it("is carried and stored first on the next run, without a second request", async () => {
    const a = await world.person("keep1@valid.test");
    const b = await world.person("keep2@valid.test");
    const job = await world.enqueue(contacts([a.personId, b.personId]));
    let failed = false;
    const commit: typeof commitCheckResult = async (input) => {
      if (!failed && input.emailNorm === a.emailNorm) {
        failed = true;
        throw new Error("database is locked (test)");
      }
      return commitCheckResult(input);
    };
    expect(await world.run({ deps: { commit } })).toMatchObject({ outcome: "deferred", deferReason: "retry-later" });
    const carry = resultOf(await world.job(job.id)).carry as { uncommitted: Array<{ emailNorm: string; costUsd: number }> };
    expect(carry.uncommitted).toMatchObject([{ emailNorm: a.emailNorm, costUsd: 0.012 }]);
    expect(await db.verificationCheck.count({ where: { emailNorm: a.emailNorm } })).toBe(0);

    world.clock.advance(60_000);
    expect((await world.run({ deps: { commit } }))?.outcome).toBe("done");
    expect(requestsFor(world, a.emailNorm)).toBe(1);
    expect(await db.verificationCheck.findMany({ where: { emailNorm: a.emailNorm } })).toMatchObject([{ jobId: job.id, costUsd: 0.012 }]);
    expect((await db.person.findUniqueOrThrow({ where: { id: a.personId } })).verificationStatus).toBe("VALID");
    expect(resultOf(await world.job(job.id)).counts).toMatchObject({ checked: 2, canEmail: 2, costUsd: 0.024 });
  });
});

describe("skip rules", () => {
  it("never pays for a never-emailed company, a flagged person, a suppressed address, no email or a fresh result", async () => {
    const now = world.clock.now();
    const client = await world.person("client1@valid.test", { companyStatus: "CLIENT" });
    const unsub = await world.person("unsub1@valid.test", { unsubscribedAt: now });
    const supp = await world.person("supp1@valid.test");
    await dbWrite((c) => c.suppression.create({ data: { emailNorm: supp.emailNorm, reason: "MANUAL", source: "manual" } }));
    const fresh = await world.person("fresh2@valid.test", { status: "VALID", verifiedAt: new Date(now.getTime() - 10 * DAY) });
    const wait = await world.person("wait1@valid.test", { status: "UNKNOWN", risk: "UNKNOWN", verifiedAt: new Date(now.getTime() - HOUR) });
    const noEmail = await world.person("placeholder@valid.test");
    await dbWrite((c) => c.person.update({ where: { id: noEmail.personId }, data: { email: null, emailNorm: null } }));
    const plain = await world.person("plain1@valid.test");
    const ids = [client, unsub, supp, fresh, wait, noEmail, plain].map((p) => p.personId);
    const job = await world.enqueue(contacts(ids));
    expect((await world.run())?.outcome).toBe("done");
    expect(world.mg.fake.validations.map((v) => v.address)).toEqual(["plain1@valid.test"]);
    const result = resultOf(await world.job(job.id));
    expect(result.counts).toMatchObject({ checked: 1, skipped: { fresh: 2, suppressed: 2, noEmail: 1, neverEmailed: 1 } });
    const done = await world.job(job.id);
    expect([done.progressDone, done.progressTotal]).toEqual([7, 7]);
    expect(await db.notification.findFirstOrThrow({ where: { type: "verify.finished" } })).toMatchObject({
      title: "Address checks finished",
      link: "/contacts",
    });
  });

  it("Contacts runs judge by the live check context: in a dry run before go-live they still check unchecked people", async () => {
    await setSettingValue("sending.mode", "DRY_RUN");
    await setSettingValue("sending.goLive", false);
    await setSettingValue("sending.testList", ["dry1@valid.test"]);
    try {
      const a = await world.person("dry1@valid.test");
      const b = await world.person("dry2@valid.test", { status: "VALID", provider: "fake" });
      await world.enqueue(contacts([a.personId, b.personId]));
      expect((await world.run())?.outcome).toBe("done");
      expect(world.mg.fake.validations.map((v) => v.address).sort()).toEqual(["dry1@valid.test", "dry2@valid.test"]);
    } finally {
      await setSettingValue("sending.mode", "LIVE");
      await setSettingValue("sending.goLive", true);
      await setSettingValue("sending.testList", []);
    }
  });

  it("'Check these again too' re-checks fresh results and first 'no answer's inside their 24 hours", async () => {
    const now = world.clock.now();
    const fresh = await world.person("again1@valid.test", { status: "VALID", verifiedAt: new Date(now.getTime() - 10 * DAY) });
    const wait = await world.person("again2@valid.test", { status: "UNKNOWN", risk: "UNKNOWN", verifiedAt: new Date(now.getTime() - HOUR) });
    await world.enqueue(contacts([fresh.personId, wait.personId], true));
    expect((await world.run())?.outcome).toBe("done");
    expect(world.mg.fake.validations.map((v) => v.address).sort()).toEqual(["again1@valid.test", "again2@valid.test"]);
    expect(await db.person.findUniqueOrThrow({ where: { id: wait.personId } })).toMatchObject({ verificationStatus: "VALID", verificationUnknowns: 0 });
  });
});

describe("one-address runs", () => {
  it("the panel's Check: the result for its toast and a person.checked entry", async () => {
    const p = await world.person("panel1@catchall-low.test", { status: "VALID", verifiedAt: world.clock.now() });
    const job = await world.enqueue(
      { source: "panel", personIds: [p.personId], confirmedCount: 1, recheckRecent: true, listId: null },
      { createdById: world.member.id, priority: 25 },
    );
    expect((await world.run())?.outcome).toBe("done");
    const result = resultOf(await world.job(job.id));
    expect(result.single).toMatchObject({
      personId: p.personId,
      outcome: "checked",
      status: "CATCH_ALL",
      risk: "LOW",
      disposable: false,
      decision: "send",
      detail: null,
    });
    expect(typeof (result.single as { ms: unknown }).ms).toBe("number");
    expect(await db.activityLog.findFirstOrThrow({ where: { type: "person.checked" } })).toMatchObject({
      actorId: world.member.id,
      personId: p.personId,
      summary: "Ali checked panel1@catchall-low.test: can't be confirmed, but it's low risk, so it can be emailed",
    });
    expect(await db.notification.count({ where: { type: "verify.finished" } })).toBe(0);
    expect((await checkRunView(job.id, world.clock.now())).single?.outcome).toBe("checked");
  });

  it("the panel doesn't pay again when another run checked the person after the Check was clicked", async () => {
    const others = [await world.person("pa1@valid.test"), await world.person("pa2@valid.test")];
    const panelp = await world.person("panelp@valid.test");
    // The panel's Check, queued now; it waits behind a Contacts run that has the same person in its list.
    const panel = await world.enqueue(
      { source: "panel", personIds: [panelp.personId], confirmedCount: 1, recheckRecent: true, listId: null },
      { createdById: world.member.id, priority: 25 },
    );
    await dbWrite((c) => c.job.update({ where: { id: panel.id }, data: { createdAt: world.clock.now(), runAt: new Date(world.clock.now().getTime() + 60_000) } }));
    const run = await world.enqueue(contacts([...others, panelp].map((p) => p.personId)));
    expect((await world.run())?.outcome).toBe("done");
    expect((await world.job(run.id)).status).toBe("DONE");
    expect(billed(world)["panelp@valid.test"]).toBe(1);

    world.clock.advance(60_000);
    expect((await world.run())?.outcome).toBe("done");
    expect(billed(world)["panelp@valid.test"]).toBe(1);
    expect(await db.verificationCheck.count({ where: { jobId: panel.id } })).toBe(0);
    // The toast still says what the address check found (the other run's answer, from today).
    expect(resultOf(await world.job(panel.id)).single).toMatchObject({ personId: panelp.personId, outcome: "checked", status: "VALID", decision: "send" });
    // No second "checked" entry: the Contacts run's summary already covers it.
    expect(await db.activityLog.count({ where: { type: "person.checked" } })).toBe(0);
  });

  it("the panel never checks an address on the do-not-email list", async () => {
    const p = await world.person("panel2@valid.test");
    await dbWrite((c) => c.suppression.create({ data: { emailNorm: p.emailNorm, reason: "BOUNCED", source: "mailgun" } }));
    const job = await world.enqueue({ source: "panel", personIds: [p.personId], confirmedCount: 1, recheckRecent: true }, { priority: 25 });
    expect((await world.run())?.outcome).toBe("done");
    expect(resultOf(await world.job(job.id)).single).toMatchObject({ outcome: "skipped", skipReason: "suppressed" });
    expect(world.mg.fake.validations).toHaveLength(0);
  });

  it("a panel check Mailgun refuses (400) says so, with Mailgun's words scrubbed", async () => {
    const p = await world.person("panel3@valid.test");
    world.mg.fake.setValidation(p.emailNorm, { status: 400, body: { message: "panel3@valid.test is disabled" } });
    const job = await world.enqueue({ source: "panel", personIds: [p.personId], confirmedCount: 1, recheckRecent: true }, { priority: 25 });
    expect((await world.run())?.outcome).toBe("done");
    const result = resultOf(await world.job(job.id));
    expect(result.single).toMatchObject({ outcome: "refused", detail: "[address] is disabled" });
    expect(result.counts).toMatchObject({ refused: 1, checked: 0 });
  });

  it("the Settings test stores a row only: no person, no do-not-email entry", async () => {
    const job = await world.enqueue({ source: "settings", address: "bad7@valid.test" }, { priority: 25, maxAttempts: 1 });
    expect((await world.run())?.outcome).toBe("done");
    const result = resultOf(await world.job(job.id));
    expect(result.single).toMatchObject({ personId: null, outcome: "checked", status: "INVALID", decision: "undeliverable" });
    expect(await db.verificationCheck.findMany({ where: { jobId: job.id } })).toMatchObject([
      { personId: null, emailNorm: "bad7@valid.test", source: "settings", costUsd: 0.012 },
    ]);
    expect(await db.suppression.count({ where: { emailNorm: "bad7@valid.test" } })).toBe(0);
    expect(await db.activityLog.count({ where: { type: { in: ["verify.run", "person.checked"] } } })).toBe(0);
  });
});
