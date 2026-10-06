import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeDraft, makeUser, setSettingValue } from "../campaigns/seed";

/**
 * Starting and stopping check runs (M5-DESIGN §2.5 table, §2.9 refusals, §6.11): payloads, priorities, dedupe keys and
 * tries per source; the refusals (paused, no key, a key that doesn't fit, the count changed, the monthly limit for the
 * Owner and a Member, the panel's 24-hour rule); Stop acts on check runs only.
 */

const t = await createTestDb("verification-start");
const { db, dbWrite } = await import("@/server/db");
const { setSecret, deleteSecret } = await import("@/server/secrets");
const { enqueueJob } = await import("@/server/jobs");
const { startCheckRun, stopCheckRun, checkRunJobOptions, CheckRunError } = await import("@/server/services/verification/start");
const { pauseChecks, resumeChecks } = await import("@/server/services/verification/pause");
const words = await import("@/core/verification/words");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let owner: { id: number; name: string; role: "OWNER" };
let member: { id: number; name: string; role: "MEMBER" };

async function jobOf(jobId: number) {
  return db.job.findUniqueOrThrow({ where: { id: jobId } });
}

async function refusal(p: Promise<unknown>): Promise<{ message: string; code: string }> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(CheckRunError);
    return { message: (err as Error).message, code: (err as InstanceType<typeof CheckRunError>).code };
  }
  throw new Error("expected a refusal");
}

async function checkRow(emailNorm: string, at: Date, costUsd = 0.012, provider = "mailgun-fake") {
  await dbWrite((c) =>
    c.verificationCheck.create({ data: { emailNorm, provider, status: "VALID", risk: "LOW", costUsd, checkedAt: at, source: "contacts" } }),
  );
}

beforeAll(async () => {
  const o = await makeUser("Arslan", { role: "OWNER" });
  const m = await makeUser("Sara");
  owner = { id: o.id, name: o.name, role: "OWNER" };
  member = { id: m.id, name: m.name, role: "MEMBER" };
});

beforeEach(async () => {
  await setSettingValue("practice.copy", false);
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.goLive", true);
  await setSettingValue("verification.monthlyLimitUsd", 100);
  await setSecret("mailgun.apiKey", "key-fake-api", null);
  await deleteSecret("verification.apiKey");
  await dbWrite((c) => c.systemState.deleteMany({ where: { key: "checks.pause" } }));
  await dbWrite((c) => c.job.updateMany({ where: { status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED", activeDedupeKey: null } }));
  await dbWrite((c) => c.verificationCheck.deleteMany({}));
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("checkRunJobOptions (§2.5 table)", () => {
  it("gives each source its priority, dedupe key and tries", () => {
    expect(checkRunJobOptions({ source: "recheck" })).toEqual({ priority: 30, dedupeKey: "verify:recheck", maxAttempts: 3 });
    expect(checkRunJobOptions({ source: "panel", personIds: [7], confirmedCount: 1, recheckRecent: true })).toEqual({
      priority: 25,
      dedupeKey: "verify:person:7",
      maxAttempts: 3,
    });
    expect(checkRunJobOptions({ source: "settings", address: "a@b.de" })).toEqual({ priority: 25, dedupeKey: "verify:settings", maxAttempts: 1 });
    expect(checkRunJobOptions({ source: "wizard", campaignId: 4, personIds: [], confirmedCount: 0 })).toEqual({
      priority: 20,
      dedupeKey: "verify:campaign:4",
      maxAttempts: 3,
    });
    expect(checkRunJobOptions({ source: "list", personIds: [], confirmedCount: 0, recheckRecent: false, listId: 3 })).toEqual({
      priority: 10,
      dedupeKey: undefined,
      maxAttempts: 3,
    });
  });
});

describe("startCheckRun", () => {
  it("wizard: checks the campaign's addresses that need it, one run per campaign", async () => {
    const a = await makeCompany({ name: "Wizard Start A", people: [{ name: "Anna" }, { name: "Bob" }] });
    const fresh = a.people[1]!;
    await dbWrite((c) =>
      c.person.update({ where: { id: fresh.id }, data: { verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: ago(DAY), verificationProvider: "mailgun" } }),
    );
    const draft = await makeDraft({
      name: "Germany Q4",
      createdById: owner.id,
      recipients: a.people.map((p) => ({ companyId: a.company.id, personId: p.id })),
    });
    const changed = await refusal(startCheckRun(owner, { source: "wizard", campaignId: draft.id, confirmedCount: 2 }, { now: NOW }));
    expect(changed).toEqual({ message: words.CAMPAIGN_COUNT_CHANGED_TEXT, code: "count-changed" });

    const res = await startCheckRun(member, { source: "wizard", campaignId: draft.id, confirmedCount: 1 }, { now: NOW });
    expect(res.count).toBe(1);
    const job = await jobOf(res.jobId);
    expect(job).toMatchObject({
      type: "verify.addresses",
      status: "QUEUED",
      priority: 20,
      maxAttempts: 3,
      activeDedupeKey: `verify:campaign:${draft.id}`,
      createdById: member.id,
    });
    expect(job.payload).toEqual({ source: "wizard", campaignId: draft.id, personIds: [a.people[0]!.id], confirmedCount: 1 });
    expect(job.runAt.getTime()).toBe(NOW.getTime());
    // Starting again returns the run that is already queued.
    expect(await startCheckRun(owner, { source: "wizard", campaignId: draft.id, confirmedCount: 1 }, { now: NOW })).toEqual(res);
    expect(await db.job.count({ where: { type: "verify.addresses", status: "QUEUED" } })).toBe(1);
  });

  it("contacts and list: the needed addresses, plus the recent ones when asked; the count must match", async () => {
    const co = await makeCompany({ name: "Contacts Start Co", people: [{ name: "New" }, { name: "Recent" }] });
    const recent = co.people[1]!;
    await dbWrite((c) =>
      c.person.update({ where: { id: recent.id }, data: { verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: ago(DAY), verificationProvider: "mailgun" } }),
    );
    const res = await startCheckRun(owner, { source: "contacts", companyIds: [co.company.id], recheckRecent: false, confirmedCount: 1 }, { now: NOW });
    const job = await jobOf(res.jobId);
    expect(job).toMatchObject({ priority: 10, maxAttempts: 3, activeDedupeKey: null });
    expect(job.payload).toEqual({ source: "contacts", personIds: [co.people[0]!.id], confirmedCount: 1, recheckRecent: false, listId: null });

    // Each start is its own run (no dedupe key).
    const again = await startCheckRun(owner, { source: "contacts", companyIds: [co.company.id], recheckRecent: true, confirmedCount: 2 }, { now: NOW });
    expect(again.jobId).not.toBe(res.jobId);
    expect((await jobOf(again.jobId)).payload).toMatchObject({ personIds: co.people.map((p) => p.id), recheckRecent: true, confirmedCount: 2 });

    const changed = await refusal(
      startCheckRun(owner, { source: "contacts", companyIds: [co.company.id], recheckRecent: false, confirmedCount: 3 }, { now: NOW }),
    );
    expect(changed).toEqual({ message: "The number of addresses changed. Open the dialog again to see the new count and cost.", code: "count-changed" });

    const list = await dbWrite((c) => c.list.create({ data: { name: "Start list" } }));
    await dbWrite((c) => c.companyList.create({ data: { companyId: co.company.id, listId: list.id } }));
    const fromList = await startCheckRun(member, { source: "list", listId: list.id, recheckRecent: false, confirmedCount: 1 }, { now: NOW });
    expect((await jobOf(fromList.jobId)).payload).toEqual({
      source: "list",
      personIds: [co.people[0]!.id],
      confirmedCount: 1,
      recheckRecent: false,
      listId: list.id,
    });

    const nothing = await makeCompany({ name: "Nothing Co", people: [{ name: "No Mail", email: null }] });
    expect((await refusal(startCheckRun(owner, { source: "contacts", companyIds: [nothing.company.id], recheckRecent: false, confirmedCount: 0 }, { now: NOW }))).code).toBe(
      "nothing",
    );
  });

  it("panel: one person, refused when a real check of the address is less than 24 hours old", async () => {
    const co = await makeCompany({ name: "Panel Start Co", people: [{ name: "Anna" }, { name: "Empty", email: null }] });
    const anna = co.people[0]!;
    const res = await startCheckRun(member, { source: "panel", personId: anna.id }, { now: NOW });
    const job = await jobOf(res.jobId);
    expect(job).toMatchObject({ priority: 25, maxAttempts: 3, activeDedupeKey: `verify:person:${anna.id}` });
    expect(job.payload).toEqual({ source: "panel", personIds: [anna.id], confirmedCount: 1, recheckRecent: true, listId: null });
    await dbWrite((c) => c.job.update({ where: { id: res.jobId }, data: { status: "DONE", activeDedupeKey: null } }));

    await checkRow(anna.emailNorm!, ago(2 * HOUR));
    expect(await refusal(startCheckRun(owner, { source: "panel", personId: anna.id }, { now: NOW }))).toEqual({
      message: `${anna.emailNorm} was checked today already.`,
      code: "checked-today",
    });
    // The test checker's results don't count, and a day later it may be checked again.
    await dbWrite((c) => c.verificationCheck.deleteMany({}));
    await checkRow(anna.emailNorm!, ago(2 * HOUR), 0, "fake");
    await checkRow(anna.emailNorm!, ago(25 * HOUR));
    expect((await startCheckRun(owner, { source: "panel", personId: anna.id }, { now: NOW })).count).toBe(1);

    expect((await refusal(startCheckRun(owner, { source: "panel", personId: co.people[1]!.id }, { now: NOW }))).message).toBe(
      "No email address to check.",
    );
    expect((await refusal(startCheckRun(owner, { source: "panel", personId: 987_654 }, { now: NOW }))).code).toBe("person-gone");
  });

  it("settings: the Owner's test of one typed address", async () => {
    const res = await startCheckRun(owner, { source: "settings", address: " Arslan@Studio.example " }, { now: NOW });
    const job = await jobOf(res.jobId);
    expect(job).toMatchObject({ priority: 25, maxAttempts: 1, activeDedupeKey: "verify:settings" });
    expect(job.payload).toEqual({ source: "settings", address: "Arslan@studio.example" });
    expect(await refusal(startCheckRun(member, { source: "settings", address: "a@b.example" }, { now: NOW }))).toEqual({
      message: "Only the Owner can test address checks.",
      code: "owner-only",
    });
    expect((await refusal(startCheckRun(owner, { source: "settings", address: "not an address" }, { now: NOW }))).code).toBe("bad-address");
  });

  it("settings: a test of another address still waiting is never handed back as this one's", async () => {
    const first = await startCheckRun(owner, { source: "settings", address: "a@test-one.example" }, { now: NOW });
    // The same address (other case, spaces) is the same test.
    expect((await startCheckRun(owner, { source: "settings", address: " A@Test-One.example " }, { now: NOW })).jobId).toBe(first.jobId);
    expect(await refusal(startCheckRun(owner, { source: "settings", address: "b@test-two.example" }, { now: NOW }))).toEqual({
      message: "A test of another address hasn't finished yet. Try again in a minute.",
      code: "test-busy",
    });
    expect(await db.job.count({ where: { type: "verify.addresses", status: "QUEUED" } })).toBe(1);
    // Once it has finished, the other address can be tested.
    await dbWrite((c) => c.job.update({ where: { id: first.jobId }, data: { status: "DONE", activeDedupeKey: null } }));
    const second = await startCheckRun(owner, { source: "settings", address: "b@test-two.example" }, { now: NOW });
    expect((await jobOf(second.jobId)).payload).toEqual({ source: "settings", address: "b@test-two.example" });
  });

  it("wizard: refuses while the campaign is being launched (the launch leaves out whoever isn't checked)", async () => {
    const a = await makeCompany({ name: "Launching Co", people: [{ name: "Lena" }] });
    const draft = await makeDraft({ name: "Launching now", createdById: owner.id, recipients: [{ companyId: a.company.id, personId: a.people[0]!.id }] });
    const launching = ((globalThis as { __outreachLaunching?: Set<number> }).__outreachLaunching ??= new Set<number>());
    launching.add(draft.id);
    try {
      expect(await refusal(startCheckRun(owner, { source: "wizard", campaignId: draft.id, confirmedCount: 1 }, { now: NOW }))).toEqual({
        message: "This campaign is being launched right now. Wait a moment, then open the campaign page.",
        code: "launching",
      });
      expect(await db.job.count({ where: { activeDedupeKey: `verify:campaign:${draft.id}` } })).toBe(0);
    } finally {
      launching.delete(draft.id);
    }
    expect((await startCheckRun(owner, { source: "wizard", campaignId: draft.id, confirmedCount: 1 }, { now: NOW })).count).toBe(1);
  });

  it("refuses while checks are paused, and starts again after Resume", async () => {
    const co = await makeCompany({ name: "Paused Start Co", people: [{ name: "Pia" }] });
    await pauseChecks("payment", words.checkPauseText("payment"), null, { now: NOW });
    expect(await refusal(startCheckRun(owner, { source: "panel", personId: co.people[0]!.id }, { now: NOW }))).toEqual({
      message: words.checkPauseText("payment"),
      code: "paused",
    });
    await resumeChecks(owner, { now: NOW });
    expect((await startCheckRun(owner, { source: "panel", personId: co.people[0]!.id }, { now: NOW })).count).toBe(1);
  });

  it("refuses without a usable key: none, or one that doesn't fit the server", async () => {
    const co = await makeCompany({ name: "Keyless Co", people: [{ name: "Kai" }] });
    await deleteSecret("mailgun.apiKey");
    expect(await refusal(startCheckRun(owner, { source: "panel", personId: co.people[0]!.id }, { now: NOW }))).toEqual({
      message: words.NO_CHECK_KEY_TEXT,
      code: "not-ready",
    });
    // A real-looking key while the app talks to the fake Mailgun.
    await setSecret("verification.apiKey", "0123456789abcdef-real-key", null);
    const mismatch = await refusal(startCheckRun(owner, { source: "panel", personId: co.people[0]!.id }, { now: NOW }));
    expect(mismatch.message).toContain("doesn't fit this server");
    // The separate address check key wins over the Mailgun key.
    await setSecret("mailgun.apiKey", "key-fake-api", null);
    expect((await refusal(startCheckRun(owner, { source: "panel", personId: co.people[0]!.id }, { now: NOW }))).code).toBe("not-ready");
    await setSecret("verification.apiKey", "key-fake-checks", null);
    expect((await startCheckRun(owner, { source: "panel", personId: co.people[0]!.id }, { now: NOW })).count).toBe(1);
  });

  it("refuses a start that would pass this month's check limit, in the Owner's and a Member's words", async () => {
    const co = await makeCompany({ name: "Limit Co", people: [{ name: "Lia" }, { name: "Leo" }] });
    await setSettingValue("verification.monthlyLimitUsd", 100);
    for (let i = 0; i < 76; i++) await checkRow(`spent${i}@limit.example`, ago(HOUR), 1.2);
    // $91.20 spent; 2 × $0.012 more fits under $91.23 but not under $91.21.
    await setSettingValue("verification.monthlyLimitUsd", 91.21);
    const ownerRefusal = await refusal(
      startCheckRun(owner, { source: "contacts", companyIds: [co.company.id], recheckRecent: false, confirmedCount: 2 }, { now: NOW }),
    );
    expect(ownerRefusal).toEqual({
      message: "That would pass this month's check limit of $91.21 ($91.20 used so far). Raise the limit in Settings › Deliverability, or check fewer addresses.",
      code: "monthly-limit",
    });
    const memberRefusal = await refusal(
      startCheckRun(member, { source: "contacts", companyIds: [co.company.id], recheckRecent: false, confirmedCount: 2 }, { now: NOW }),
    );
    expect(memberRefusal.message).toBe(
      "That would pass this month's check limit of $91.21 ($91.20 used so far). Ask the Owner to raise the limit in Settings › Deliverability, or check fewer addresses.",
    );
    await setSettingValue("verification.monthlyLimitUsd", 91.23);
    expect((await startCheckRun(member, { source: "contacts", companyIds: [co.company.id], recheckRecent: false, confirmedCount: 2 }, { now: NOW })).count).toBe(2);
  });

  it("refuses more than 5,000 addresses from Contacts", async () => {
    const co = await makeCompany({ name: "Too Many Co", domain: "too-many.test", people: [] });
    for (let start = 0; start < 5_001; start += 500) {
      const data: Prisma.PersonCreateManyInput[] = [];
      for (let i = start; i < Math.min(start + 500, 5_001); i++) {
        data.push({ companyId: co.company.id, name: `T${i}`, email: `t${i}@too-many.test`, emailNorm: `t${i}@too-many.test` });
      }
      await dbWrite((c) => c.person.createMany({ data }));
    }
    expect(
      await refusal(startCheckRun(owner, { source: "contacts", companyIds: [co.company.id], recheckRecent: false, confirmedCount: 5_001 }, { now: NOW })),
    ).toEqual({ message: "That's 5,001 addresses. Check at most 5,000 at a time: tick fewer companies.", code: "too-many" });
  });
});

describe("stopCheckRun", () => {
  it("refuses any other job type and leaves it alone", async () => {
    const backup = await enqueueJob({ type: "backup.run", dedupeKey: "backup:test" });
    expect(await refusal(stopCheckRun(member, backup.id))).toEqual({ message: "This isn't an address check run.", code: "not-a-check-run" });
    expect((await jobOf(backup.id)).status).toBe("QUEUED");
    expect((await refusal(stopCheckRun(member, 987_654))).code).toBe("not-a-check-run");
  });

  it("cancels a queued run, asks a running one to stop, and says when it had finished", async () => {
    const co = await makeCompany({ name: "Stop Co", people: [{ name: "Stan" }] });
    const queued = await startCheckRun(member, { source: "contacts", companyIds: [co.company.id], recheckRecent: false, confirmedCount: 1 }, { now: NOW });
    expect(await stopCheckRun(member, queued.jobId, { now: NOW })).toEqual({ message: "Address checks stopped before they started." });
    expect((await jobOf(queued.jobId)).status).toBe("CANCELLED");

    const running = await startCheckRun(member, { source: "contacts", companyIds: [co.company.id], recheckRecent: false, confirmedCount: 1 }, { now: NOW });
    await dbWrite((c) => c.job.update({ where: { id: running.jobId }, data: { status: "RUNNING" } }));
    expect(await stopCheckRun(member, running.jobId, { now: NOW })).toEqual({
      message: "Stopping the address checks. The checks already running finish first.",
    });
    expect((await jobOf(running.jobId)).cancelRequestedAt?.getTime()).toBe(NOW.getTime());
    await dbWrite((c) => c.job.update({ where: { id: running.jobId }, data: { status: "DONE" } }));
    expect(await stopCheckRun(member, running.jobId, { now: NOW })).toEqual({ message: "These address checks had already finished." });
  });

  it("never answers 'finished' for a run that goes on: a run moving between running and waiting can't slip past Stop", async () => {
    const co = await makeCompany({ name: "Flip Co", people: [{ name: "Flo" }] });
    for (let i = 0; i < 20; i++) {
      const started = await startCheckRun(member, { source: "contacts", companyIds: [co.company.id], recheckRecent: false, confirmedCount: 1 }, { now: NOW });
      await dbWrite((c) => c.job.update({ where: { id: started.jobId }, data: { status: "RUNNING" } }));
      // The worker defers the run (running → waiting) while Stop is being clicked, at slightly different moments.
      const flip = (async () => {
        for (let k = 0; k < i % 5; k++) await new Promise((r) => setImmediate(r));
        await dbWrite((c) => c.job.updateMany({ where: { id: started.jobId, status: "RUNNING" }, data: { status: "QUEUED" } }));
      })();
      const [res] = await Promise.all([stopCheckRun(member, started.jobId, { now: NOW }), flip]);
      const row = await jobOf(started.jobId);
      expect(res.message).not.toBe("These address checks had already finished.");
      // Either it was cancelled while waiting, or it is asked to stop and will (the request stays on the job).
      expect(row.status === "CANCELLED" || row.cancelRequestedAt !== null).toBe(true);
      await dbWrite((c) => c.job.update({ where: { id: started.jobId }, data: { status: "CANCELLED", activeDedupeKey: null } }));
    }
  });

  it("Stop stores a waiting run's paid answer only once, even when the run had stored it already", async () => {
    const co = await makeCompany({ name: "Twice Co", people: [{ name: "Tia", email: "tia@twice.test" }] });
    const tia = co.people[0]!;
    const result = { status: "VALID", risk: "LOW", isRole: false, isDisposable: false, didYouMean: null, reasons: [], raw: { result: "deliverable" } };
    const job = await dbWrite((c) =>
      c.job.create({
        data: {
          type: "verify.addresses",
          status: "QUEUED",
          runAt: new Date(NOW.getTime() + 60_000),
          payload: { source: "contacts", personIds: [tia.id], confirmedCount: 1, recheckRecent: false },
          result: {
            carry: { cursor: 1, uncommitted: [{ personId: tia.id, emailNorm: "tia@twice.test", result, unreadable: false, provider: "mailgun-fake", costUsd: 0.012 }] },
            deferred: "retry-later",
          },
        },
      }),
    );
    // The run stored it, then died before saving its smaller carry.
    await dbWrite((c) =>
      c.verificationCheck.create({
        data: { personId: tia.id, emailNorm: "tia@twice.test", provider: "mailgun-fake", status: "VALID", risk: "LOW", costUsd: 0.012, jobId: job.id, source: "contacts" },
      }),
    );
    expect(await stopCheckRun(member, job.id, { now: NOW })).toEqual({ message: "Address checks stopped before they started." });
    expect(await db.verificationCheck.count({ where: { jobId: job.id } })).toBe(1);
    const carry = ((await jobOf(job.id)).result as { carry: { uncommitted: unknown[] } }).carry;
    expect(carry.uncommitted).toEqual([]);
  });
});
