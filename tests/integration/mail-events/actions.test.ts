import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeMember, makeOwner, seedEmail } from "./seed";

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

const t = await createTestDb("mail-actions");
const { db } = await import("@/server/db");
const deliverability = await import("@/app/(app)/settings/deliverability/actions");
const system = await import("@/app/(app)/settings/system/actions");
const outbox = await import("@/app/(app)/campaigns/outbox/actions");
const { getSetting } = await import("@/server/settings");

let owner: TestUser;
let member: TestUser;

function asUser(u: { id: number; email: string; name: string; role: "OWNER" | "MEMBER" }): TestUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, timeZone: "Asia/Karachi", sessionId: 1 };
}

const thresholds = {
  bounceWindow: "200",
  bouncePercent: "3",
  complaintWindow: "1000",
  complaintPercent: "0.1",
  healthyBouncePercent: "2",
  healthyComplaintPercent: "0.05",
};

beforeAll(async () => {
  owner = asUser(await makeOwner());
  member = asUser(await makeMember("Ali", "ali@polygonparadise.test"));
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("Owner-only actions refuse Members", () => {
  it("Deliverability and System", async () => {
    auth.user = member;
    const refused = { ok: false, error: "Only the Owner can do this." };
    expect(await deliverability.saveHealthThresholdsAction(thresholds)).toEqual(refused);
    expect(await deliverability.addSuppressionAction({ email: "x@y.de", reason: "MANUAL" })).toEqual(refused);
    expect(await deliverability.removeOwnSuppressionAction({ email: "x@y.de" })).toEqual(refused);
    expect(await system.checkRemoteAccessAction()).toEqual(refused);
    expect(await db.suppression.count()).toBe(0);
  });

  it("everything refuses without a session", async () => {
    auth.user = null;
    expect((await deliverability.addSuppressionAction({ email: "x@y.de", reason: "MANUAL" })).ok).toBe(false);
    expect((await outbox.simulateEmailAction({ emailId: 1, kind: "bounce" })).ok).toBe(false);
  });
});

describe("the Owner's Deliverability actions", () => {
  it("saves thresholds, with field messages and Mailgun warnings", async () => {
    auth.user = owner;
    const res = await deliverability.saveHealthThresholdsAction({ ...thresholds, bouncePercent: "6", complaintPercent: "0.05" });
    expect(res).toMatchObject({ ok: true, message: "Thresholds saved.", data: { changed: 2 } });
    if (res.ok) {
      expect(res.data.warnings.bounce).toBe("Above Mailgun's own limit of 5%: Mailgun may suspend your account before the app pauses.");
      expect(res.data.warnings.complaint).toBeNull();
    }
    expect(await getSetting("health.bouncePercent")).toBe(6);
    const bad = await deliverability.saveHealthThresholdsAction({ ...thresholds, bounceWindow: "10", complaintPercent: "5" });
    expect(bad).toMatchObject({ ok: false });
    if (!bad.ok) {
      expect(bad.fieldErrors?.bounceWindow).toEqual(["Use a whole number from 50 to 5,000."]);
      expect(bad.fieldErrors?.complaintPercent).toEqual(["Use a number from 0.01 to 1."]);
    }
    expect(await db.activityLog.findFirst({ where: { type: "settings.updated" } })).toMatchObject({
      actorId: owner.id,
      summary: "Arslan changed the bounce and complaint limits",
    });
  });

  it("adds an address and refuses to take a stranger off the list", async () => {
    auth.user = owner;
    const add = await deliverability.addSuppressionAction({ email: "stranger@studio.de", reason: "MANUAL" });
    expect(add).toMatchObject({ ok: true, message: "Added to the do-not-email list.", data: { created: true } });
    const bad = await deliverability.addSuppressionAction({ email: "nope", reason: "MANUAL" });
    expect(bad).toMatchObject({ ok: false });
    const remove = await deliverability.removeOwnSuppressionAction({ email: "stranger@studio.de" });
    expect(remove).toEqual({ ok: false, error: "Only your test mailboxes and your team's reply inboxes can be taken off the list." });
  });
});

describe("simulate is for everyone", () => {
  it("lets a Member simulate a dry-run email", async () => {
    const s = await seedEmail({ createdById: owner.id, mode: "DRY_RUN" });
    auth.user = member;
    const res = await outbox.simulateEmailAction({ emailId: s.emailId, kind: "unsubscribe" });
    expect(res).toMatchObject({ ok: true, data: { message: `Simulated an unsubscribe for ${s.toNorm}. In a dry run this only changes this campaign.` } });
    const live = await seedEmail({ createdById: owner.id, mode: "LIVE" });
    expect(await outbox.simulateEmailAction({ emailId: live.emailId, kind: "bounce" })).toEqual({
      ok: false,
      error: "Only dry-run emails can be simulated. Real emails get their results from Mailgun.",
    });
  });
});
