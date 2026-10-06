import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeDraft, setSettingValue } from "../campaigns/seed";
import { TESS, freshCheck, holdLease, resetGoLive, seedLiveTest, setupGoLive, type GoLiveWorld } from "./helpers";

/**
 * The go-live switch (M6-DESIGN §2.5, §2.6, §8 P2): the blockers refuse without any write; only the Owner may switch
 * it; going live writes the four settings with who, removes today's hand-set limit, logs one activity, tells every
 * active user and restarts the warm-up; an input changed between the check and the transaction refuses; a second call
 * and two calls at once go live once; a failed warm-up restart leaves go-live on and the next warm-up check repairs it;
 * and the card's view in each state. Real-data settings against the fake Mailgun; nothing reaches the network.
 */

type TestUser = { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number };
const auth = vi.hoisted(() => ({ user: null as TestUser | null }));
/** Hooks into the service's steps: run something right after the gate inputs were loaded; fail the warm-up restart. */
const hooks = vi.hoisted(() => ({ afterGate: null as null | (() => Promise<void>), failWarmup: false }));

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
vi.mock("@/server/services/reply-test", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/server/services/reply-test")>();
  return {
    ...orig,
    loadGateInputs: async (now?: Date) => {
      const gate = await orig.loadGateInputs(now);
      const after = hooks.afterGate;
      hooks.afterGate = null;
      if (after) await after();
      return gate;
    },
  };
});
vi.mock("@/server/services/sending/warmup-days", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/server/services/sending/warmup-days")>();
  return {
    ...orig,
    startWarmupAtGoLive: async (now: Date) => {
      if (hooks.failWarmup) {
        hooks.failWarmup = false;
        throw new Error("injected: the warm-up state kept changing");
      }
      return orig.startWarmupAtGoLive(now);
    },
  };
});

const t = await createTestDb("go-live-switch");
const { db, dbWrite } = await import("@/server/db");
const { getSetting, getSettings } = await import("@/server/settings");
const { setState } = await import("@/server/state");
const { readTyped } = await import("@/server/state-typed");
const { parseWarmupState } = await import("@/core/system-state-parse");
const { capDayOf, addCapDays } = await import("@/core/sending/capday");
const { MODE_GATE_TEXTS } = await import("@/core/sending/mode-gates");
const { GO_LIVE_COPY } = await import("@/core/sending/go-live-copy");
const { GoLiveError, goLive, loadGoLiveView } = await import("@/server/services/go-live");
const { evaluateWarmupDays } = await import("@/server/services/sending/warmup-days");
const { pauseSending } = await import("@/server/services/sending/pause");
const { goLiveAction } = await import("@/app/(app)/settings/sending/actions");

const ZONE = "Asia/Karachi";
let world: GoLiveWorld;
let owner: TestUser;
let member: TestUser;

function asUser(u: { id: number; name: string }, role: "OWNER" | "MEMBER"): TestUser {
  return { id: u.id, email: `${u.name.toLowerCase()}@polygonparadise.test`, name: u.name, role, timeZone: "Europe/Berlin", sessionId: 1 };
}

/** Ready to go live at `now`: a fresh check, a running background sender. */
async function ready(now: Date): Promise<void> {
  await freshCheck(now);
  await holdLease(now);
}

/** A warm-up that climbed before go-live: step 2, with history. */
async function climbedWarmup(): Promise<void> {
  const day = { day: "2026-09-01", cap: 50, used: 30, result: "up", bounces: 0, bounceSample: 30, complaints: 0, complaintSample: 30, stepAfter: 1 };
  await setState("warmup", {
    domain: "send.example.com",
    step: 2,
    lastEvaluatedCapDay: "2026-09-02",
    startedCapDay: "2026-08-31",
    history: [day, { ...day, day: "2026-09-02", stepAfter: 2 }],
  });
}

async function goLiveActivities() {
  return db.activityLog.findMany({ where: { type: "sending.goLive" }, orderBy: { id: "asc" } });
}

beforeAll(async () => {
  world = await setupGoLive();
  owner = asUser(world.owner, "OWNER");
  member = asUser(world.member, "MEMBER");
  await seedLiveTest(world);
});

beforeEach(async () => {
  auth.user = owner;
  hooks.afterGate = null;
  hooks.failWarmup = false;
  await resetGoLive();
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("refusals", () => {
  it("refuses with the blockers and writes nothing", async () => {
    const now = new Date();
    await ready(now);
    await holdLease(new Date(now.getTime() - 5 * 60_000)); // the background sender stopped
    await expect(goLive(world.owner, { now })).rejects.toThrow(new GoLiveError(MODE_GATE_TEXTS.workerStopped));
    expect(await getSettings(["sending.goLive", "sending.goLiveAt", "sending.goLiveDomain", "sending.mode"] as const)).toEqual({
      "sending.goLive": false,
      "sending.goLiveAt": null,
      "sending.goLiveDomain": null,
      "sending.mode": "TEST",
    });
    expect(await goLiveActivities()).toEqual([]);
    expect(await db.notification.count()).toBe(0);
  });

  it("a Member gets 'Only the Owner can do this.' and nothing is written", async () => {
    await ready(new Date());
    auth.user = member;
    expect(await goLiveAction({ confirm: true })).toEqual({ ok: false, error: "Only the Owner can do this." });
    expect(await getSetting("sending.goLive")).toBe(false);
    expect(await goLiveActivities()).toEqual([]);
  });

  it("the action needs the tick", async () => {
    await ready(new Date());
    expect(await goLiveAction({ confirm: false as never })).toMatchObject({ ok: false, error: "Tick the box to confirm." });
    expect(await getSetting("sending.goLive")).toBe(false);
  });

  it("an action refusal is the blockers' sentences", async () => {
    const now = new Date();
    await ready(now);
    await freshCheck(new Date(now.getTime() - 61 * 60_000));
    expect(await goLiveAction({ confirm: true })).toEqual({ ok: false, error: MODE_GATE_TEXTS.checkStale });
    expect(await getSetting("sending.goLive")).toBe(false);
  });

  it("a pause between the check and the switch: 'Something changed…', nothing written", async () => {
    const now = new Date();
    await ready(now);
    hooks.afterGate = async () => {
      await pauseSending({ kind: "manual", reason: "by Arslan", fixText: "Click Resume.", byUserId: owner.id, now });
    };
    await expect(goLive(world.owner, { now })).rejects.toThrow("Something changed while going live. Check the list again.");
    expect(await getSetting("sending.goLive")).toBe(false);
    expect(await getSetting("sending.mode")).toBe("TEST");
    expect(await goLiveActivities()).toEqual([]);
    expect(await db.notification.count({ where: { type: "sending.wentLive" } })).toBe(0);
  });

  it("a test-list change between the check and the switch refuses too", async () => {
    const now = new Date();
    await ready(now);
    hooks.afterGate = () => setSettingValue("sending.testList", [TESS, "second@test-mailbox.example"]);
    await expect(goLive(world.owner, { now })).rejects.toThrow(GO_LIVE_COPY.changed);
    expect(await getSetting("sending.goLive")).toBe(false);
  });
});

describe("going live", () => {
  it("writes the switch, when, where and Live mode by the Owner, removes today's limit, logs, notifies and restarts the warm-up", async () => {
    const now = new Date();
    await ready(now);
    const today = capDayOf(now, ZONE);
    await setSettingValue("sending.capOverride", { capDay: today, cap: 400, byUserId: owner.id, at: now.toISOString() });
    await climbedWarmup();

    const res = await goLiveAction({ confirm: true });
    expect(res).toEqual({
      ok: true,
      data: { at: expect.any(String), alreadyLive: false },
      message: "You're live. New campaigns now email everyone eligible, and warm-up has started.",
    });
    const at = res.ok ? res.data.at : "";

    const rows = await db.setting.findMany({
      where: { key: { in: ["sending.goLive", "sending.goLiveAt", "sending.goLiveDomain", "sending.mode", "sending.capOverride"] } },
    });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get("sending.goLive")).toMatchObject({ value: true, updatedById: owner.id });
    expect(byKey.get("sending.goLiveAt")).toMatchObject({ value: at, updatedById: owner.id });
    expect(byKey.get("sending.goLiveDomain")).toMatchObject({ value: "send.example.com", updatedById: owner.id });
    expect(byKey.get("sending.mode")).toMatchObject({ value: "LIVE", updatedById: owner.id });
    expect(byKey.get("sending.capOverride")).toMatchObject({ value: null, updatedById: owner.id });

    const activities = await goLiveActivities();
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      actorId: owner.id,
      summary: "Arslan went live on send.example.com",
      data: { at, domain: "send.example.com", modeFrom: "TEST", modeTo: "LIVE", capOverrideCleared: 400 },
    });

    const notes = await db.notification.findMany({ where: { type: "sending.wentLive" }, orderBy: { userId: "asc" } });
    expect(notes.map((n) => n.userId)).toEqual([owner.id, member.id]); // Bo is switched off
    expect(notes[0]).toMatchObject({
      title: "The app is live",
      body: "Arslan switched on Go live. Sending mode is now Live: the next campaign anyone launches sends real email to everyone eligible. Warm-up has started at 50 a day.",
      link: "/dashboard",
    });

    expect((await readTyped("warmup", parseWarmupState)).value).toEqual({
      domain: "send.example.com",
      step: 0,
      lastEvaluatedCapDay: addCapDays(today, -1),
      startedCapDay: today,
      history: [],
      // The go-live it restarted for (review GOLIVE-02).
      startedForGoLiveAt: at,
    });
  });

  it("a second call answers 'You're already live.' and writes nothing new", async () => {
    await ready(new Date());
    expect((await goLiveAction({ confirm: true })).ok).toBe(true);
    const at = await getSetting("sending.goLiveAt");
    const second = await goLiveAction({ confirm: true });
    expect(second).toEqual({ ok: true, data: { at: at!, alreadyLive: true }, message: "You're already live." });
    expect(await goLiveActivities()).toHaveLength(1);
    expect(await db.notification.count({ where: { type: "sending.wentLive" } })).toBe(2);
  });

  it("two calls at once go live once", async () => {
    const now = new Date();
    await ready(now);
    const results = await Promise.all([goLive(world.owner, { now }), goLive(world.owner, { now })]);
    expect(results.map((r) => r.alreadyLive).sort()).toEqual([false, true]);
    expect(await goLiveActivities()).toHaveLength(1);
    expect(await db.notification.count({ where: { type: "sending.wentLive" } })).toBe(2);
  });

  it("a failed warm-up restart leaves go-live on and is logged; the next warm-up check restarts the ramp at the go-live day", async () => {
    const now = new Date();
    await ready(now);
    await climbedWarmup();
    hooks.failWarmup = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await goLive(world.owner, { now });
      expect(res).toMatchObject({ alreadyLive: false, modeBefore: "TEST" });
      expect(errors.mock.calls.some((c) => String(c[0]).includes("[go-live]"))).toBe(true);
    } finally {
      errors.mockRestore();
    }
    expect(await getSetting("sending.goLive")).toBe(true);
    expect((await readTyped("warmup", parseWarmupState)).value.step).toBe(2);

    const healed = await evaluateWarmupDays({ now, mailgun: world.mailgun });
    const day = capDayOf(now, ZONE);
    expect(healed.state).toEqual({
      domain: "send.example.com",
      step: 0,
      lastEvaluatedCapDay: addCapDays(day, -1),
      startedCapDay: day,
      history: [],
      startedForGoLiveAt: now.toISOString(),
    });
    expect((await readTyped("warmup", parseWarmupState)).value).toEqual(healed.state);
    // Repaired once: the next check leaves it (review GOLIVE-02), also after the cap-day zone changed.
    await setSettingValue("sending.capDayTimeZone", "Pacific/Kiritimati");
    try {
      const again = await evaluateWarmupDays({ now, mailgun: world.mailgun });
      expect(again.state).toMatchObject({ startedCapDay: day, startedForGoLiveAt: now.toISOString() });
    } finally {
      await setSettingValue("sending.capDayTimeZone", ZONE);
    }
  });
});

describe("loadGoLiveView in each state of the card", () => {
  it("the practice copy", async () => {
    await ready(new Date());
    await setSettingValue("practice.copy", true);
    const view = await loadGoLiveView();
    expect(view).toMatchObject({
      practiceCopy: true,
      live: false,
      blockers: ["The practice copy never sends real email."],
      recommendations: [],
      drafts: { items: [], more: 0 },
    });
  });

  it("with blockers", async () => {
    const now = new Date();
    await ready(now);
    await freshCheck(now, "send.example.com", "The domain check failed.");
    const view = await loadGoLiveView(now);
    expect(view.blockers).toEqual([MODE_GATE_TEXTS.checkStale]);
    expect(view).toMatchObject({ live: false, at: null, byName: null, domain: "send.example.com", endedOnDomain: null, warmupLine: null });
    // Recommendations never block and still show next to the blockers.
    expect(view.recommendations).toContain("Test the AI model once (Settings › AI).");
  });

  it("ready, with the drafts that would send real email and today's hand-set limit", async () => {
    const now = new Date();
    await ready(now);
    await setSettingValue("sending.capOverride", { capDay: capDayOf(now, ZONE), cap: 400, byUserId: owner.id, at: now.toISOString() });
    const { company, people } = await makeCompany({ name: "Studio Nord", domain: "nord.example", people: [{ name: "Ola", email: "ola@nord.example" }] });
    const made = await makeDraft({ name: "Made early", createdById: owner.id, recipients: [{ companyId: company.id, personId: people[0]!.id }] });
    // A draft to the test list only would send nothing new: it isn't listed.
    await makeDraft({ name: "Test list only", createdById: owner.id, recipients: [{ companyId: world.tess.companyId, personId: world.tess.personId }] });
    // Nor is a draft whose only person isn't ticked.
    const { company: other, people: others } = await makeCompany({ name: "Unticked Co", domain: "unticked.example", people: [{ name: "Una" }] });
    await makeDraft({ name: "Unticked", createdById: owner.id, recipients: [{ companyId: other.id, personId: others[0]!.id, included: false }] });
    const view = await loadGoLiveView(now);
    expect(view.blockers).toEqual([]);
    expect(view.capOverrideToday).toBe(400);
    expect(view.drafts).toEqual({ items: [{ id: made.id, name: "Made early", people: 1 }], more: 0 });
    await dbWrite((c) => c.campaign.deleteMany({ where: { status: "DRAFT" } }));
  });

  it("live, with who switched it on and the warm-up line", async () => {
    const now = new Date();
    await ready(now);
    await goLive(world.owner, { now });
    const view = await loadGoLiveView(now);
    expect(view).toMatchObject({
      live: true,
      byName: "Arslan",
      domain: "send.example.com",
      endedOnDomain: null,
      blockers: [],
      recommendations: [],
      capOverrideToday: null,
    });
    expect(view.at?.toISOString()).toBe(now.toISOString());
    expect(view.warmupLine).toMatch(/^Warm-up step 1 of 20: 50 a day\. /);
  });

  it("after a domain change ended go-live: the old domain", async () => {
    await ready(new Date());
    await setSettingValue("sending.goLiveAt", "2026-09-20T08:00:00.000Z");
    await setSettingValue("sending.goLiveDomain", "mail.example.com");
    const view = await loadGoLiveView();
    expect(view).toMatchObject({ live: false, domain: "send.example.com", endedOnDomain: "mail.example.com" });
  });
});
