import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";

/**
 * Switching a teammate off in Milestone 4 (M4-DESIGN §4.2, §9.8, D21): their campaigns are paused (default) or left
 * to finish, their replies waiting for an answer move to the Owner either way, and the team list tells the dialog
 * about both. Also the pop-up groups (§5.4): setPopupGroups and savePopupGroupsAction.
 */

type TestUser = { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number };
const auth = vi.hoisted(() => ({ user: null as TestUser | null }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
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

const t = await createTestDb("team-switch-off");
const { db, dbWrite } = await import("@/server/db");
const users = await import("@/server/services/users");
const { switchOffAction } = await import("@/app/(app)/settings/team/actions");
const { savePopupGroupsAction } = await import("@/app/(app)/settings/notifications/actions");
const { campaignListText, switchOffDialogText } = await import("@/app/(app)/settings/team/switch-off-text");

let owner: TestUser;
let member: TestUser;

async function makeUser(name: string, role: "OWNER" | "MEMBER" = "MEMBER"): Promise<TestUser> {
  const u = await dbWrite((c) => c.user.create({ data: { name, role, email: `${name.toLowerCase()}@pp.test`, passwordHash: "x" } }));
  return { id: u.id, email: u.email, name: u.name, role, timeZone: "Europe/Berlin", sessionId: 1 };
}

async function makeCampaign(name: string, senderId: number, status: "DRAFT" | "SCHEDULED" | "RUNNING" | "PAUSED" | "FINISHED") {
  return dbWrite((c) =>
    c.campaign.create({
      data: {
        name,
        senderId,
        createdById: owner.id,
        status,
        mode: status === "DRAFT" ? null : "LIVE",
        launchedAt: status === "DRAFT" ? null : new Date(),
        startAt: status === "SCHEDULED" ? new Date(Date.now() + 86_400_000) : null,
        pausedAt: status === "PAUSED" ? new Date() : null,
        pauseReason: status === "PAUSED" ? "Paused by Arslan" : null,
      },
    }),
  );
}

let replyNo = 0;
async function makeReply(assigneeId: number, data: Record<string, unknown> = {}) {
  return dbWrite((c) =>
    c.inboundMessage.create({
      data: {
        receivedAt: new Date(),
        toAddress: "reply@send.example.com",
        fromEmail: `writer${++replyNo}@firma.de`,
        source: "NOTIFY",
        processedAt: new Date(),
        kind: "REPLY",
        replyScope: "real",
        assigneeId,
        ...data,
      },
    }),
  );
}

beforeAll(async () => {
  owner = await makeUser("Arslan", "OWNER");
  member = await makeUser("Mira");
});

beforeEach(() => {
  auth.user = owner;
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("the team list tells the dialog about campaigns and waiting replies", () => {
  it("lists each person's scheduled, running and paused campaigns and their waiting replies", async () => {
    const lena = await makeUser("Lena");
    const running = await makeCampaign("Germany Q4", lena.id, "RUNNING");
    const scheduled = await makeCampaign("Norway prints", lena.id, "SCHEDULED");
    const paused = await makeCampaign("Old test", lena.id, "PAUSED");
    await makeCampaign("Draft idea", lena.id, "DRAFT");
    await makeCampaign("Done", lena.id, "FINISHED");
    await makeCampaign("Someone else's", member.id, "RUNNING");
    await makeReply(lena.id);
    await makeReply(lena.id, { kind: "POSSIBLE_REPLY" });
    await makeReply(lena.id, { kind: "UNLINKED", replyScope: "none" });
    await makeReply(lena.id, { replyScope: "campaign" }); // a dry-run reply still moves with her
    await makeReply(lena.id, { answeredAt: new Date(), answerOutcome: "answered" });
    await makeReply(lena.id, { kind: "AUTO_REPLY" });

    const team = await users.listTeam();
    const row = team.find((m) => m.id === lena.id)!;
    expect(row.activeCampaigns).toEqual([
      { id: running.id, name: "Germany Q4", status: "RUNNING" },
      { id: scheduled.id, name: "Norway prints", status: "SCHEDULED" },
      { id: paused.id, name: "Old test", status: "PAUSED" },
    ]);
    expect(row.waitingReplies).toBe(4);
    expect(team.find((m) => m.id === owner.id)).toMatchObject({ activeCampaigns: [], waitingReplies: 0 });

    const text = switchOffDialogText({ name: row.name, activeCampaigns: row.activeCampaigns, waitingReplies: row.waitingReplies });
    expect(text).toEqual({
      title: "Switch off Lena?",
      intro:
        "Lena will be signed out everywhere and can't sign in. Their history stays. Replies to Lena's sending address will come to your inbox from now on.",
      campaigns:
        "Lena has 3 active campaigns: Germany Q4 (running), Norway prints (scheduled), Old test (paused). What should happen to them?",
      pauseLabel: "Pause them. You can resume or cancel them later.",
      finishLabel: "Let them finish, including follow-ups. Replies will come to you.",
      replies: "Lena's 4 replies waiting for an answer move to you.",
      confirm: "Switch off Lena",
    });
  });

  it("words one campaign and one reply, none at all, and a long list", () => {
    const one = switchOffDialogText({ name: "Ali", activeCampaigns: [{ id: 1, name: "Germany Q4", status: "RUNNING" }], waitingReplies: 1 });
    expect(one.campaigns).toBe("Ali has 1 active campaign: Germany Q4 (running). What should happen to it?");
    expect(one.pauseLabel).toBe("Pause it. You can resume or cancel it later.");
    expect(one.finishLabel).toBe("Let it finish, including follow-ups. Replies will come to you.");
    expect(one.replies).toBe("Ali's 1 reply waiting for an answer moves to you.");
    const none = switchOffDialogText({ name: "Ali", activeCampaigns: [], waitingReplies: 0 });
    expect(none.campaigns).toBeNull();
    expect(none.replies).toBeNull();
    const many = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, name: `C${i + 1}`, status: "RUNNING" as const }));
    expect(campaignListText(many)).toBe("C1 (running), C2 (running), C3 (running), C4 (running), C5 (running) and 3 more");
  });
});

describe("deactivateUser with campaigns and waiting replies", () => {
  it("pauses their scheduled and running campaigns by default (old call shape), with the reason", async () => {
    const sam = await makeUser("Sam");
    const running = await makeCampaign("Sam running", sam.id, "RUNNING");
    const scheduled = await makeCampaign("Sam scheduled", sam.id, "SCHEDULED");
    const paused = await makeCampaign("Sam paused", sam.id, "PAUSED");
    const finished = await makeCampaign("Sam finished", sam.id, "FINISHED");
    const other = await makeCampaign("Mira's", member.id, "RUNNING");
    const waiting = await makeReply(sam.id);
    const possible = await makeReply(sam.id, { kind: "POSSIBLE_REPLY" });
    const answered = await makeReply(sam.id, { answeredAt: new Date(), answerOutcome: "answered" });
    const auto = await makeReply(sam.id, { kind: "AUTO_REPLY" });

    const res = await users.deactivateUser(owner.id, sam.id);
    expect(res).toMatchObject({ id: sam.id, name: "Sam", paused: 2, movedReplies: 2 });
    expect(res.campaigns.map((c) => c.id)).toEqual([running.id, scheduled.id, paused.id]);

    const after = new Map((await db.campaign.findMany({ select: { id: true, status: true, pauseReason: true } })).map((c) => [c.id, c]));
    expect(after.get(running.id)).toMatchObject({ status: "PAUSED", pauseReason: "Paused because Sam was switched off" });
    expect(after.get(scheduled.id)).toMatchObject({ status: "PAUSED", pauseReason: "Paused because Sam was switched off" });
    expect(after.get(paused.id)).toMatchObject({ status: "PAUSED", pauseReason: "Paused by Arslan" }); // untouched
    expect(after.get(finished.id)?.status).toBe("FINISHED");
    expect(after.get(other.id)?.status).toBe("RUNNING");
    expect(await db.activityLog.count({ where: { type: "campaign.paused", actorId: owner.id, campaignId: running.id } })).toBe(1);

    const replies = new Map((await db.inboundMessage.findMany({ select: { id: true, assigneeId: true } })).map((r) => [r.id, r.assigneeId]));
    expect(replies.get(waiting.id)).toBe(owner.id);
    expect(replies.get(possible.id)).toBe(owner.id);
    expect(replies.get(answered.id)).toBe(sam.id); // answered ones stay where they were
    expect(replies.get(auto.id)).toBe(sam.id); // not a waiting kind

    const log = await db.activityLog.findFirstOrThrow({ where: { type: "user.deactivated" }, orderBy: { id: "desc" } });
    expect(log.summary).toBe("Arslan switched off Sam; Sam's 2 replies waiting for an answer moved to Arslan");
    expect(log.data).toMatchObject({ userId: sam.id, campaigns: "pause", movedReplies: 2 });
    expect((await db.user.findUniqueOrThrow({ where: { id: sam.id } })).active).toBe(false);
  });

  it("lets them finish when asked, and still moves the waiting replies", async () => {
    const kim = await makeUser("Kim");
    const running = await makeCampaign("Kim running", kim.id, "RUNNING");
    const scheduled = await makeCampaign("Kim scheduled", kim.id, "SCHEDULED");
    const reply = await makeReply(kim.id, { kind: "UNLINKED", replyScope: "none" });
    const res = await users.deactivateUser(owner.id, kim.id, new Date(), { campaigns: "finish" });
    expect(res).toMatchObject({ paused: 0, movedReplies: 1 });
    expect((await db.campaign.findUniqueOrThrow({ where: { id: running.id } })).status).toBe("RUNNING");
    expect((await db.campaign.findUniqueOrThrow({ where: { id: scheduled.id } })).status).toBe("SCHEDULED");
    expect((await db.inboundMessage.findUniqueOrThrow({ where: { id: reply.id } })).assigneeId).toBe(owner.id);
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "user.deactivated" }, orderBy: { id: "desc" } });
    expect(log.summary).toBe("Arslan switched off Kim; Kim's 1 reply waiting for an answer moved to Arslan");
    expect(log.data).toMatchObject({ campaigns: "finish" });
  });

  it("moves nothing and pauses nothing for someone without campaigns or replies", async () => {
    const zoe = await makeUser("Zoe");
    const res = await users.deactivateUser(owner.id, zoe.id);
    expect(res).toMatchObject({ campaigns: [], paused: 0, movedReplies: 0 });
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "user.deactivated" }, orderBy: { id: "desc" } });
    expect(log.summary).toBe("Arslan switched off Zoe");
  });

  it("pauses the way the Pause button does: reservations expire after the paused-expiry setting (14 days)", async () => {
    const lou = await makeUser("Lou");
    const running = await makeCampaign("Lou running", lou.id, "RUNNING");
    const company = await dbWrite((c) => c.company.create({ data: { name: "Firma GmbH", nameNorm: "firma gmbh" } }));
    await dbWrite((c) => c.companyReservation.create({ data: { campaignId: running.id, companyId: company.id } }));
    const now = new Date("2026-09-26T09:00:00.000Z");
    const res = await users.deactivateUser(owner.id, lou.id, now);
    expect(res.paused).toBe(1);
    expect(await db.campaign.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({
      status: "PAUSED",
      pausedAt: now,
      pauseReason: "Paused because Lou was switched off",
    });
    const reservation = await db.companyReservation.findFirstOrThrow({ where: { campaignId: running.id } });
    expect(reservation.expiresAt?.toISOString()).toBe("2026-10-10T09:00:00.000Z");
    const paused = await db.activityLog.findFirstOrThrow({ where: { type: "campaign.paused", campaignId: running.id } });
    expect(paused).toMatchObject({ actorId: owner.id, summary: "Arslan paused Lou running", mode: "LIVE" });
    expect(paused.data).toEqual({ reason: "Paused because Lou was switched off" });
  });

  it("switches off and pauses together or not at all: never switched off with a campaign still running (DATA-04)", async () => {
    const max = await makeUser("Max");
    const running = await makeCampaign("Max running", max.id, "RUNNING");
    const scheduled = await makeCampaign("Max scheduled", max.id, "SCHEDULED");
    const reply = await makeReply(max.id);
    const original = db.$transaction.bind(db) as (fn: (tx: object) => Promise<unknown>, opts?: unknown) => Promise<unknown>;
    /** The transaction client, except that pausing a campaign fails (as a busy database would, every time). */
    const failingPause = (tx: object) =>
      new Proxy(tx, {
        get(target, prop) {
          const value = Reflect.get(target, prop) as unknown;
          if (prop === "campaign") {
            const delegate = value as Record<PropertyKey, unknown>;
            return new Proxy(delegate, {
              get: (d, p) => {
                if (p === "updateMany") return async () => Promise.reject(new Error("The disk is full."));
                const v = Reflect.get(d, p) as unknown;
                return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(d) : v;
              },
            });
          }
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
    vi.spyOn(db, "$transaction").mockImplementation(((fn: (tx: object) => Promise<unknown>, opts?: unknown) =>
      original((tx) => fn(failingPause(tx)), opts)) as never);
    await expect(users.deactivateUser(owner.id, max.id)).rejects.toThrow("The disk is full.");
    vi.restoreAllMocks();

    // Nothing happened: Max is still on, his campaigns run, his reply is still his, nothing was logged.
    expect((await db.user.findUniqueOrThrow({ where: { id: max.id } })).active).toBe(true);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: running.id } })).status).toBe("RUNNING");
    expect((await db.campaign.findUniqueOrThrow({ where: { id: scheduled.id } })).status).toBe("SCHEDULED");
    expect((await db.inboundMessage.findUniqueOrThrow({ where: { id: reply.id } })).assigneeId).toBe(max.id);
    const logged = await db.activityLog.findMany({ where: { type: { in: ["user.deactivated", "campaign.paused"] } }, select: { data: true, campaignId: true } });
    expect(logged.filter((l) => (l.data as { userId?: number }).userId === max.id || [running.id, scheduled.id].includes(l.campaignId ?? 0))).toEqual([]);

    // Once the database works again, both are paused with the switch-off.
    expect(await users.deactivateUser(owner.id, max.id)).toMatchObject({ paused: 2, movedReplies: 1 });
    expect((await db.campaign.findUniqueOrThrow({ where: { id: running.id } })).status).toBe("PAUSED");
    expect((await db.campaign.findUniqueOrThrow({ where: { id: scheduled.id } })).status).toBe("PAUSED");
  });

  it("changes nothing when the switch-off is refused", async () => {
    const running = await makeCampaign("Owner's own", owner.id, "RUNNING");
    const reply = await makeReply(owner.id);
    await expect(users.deactivateUser(owner.id, owner.id)).rejects.toThrow(/can't switch yourself off/);
    await expect(users.deactivateUser(member.id, owner.id)).rejects.toThrow(/Only the Owner/);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: running.id } })).status).toBe("RUNNING");
    expect((await db.inboundMessage.findUniqueOrThrow({ where: { id: reply.id } })).assigneeId).toBe(owner.id);
  });
});

describe("switchOffAction", () => {
  it("is for the Owner only", async () => {
    const x = await makeUser("Xena");
    auth.user = member;
    const res = await switchOffAction({ userId: x.id });
    expect(res).toEqual({ ok: false, error: "Only the Owner can do this." });
    expect((await db.user.findUniqueOrThrow({ where: { id: x.id } })).active).toBe(true);
  });

  it("says how many campaigns were paused", async () => {
    const ali = await makeUser("Ali");
    await makeCampaign("Ali one", ali.id, "RUNNING");
    await makeCampaign("Ali two", ali.id, "SCHEDULED");
    const res = await switchOffAction({ userId: ali.id, campaigns: "pause" });
    expect(res).toMatchObject({ ok: true, message: "Ali is switched off. 2 campaigns paused.", data: { name: "Ali", paused: 2 } });
    const bo = await makeUser("Bo");
    await makeCampaign("Bo one", bo.id, "RUNNING");
    expect(await switchOffAction({ userId: bo.id })).toMatchObject({ ok: true, message: "Bo is switched off. 1 campaign paused." });
  });

  it("says the campaigns keep going when they may finish, and the old sentence without campaigns", async () => {
    const cy = await makeUser("Cy");
    await makeCampaign("Cy one", cy.id, "RUNNING");
    expect(await switchOffAction({ userId: cy.id, campaigns: "finish" })).toMatchObject({
      ok: true,
      message: "Cy is switched off. Their campaigns keep going; replies come to you.",
    });
    const dee = await makeUser("Dee");
    expect(await switchOffAction({ userId: dee.id, campaigns: "finish" })).toMatchObject({
      ok: true,
      message: "Dee is switched off and signed out everywhere.",
    });
  });

  it("refuses an unknown choice", async () => {
    const eve = await makeUser("Eve");
    const res = await switchOffAction({ userId: eve.id, campaigns: "delete" as never });
    expect(res.ok).toBe(false);
    expect((await db.user.findUniqueOrThrow({ where: { id: eve.id } })).active).toBe(true);
  });
});

describe("pop-up groups (What pops up)", () => {
  it("keeps the legacy switch, drops unknown groups, and drops Owner-only groups for Members", async () => {
    const fay = await makeUser("Fay");
    await dbWrite((c) => c.user.update({ where: { id: fay.id }, data: { notifyPrefs: { desktopReplies: true, somethingElse: 1 } } }));
    expect(await users.setPopupGroups(fay.id, ["campaign", "junk", "reply", "sending", "reply"], "MEMBER")).toEqual({
      popupGroups: ["reply", "campaign"],
      desktopReplies: true,
    });
    const stored = await db.user.findUniqueOrThrow({ where: { id: fay.id } });
    expect(stored.notifyPrefs).toEqual({ desktopReplies: true, somethingElse: 1, popupGroups: ["reply", "campaign"] });
    expect(await users.setPopupGroups(owner.id, ["sending", "outage"], "OWNER")).toEqual({
      popupGroups: ["outage", "sending"],
      desktopReplies: false,
    });
    // Nothing chosen is a choice too (only the bell).
    expect((await users.setPopupGroups(fay.id, [], "MEMBER")).popupGroups).toEqual([]);
    expect((await users.getNotifyPrefs(fay.id)).popupGroups).toEqual([]);
  });

  it("saves through savePopupGroupsAction for the signed-in person", async () => {
    auth.user = member;
    const res = await savePopupGroupsAction({ groups: ["reply", "outage", "sending"] });
    expect(res).toEqual({ ok: true, data: { groups: ["reply", "outage"] }, message: "Saved." });
    expect((await users.getNotifyPrefs(member.id)).popupGroups).toEqual(["reply", "outage"]);
    const bad = await savePopupGroupsAction({ groups: "reply" as never });
    expect(bad.ok).toBe(false);
    auth.user = null;
    expect(await savePopupGroupsAction({ groups: ["reply"] })).toEqual({ ok: false, error: "Your session has ended. Please sign in again." });
  });
});
