import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeUser } from "../campaigns/seed";

/**
 * "We don't use Cloudflare Access" on Settings › System (M6-DESIGN §2.8, G7): Owner only, saved with who changed it and
 * one activity, and a domain check queued with the Check-again dedupe key so the remote-access row follows at once.
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

const t = await createTestDb("settings-access-choice");
const { db, dbWrite } = await import("@/server/db");
const { getSetting } = await import("@/server/settings");
const { saveAccessChoiceAction } = await import("@/app/(app)/settings/system/actions");

let owner: TestUser;
let member: TestUser;

function asUser(u: { id: number; email: string; name: string; role: "OWNER" | "MEMBER" }): TestUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, timeZone: "Europe/Berlin", sessionId: 1 };
}

beforeAll(async () => {
  owner = asUser(await makeUser("Arslan", { role: "OWNER" }));
  member = asUser(await makeUser("Ali"));
});

beforeEach(async () => {
  auth.user = owner;
  await dbWrite(async (c) => {
    await c.activityLog.deleteMany({});
    await c.job.deleteMany({});
    await c.setting.deleteMany({ where: { key: "remoteAccess.accessOff" } });
  });
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

const SAVED = "Saved. The Domain checklist checks remote access again in a minute.";

async function activities() {
  return db.activityLog.findMany({ orderBy: { id: "asc" }, select: { type: true, summary: true, data: true, actorId: true } });
}

describe("saveAccessChoiceAction", () => {
  it("refuses a Member and without a session; nothing written or queued", async () => {
    auth.user = member;
    expect(await saveAccessChoiceAction({ accessOff: true })).toEqual({ ok: false, error: "Only the Owner can do this." });
    auth.user = null;
    expect(await saveAccessChoiceAction({ accessOff: true })).toEqual({ ok: false, error: "Your session has ended. Please sign in again." });
    expect(await db.setting.findUnique({ where: { key: "remoteAccess.accessOff" } })).toBeNull();
    expect(await activities()).toEqual([]);
    expect(await db.job.count()).toBe(0);
  });

  it("turning the check off: saved with who, one activity, one domain check queued", async () => {
    expect(await getSetting("remoteAccess.accessOff")).toBe(false);
    expect(await saveAccessChoiceAction({ accessOff: true })).toEqual({ ok: true, data: null, message: SAVED });
    const row = await db.setting.findUniqueOrThrow({ where: { key: "remoteAccess.accessOff" } });
    expect(row.value).toBe(true);
    expect(row.updatedById).toBe(owner.id);
    expect(await activities()).toEqual([
      {
        type: "settings.updated",
        summary: "Arslan turned off the Cloudflare Access check",
        data: { key: "remoteAccess.accessOff", from: false, to: true },
        actorId: owner.id,
      },
    ]);
    const jobs = await db.job.findMany({ select: { type: true, status: true, activeDedupeKey: true, priority: true, createdById: true } });
    expect(jobs).toEqual([{ type: "mailgun.checkDomain", status: "QUEUED", activeDedupeKey: "mailgun:domain-check", priority: 20, createdById: owner.id }]);
  });

  it("the same value again changes nothing; turning it back on logs and reuses the queued check", async () => {
    await saveAccessChoiceAction({ accessOff: true });
    expect(await saveAccessChoiceAction({ accessOff: true })).toEqual({
      ok: true,
      data: null,
      message: "Nothing changed, so there was nothing to save.",
    });
    expect(await activities()).toHaveLength(1);
    expect(await saveAccessChoiceAction({ accessOff: false })).toEqual({ ok: true, data: null, message: SAVED });
    expect(await getSetting("remoteAccess.accessOff")).toBe(false);
    expect((await activities()).map((a) => a.summary)).toEqual([
      "Arslan turned off the Cloudflare Access check",
      "Arslan turned on the Cloudflare Access check",
    ]);
    expect(await db.job.count()).toBe(1);
  });

  it("refuses anything but true or false", async () => {
    const res = await saveAccessChoiceAction({ accessOff: "yes" as unknown as boolean });
    expect(res.ok).toBe(false);
    expect(await db.setting.findUnique({ where: { key: "remoteAccess.accessOff" } })).toBeNull();
  });
});
