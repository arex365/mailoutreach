import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { startFakeMailgun, type FakeMailgun } from "../../fake-mailgun/server";
import { addSenderAddress, clearJobs, makeUser, queuedJobs, setSettingValue } from "../mailgun-setup/helpers";

/**
 * Connecting in own-mailbox mode (MAIN-DOMAIN-DESIGN §2.2, §2.7, §3.1, O1, O2, O7, O8, O22): "How the app sends" is saved
 * with the connection; the first own-mailbox connect sets the Free plan; nobody's address moves and no route sync is
 * queued; switching modes is a domain change (both ways, also on the same domain); a saved From must fit the new mode
 * and domain; the website domain is refused in app mode before Mailgun is asked. Fakes only (example.com, US, free).
 */

const t = await createTestDb("own-connect");
const { db, dbWrite } = await import("@/server/db");
const { getSetting } = await import("@/server/settings");
const connect = await import("@/server/services/mailgun/connect");
const { loadTeamFrom } = await import("@/server/services/mailgun/team-from");
const { loadPlanLimits } = await import("@/server/services/mailgun/plan");
const { SENDING_DOMAIN_TEXTS } = await import("@/core/sender-address");
const { TEAM_FROM_TEXTS } = await import("@/core/sending/from-address");
const { OWN_MAILBOX_TEXTS } = await import("@/core/sending/own-mailbox");
const { GO_LIVE_COPY } = await import("@/core/sending/go-live-copy");

const deps = { retryDelayMs: () => 0 };
const OWN = "example.com";
const APP = "send.example.com";
let fakeOwn: FakeMailgun;
let fakeApp: FakeMailgun;
let owner: { id: number; name: string };
let member: { id: number; name: string };
const previousBase = process.env.OUTREACH_MAILGUN_BASE_URL;

/** Runs `fn` against one fake (the connection test asks it for the domain). */
async function via<T>(fake: FakeMailgun, fn: () => Promise<T>): Promise<T> {
  process.env.OUTREACH_MAILGUN_BASE_URL = fake.origin;
  return fn();
}

function nextSentence(domainState: string | null): string {
  return domainState === "active"
    ? "Next: click Apply recommended settings on the Domain checklist."
    : "Mailgun hasn't confirmed your DNS records yet: add them from the Domain checklist.";
}

async function lastActivity(type: string) {
  return db.activityLog.findFirstOrThrow({ where: { type }, orderBy: { id: "desc" } });
}

/** Every request the two fakes got (the website refusal must reach neither). */
const requestCount = () => fakeOwn.requests.length + fakeApp.requests.length;

beforeAll(async () => {
  fakeOwn = await startFakeMailgun({ domain: OWN, region: "US", plan: "free", receivesMail: false });
  fakeApp = await startFakeMailgun({ domain: APP, region: "US" });
  const o = await makeUser("Arslan", { role: "OWNER", replyInbox: "arslan.owner@gmail.com" });
  owner = { id: o.id, name: o.name };
  const m = await makeUser("Ali", { replyInbox: "ali.khan@gmail.com" });
  member = { id: m.id, name: m.name };
});

afterAll(async () => {
  if (previousBase === undefined) delete process.env.OUTREACH_MAILGUN_BASE_URL;
  else process.env.OUTREACH_MAILGUN_BASE_URL = previousBase;
  await Promise.all([fakeOwn.close(), fakeApp.close()]);
  await db.$disconnect();
  t.cleanup();
});

describe("the sending domain and the mode", () => {
  it("app mode refuses polygonparadise.com with the sentence naming the choice, before Mailgun is asked", async () => {
    const before = requestCount();
    for (const replies of [undefined, "app" as const]) {
      const res = await via(fakeOwn, () =>
        connect.connectMailgun(owner, { region: "US", domain: "polygonparadise.com", apiKey: "key-fake-api", ...(replies ? { replies } : {}) }, deps),
      );
      expect(res).toEqual({ ok: false, field: "domain", error: SENDING_DOMAIN_TEXTS.website, detail: null });
    }
    // Own-mailbox mode: www. is refused, the sandbox with the own sentence.
    expect(
      await connect.connectMailgun(owner, { region: "US", domain: "www.polygonparadise.com", apiKey: "key-fake-api", replies: "own-mailbox" }, deps),
    ).toEqual({ ok: false, field: "domain", error: SENDING_DOMAIN_TEXTS.www, detail: null });
    expect(
      await connect.testMailgunConnection({ region: "US", domain: "sandbox1.mailgun.org", apiKey: "key-fake-api", replies: "own-mailbox" }, deps),
    ).toMatchObject({ ok: false, field: "domain", error: SENDING_DOMAIN_TEXTS.sandboxOwn });
    expect(requestCount()).toBe(before);
    expect(await getSetting("mailgun.domain")).toBeNull();
    expect(await db.setting.count({ where: { key: "mailgun.replies" } })).toBe(0);
  });

  it("the first own-mailbox connect: the mode, the Free plan with 1/1 days and its activity, no address, no route sync", async () => {
    await clearJobs();
    const res = await via(fakeOwn, () =>
      connect.connectMailgun(owner, { region: "US", domain: OWN, apiKey: "key-fake-api", replies: "own-mailbox" }, deps),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // No From saved yet: the next step is the From card, then the plan sentence.
    expect(res.message).toBe(`Connected to ${OWN} (US). ${OWN_MAILBOX_TEXTS.connectedNext}${OWN_MAILBOX_TEXTS.planSetFree}`);
    expect(res.message).toBe(
      "Connected to example.com (US). Replies go to your own mailbox. Next: type your From address in the From address card below. The app keeps to Mailgun's Free plan (100 emails a day, 1 day of logs). If you upgrade, choose the plan under Advanced.",
    );
    expect(await getSetting("mailgun.replies")).toBe("own-mailbox");
    expect(await getSetting("mailgun.domain")).toBe(OWN);
    expect(await getSetting("mailgun.region")).toBe("US");
    expect(await getSetting("mailgun.plan")).toBe("free");
    expect(await getSetting("mailgun.logRetentionDays")).toBe(1);
    expect(await getSetting("mailgun.messageRetentionDays")).toBe(1);
    expect(await loadPlanLimits()).toMatchObject({ plan: "free", assumed: false, dailyLimit: 100, logDays: 1 });
    const plan = await lastActivity("settings.updated");
    expect(plan.summary).toBe("Arslan set the Mailgun plan to Free, with 1 day of event logs and 1 day of stored replies");
    expect(plan.data).toEqual({ key: "mailgun.retention", logRetentionDays: 1, messageRetentionDays: 1, plan: "free" });
    expect((await lastActivity("mailgun.connected")).data).toMatchObject({ domain: OWN, region: "US", replies: "own-mailbox" });

    expect(await db.sendingDomain.count()).toBe(1);
    expect(await db.sendingDomain.findUniqueOrThrow({ where: { name: OWN } })).toMatchObject({ active: true, region: "US" });
    expect(await db.senderAddress.count()).toBe(0);
    expect(await queuedJobs("mailgun.syncRoutes")).toHaveLength(0);
    expect(await queuedJobs("mailgun.checkDomain")).toHaveLength(1);
    expect(await queuedJobs("mailgun.syncSuppressions")).toHaveLength(1);
    // Nothing on the fake but read-only calls (the domain and the signing key); never a route.
    expect(fakeOwn.requests.every((r) => r.method === "GET")).toBe(true);
    expect(fakeOwn.requests.some((r) => r.path.startsWith("/v3/routes"))).toBe(false);

    const team = await loadTeamFrom();
    expect(team).toMatchObject({ replies: "own-mailbox", address: null, ownFrom: null, evidenceFrom: null, problem: OWN_MAILBOX_TEXTS.fromMissing(OWN) });
  });

  it("a reconnect leaves a plan the Owner chose alone; with a fitting From the message says replies go to the own mailbox", async () => {
    await connect.saveRetention(owner, { logRetentionDays: 5, messageRetentionDays: 1, plan: "foundation" });
    expect(await getSetting("mailgun.plan")).toBe("foundation");
    expect((await lastActivity("settings.updated")).summary).toBe(
      "Arslan set the Mailgun plan to Foundation, with 5 days of event logs and 1 day of stored replies",
    );
    const from = await connect.saveFromAddress(owner, { fromAddress: "contact@example.com" });
    expect(from).toMatchObject({ ok: true, fromAddress: "contact@example.com" });
    const changes = await db.activityLog.count({ where: { type: "mailgun.domainChanged" } });
    const planChanges = await db.activityLog.count({ where: { type: "settings.updated" } });

    const res = await via(fakeOwn, () => connect.connectMailgun(owner, { region: "US", domain: OWN, apiKey: null }, deps));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.message).toBe(`Connected to ${OWN} (US). ${OWN_MAILBOX_TEXTS.connectedMode} ${nextSentence(res.domainState)}`);
    expect(res.message).not.toContain(OWN_MAILBOX_TEXTS.planSetFree.trim());
    expect(await getSetting("mailgun.plan")).toBe("foundation");
    expect(await getSetting("mailgun.logRetentionDays")).toBe(5);
    expect(await getSetting("mailgun.replies")).toBe("own-mailbox");
    expect(await db.activityLog.count({ where: { type: "mailgun.domainChanged" } })).toBe(changes);
    expect(await db.activityLog.count({ where: { type: "settings.updated" } })).toBe(planChanges);
    expect((await loadTeamFrom()).ownFrom).toBe("contact@example.com");
  });
});

describe("switching modes (a domain change, O2)", () => {
  it("own-mailbox → app on another domain: the shared From still fits, go-live-style resets, and the routes are synced again", async () => {
    await clearJobs();
    // contact@example.com fits send.example.com as a shared From address.
    const res = await via(fakeApp, () => connect.connectMailgun(owner, { region: "US", domain: APP, apiKey: null, replies: "app" }, deps));
    expect(res.ok).toBe(true);
    expect(await getSetting("mailgun.replies")).toBe("app");
    expect(await getSetting("mailgun.fromAddress")).toBe("contact@example.com");
    expect((await loadTeamFrom()).address).toBe("contact@example.com");
    const changed = await lastActivity("mailgun.domainChanged");
    expect(changed.summary).toBe(`Arslan changed the sending domain from ${OWN} to ${APP}`);
    expect(changed.data).toMatchObject({ from: OWN, to: APP, fromReplies: "own-mailbox", toReplies: "app", movedAddresses: 0 });
    expect(await queuedJobs("mailgun.syncRoutes")).toHaveLength(1);
  });

  it("app → own-mailbox: refused while a live campaign runs; then go-live ends, the reply test resets, no address moves", async () => {
    // The app-mode world on send.example.com: two addresses with working routes, a passed reply test, live, pushed suppressions.
    const appRow = await db.sendingDomain.findUniqueOrThrow({ where: { name: APP } });
    const a1 = await addSenderAddress(owner.id, appRow.id, "arslan", "ok");
    const a2 = await addSenderAddress(member.id, appRow.id, "ali", "ok");
    await setSettingValue("mailgun.unsubscribeTest", {
      setup: "A",
      status: "passed",
      domain: APP,
      mailboxes: [],
      headersOk: true,
      decidedAt: new Date().toISOString(),
      decidedById: owner.id,
      note: null,
      from: "contact@example.com",
    });
    await setSettingValue("sending.goLive", true);
    await setSettingValue("sending.goLiveAt", "2026-09-20T10:00:00.000Z");
    await setSettingValue("sending.goLiveDomain", APP);
    await dbWrite((c) =>
      c.suppression.create({ data: { emailNorm: "gone@studio.de", reason: "BOUNCED", source: "webhook", pushedToMailgunAt: new Date() } }),
    );
    await dbWrite((c) => c.campaign.create({ data: { name: "Live run", createdById: owner.id, mode: "LIVE", status: "RUNNING" } }));
    const fromRowBefore = await db.setting.findUniqueOrThrow({ where: { key: "mailgun.fromAddress" } });

    const before = fakeOwn.requests.length;
    expect(await via(fakeOwn, () => connect.connectMailgun(owner, { region: "US", domain: OWN, apiKey: null, replies: "own-mailbox" }, deps))).toEqual({
      ok: false,
      field: "domain",
      error: "Finish or cancel “Live run” first: it sends from send.example.com.",
      detail: null,
    });
    expect(fakeOwn.requests.length).toBe(before);
    expect(await getSetting("mailgun.replies")).toBe("app");

    await dbWrite((c) => c.campaign.updateMany({ where: { name: "Live run" }, data: { status: "CANCELLED" } }));
    await clearJobs();
    await new Promise((r) => setTimeout(r, 5)); // the From row's updatedAt must be able to move
    const res = await via(fakeOwn, () => connect.connectMailgun(owner, { region: "US", domain: OWN, apiKey: null, replies: "own-mailbox" }, deps));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.message).toContain(`Connected to ${OWN} (US). ${OWN_MAILBOX_TEXTS.connectedMode}`);
    expect(res.message).toContain(GO_LIVE_COPY.endedByDomainChange(APP, OWN));
    // The plan chosen before (Foundation) stays: this isn't a connect without a plan.
    expect(res.message).not.toContain(OWN_MAILBOX_TEXTS.planSetFree.trim());
    expect(await getSetting("mailgun.plan")).toBe("foundation");

    expect(await getSetting("mailgun.replies")).toBe("own-mailbox");
    expect(await getSetting("sending.goLive")).toBe(false);
    expect(await getSetting("sending.goLiveAt")).toBe("2026-09-20T10:00:00.000Z");
    expect(await getSetting("mailgun.unsubscribeTest")).toMatchObject({ status: "untested", domain: null, setup: "A", mailboxes: [] });
    // The From stays (it fits own-mailbox mode on example.com); its evidence moment moved to the switch.
    const fromRowAfter = await db.setting.findUniqueOrThrow({ where: { key: "mailgun.fromAddress" } });
    expect(fromRowAfter.value).toBe("contact@example.com");
    expect(fromRowAfter.updatedAt.getTime()).toBeGreaterThan(fromRowBefore.updatedAt.getTime());
    expect(await loadTeamFrom()).toMatchObject({ replies: "own-mailbox", address: null, ownFrom: "contact@example.com", evidenceFrom: "contact@example.com" });
    // Nobody's address moved: the old ones are untouched on the (now inactive) old domain.
    const addresses = await db.senderAddress.findMany({ orderBy: { id: "asc" } });
    expect(addresses.map((a) => [a.id, a.address, a.domainId, a.retiredAt, a.routeStatus])).toEqual([
      [a1.id, "arslan@send.example.com", appRow.id, null, "ok"],
      [a2.id, "ali@send.example.com", appRow.id, null, "ok"],
    ]);
    expect((await db.sendingDomain.findUniqueOrThrow({ where: { name: APP } })).active).toBe(false);
    expect((await db.sendingDomain.findUniqueOrThrow({ where: { name: OWN } })).active).toBe(true);
    expect((await db.suppression.findUniqueOrThrow({ where: { emailNorm: "gone@studio.de" } })).pushedToMailgunAt).toBeNull();
    const changed = await lastActivity("mailgun.domainChanged");
    expect(changed.summary).toBe(`Arslan changed the sending domain from ${APP} to ${OWN}`);
    expect(changed.data).toMatchObject({ from: APP, to: OWN, fromReplies: "app", toReplies: "own-mailbox", movedAddresses: 0, goLiveEnded: true });
    expect(await queuedJobs("mailgun.syncRoutes")).toHaveLength(0);
    expect(await queuedJobs("mailgun.checkDomain")).toHaveLength(1);
    expect(await queuedJobs("mailgun.syncSuppressions")).toHaveLength(1);
  });

  it("a saved From that doesn't fit the new mode and domain is refused before Mailgun is asked (own and app sentences)", async () => {
    await setSettingValue("mailgun.fromAddress", "contact@other.com");
    const before = requestCount();
    expect(
      await via(fakeOwn, () => connect.connectMailgun(owner, { region: "US", domain: "mail.example.com", apiKey: null, replies: "own-mailbox" }, deps)),
    ).toEqual({ ok: false, field: "domain", error: OWN_MAILBOX_TEXTS.domainMisfit("contact@other.com", "mail.example.com"), detail: null });
    expect(OWN_MAILBOX_TEXTS.domainMisfit("contact@other.com", "mail.example.com")).toBe(
      "Your From address contact@other.com isn't on mail.example.com. Clear it in the From address card first, then connect again.",
    );
    // contact@example.com isn't on mail.example.com either (own-mailbox mode needs it exactly on the domain).
    await setSettingValue("mailgun.fromAddress", "contact@example.com");
    expect(
      await via(fakeOwn, () => connect.connectMailgun(owner, { region: "US", domain: "mail.example.com", apiKey: null, replies: "own-mailbox" }, deps)),
    ).toMatchObject({ ok: false, field: "domain", error: OWN_MAILBOX_TEXTS.domainMisfit("contact@example.com", "mail.example.com") });
    // The same domain in app mode: contact@example.com can't be a shared From on example.com itself.
    expect(await via(fakeOwn, () => connect.connectMailgun(owner, { region: "US", domain: OWN, apiKey: null, replies: "app" }, deps))).toEqual({
      ok: false,
      field: "domain",
      error: TEAM_FROM_TEXTS.domainMisfit("contact@example.com", OWN),
      detail: null,
    });
    expect(requestCount()).toBe(before);
    expect(await getSetting("mailgun.replies")).toBe("own-mailbox");
    expect(await getSetting("mailgun.domain")).toBe(OWN);
  });

  it("the same domain, the other mode, both ways: the switch summary, the reply test reset, routes only for app mode", async () => {
    await setSettingValue("mailgun.fromAddress", null);
    await clearJobs();
    const toApp = await via(fakeOwn, () => connect.connectMailgun(owner, { region: "US", domain: OWN, apiKey: null, replies: "app" }, deps));
    expect(toApp.ok).toBe(true);
    expect(await getSetting("mailgun.replies")).toBe("app");
    let changed = await lastActivity("mailgun.domainChanged");
    expect(changed.summary).toBe("Arslan switched replies for example.com to go through the app");
    expect(changed.data).toMatchObject({ from: OWN, to: OWN, fromRegion: "US", toRegion: "US", fromReplies: "own-mailbox", toReplies: "app" });
    // Back in app mode everyone's address follows the domain, and the routes are synced.
    expect(await db.senderAddress.count({ where: { retiredAt: null, address: { endsWith: `@${OWN}` } } })).toBe(2);
    expect(await queuedJobs("mailgun.syncRoutes")).toHaveLength(1);

    await clearJobs();
    await setSettingValue("sending.goLive", true);
    const toOwn = await via(fakeOwn, () => connect.connectMailgun(owner, { region: "US", domain: OWN, apiKey: null, replies: "own-mailbox" }, deps));
    expect(toOwn.ok).toBe(true);
    if (toOwn.ok) {
      expect(toOwn.message).toContain(OWN_MAILBOX_TEXTS.connectedNext);
      expect(toOwn.message).toContain(GO_LIVE_COPY.endedByDomainChange(OWN, OWN));
    }
    changed = await lastActivity("mailgun.domainChanged");
    expect(changed.summary).toBe("Arslan switched replies for example.com to your own mailbox");
    expect(changed.data).toMatchObject({ fromReplies: "app", toReplies: "own-mailbox", goLiveEnded: true });
    expect(await getSetting("sending.goLive")).toBe(false);
    expect(await getSetting("mailgun.unsubscribeTest")).toMatchObject({ status: "untested", setup: "A" });
    expect(await queuedJobs("mailgun.syncRoutes")).toHaveLength(0);
    // The addresses on example.com stay as they are (own-mailbox mode never retires or moves them).
    expect(await db.senderAddress.count({ where: { retiredAt: null, address: { endsWith: `@${OWN}` } } })).toBe(2);
    // A reconnect in the same mode is no change at all.
    const changes = await db.activityLog.count({ where: { type: "mailgun.domainChanged" } });
    expect((await via(fakeOwn, () => connect.connectMailgun(owner, { region: "US", domain: OWN, apiKey: null }, deps))).ok).toBe(true);
    expect(await db.activityLog.count({ where: { type: "mailgun.domainChanged" } })).toBe(changes);
    expect(await getSetting("mailgun.replies")).toBe("own-mailbox");
  });
});
