import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { addSenderAddress, clearJobs, fastMailgun, healthFetch, makeUser, queuedJobs, setSettingValue } from "../mailgun-setup/helpers";

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

/**
 * Apply recommended settings, the route sync and "Your Mailgun plan" in own-mailbox mode (MAIN-DOMAIN-DESIGN O8, O20,
 * O21, O22, §2.8, §4), against a fake on the free plan whose domain's MX isn't Mailgun's: no request ever touches
 * /v3/routes, no spam-filter or message_ttl change, the certificate's 402 is "not in plan", webhooks only with a public
 * address, the route sync finishes at once without a Mailgun call, and the plan is saved with the numbers.
 */

const t = await createTestDb("own-apply-routes");
const mg: FakeConnection = await connectFakeMailgun({
  domain: "example.com",
  region: "US",
  replies: "own-mailbox",
  fromAddress: "contact@example.com",
  plan: "free",
  fake: { domain: "example.com", region: "US", plan: "free", receivesMail: false },
});
const { db } = await import("@/server/db");
const { getSetting } = await import("@/server/settings");
const apply = await import("@/server/services/mailgun/apply-settings");
const routes = await import("@/server/services/mailgun/routes");
const { loadPlanLimits } = await import("@/server/services/mailgun/plan");
const { OWN_MAILBOX_TEXTS } = await import("@/core/sending/own-mailbox");
const { APPLY_STEP_TEXTS, applyStepStatus } = await import("@/core/dns/checklist");
const { WEBHOOK_TYPES, WEBHOOKS_OK_TEXT } = await import("@/server/services/mailgun/webhooks-setup");
const { syncRoutesJob } = await import("../../../worker/jobs/mailgun-sync-routes");
const sending = await import("@/app/(app)/settings/sending/actions");

const PUB = "http://127.0.0.1:3999";
const NOT_NEEDED = "Not needed: replies go to your own mailbox.";
const previousPub = process.env.APP_PUBLIC_URL;
let owner: TestUser;

function asUser(u: { id: number; email: string; name: string; role: "OWNER" | "MEMBER" }): TestUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, timeZone: "Asia/Karachi", sessionId: 1 };
}

async function run(opts: Partial<Parameters<typeof apply.runApplySettings>[0]> = {}) {
  return apply.runApplySettings({ byUserId: owner.id, mailgun: fastMailgun, fetchImpl: healthFetch(), ...opts });
}

function step(state: { steps: Array<{ key: string; ok: boolean | null; text: string; detail: string | null }> }, key: string) {
  const s = state.steps.find((x) => x.key === key);
  if (!s) throw new Error(`No step ${key}: ${state.steps.map((x) => x.key).join(", ")}`);
  return s;
}

/** Every request the fake got to Mailgun's routes, or that changed the spam filter or the stored-message retention. */
function forbiddenRequests() {
  return mg.fake.requests.filter((r) => {
    if (r.path.startsWith("/v3/routes")) return true;
    const body = r.body && typeof r.body === "object" ? (r.body as Record<string, unknown>) : {};
    return r.method === "PUT" && ("spam_action" in body || "message_ttl" in body);
  });
}

beforeAll(async () => {
  owner = asUser(await makeUser("Arslan", { role: "OWNER", replyInbox: "arslan.owner@gmail.com" }));
});

beforeEach(async () => {
  auth.user = owner;
  delete process.env.APP_PUBLIC_URL;
  mg.fake.reset();
  mg.fake.setDns("all");
  await setSettingValue("mailgun.unsubscribeTest", { setup: "A", status: "untested", domain: null, mailboxes: [], headersOk: null, decidedAt: null, decidedById: null, note: null });
});

afterAll(async () => {
  if (previousPub === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previousPub;
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("Apply recommended settings in own-mailbox mode", () => {
  it("without a public address: tracking off, unsubscribe on, the inbound steps not needed, the 402 not in plan, no route", async () => {
    await clearJobs();
    const state = await run();
    expect(state.steps.map((s) => [s.key, s.ok])).toEqual([
      ["public-address", null],
      ["tracking-open", true],
      ["tracking-click", true],
      ["unsubscribe", true],
      ["spam-filter", null],
      ["retention", null],
      // Review DOMAIN-3: the Free plan's missing certificate is expected here, not a failure (no result, not red).
      ["certificate", null],
      ["https", null],
      ["signing-key", true],
      ["webhooks", null],
      ["routes", null],
    ]);
    expect(step(state, "public-address").text).toBe(OWN_MAILBOX_TEXTS.applyNoPublicAddress);
    expect(step(state, "public-address").text).toBe(
      "No public address yet: Mailgun's reports come through the app's hourly check instead. Remote access is optional in your setup (Cloudflare guide).",
    );
    for (const key of ["spam-filter", "retention", "routes"]) expect(step(state, key).text).toBe(NOT_NEEDED);
    expect(step(state, "unsubscribe").text).toBe(apply.APPLY_TEXTS.unsubscribeOn);
    expect(step(state, "certificate").text).toBe(apply.APPLY_TEXTS.certNotInPlan);
    // The card words the step by the same sentence (spelled out in both files).
    expect(apply.APPLY_TEXTS.certNotInPlan).toBe(APPLY_STEP_TEXTS.certNotInPlan);
    expect(state.certificate).toMatchObject({ host: "email.example.com", status: "not-in-plan" });
    // Review SCREENS-06: the https and webhooks steps say what the Free plan and no public address mean.
    expect(step(state, "https").text).toBe(APPLY_STEP_TEXTS.httpsNotInPlanOwn);
    expect(step(state, "webhooks").text).toBe(APPLY_STEP_TEXTS.webhooksOptionalOwn);
    // The Recommended settings card's words: nothing reads "Waiting" or red in the owner's setup.
    expect(state.steps.map((s) => [s.key, applyStepStatus(s).word ?? applyStepStatus(s).status])).toEqual([
      ["public-address", "Optional"],
      ["tracking-open", "ok"],
      ["tracking-click", "ok"],
      ["unsubscribe", "ok"],
      ["spam-filter", "Not needed"],
      ["retention", "Not needed"],
      ["certificate", "Not in your plan"],
      ["https", "Not in your plan"],
      ["signing-key", "ok"],
      ["webhooks", "Optional"],
      ["routes", "Not needed"],
    ]);

    // What Mailgun now has, and what it was never asked.
    const fs = mg.fake.state();
    expect(fs.tracking.open.active).toBe(false);
    expect(fs.tracking.click.active).toBe(false);
    expect(fs.tracking.unsubscribe).toMatchObject({ active: true, htmlFooter: "", textFooter: "" });
    expect(fs.routes).toEqual([]);
    expect(forbiddenRequests()).toEqual([]);
    expect(mg.fake.requests.some((r) => r.path.includes("/webhooks"))).toBe(false);
    expect(mg.fake.requests.some((r) => r.method === "POST" && r.path === "/v2/x509/email.example.com")).toBe(true);
    // No route sync is queued; a fresh domain check is.
    expect(await queuedJobs("mailgun.syncRoutes")).toHaveLength(0);
    expect(await queuedJobs("mailgun.checkDomain")).toHaveLength(1);
  });

  it("the job's summary counts nothing as left to do on the Free plan (review DOMAIN-3)", async () => {
    await clearJobs();
    const jobCtx = { createdById: owner.id, jobId: null, progress: async () => undefined } as unknown as Parameters<typeof apply.applySettingsHandler>[1];
    const result = (await apply.applySettingsHandler({}, jobCtx)) as { summary: string; failed: number };
    expect(result.failed).toBe(0);
    expect(result.summary).toBe("All 4 steps done.");
    expect(result.summary).not.toContain("what's left");
  });

  it("a restored Setup B still gets Setup A: Mailgun's unsubscribe handling on", async () => {
    await setSettingValue("mailgun.unsubscribeTest", { setup: "B", status: "untested", domain: null, mailboxes: [], headersOk: null, decidedAt: null, decidedById: null, note: null });
    const state = await run();
    expect(step(state, "unsubscribe")).toMatchObject({ ok: true, text: apply.APPLY_TEXTS.unsubscribeOn });
    expect(mg.fake.state().tracking.unsubscribe.active).toBe(true);
  });

  it("with a working public address: the webhooks are set, the routes still aren't", async () => {
    process.env.APP_PUBLIC_URL = PUB;
    const state = await run();
    expect(step(state, "public-address")).toMatchObject({ ok: true, text: `The public address answers: ${PUB}.` });
    expect(step(state, "webhooks")).toMatchObject({ ok: true, text: WEBHOOKS_OK_TEXT });
    expect(step(state, "routes")).toMatchObject({ ok: null, text: NOT_NEEDED });
    const fs = mg.fake.state();
    for (const type of WEBHOOK_TYPES) expect(fs.webhooks[type]).toEqual([`${PUB}/api/webhooks/mailgun/events`]);
    expect(fs.routes).toEqual([]);
    expect(forbiddenRequests()).toEqual([]);
  });

  it("a public address that doesn't answer is still a failed step (it was set up on purpose); the webhooks wait", async () => {
    process.env.APP_PUBLIC_URL = PUB;
    const state = await run({ fetchImpl: healthFetch({ status: 502 }) });
    expect(step(state, "public-address")).toMatchObject({ ok: false, text: apply.publicAddressDownText(PUB) });
    expect(step(state, "webhooks")).toMatchObject({ ok: null, text: apply.APPLY_TEXTS.skippedNoPublicAddress });
    expect(step(state, "routes")).toMatchObject({ ok: null, text: NOT_NEEDED });
    expect(forbiddenRequests()).toEqual([]);
  });
});

describe("the route sync in own-mailbox mode", () => {
  it("returns ok without asking Mailgun anything and leaves every sending address as it was", async () => {
    const address = await addSenderAddress(owner.id, mg.domainId, "arslan", "ok");
    const before = await db.senderAddress.findUniqueOrThrow({ where: { id: address.id } });
    for (const pub of [undefined, PUB]) {
      if (pub) process.env.APP_PUBLIC_URL = pub;
      mg.fake.reset();
      const res = await routes.syncRoutes({ mailgun: fastMailgun, byUserId: owner.id });
      expect(res).toEqual({ ok: true, created: 0, updated: 0, deleted: 0, problems: [], senders: 0, retryable: false });
      expect(mg.fake.requests.filter((r) => r.path.startsWith("/v3/routes"))).toEqual([]);
    }
    expect(await db.senderAddress.findUniqueOrThrow({ where: { id: address.id } })).toEqual(before);
    expect(await db.activityLog.count({ where: { type: "mailgun.routesSynced" } })).toBe(0);
  });

  it("the route-sync job finishes at once and says why", async () => {
    mg.fake.reset();
    const out = (await syncRoutesJob.handler({}, { jobId: 1, createdById: owner.id, signal: new AbortController().signal, progress: async () => undefined })) as {
      summary: string;
      created: number;
      problems: string[];
    };
    expect(out).toMatchObject({ summary: NOT_NEEDED, created: 0, problems: [] });
    expect(mg.fake.requests.filter((r) => r.path.startsWith("/v3/routes"))).toEqual([]);
  });
});

describe("Your Mailgun plan (Save these numbers)", () => {
  it("saves the plan with the numbers and one activity; the plan's limits apply at once", async () => {
    const activities = () => db.activityLog.findMany({ where: { type: "settings.updated" }, orderBy: { id: "asc" } });
    const before = (await activities()).length;

    // Scale: 30 days of logs and 7 of stored replies. In own-mailbox mode Apply leaves stored replies alone: plain toast.
    expect(await sending.saveRetentionAction({ logRetentionDays: 30, messageRetentionDays: 7, plan: "scale" })).toEqual({
      ok: true,
      data: null,
      message: "Saved.",
    });
    expect(await getSetting("mailgun.plan")).toBe("scale");
    expect(await getSetting("mailgun.logRetentionDays")).toBe(30);
    expect(await getSetting("mailgun.messageRetentionDays")).toBe(7);
    expect(await loadPlanLimits()).toMatchObject({ plan: "scale", assumed: false, dailyLimit: null, logDays: 30 });

    expect(await sending.saveRetentionAction({ logRetentionDays: 1, messageRetentionDays: 1, plan: "free" })).toMatchObject({ ok: true });
    expect(await getSetting("mailgun.plan")).toBe("free");
    expect(await getSetting("mailgun.logRetentionDays")).toBe(1);
    expect(await getSetting("mailgun.messageRetentionDays")).toBe(1);
    const logged = (await activities()).slice(before);
    expect(logged.map((a) => a.summary)).toEqual([
      "Arslan set the Mailgun plan to Scale or higher, with 30 days of event logs and 7 days of stored replies",
      "Arslan set the Mailgun plan to Free, with 1 day of event logs and 1 day of stored replies",
    ]);
    expect(logged[1]!.data).toEqual({ key: "mailgun.retention", logRetentionDays: 1, messageRetentionDays: 1, plan: "free" });

    // Not sure: the Free plan's limits are assumed in own-mailbox mode; the same numbers again change nothing.
    expect(await sending.saveRetentionAction({ logRetentionDays: 1, messageRetentionDays: 1, plan: null })).toMatchObject({ ok: true });
    expect(await getSetting("mailgun.plan")).toBeNull();
    expect(await loadPlanLimits()).toMatchObject({ plan: "free", assumed: true });
    const count = (await activities()).length;
    expect(await sending.saveRetentionAction({ logRetentionDays: 1, messageRetentionDays: 1, plan: null })).toMatchObject({ ok: true });
    expect(await sending.saveRetentionAction({ logRetentionDays: 1, messageRetentionDays: 1 })).toMatchObject({ ok: true });
    expect((await activities()).length).toBe(count);
  });

  it("a refused input writes nothing, and a Member can't save", async () => {
    const count = await db.activityLog.count();
    expect(await sending.saveRetentionAction({ logRetentionDays: 1, messageRetentionDays: 1, plan: "gold" as never })).toMatchObject({ ok: false });
    expect(await sending.saveRetentionAction({ logRetentionDays: 0, messageRetentionDays: 1, plan: "free" })).toMatchObject({
      ok: false,
      fieldErrors: { logRetentionDays: ["Use 1 to 30 days."] },
    });
    auth.user = asUser(await makeUser("Ali", { replyInbox: "ali.khan@gmail.com" }));
    expect(await sending.saveRetentionAction({ logRetentionDays: 5, messageRetentionDays: 1, plan: "foundation" })).toEqual({
      ok: false,
      error: "Only the Owner can do this.",
    });
    expect(await getSetting("mailgun.plan")).toBeNull();
    expect(await db.activityLog.count()).toBe(count);
  });
});
