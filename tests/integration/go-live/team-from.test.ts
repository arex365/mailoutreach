import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChecklistRow, CheckStatus } from "@/core/system-state";
import { createTestDb } from "../helpers/test-db";
import { setSettingValue } from "../campaigns/seed";
import { checklistRows } from "../sending-m3/helpers";
import { TESS, holdLease, resetGoLive, seedLiveTest, setupGoLive, type GoLiveWorld } from "./helpers";

/**
 * Going live with a shared From address (SHARED-FROM-DESIGN §2.7, §3.3, F12, F13, F21, F26): `goLive()` records the
 * From address (`sending.goLiveFrom`) and its activity carries it; a reply-test spam placement needs the dialog's tick
 * (refused without it, on the service and the action); a From change between the check and the transaction refuses;
 * the card's view after a From change says so (`endedOnFrom`) in both directions; the blockers name the from-mx row
 * and say when the checklist predates the From change. The From address is written directly here (its service is
 * P2's). Real-data settings against the fake Mailgun; nothing reaches the network.
 */

type TestUser = { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number };
const auth = vi.hoisted(() => ({ user: null as TestUser | null }));
const hooks = vi.hoisted(() => ({ afterGate: null as null | (() => Promise<void>) }));

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

const t = await createTestDb("go-live-team-from");
const { db, dbWrite } = await import("@/server/db");
const { getSetting } = await import("@/server/settings");
const { setState } = await import("@/server/state");
const { CHECKLIST_ROW_TITLES, MODE_GATE_TEXTS } = await import("@/core/sending/mode-gates");
const { GO_LIVE_COPY } = await import("@/core/sending/go-live-copy");
const { GoLiveError, goLive, loadGoLiveView } = await import("@/server/services/go-live");
const { goLiveBlockersFor, loadGateInputs } = await import("@/server/services/reply-test");
const { goLiveAction } = await import("@/app/(app)/settings/sending/actions");

const FROM = "contact@example.com";
let world: GoLiveWorld;
let owner: TestUser;

/** The Domain checklist, all green plus the shared-From rows, checked at `at`. */
async function teamCheck(at: Date, fromMx: CheckStatus | "absent" = "ok"): Promise<void> {
  const extra: ChecklistRow[] =
    fromMx === "absent"
      ? []
      : [{ key: "from-mx", group: "dns", status: fromMx, title: "Mail for example.com stays with your mail provider (MX)", text: "", fix: null, records: [], detail: null }];
  await setState("domain.check", {
    domain: "send.example.com",
    region: "EU",
    checkedAt: at.toISOString(),
    lastVerifyAt: null,
    rows: [...checklistRows(), ...extra],
    error: null,
  });
}

/** The reply test passed for the domain and `from` (null = per-person), with the given placement answers. */
async function replyTestPassed(from: string | null, placementOk: boolean | null = true): Promise<void> {
  await setSettingValue("mailgun.unsubscribeTest", {
    setup: "A",
    status: "passed",
    domain: "send.example.com",
    from,
    mailboxes: [{ address: TESS, provider: "other", inboxOk: true, authOk: "pass", authFromHeaders: false, placementOk, dmarcOk: "pass", dmarcFromHeaders: false }],
    headersOk: true,
    decidedAt: new Date().toISOString(),
    decidedById: world.owner.id,
    note: null,
  });
}

/** A delivered live test email of a campaign sent with the shared From address, launched now (F26). */
async function teamLiveTest(): Promise<void> {
  const emailId = await seedLiveTest(world, { at: new Date() });
  const email = await db.outboundEmail.findUniqueOrThrow({ where: { id: emailId }, select: { campaignId: true } });
  await dbWrite(async (c) => {
    await c.campaign.update({ where: { id: email.campaignId }, data: { fromAddress: FROM, replyTo: "ali@send.example.com" } });
    await c.outboundEmail.update({ where: { id: emailId }, data: { replyTo: "ali@send.example.com" } });
  });
}

/** Shared-From mode ready to go live: the From saved first, then a fresh check, the reply test and a team live test. */
async function readyWithTeamFrom(opts: { placementOk?: boolean } = {}): Promise<Date> {
  await setSettingValue("mailgun.fromAddress", FROM);
  await replyTestPassed(FROM, opts.placementOk ?? true);
  await teamLiveTest();
  const now = new Date();
  await teamCheck(now);
  await holdLease(now);
  return now;
}

beforeAll(async () => {
  world = await setupGoLive();
  owner = { id: world.owner.id, email: "arslan@polygonparadise.test", name: world.owner.name, role: "OWNER", timeZone: "Europe/Berlin", sessionId: 1 };
});

beforeEach(async () => {
  auth.user = owner;
  hooks.afterGate = null;
  await resetGoLive();
  await setSettingValue("sending.goLiveFrom", null);
  await dbWrite((c) => c.setting.deleteMany({ where: { key: "mailgun.fromAddress" } }));
  await replyTestPassed(null, null);
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("goLive() with a shared From address", () => {
  it("records the From address in sending.goLiveFrom and the activity", async () => {
    const now = await readyWithTeamFrom();
    const gate = await loadGateInputs(now);
    expect(gate).toMatchObject({ teamFrom: FROM, checkFresh: true, checkBeforeFromChange: false, liveTest: "delivered", spamPlacements: [] });
    expect(goLiveBlockersFor(gate)).toEqual([]);
    const res = await goLive(world.owner, { now });
    expect(res.alreadyLive).toBe(false);
    expect(await getSetting("sending.goLiveFrom")).toBe(FROM);
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "sending.goLive" }, orderBy: { id: "desc" } });
    expect(log.data).toMatchObject({ domain: "send.example.com", from: FROM });
    expect(log.data).not.toHaveProperty("spamPlacementConfirmed");
    const view = await loadGoLiveView(now);
    expect(view).toMatchObject({ live: true, from: FROM, endedOnFrom: null });
  });

  it("per-person mode records null", async () => {
    await replyTestPassed(null);
    await seedLiveTest(world, { at: new Date() });
    const now = new Date();
    await teamCheck(now, "absent");
    await holdLease(now);
    await goLive(world.owner, { now });
    expect(await getSetting("sending.goLiveFrom")).toBeNull();
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "sending.goLive" }, orderBy: { id: "desc" } });
    expect(log.data).toMatchObject({ from: null });
  });

  it("a spam placement needs the tick: refused without it (service and action), live with it", async () => {
    const now = await readyWithTeamFrom({ placementOk: false });
    expect((await loadGateInputs(now)).spamPlacements).toEqual([`Other (${TESS})`]);
    await expect(goLive(world.owner, { now })).rejects.toThrow(new GoLiveError(GO_LIVE_COPY.spamPlacementRequired));
    expect(await goLiveAction({ confirm: true })).toEqual({ ok: false, error: "Tick the box about the spam folder first." });
    expect(await goLiveAction({ confirm: true, confirmSpamPlacement: false })).toMatchObject({ ok: false, error: GO_LIVE_COPY.spamPlacementRequired });
    expect(await getSetting("sending.goLive")).toBe(false);

    const res = await goLiveAction({ confirm: true, confirmSpamPlacement: true });
    expect(res).toMatchObject({ ok: true, data: { alreadyLive: false } });
    expect(await getSetting("sending.goLive")).toBe(true);
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "sending.goLive" }, orderBy: { id: "desc" } });
    expect(log.data).toMatchObject({ from: FROM, spamPlacementConfirmed: true });
  });

  it("the view carries the spam placements for the dialog's tick, the From and the Owner's own From line", async () => {
    const now = await readyWithTeamFrom({ placementOk: false });
    const view = await loadGoLiveView(now);
    expect(view).toMatchObject({
      live: false,
      blockers: [],
      from: FROM,
      spamPlacements: [`Other (${TESS})`],
      ownFromExample: "Arslan from Polygon Paradise <arslan@send.example.com>",
    });
    expect(view.recommendations).toContain(
      `The reply test's email landed in spam at Other (${TESS}). Emails from your From address may land in spam there at first: start with small campaigns and watch the replies.`,
    );
  });

  it("a From address changed between the check and the switch refuses with 'Something changed…'", async () => {
    const now = await readyWithTeamFrom();
    hooks.afterGate = () => setSettingValue("mailgun.fromAddress", "info@example.com");
    await expect(goLive(world.owner, { now })).rejects.toThrow(new GoLiveError(GO_LIVE_COPY.changed));
    expect(await getSetting("sending.goLive")).toBe(false);
    expect(await getSetting("sending.goLiveFrom")).toBeNull();
  });

  it("a spam answer changed between the check and the switch refuses too", async () => {
    const now = await readyWithTeamFrom();
    hooks.afterGate = () => replyTestPassed(FROM, false);
    await expect(goLive(world.owner, { now })).rejects.toThrow(GO_LIVE_COPY.changed);
    expect(await getSetting("sending.goLive")).toBe(false);
  });
});

describe("the go-live blockers and view with a shared From address", () => {
  it("names the from-mx row when it was never checked, in its title's '…: not done yet' form", async () => {
    await setSettingValue("mailgun.fromAddress", FROM);
    await replyTestPassed(FROM);
    await teamLiveTest();
    const now = new Date();
    await teamCheck(now, "absent");
    await holdLease(now);
    const blockers = goLiveBlockersFor(await loadGateInputs(now));
    expect(blockers).toEqual([`${CHECKLIST_ROW_TITLES["from-mx"]}: not done yet (Domain checklist).`]);
    await teamCheck(new Date(), "bad");
    expect(goLiveBlockersFor(await loadGateInputs())).toEqual(["Mail for example.com stays with your mail provider (MX): not done yet (Domain checklist)."]);
  });

  it("a checklist checked before the From change: checkBeforeFromChange, not checkStale", async () => {
    const before = new Date(Date.now() - 5 * 60_000);
    await teamCheck(before);
    await setSettingValue("mailgun.fromAddress", FROM);
    await replyTestPassed(FROM);
    await teamLiveTest();
    const now = new Date();
    await holdLease(now);
    const gate = await loadGateInputs(now);
    expect(gate).toMatchObject({ checkFresh: false, checkBeforeFromChange: true });
    expect(goLiveBlockersFor(gate)).toEqual([MODE_GATE_TEXTS.checkBeforeFromChange]);
    // A check more than an hour old is simply stale.
    await teamCheck(new Date(Date.now() - 61 * 60_000));
    const stale = await loadGateInputs(new Date());
    expect(stale).toMatchObject({ checkFresh: false, checkBeforeFromChange: false });
    expect(goLiveBlockersFor(stale)[0]).toBe(MODE_GATE_TEXTS.checkStale);
  });

  it("after a From change ended go-live on the same domain: endedOnFrom, in both directions", async () => {
    await setSettingValue("sending.goLiveAt", "2026-09-20T08:00:00.000Z");
    await setSettingValue("sending.goLiveDomain", "send.example.com");
    // Live per-person before; now the From address is set.
    await setSettingValue("sending.goLiveFrom", null);
    await setSettingValue("mailgun.fromAddress", FROM);
    expect(await loadGoLiveView()).toMatchObject({ live: false, endedOnDomain: null, endedOnFrom: { was: null }, from: FROM });
    // Live with the shared address before; now it is cleared.
    await setSettingValue("sending.goLiveFrom", FROM);
    await setSettingValue("mailgun.fromAddress", null);
    expect(await loadGoLiveView()).toMatchObject({ endedOnFrom: { was: FROM }, from: null });
    // The same From as at go-live (e.g. a domain change and back): nothing to say about the From.
    await setSettingValue("sending.goLiveFrom", null);
    expect((await loadGoLiveView()).endedOnFrom).toBeNull();
    // A domain change is its own case.
    await setSettingValue("sending.goLiveDomain", "mail.example.com");
    await setSettingValue("mailgun.fromAddress", FROM);
    expect(await loadGoLiveView()).toMatchObject({ endedOnDomain: "mail.example.com", endedOnFrom: null });
  });
});
