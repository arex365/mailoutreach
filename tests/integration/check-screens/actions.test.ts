import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { makeCompany, makeDraft, makeUser, setSettingValue } from "../campaigns/seed";
import { runCheckJob } from "./check-job";

/**
 * The check screens' Server Actions on a temp database with the fake Mailgun (M5-DESIGN §6.1, §6.3, §6.5, §6.6,
 * §6.11): estimate / start / stop for Contacts, a list, the panel and the wizard; Stop refuses other job types;
 * checkRunViewAction gives counts and `single`; Continue from Verify while checks run; the Owner-only settings actions
 * refused for a Member; the settings' validation (incl. the monthly limit), the key rules, and "Test address checks"
 * against the fake (an undeliverable test address isn't put on the do-not-email list).
 */

type TestUser = { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number };
const auth = vi.hoisted(() => ({ user: null as TestUser | null }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/dal", () => {
  class AuthError extends Error {
    constructor(
      message: string,
      readonly status: 401 | 403,
    ) {
      super(message);
      this.name = "AuthError";
    }
  }
  const requireUserAction = async () => {
    if (!auth.user) throw new AuthError("Your session has ended. Please sign in again.", 401);
    return auth.user;
  };
  return {
    AuthError,
    getUserOrNull: async () => auth.user,
    requireUserAction,
    requireOwnerAction: async () => {
      const user = await requireUserAction();
      if (user.role !== "OWNER") throw new AuthError("Only the Owner can do this.", 403);
      return user;
    },
  };
});

const t = await createTestDb("check-screens-actions");
const { db, dbWrite } = await import("@/server/db");
const contacts = await import("@/app/(app)/contacts/check-actions");
const verify = await import("@/app/(app)/campaigns/[id]/setup/verify-actions");
const setup = await import("@/app/(app)/campaigns/[id]/setup/actions");
const settings = await import("@/app/(app)/settings/deliverability/check-actions");
const { enqueueJob } = await import("@/server/jobs");
const { getSetting } = await import("@/server/settings");
const { getSecret, setSecret, deleteSecret } = await import("@/server/secrets");
const { getChecksPause, pauseChecks } = await import("@/server/services/verification/pause");
const { checkRunDoneLines } = await import("@/core/verification/words");
const { testCheckResultView } = await import("@/components/settings/checks/check-settings");

let mg: FakeConnection;
let owner: TestUser;
let member: TestUser;

function asUser(u: { id: number; email: string; name: string; role: "OWNER" | "MEMBER" }): TestUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, timeZone: "Asia/Karachi", sessionId: 1 };
}

async function freshPause() {
  await dbWrite((c) => c.systemState.deleteMany({ where: { key: "checks.pause" } }));
}

beforeAll(async () => {
  mg = await connectFakeMailgun();
  owner = asUser(await makeUser("Arslan", { role: "OWNER" }));
  member = asUser(await makeUser("Ali", { role: "MEMBER" }));
});

beforeEach(async () => {
  auth.user = owner;
  await setSettingValue("practice.copy", false);
  await setSettingValue("verification.monthlyLimitUsd", 100);
  await freshPause();
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("Contacts and list checks", () => {
  let companyIds: number[];
  let listId: number;

  beforeAll(async () => {
    const a = await makeCompany({ name: "Alpha Checks", domain: "valid.test", people: [{ name: "Anna", email: "anna@valid.test" }, { name: "Ben", email: "ben@valid.test" }] });
    const b = await makeCompany({ name: "Beta Checks", domain: "catchall-medium.test", people: [{ name: "Cara", email: "ok@catchall-medium.test" }, { name: "No mail", email: null }] });
    companyIds = [a.company.id, b.company.id];
    const list = await dbWrite((c) => c.list.create({ data: { name: "Germany Q4" } }));
    listId = list.id;
    await dbWrite((c) => c.companyList.create({ data: { listId, companyId: a.company.id } }));
  });

  it("estimates, refuses a changed count, starts, shows the run and its finished lines", async () => {
    const est = await contacts.estimateChecksAction({ companyIds });
    expect(est.ok).toBe(true);
    if (!est.ok) return;
    expect(est.data).toMatchObject({ companies: 2, addresses: 4, need: 3, cannot: 1, maxAgeDays: 90, isOwner: true, practiceCopy: false, timeZone: "Asia/Karachi" });
    expect(est.data.estimate).toMatchObject({ count: 3, aboutUsd: 0.036, provider: "mailgun-fake" });
    // No person ids reach the browser.
    expect(est.data).not.toHaveProperty("targets");

    expect(await contacts.startChecksAction({ companyIds, recheckRecent: false, confirmedCount: 4 })).toEqual({
      ok: false,
      error: "The number of addresses changed. Open the dialog again to see the new count and cost.",
    });
    const started = await contacts.startChecksAction({ companyIds, recheckRecent: false, confirmedCount: 3 });
    expect(started).toMatchObject({ ok: true, message: "Checking 3 addresses. You'll get a notification when it's done." });
    if (!started.ok) return;
    const job = await db.job.findUniqueOrThrow({ where: { id: started.data.jobId } });
    expect(job).toMatchObject({ type: "verify.addresses", priority: 10, createdById: owner.id, status: "QUEUED" });

    const queued = await contacts.checkRunViewAction({ jobId: started.data.jobId });
    expect(queued).toMatchObject({ ok: true, data: { status: "QUEUED", counts: null, single: null } });

    await runCheckJob(started.data.jobId);
    const view = await contacts.checkRunViewAction({ jobId: started.data.jobId });
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.data.status).toBe("DONE");
    expect(view.data.counts).toMatchObject({ checked: 3, canEmail: 2, catchAllBlocked: 1, costUsd: 0.036 });
    expect(checkRunDoneLines(view.data.counts!)).toEqual([
      "2 can be emailed.",
      "1 can't be confirmed. Your check settings skip these.",
      "Cost $0.04.",
    ]);
    expect(view.data.leftOut.map((l) => l.reason)).toEqual(["can't be confirmed"]);

    expect(await contacts.stopChecksAction({ jobId: started.data.jobId })).toEqual({ ok: true, data: null, message: "These address checks had already finished." });
  });

  it("checks a list, with the recent ones too, and stops a queued run", async () => {
    const est = await contacts.estimateChecksAction({ listId });
    expect(est).toMatchObject({ ok: true, data: { listName: "Germany Q4", companies: 1, need: 0, recent: 2 } });
    expect(await contacts.startChecksAction({ listId, recheckRecent: false, confirmedCount: 1 })).toEqual({
      ok: false,
      error: "No addresses here need a check.",
    });
    const started = await contacts.startChecksAction({ listId, recheckRecent: true, confirmedCount: 2 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const job = await db.job.findUniqueOrThrow({ where: { id: started.data.jobId } });
    expect(job.payload).toMatchObject({ source: "list", listId, recheckRecent: true, confirmedCount: 2 });
    expect(await contacts.stopChecksAction({ jobId: started.data.jobId })).toEqual({ ok: true, data: null, message: "Address checks stopped before they started." });
    expect((await db.job.findUniqueOrThrow({ where: { id: started.data.jobId } })).status).toBe("CANCELLED");

    expect(await contacts.estimateChecksAction({ listId: 987_654 })).toEqual({
      ok: false,
      error: "That list doesn't exist any more: someone may have just deleted it. Refresh the page to see the current lists.",
    });
  });

  it("refuses while paused and over the monthly limit (Owner and Member wording)", async () => {
    await pauseChecks("payment", "Address checks paused: billing.", null);
    expect(await contacts.startChecksAction({ companyIds, recheckRecent: true, confirmedCount: 3 })).toEqual({ ok: false, error: "Address checks paused: billing." });
    await freshPause();

    await setSettingValue("verification.monthlyLimitUsd", 0.05);
    const est = await contacts.estimateChecksAction({ companyIds });
    expect(est).toMatchObject({ ok: true, data: { monthly: { wouldPass: false }, allMonthly: { limitUsd: 0.05, wouldPass: true } } });
    const refused = await contacts.startChecksAction({ companyIds, recheckRecent: true, confirmedCount: 3 });
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/^That would pass this month's check limit of \$0\.05 \(\$0\.04 used so far\)\. Raise the limit/) });
    auth.user = member;
    const memberRefused = await contacts.startChecksAction({ companyIds, recheckRecent: true, confirmedCount: 3 });
    expect(memberRefused).toMatchObject({ ok: false, error: expect.stringContaining("Ask the Owner to raise the limit in Settings › Deliverability") });
  });

  it("refuses without a session", async () => {
    auth.user = null;
    expect((await contacts.estimateChecksAction({ companyIds })).ok).toBe(false);
    expect((await contacts.checkRunViewAction({ jobId: 1 })).ok).toBe(false);
  });
});

describe("the panel's Check on one person", () => {
  it("checks one person, gives the one-address outcome, and refuses within 24 hours", async () => {
    const c = await makeCompany({ name: "Panel Checks", domain: "valid.test", people: [{ name: "Tina", email: "temp1@valid.test" }, { name: "Nomail", email: null }] });
    auth.user = member;
    const res = await contacts.checkPersonAction({ personId: c.people[0]!.id });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const job = await db.job.findUniqueOrThrow({ where: { id: res.data.jobId } });
    expect(job).toMatchObject({ priority: 25, activeDedupeKey: `verify:person:${c.people[0]!.id}` });
    await runCheckJob(res.data.jobId);
    const view = await contacts.checkRunViewAction({ jobId: res.data.jobId });
    expect(view).toMatchObject({
      ok: true,
      data: { status: "DONE", single: { outcome: "checked", status: "VALID", disposable: true, decision: "block" } },
    });
    expect(await contacts.checkPersonAction({ personId: c.people[0]!.id })).toEqual({ ok: false, error: "temp1@valid.test was checked today already." });
    expect(await contacts.checkPersonAction({ personId: c.people[1]!.id })).toEqual({ ok: false, error: "No email address to check." });
  });
});

describe("Stop acts on address check runs only", () => {
  it("refuses a backup's id and leaves it queued", async () => {
    auth.user = member;
    const backup = await enqueueJob({ type: "backup.run", payload: {} });
    for (const stop of [contacts.stopChecksAction, verify.stopChecksAction]) {
      expect(await stop({ jobId: backup.id })).toEqual({ ok: false, error: "This isn't an address check run." });
    }
    expect((await db.job.findUniqueOrThrow({ where: { id: backup.id } })).status).toBe("QUEUED");
    expect(await contacts.checkRunViewAction({ jobId: backup.id })).toEqual({ ok: false, error: "This isn't an address check run." });
    await dbWrite((c) => c.job.update({ where: { id: backup.id }, data: { status: "CANCELLED", activeDedupeKey: null } }));
  });
});

describe("the wizard's Verify step", () => {
  it("starts the campaign's checks, refuses Continue while they run, and stops them", async () => {
    await setSettingValue("sending.mode", "LIVE");
    await setSettingValue("sending.goLive", true);
    const a = await makeCompany({ name: "Wizard Checks A", domain: "valid.test", people: [{ name: "Wim", email: "wim@valid.test" }] });
    const b = await makeCompany({ name: "Wizard Checks B", domain: "valid.test", people: [{ name: "Vera", email: "vera@valid.test" }] });
    const draft = await makeDraft({
      name: "Germany Q4",
      createdById: owner.id,
      recipients: [a, b].map((x) => ({ companyId: x.company.id, personId: x.people[0]!.id })),
    });
    auth.user = member;
    const viewRes = await verify.campaignCheckViewAction({ campaignId: draft.id });
    expect(viewRes).toMatchObject({ ok: true, data: { mode: "LIVE", goLive: true, need: { total: 2, notChecked: 2 }, run: null } });

    expect(await verify.startCampaignChecksAction({ campaignId: draft.id, confirmedCount: 3 })).toEqual({
      ok: false,
      error: "The number of addresses changed. Check the new count and cost on this page, then start the checks again.",
    });
    const started = await verify.startCampaignChecksAction({ campaignId: draft.id, confirmedCount: 2 });
    expect(started).toMatchObject({ ok: true, message: "Checking 2 addresses. You'll get a notification when it's done." });
    if (!started.ok) return;
    expect(await db.job.findUniqueOrThrow({ where: { id: started.data.jobId } })).toMatchObject({ priority: 20, activeDedupeKey: `verify:campaign:${draft.id}` });

    expect(await setup.continueAction({ campaignId: draft.id, from: "verify" })).toEqual({
      ok: false,
      error: "The address checks are still running. Wait for them to finish, or stop them first.",
    });
    expect(await verify.stopChecksAction({ jobId: started.data.jobId })).toEqual({ ok: true, data: null, message: "Address checks stopped before they started." });
    expect(await setup.continueAction({ campaignId: draft.id, from: "verify" })).toEqual({
      ok: true,
      data: { href: `/campaigns/${draft.id}/setup/review` },
      message: undefined,
    });
    await setSettingValue("sending.mode", "DRY_RUN");
    await setSettingValue("sending.goLive", false);
  });
});

describe("Settings › Deliverability › Address checks (Owner)", () => {
  const good = {
    deliverableHighRisk: "block",
    catchAllLow: "send",
    catchAllMedium: "block",
    catchAllHigh: "block",
    disposable: "block",
    unknown: "recheck",
    pricePerCheck: "0.012",
    includedPerMonth: "0",
    maxAgeDays: "90",
    monthlyLimitUsd: "100",
    concurrency: "2",
  };

  it("refuses every settings action for a Member", async () => {
    auth.user = member;
    const refused = { ok: false, error: "Only the Owner can do this." };
    expect(await settings.saveCheckSettingsAction(good)).toEqual(refused);
    expect(await settings.saveVerificationKeyAction({ key: "key-fake-verify" })).toEqual(refused);
    expect(await settings.removeVerificationKeyAction()).toEqual(refused);
    expect(await settings.testCheckAction({ email: "anna@valid.test" })).toEqual(refused);
    expect(await settings.resumeChecksAction()).toEqual(refused);
    expect(await getSecret("verification.apiKey")).toBeNull();
  });

  it("validates, saves only what changed and logs each key", async () => {
    const bad = await settings.saveCheckSettingsAction({ ...good, pricePerCheck: "2", maxAgeDays: "10", monthlyLimitUsd: "0", concurrency: "9", includedPerMonth: "1.5" });
    expect(bad).toMatchObject({ ok: false, error: "Some details need fixing. Check the highlighted fields." });
    if (!bad.ok) {
      expect(bad.fieldErrors).toEqual({
        pricePerCheck: ["Enter a price from $0 to $1 per check."],
        includedPerMonth: ["Enter a whole number of checks, 0 or more."],
        maxAgeDays: ["Choose between 30 and 365 days."],
        monthlyLimitUsd: ["Enter an amount from $1 to $10,000."],
        concurrency: ["Choose from 1 to 4 checks at the same time."],
      });
    }
    expect(await settings.saveCheckSettingsAction(good)).toEqual({ ok: true, data: { changed: 0, resumed: false }, message: "Nothing changed." });

    const saved = await settings.saveCheckSettingsAction({ ...good, catchAllLow: "block", disposable: "send", monthlyLimitUsd: "150", maxAgeDays: "60" });
    expect(saved).toEqual({ ok: true, data: { changed: 3, resumed: false }, message: "Check settings saved." });
    expect(await getSetting("verification.policy")).toEqual({
      deliverableHighRisk: "block",
      catchAllLow: "block",
      catchAllMedium: "block",
      catchAllHigh: "block",
      disposable: "send",
      unknown: "recheck",
    });
    expect(await getSetting("verification.monthlyLimitUsd")).toBe(150);
    expect(await getSetting("verification.maxAgeDays")).toBe(60);
    const logged = await db.activityLog.findMany({ where: { type: "settings.updated", actorId: owner.id }, orderBy: { id: "asc" } });
    expect(logged.map((l) => (l.data as { key: string }).key)).toEqual(["verification.policy", "verification.maxAgeDays", "verification.monthlyLimitUsd"]);
    expect(logged.map((l) => l.summary)).toContain("Arslan set the monthly limit for address checks to $150");
    await settings.saveCheckSettingsAction(good);
  });

  it("raising the monthly limit lifts the monthly-limit pause", async () => {
    await pauseChecks("monthly_limit", "Address checks stopped: this month's check limit of $100 is reached.", null, { until: new Date(Date.now() + 86_400_000) });
    const res = await settings.saveCheckSettingsAction({ ...good, monthlyLimitUsd: "200" });
    expect(res).toEqual({ ok: true, data: { changed: 1, resumed: true }, message: "Check settings saved. Address checks resumed." });
    expect((await getChecksPause()).paused).toBe(false);
    await settings.saveCheckSettingsAction(good);
  });

  it("saves a separate key with the Mailgun key rules, lifts a key pause, and removes it", async () => {
    expect(await settings.saveVerificationKeyAction({ key: "  " })).toEqual({
      ok: false,
      error: "Paste the key from Mailgun › API Security.",
      fieldErrors: { key: ["Paste the key from Mailgun › API Security."] },
    });
    // Tests talk to the fake Mailgun (fake mode): only test keys.
    expect(await settings.saveVerificationKeyAction({ key: "abc123-real-key" })).toMatchObject({
      ok: false,
      error: "The test server only takes test keys (key-fake-…).",
    });
    await pauseChecks("auth", "Address checks paused: Mailgun didn't accept the key.", null);
    const saved = await settings.saveVerificationKeyAction({ key: "​key-fake-verify " });
    expect(saved).toEqual({ ok: true, data: { last4: "rify" }, message: "Key saved. It's used for the next check. Address checks resumed." });
    expect(await getSecret("verification.apiKey")).toBe("key-fake-verify");
    expect((await getChecksPause()).paused).toBe(false);

    // Outside fake mode a test key is refused.
    const before = process.env.OUTREACH_MAILGUN_BASE_URL;
    delete process.env.OUTREACH_MAILGUN_BASE_URL;
    try {
      expect(await settings.saveVerificationKeyAction({ key: "key-fake-other" })).toMatchObject({
        ok: false,
        error: "This is a test key. Paste the key from Mailgun › API Security.",
      });
    } finally {
      process.env.OUTREACH_MAILGUN_BASE_URL = before;
    }

    expect(await settings.removeVerificationKeyAction()).toEqual({ ok: true, data: { removed: true }, message: "Address checks use the Mailgun key again." });
    expect(await getSecret("verification.apiKey")).toBeNull();
    expect(await settings.removeVerificationKeyAction()).toMatchObject({ ok: true, data: { removed: false } });

    await setSettingValue("practice.copy", true);
    expect(await settings.saveVerificationKeyAction({ key: "key-fake-verify" })).toEqual({ ok: false, error: "The practice copy never talks to Mailgun." });
  });

  it("tests one address against the fake: the result with the time, and never a suppression", async () => {
    expect(await settings.testCheckAction({ email: "nope" })).toEqual({
      ok: false,
      error: "Enter a valid email address, like name@example.com.",
      fieldErrors: { email: ["Enter a valid email address, like name@example.com."] },
    });

    const bad = await settings.testCheckAction({ email: "bad1@valid.test" });
    expect(bad.ok).toBe(true);
    if (!bad.ok) return;
    expect(await db.job.findUniqueOrThrow({ where: { id: bad.data.jobId } })).toMatchObject({ priority: 25, maxAttempts: 1, activeDedupeKey: "verify:settings" });
    await runCheckJob(bad.data.jobId);
    const view = await contacts.checkRunViewAction({ jobId: bad.data.jobId });
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(testCheckResultView(view.data).text).toMatch(/^Checked in \d+\.\d s: doesn't exist\. It wasn't added to the do-not-email list\.$/);
    expect(await db.suppression.count({ where: { emailNorm: "bad1@valid.test" } })).toBe(0);
    expect(await db.verificationCheck.findFirst({ where: { emailNorm: "bad1@valid.test" } })).toMatchObject({
      personId: null,
      source: "settings",
      status: "INVALID",
      provider: "mailgun-fake",
    });
    expect(mg.fake.validations.some((v) => v.address === "bad1@valid.test")).toBe(true);

    const good1 = await settings.testCheckAction({ email: "anna@valid.test" });
    if (!good1.ok) throw new Error(good1.error);
    await runCheckJob(good1.data.jobId);
    const goodView = await contacts.checkRunViewAction({ jobId: good1.data.jobId });
    if (!goodView.ok) throw new Error(goodView.error);
    expect(testCheckResultView(goodView.data)).toMatchObject({
      tone: "good",
      text: expect.stringMatching(/^Checked in \d+\.\d s: can be emailed \(deliverable, low risk\)\.$/),
    });
  });

  it("resumes checks", async () => {
    expect(await settings.resumeChecksAction()).toEqual({ ok: true, data: null, message: "Address checks aren't paused." });
    await pauseChecks("unreadable", "Address checks paused: Mailgun's answers couldn't be read.", null);
    expect(await settings.resumeChecksAction()).toEqual({ ok: true, data: null, message: "Address checks resumed." });
    expect((await getChecksPause()).paused).toBe(false);
  });

  it("uses the Mailgun key when no separate one is saved", async () => {
    await deleteSecret("verification.apiKey");
    await setSecret("mailgun.apiKey", mg.apiKey, null);
    const est = await contacts.estimateChecksAction({ companyIds: [] });
    expect(est).toMatchObject({ ok: true, data: { notReady: null } });
  });
});
