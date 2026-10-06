import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { makeCompany, makeDraft, makeUser, setSettingValue } from "../campaigns/seed";
import { runCheckJob, setRunState } from "./check-job";

/**
 * The wizard's step 4 "Verify" page rendered from seeded databases (M5-DESIGN §6.1): before go-live, a dry run in the
 * practice copy, needs checks with the cost, over the monthly check limit (Owner and Member), not ready, queued behind
 * another run, running, waiting after a deferral, paused (Owner and Member, both with Stop), done with the split lines
 * and who is left out; and the Schedule step's address-check note.
 */

type TestUser = { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number };
const auth = vi.hoisted(() => ({ user: null as TestUser | null }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => "/campaigns",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock("@/lib/auth/dal", () => {
  const user = async () => {
    if (!auth.user) throw new Error("signed out");
    return auth.user;
  };
  return { requireUser: user, requireOwner: user, requireUserAction: user, requireOwnerAction: user, getUserOrNull: async () => auth.user };
});

const t = await createTestDb("check-screens-verify");
const { db, dbWrite } = await import("@/server/db");
const { enqueueJob } = await import("@/server/jobs");
const { deleteSecret, setSecret } = await import("@/server/secrets");
const { pauseChecks } = await import("@/server/services/verification/pause");
const { whenText } = await import("@/components/checks/run-text");
const { default: VerifyStepPage } = await import("@/app/(app)/campaigns/[id]/setup/verify/page");
const { default: ScheduleStepPage } = await import("@/app/(app)/campaigns/[id]/setup/schedule/page");

const TZ = "Asia/Karachi";
const html = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

let mg: FakeConnection;
let owner: TestUser;
let member: TestUser;
let drafts = 0;

function asUser(u: { id: number; email: string; name: string; role: "OWNER" | "MEMBER" }): TestUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, timeZone: TZ, sessionId: 1 };
}

/** A draft with one ticked person per address (a company each). */
async function draftWith(emails: string[]) {
  drafts += 1;
  const recipients: Array<{ companyId: number; personId: number }> = [];
  for (const [i, email] of emails.entries()) {
    const domain = email.split("@")[1]!;
    const c = await makeCompany({ name: `Verify ${drafts}-${i}`, domain, people: [{ name: `Person ${drafts}-${i}`, email }] });
    recipients.push({ companyId: c.company.id, personId: c.people[0]!.id });
  }
  const draft = await makeDraft({ name: `Germany Q4 ${drafts}`, createdById: owner.id, recipients });
  return { id: draft.id, personIds: recipients.map((r) => r.personId) };
}

async function wizardRun(campaignId: number, personIds: number[]) {
  return enqueueJob({
    type: "verify.addresses",
    payload: { source: "wizard", campaignId, personIds, confirmedCount: personIds.length },
    dedupeKey: `verify:campaign:${campaignId}`,
    priority: 20,
    createdById: owner.id,
  });
}

async function finishJob(id: number) {
  await dbWrite((c) => c.job.update({ where: { id }, data: { status: "CANCELLED", activeDedupeKey: null, finishedAt: new Date() } }));
}

async function page(campaignId: number, user: TestUser = owner): Promise<string> {
  auth.user = user;
  const el = await VerifyStepPage({ params: Promise.resolve({ id: String(campaignId) }), searchParams: Promise.resolve({}) } as never);
  return html(renderToStaticMarkup(el));
}

beforeAll(async () => {
  mg = await connectFakeMailgun();
  owner = asUser(await makeUser("Arslan", { role: "OWNER" }));
  member = asUser(await makeUser("Ali", { role: "MEMBER" }));
});

beforeEach(async () => {
  await setSettingValue("practice.copy", false);
  await setSettingValue("sending.mode", "LIVE");
  await setSettingValue("sending.goLive", true);
  await setSettingValue("verification.monthlyLimitUsd", 100);
  await dbWrite((c) => c.systemState.deleteMany({ where: { key: "checks.pause" } }));
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("the Verify step page", () => {
  it("before go-live: nothing to check yet", async () => {
    await setSettingValue("sending.mode", "TEST");
    await setSettingValue("sending.goLive", false);
    const d = await draftWith(["tina@valid.test"]);
    const out = await page(d.id);
    expect(out).toContain("Check the addresses");
    expect(out).toContain("Nothing to check yet.");
    // Test mode only ever emails the test list (M6-DESIGN §2.7), so its sentence doesn't mention going live.
    expect(out).toContain("Test mode only emails your test list, and those addresses count as checked.");
    expect(out).toContain("Test mode");
  });

  it("a dry run in the practice copy offers to check them anyway with the test checker", async () => {
    await setSettingValue("sending.mode", "DRY_RUN");
    await setSettingValue("practice.copy", true);
    const d = await draftWith(["dora@valid.test", "dirk@valid.test"]);
    const out = await page(d.id);
    expect(out).toContain("This campaign is a dry run, so addresses don't need checking.");
    expect(out).toContain(
      "2 addresses here were never checked or were checked long ago. You can check them now, so they're ready for a live campaign later.",
    );
    expect(out).toContain("The practice copy uses the free test checker.");
    expect(out).toContain("Check them anyway");
  });

  it("needs checks: the counts, the cost and the buttons; over the monthly limit for the Owner and a Member", async () => {
    const d = await draftWith(["nina@valid.test", "nils@valid.test", "nora@valid.test"]);
    const out = await page(d.id);
    expect(out).toContain("3 addresses need a check");
    expect(out).toContain("3 were never checked");
    expect(out).toContain("Cost: about $0.04 (3 checks × $0.012). Up to $0.01 more if some need a second check tomorrow.");
    expect(out).toContain("Continue without checking");
    expect(out).toContain("Check 3 addresses");
    expect(out).toContain(">Live<");

    await setSettingValue("verification.monthlyLimitUsd", 0.01);
    expect(await page(d.id)).toContain(
      "That would pass this month's check limit of $0.01 ($0 used so far). Raise the limit in Settings › Deliverability, or check fewer addresses.",
    );
    expect(await page(d.id, member)).toContain(
      "That would pass this month's check limit of $0.01 ($0 used so far). Ask the Owner to raise the limit in Settings › Deliverability.",
    );
  });

  it("not ready without a key", async () => {
    const d = await draftWith(["kim@valid.test"]);
    await deleteSecret("mailgun.apiKey");
    try {
      const out = await page(d.id);
      expect(out).toContain("1 address needs a check");
      expect(out).toContain("Address checks need a Mailgun key. The Owner can connect Mailgun in Settings › Sending & Mailgun.");
      expect(out).toContain("Continue without checking");
      expect(out).not.toContain("Check 1 address");
    } finally {
      await setSecret("mailgun.apiKey", mg.apiKey, null);
    }
  });

  it("queued behind another run, running, waiting after a deferral", async () => {
    const d = await draftWith(["rita@valid.test", "rolf@valid.test"]);
    const other = await enqueueJob({ type: "verify.addresses", payload: { source: "contacts", personIds: [1], confirmedCount: 1, recheckRecent: false } });
    await setRunState(other.id, { status: "RUNNING" });
    const run = await wizardRun(d.id, d.personIds);
    let out = await page(d.id);
    expect(out).toContain("Waiting to start: another address check run is going on.");
    expect(out).toContain("Stop checking");
    await finishJob(other.id);

    await setRunState(run.id, { status: "RUNNING", done: 12, total: 40 });
    out = await page(d.id);
    expect(out).toContain("Checking addresses");
    expect(out).toContain("12 of 40 checked");
    expect(out).toContain('role="progressbar"');
    expect(out).toContain("You can leave this page. The checks keep running, and you get a notification when they're done.");

    const at = new Date(Date.now() + 65 * 60_000);
    await setRunState(run.id, { status: "QUEUED", done: 12, total: 40, runAt: at, summary: "Waiting: some checks will be tried again later." });
    out = await page(d.id);
    expect(out).toContain(`Waiting: some checks will be tried again at ${whenText(at, TZ, new Date())}.`);
    expect(out).toContain("Stop checking");
    await finishJob(run.id);
  });

  it("paused: the pause text with Stop, the Owner's link and the Member's note", async () => {
    const d = await draftWith(["paula@valid.test"]);
    const run = await wizardRun(d.id, d.personIds);
    await setRunState(run.id, { status: "QUEUED", runAt: new Date(Date.now() + 3_600_000), summary: "Paused: Address checks paused." });
    await pauseChecks("auth", "Address checks paused: Mailgun didn't accept the key.", "Invalid private key");
    const ownerView = await page(d.id);
    expect(ownerView).toContain("Address checks paused: Mailgun didn't accept the key.");
    expect(ownerView).toContain("Open Settings › Deliverability");
    expect(ownerView).toContain("Stop checking");
    const memberView = await page(d.id, member);
    expect(memberView).toContain("The Owner can fix this in Settings.");
    expect(memberView).not.toContain("Open Settings › Deliverability");
    expect(memberView).toContain("Stop checking");
    await finishJob(run.id);
  });

  it("done: the split lines, what still needs a check and who is left out", async () => {
    const d = await draftWith([
      "anna@valid.test",
      "risky1@valid.test",
      "ok@catchall-low.test",
      "ok@catchall-medium.test",
      "temp1@valid.test",
      "bad1@valid.test",
      "x@disposable.test",
      "t@timeout.test",
      "flaky@valid.test",
    ]);
    mg.fake.setValidation("flaky@valid.test", { status: 500 });
    const run = await wizardRun(d.id, d.personIds);
    await runCheckJob(run.id);
    const out = await page(d.id);
    expect(out).toContain("Checks finished");
    for (const line of [
      "2 can be emailed (1 of them can't be confirmed but is low risk).",
      "1 doesn't exist. It's left out and on the do-not-email list now.",
      "1 shouldn't be emailed: the check says not to. It's left out and on the do-not-email list now.",
      "1 is rated high risk. Your check settings skip these.",
      "1 can't be confirmed. Your check settings skip these.",
      "1 is a throwaway address. Your check settings skip these.",
      "1 got no answer. It's checked again 24 hours after the first try, and emailed if it passes.",
      "1 couldn't be checked right now. It's left out at launch unless you check it again.",
      "Cost $0.10.",
    ]) {
      expect(out).toContain(line);
    }
    // The one not reached still needs a check; the first "no answer" waits for its second check.
    expect(out).toContain("1 address needs a check");
    expect(out).toContain("1 address waits for its second check; it's checked again after launch.");
    expect(out).toContain("Who is left out (5)");
    expect(out).toContain(" · bad1@valid.test · ");
    expect(out).toContain("— doesn't exist");
    expect(out).toContain("— a throwaway address");
  });
});

describe("the Schedule step's check note", () => {
  it("says how many unchecked people launch leaves out", async () => {
    const d = await draftWith(["sam@valid.test", "sue@valid.test"]);
    auth.user = owner;
    const el = await ScheduleStepPage({ params: Promise.resolve({ id: String(d.id) }), searchParams: Promise.resolve({}) } as never);
    const out = html(renderToStaticMarkup(el));
    expect(out).toContain("2 people with unchecked addresses will be left out when you launch.");
    expect(out).toContain(`href="/campaigns/${d.id}/setup/verify"`);
  });
});
