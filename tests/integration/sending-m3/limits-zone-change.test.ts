import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeUser, setSettingValue } from "../campaigns/seed";

/**
 * Changing the time zone of the sending day ends a "today only" limit (review GATES-08): the limit was confirmed for
 * a day of the old zone, so it goes back to the warm-up schedule instead of being ignored today or applying on a day
 * the Owner never confirmed. The change is logged and the Owner is told.
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

const t = await createTestDb("m3-limits-zone-change");
const { db, dbWrite } = await import("@/server/db");
const { getSettings } = await import("@/server/settings");
const limits = await import("@/app/(app)/settings/limits/actions");
const { getTodayCap } = await import("@/server/services/sending/usage");

const LIMITS = {
  window: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
  defaultTimeZone: "Europe/Berlin",
  maxDailyCap: 1000,
  minGapSeconds: 20,
  capDayTimeZone: "Asia/Karachi",
  warmupStartCap: 50,
  warmupSteps: 20,
  warmupMinUsePercent: 50,
};

let owner: TestUser;

beforeAll(async () => {
  const u = await makeUser("Arslan", { role: "OWNER" });
  owner = { id: u.id, email: u.email, name: u.name, role: "OWNER", timeZone: "Asia/Karachi", sessionId: 1 };
});

beforeEach(async () => {
  auth.user = owner;
  await setSettingValue("sending.capOverride", null);
  await setSettingValue("sending.capDayTimeZone", "Asia/Karachi");
  await setSettingValue("sending.minGapSeconds", 20);
  await dbWrite((c) => c.activityLog.deleteMany({}));
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("today's limit and the sending day's time zone (GATES-08)", () => {
  it("a new cap-day zone sends today's changed limit back to the warm-up schedule, logged and said", async () => {
    expect(await limits.setTodayCapAction({ cap: 300, confirmed: true })).toMatchObject({ ok: true });
    expect((await getSettings(["sending.capOverride"] as const))["sending.capOverride"]).toMatchObject({ cap: 300 });

    const res = await limits.saveLimitsAction({ ...LIMITS, capDayTimeZone: "America/New_York" });
    expect(res).toEqual({
      ok: true,
      data: { changed: 1 },
      message: "Limits saved. The sending day now follows a different time zone, so today's limit follows the warm-up schedule again.",
    });
    expect((await getSettings(["sending.capOverride"] as const))["sending.capOverride"]).toBeNull();
    // Neither today nor any later New York day uses the old 300.
    expect(await getTodayCap(new Date())).toMatchObject({ source: "warmup", override: null });
    expect(await getTodayCap(new Date(Date.now() + 86_400_000))).toMatchObject({ source: "warmup", override: null });
    const logged = await db.activityLog.findFirstOrThrow({ where: { type: "settings.updated" } });
    expect(logged.summary).toBe("Arslan changed the time zone of the sending day, and today's limit went back to the warm-up schedule");
  });

  it("other changes keep today's limit", async () => {
    await limits.setTodayCapAction({ cap: 300, confirmed: true });
    const res = await limits.saveLimitsAction({ ...LIMITS, minGapSeconds: 45 });
    expect(res).toEqual({ ok: true, data: { changed: 1 }, message: "Limits saved." });
    expect((await getSettings(["sending.capOverride"] as const))["sending.capOverride"]).toMatchObject({ cap: 300 });
    const logged = await db.activityLog.findFirstOrThrow({ where: { type: "settings.updated" } });
    expect(logged.summary).toBe("Arslan changed the smallest gap");
  });

  it("a new zone without a changed limit only changes the zone", async () => {
    const res = await limits.saveLimitsAction({ ...LIMITS, capDayTimeZone: "Europe/Berlin" });
    expect(res).toEqual({ ok: true, data: { changed: 1 }, message: "Limits saved." });
    expect((await db.activityLog.findFirstOrThrow({ where: { type: "settings.updated" } })).summary).toBe(
      "Arslan changed the time zone of the sending day",
    );
  });
});
