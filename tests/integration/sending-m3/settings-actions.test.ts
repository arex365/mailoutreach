import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { makeUser, setSettingValue } from "../campaigns/seed";
import { checklistRows } from "./helpers";

/**
 * Settings › Limits & warm-up, Settings › Email footer and the mode words and go-live of Settings › Sending & Mailgun
 * (M3-DESIGN §5.4, §5.6, M6-DESIGN §2.5, §2.7): only the Owner may change them, every value is checked, and every
 * change is logged with who made it.
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

const t = await createTestDb("m3-settings-actions");
const { db, dbWrite } = await import("@/server/db");
const { getSettings } = await import("@/server/settings");
const limits = await import("@/app/(app)/settings/limits/actions");
const { saveFooterAction } = await import("@/app/(app)/settings/footer/actions");
const sending = await import("@/app/(app)/settings/sending/actions");

let owner: TestUser;
let member: TestUser;

function asUser(u: { id: number; email: string; name: string; role: "OWNER" | "MEMBER" }): TestUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, timeZone: "Europe/Berlin", sessionId: 1 };
}

const GOOD_LIMITS = {
  window: { days: [1, 2, 3, 4], start: "08:00", end: "16:30" },
  defaultTimeZone: "Europe/Berlin",
  maxDailyCap: 800,
  minGapSeconds: 20,
  capDayTimeZone: "Asia/Karachi",
  warmupStartCap: 50,
  warmupSteps: 20,
  warmupMinUsePercent: 50,
};

const GOOD_FOOTER = {
  companyName: "Polygon Paradise",
  address: "55th Avenue, Thokar Niaz Baig, Lahore 53700, Pakistan",
  unsubscribeText: "Rather not hear from us? Unsubscribe here:",
  portfolioUrl: "https://www.polygonparadise.com/work",
};

beforeAll(async () => {
  owner = asUser(await makeUser("Arslan", { role: "OWNER" }));
  member = asUser(await makeUser("Ali"));
});

beforeEach(async () => {
  auth.user = owner;
  await setSettingValue("sending.capOverride", null);
  await dbWrite(async (c) => {
    await c.activityLog.deleteMany({});
    await c.user.update({ where: { id: member.id }, data: { dailyCap: null } });
  });
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

async function summaries(type: string) {
  return (await db.activityLog.findMany({ where: { type }, orderBy: { id: "asc" }, select: { summary: true } })).map((a) => a.summary);
}

describe("only the Owner", () => {
  it("refuses every limits and footer change from a Member, and changes nothing", async () => {
    auth.user = member;
    const refused = { ok: false, error: "Only the Owner can do this." };
    expect(await limits.saveLimitsAction(GOOD_LIMITS)).toEqual(refused);
    expect(await limits.setTodayCapAction({ cap: 100, confirmed: true })).toEqual(refused);
    expect(await limits.clearTodayCapAction()).toEqual(refused);
    expect(await limits.saveSenderCapsAction({ caps: [{ userId: member.id, dailyCap: 5 }] })).toEqual(refused);
    expect(await saveFooterAction(GOOD_FOOTER)).toEqual(refused);
    const s = await getSettings(["sending.maxDailyCap", "sending.capOverride", "portfolioUrl"] as const);
    expect(s["sending.maxDailyCap"]).toBe(1000);
    expect(s["sending.capOverride"]).toBeNull();
    expect(s["portfolioUrl"]).toBe("https://www.polygonparadise.com");
    expect((await db.user.findUniqueOrThrow({ where: { id: member.id } })).dailyCap).toBeNull();
    expect(await db.activityLog.count()).toBe(0);
  });

  it("refuses without a session", async () => {
    auth.user = null;
    expect(await limits.clearTodayCapAction()).toEqual({ ok: false, error: "Your session has ended. Please sign in again." });
  });
});

describe("Limits & warm-up", () => {
  it("saves the limits and logs what changed", async () => {
    const res = await limits.saveLimitsAction(GOOD_LIMITS);
    expect(res).toEqual({ ok: true, data: { changed: 2 }, message: "Limits saved." });
    const s = await getSettings(["sending.window", "sending.maxDailyCap"] as const);
    expect(s["sending.window"]).toEqual({ days: [1, 2, 3, 4], start: "08:00", end: "16:30" });
    expect(s["sending.maxDailyCap"]).toBe(800);
    expect(await summaries("settings.updated")).toEqual(["Arslan changed sending hours and the maximum daily limit"]);
    // Saving the same values again changes nothing.
    expect(await limits.saveLimitsAction(GOOD_LIMITS)).toMatchObject({ ok: true, data: { changed: 0 } });
    expect(await summaries("settings.updated")).toHaveLength(1);
  });

  it("refuses bad limits with a message per field", async () => {
    const res = await limits.saveLimitsAction({ ...GOOD_LIMITS, maxDailyCap: 20, warmupSteps: 2, capDayTimeZone: "Mars/Olympus" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("Some limits need fixing. Check the highlighted fields.");
    expect(res.fieldErrors?.maxDailyCap).toEqual(["The maximum daily limit must be a whole number from 50 to 10,000."]);
    expect(res.fieldErrors?.warmupSteps).toEqual(["The warm-up needs a whole number of steps from 5 to 60."]);
    expect(res.fieldErrors?.capDayTimeZone).toEqual(["Pick a time zone from the list, for example Asia/Karachi."]);
  });

  it("changes today's limit only once confirmed, never above the maximum, and goes back to the schedule", async () => {
    await setSettingValue("sending.maxDailyCap", 1000);
    expect(await limits.setTodayCapAction({ cap: 300, confirmed: false })).toEqual({ ok: false, error: "Confirm the change in the dialog first." });
    expect(await limits.setTodayCapAction({ cap: 5000, confirmed: true })).toMatchObject({
      ok: false,
      error: "Today's limit must be a whole number from 0 to 1,000.",
    });
    const res = await limits.setTodayCapAction({ cap: 300, confirmed: true });
    expect(res).toEqual({ ok: true, data: { cap: 300 }, message: "Today's limit changed. It goes back to the warm-up schedule tomorrow." });
    const override = (await getSettings(["sending.capOverride"] as const))["sending.capOverride"];
    expect(override).toMatchObject({ cap: 300, byUserId: owner.id });
    expect(override?.capDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await summaries("sending.capOverride")).toEqual(["Arslan changed today's limit to 300 (above the warm-up schedule of 50)"]);

    expect(await limits.clearTodayCapAction()).toMatchObject({ ok: true, message: "Today's limit follows the warm-up schedule again." });
    expect((await getSettings(["sending.capOverride"] as const))["sending.capOverride"]).toBeNull();
    expect((await summaries("sending.capOverride"))[1]).toBe("Arslan set today's limit back to the warm-up schedule");
  });

  it("saves each teammate's own daily limit and refuses a bad one", async () => {
    expect(await limits.saveSenderCapsAction({ caps: [{ userId: member.id, dailyCap: 100 }] })).toEqual({
      ok: true,
      data: { changed: 1 },
      message: "Sender limits saved.",
    });
    expect((await db.user.findUniqueOrThrow({ where: { id: member.id } })).dailyCap).toBe(100);
    expect(await summaries("settings.updated")).toEqual(["Arslan set Ali's daily limit to 100"]);

    const bad = await limits.saveSenderCapsAction({ caps: [{ userId: member.id, dailyCap: 0 }] });
    expect(bad).toEqual({
      ok: false,
      error: "A daily limit must be a whole number from 1 to 10,000, or empty for no limit of their own.",
      fieldErrors: { [`cap-${member.id}`]: ["A daily limit must be a whole number from 1 to 10,000, or empty for no limit of their own."] },
    });

    expect(await limits.saveSenderCapsAction({ caps: [{ userId: member.id, dailyCap: null }] })).toMatchObject({ ok: true, data: { changed: 1 } });
    expect((await db.user.findUniqueOrThrow({ where: { id: member.id } })).dailyCap).toBeNull();
    expect((await summaries("settings.updated"))[1]).toBe("Arslan removed Ali's own daily limit");
  });
});

describe("Sending & Mailgun: mode words and go-live (M6-DESIGN §2.5, §2.7)", () => {
  let mg: FakeConnection;

  beforeAll(async () => {
    mg = await connectFakeMailgun({ domain: "send.example.com" });
    const { setState } = await import("@/server/state");
    await setState("domain.check", {
      domain: mg.domain,
      region: "EU",
      checkedAt: new Date().toISOString(),
      lastVerifyAt: null,
      rows: checklistRows(),
      error: null,
    });
  });

  afterAll(async () => {
    await setSettingValue("sending.goLive", false);
    await setSettingValue("sending.mode", "DRY_RUN");
    await mg.stop();
  });

  it("says 'live (test list only)' before go-live and 'live' after it, in the message and the activity", async () => {
    await setSettingValue("sending.goLive", false);
    await setSettingValue("sending.mode", "DRY_RUN");
    expect(await sending.setSendingModeAction({ mode: "LIVE" })).toMatchObject({ ok: true, message: "Sending is set to live (test list only)." });
    expect(await summaries("sending.modeChanged")).toEqual(["Arslan set sending to live (test list only)"]);

    await setSettingValue("sending.goLive", true);
    expect(await sending.setSendingModeAction({ mode: "LIVE" })).toMatchObject({ ok: true, message: "Sending is already set to live." });
    expect(await sending.setSendingModeAction({ mode: "DRY_RUN" })).toMatchObject({ ok: true, message: "Sending is set to dry run." });
    expect(await sending.setSendingModeAction({ mode: "LIVE" })).toMatchObject({ ok: true, message: "Sending is set to live." });
    expect((await summaries("sending.modeChanged")).slice(-1)).toEqual(["Arslan set sending to live"]);
  });

  it("go-live is the Owner's: a Member is refused and nothing is written", async () => {
    await setSettingValue("sending.goLive", false);
    auth.user = member;
    expect(await sending.goLiveAction({ confirm: true })).toEqual({ ok: false, error: "Only the Owner can do this." });
    expect((await getSettings(["sending.goLive"] as const))["sending.goLive"]).toBe(false);
    expect(await db.activityLog.count({ where: { type: "sending.goLive" } })).toBe(0);
  });

  it("the Owner's go-live refused by the checklist says what is missing", async () => {
    await setSettingValue("sending.goLive", false);
    // No background sender, no live test and no reply test here.
    const res = await sending.goLiveAction({ confirm: true });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("The reply test hasn't passed yet.");
      expect(res.error).toContain("Send one live campaign to your test list first");
      expect(res.error).toContain("The background sender isn't running.");
    }
    expect((await getSettings(["sending.goLive"] as const))["sending.goLive"]).toBe(false);
  });
});

describe("Email footer", () => {
  it("saves the footer and logs what changed", async () => {
    const res = await saveFooterAction({ ...GOOD_FOOTER, companyName: "  Polygon   Paradise " });
    expect(res).toEqual({ ok: true, data: GOOD_FOOTER, message: "Footer saved. Emails prepared from now on use it." });
    const s = await getSettings(["footer.unsubscribeText", "portfolioUrl"] as const);
    expect(s["footer.unsubscribeText"]).toBe(GOOD_FOOTER.unsubscribeText);
    expect(s["portfolioUrl"]).toBe(GOOD_FOOTER.portfolioUrl);
    expect(await summaries("settings.updated")).toEqual(["Arslan changed the email footer (the unsubscribe line and the portfolio link)"]);
  });

  it("refuses a % in the unsubscribe line, an address on two lines and a link without https", async () => {
    const res = await saveFooterAction({
      ...GOOD_FOOTER,
      address: "Street 1\nLahore",
      unsubscribeText: "Unsubscribe: %unsubscribe_url%",
      portfolioUrl: "http://polygonparadise.com",
    });
    expect(res).toEqual({
      ok: false,
      error: "Some details need fixing. Check the highlighted fields.",
      fieldErrors: {
        address: ["Enter the postal address on one line, up to 200 characters."],
        unsubscribeText: ["Write the unsubscribe line, up to 150 characters, without a % sign."],
        portfolioUrl: ["Enter the full link, starting with https://."],
      },
    });
  });
});
