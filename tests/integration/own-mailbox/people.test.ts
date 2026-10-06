import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { makeUser, setSettingValue } from "../campaigns/seed";

/**
 * Own-mailbox mode's people, limits and health words (MAIN-DOMAIN-DESIGN §3.7, §3.9, §2.4, O8, O9, O23, P5): nobody has
 * an address of their own (setSenderLocalPart refuses), the own From may be a test inbox, no route sync is ever queued
 * (profile save, "Remove it"), internalSenders knows the own From, the Team and Limits words, the plan's cap and the
 * cap-override check, and the health warnings' notes. App mode keeps today's behaviour in the same database.
 */

type TestUser = { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number };
const auth = vi.hoisted(() => ({ user: null as TestUser | null }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
  usePathname: () => "/settings/limits",
}));
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

const FROM = "contact@example.com";
const t = await createTestDb("own-mailbox-people");
const mg = await connectFakeMailgun({
  domain: "example.com",
  region: "US",
  replies: "own-mailbox",
  fromAddress: FROM,
  plan: "free",
  fake: { domain: "example.com", region: "US", plan: "free", receivesMail: false },
});
const { db, dbWrite } = await import("@/server/db");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { OWN_MAILBOX_TEXTS } = await import("@/core/sending/own-mailbox");
const { PLAN_TEXTS } = await import("@/core/mailgun/plan");
const sa = await import("@/server/services/sender-addresses");
const users = await import("@/server/services/users");
const { removeOwnSuppression } = await import("@/server/services/mailgun/suppressions");
const { internalSenders } = await import("@/server/services/mail-events/internal-senders");
const { loadEffectiveMaxDailyCap } = await import("@/server/services/mailgun/plan");
const { healthWarningNote, runHealthCheck } = await import("@/server/services/sending/health-check");
const { switchOffDialogText } = await import("@/app/(app)/settings/team/switch-off-text");
const { SenderCapsForm } = await import("@/components/settings/limits/sender-caps-form");
const limits = await import("@/app/(app)/settings/limits/actions");

const mailgun = () => getMailgunContext({ retryDelayMs: () => 0 });
let owner: TestUser;
let ali: TestUser;

function asUser(u: { id: number; email: string; name: string; role: "OWNER" | "MEMBER" }): TestUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, timeZone: "Europe/Berlin", sessionId: 1 };
}

/** Runs `fn` in app mode (Setting "mailgun.replies" = "app"), then puts own-mailbox mode back. */
async function inAppMode<T>(fn: () => Promise<T>): Promise<T> {
  await setSettingValue("mailgun.replies", "app");
  try {
    return await fn();
  } finally {
    await setSettingValue("mailgun.replies", "own-mailbox");
  }
}

async function routeSyncJobs(): Promise<number> {
  return db.job.count({ where: { type: "mailgun.syncRoutes" } });
}

beforeAll(async () => {
  owner = asUser(await makeUser("Arslan", { role: "OWNER", email: "arslan@polygonparadise.test" }));
  ali = asUser(await makeUser("Ali", { email: "ali@polygonparadise.test" }));
});

beforeEach(async () => {
  auth.user = owner;
  mg.fake.reset();
  await setSettingValue("mailgun.replies", "own-mailbox");
  await dbWrite(async (c) => {
    await c.job.deleteMany({});
    await c.suppression.deleteMany({});
    await c.notification.deleteMany({});
    await c.mailEvent.deleteMany({});
    await c.outboundEmail.deleteMany({});
    await c.campaignRecipient.deleteMany({});
    await c.campaignStep.deleteMany({});
    await c.campaign.deleteMany({});
    await c.systemState.deleteMany({ where: { key: { in: ["health.baseline", "sending.pause", "notices"] } } });
  });
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("sending addresses", () => {
  it("setSenderLocalPart refuses in own-mailbox mode: nothing is created and no route sync is queued", async () => {
    const refusal = "Nobody needs an address of their own: every email comes from contact@example.com with each person's display name.";
    expect(OWN_MAILBOX_TEXTS.noSendingAddress(FROM)).toBe(refusal);
    for (const [actor, userId] of [
      [owner, owner.id],
      [ali, ali.id],
      [owner, ali.id],
    ] as const) {
      const err = await sa.setSenderLocalPart(actor, userId, "arslan").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(sa.SenderAddressError);
      expect((err as InstanceType<typeof sa.SenderAddressError>).message).toBe(refusal);
      expect((err as InstanceType<typeof sa.SenderAddressError>).field).toBeNull();
    }
    expect(await db.senderAddress.count()).toBe(0);
    expect(await routeSyncJobs()).toBe(0);
    // Even a name the local-part rules refuse gets the mode's sentence first.
    await expect(sa.setSenderLocalPart(owner, owner.id, "postmaster")).rejects.toThrow(refusal);
  });

  it("getSenderAddressInfo carries the mode and the own From (My profile's From line)", async () => {
    expect(await sa.getSenderAddressInfo(ali.id)).toMatchObject({
      address: null,
      domain: "example.com",
      teamFrom: null,
      replies: "own-mailbox",
      ownFrom: FROM,
    });
    // No fitting From: the mode stays, the own From is null (the page says the Owner sets it).
    await setSettingValue("mailgun.fromAddress", "contact@mail.example.com");
    try {
      expect(await sa.getSenderAddressInfo(ali.id)).toMatchObject({ replies: "own-mailbox", ownFrom: null });
    } finally {
      await setSettingValue("mailgun.fromAddress", FROM);
    }
    expect(await inAppMode(() => sa.getSenderAddressInfo(ali.id))).toMatchObject({ replies: "app", ownFrom: null });
  });
});

describe("My profile's inbox and the loop rule", () => {
  const profile = { name: "Arslan", senderDisplayName: "Arslan from Polygon Paradise", replyInbox: FROM, signature: "", timeZone: "Europe/Berlin" };

  it("checkProfileInput accepts contact@example.com as the inbox in own-mailbox mode and refuses it in app mode on example.com", async () => {
    expect(await users.sendingDomainNames()).toEqual([]);
    expect(users.checkProfileInput(profile, await users.sendingDomainNames())).toMatchObject({ ok: true, next: { replyInbox: FROM } });

    const appDomains = await inAppMode(() => users.sendingDomainNames());
    expect(appDomains).toEqual(["example.com"]);
    expect(users.checkProfileInput(profile, appDomains)).toEqual({
      ok: false,
      fieldErrors: { replyInbox: [users.replyInboxOnSendingDomainText("example.com")] },
    });
  });

  it("an older sending domain still counts for the loop rule in own-mailbox mode (its routes still forward)", async () => {
    await dbWrite((c) => c.sendingDomain.create({ data: { name: "mail.example.com", region: "US", active: false } }));
    try {
      expect(await users.sendingDomainNames()).toEqual(["mail.example.com"]);
      expect(users.checkProfileInput({ ...profile, replyInbox: "ali@mail.example.com" }, await users.sendingDomainNames())).toMatchObject({ ok: false });
    } finally {
      await dbWrite((c) => c.sendingDomain.delete({ where: { name: "mail.example.com" } }));
    }
  });

  it("a profile save queues no route sync in own-mailbox mode (app mode still does)", async () => {
    await users.updateProfile(owner.id, profile);
    expect(await db.user.findUniqueOrThrow({ where: { id: owner.id }, select: { replyInbox: true } })).toEqual({ replyInbox: FROM });
    expect(await routeSyncJobs()).toBe(0);

    await inAppMode(() => users.updateProfile(owner.id, { ...profile, replyInbox: "arslan.k@gmail.com" }));
    expect(await routeSyncJobs()).toBe(1);
  });
});

describe('"Remove it" on Settings › Deliverability', () => {
  it("queues no route sync in own-mailbox mode (app mode still does)", async () => {
    await setSettingValue("sending.testList", ["t.gmail@gmail.com"]);
    await dbWrite((c) => c.suppression.create({ data: { emailNorm: "t.gmail@gmail.com", reason: "UNSUBSCRIBED", source: "manual" } }));
    expect(await removeOwnSuppression(owner, "t.gmail@gmail.com", { mailgun })).toEqual({ removed: true, mailgunProblem: null });
    expect(await routeSyncJobs()).toBe(0);

    await dbWrite((c) => c.suppression.create({ data: { emailNorm: "t.gmail@gmail.com", reason: "UNSUBSCRIBED", source: "manual" } }));
    await inAppMode(() => removeOwnSuppression(owner, "t.gmail@gmail.com", { mailgun }));
    expect(await routeSyncJobs()).toBe(1);
  });
});

describe("who counts as us", () => {
  it("internalSenders includes the own From (and its domain)", async () => {
    const us = await internalSenders();
    expect(us.isInternal(FROM)).toBe(true);
    expect(us.isInternal("hello@example.com")).toBe(true);
    // Unless it answers an email that went to that very address.
    expect(us.isInternal(FROM, [FROM])).toBe(false);
    expect(us.isInternal("anna@studio.example")).toBe(false);
  });
});

describe("words in own-mailbox mode", () => {
  it("the Team switch-off intro: replies keep going to the own From", () => {
    const target = { name: "Ali", activeCampaigns: [], waitingReplies: 0 };
    expect(switchOffDialogText({ ...target, ownFrom: FROM }).intro).toBe(
      "Ali will be signed out everywhere and can't sign in. Their history stays. Replies to Ali's campaigns go to contact@example.com, as before.",
    );
    // No From saved yet: no sentence about replies.
    expect(switchOffDialogText({ ...target, ownFrom: null }).intro).toBe("Ali will be signed out everywhere and can't sign in. Their history stays.");
    // App mode: today's sentences.
    expect(switchOffDialogText(target).intro).toBe(
      "Ali will be signed out everywhere and can't sign in. Their history stays. Replies to Ali's sending address will come to your inbox from now on.",
    );
    expect(switchOffDialogText({ ...target, teamFrom: true }).intro).toContain("Replies to Ali's reply address will come to your inbox");
  });

  it("the Limits page's per-sender list: 'Emails show' with each person's From line, no address words", () => {
    const out = renderToStaticMarkup(
      createElement(SenderCapsForm, {
        ownMailbox: true,
        senders: [
          { userId: 1, name: "Arslan", address: `Arslan from Polygon Paradise <${FROM}>`, dailyCap: null },
          { userId: 2, name: "Ali", address: `Ali from Polygon Paradise <${FROM}>`, dailyCap: 40 },
        ],
      }),
    )
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
    expect(out).toContain(">Emails show<");
    expect(out).toContain(`Ali from Polygon Paradise <${FROM}>`);
    expect(out).not.toMatch(/sending address|reply address/i);
    // App mode keeps its column and empty cell.
    const app = renderToStaticMarkup(createElement(SenderCapsForm, { senders: [{ userId: 2, name: "Ali", address: null, dailyCap: null }] }));
    expect(app).toContain(">Sending address<");
    expect(app).toContain("No sending address yet");
  });

  it("the plan line and the maximum field's hint: 90 campaign emails a day on the Free plan", async () => {
    const effective = await loadEffectiveMaxDailyCap();
    expect(effective.maxCap).toBe(90);
    expect(effective.limits).toMatchObject({ plan: "free", dailyLimit: 100, logDays: 1 });
    expect(PLAN_TEXTS.capLine(90, 100)).toBe(
      "Your Mailgun plan sends at most 100 emails a day, so the app plans at most 90 campaign emails a day and keeps 10 for test emails.",
    );
    expect(PLAN_TEXTS.maxFieldHint(effective.maxCap)).toBe("Your Mailgun plan keeps this at 90 at most.");
    // App mode without a plan: the saved maximum, exactly as before.
    await setSettingValue("mailgun.plan", null);
    try {
      expect(await inAppMode(() => loadEffectiveMaxDailyCap())).toEqual({ maxCap: 1000, limits: null });
    } finally {
      await setSettingValue("mailgun.plan", "free");
    }
  });

  it("a cap override of 95 on the Free plan is refused with the effective maximum", async () => {
    expect(await limits.setTodayCapAction({ cap: 95, confirmed: true })).toMatchObject({
      ok: false,
      error: "Today's limit must be a whole number from 0 to 90.",
    });
    expect((await db.setting.findUnique({ where: { key: "sending.capOverride" } }))?.value ?? null).toBeNull();
    const ok = await limits.setTodayCapAction({ cap: 90, confirmed: true });
    expect(ok).toMatchObject({ ok: true, data: { cap: 90 } });
    await setSettingValue("sending.capOverride", null);
  });
});

describe("health warnings in own-mailbox mode", () => {
  it("the notes: complaints name the own From, bounces say later bounces go to it (app mode: unchanged)", () => {
    const own = { replies: "own-mailbox", evidenceFrom: FROM };
    expect(healthWarningNote("bounce", own)).toBe(" Bounces that arrive later go to contact@example.com, not the app, so the real number can be higher.");
    expect(healthWarningNote("complaint", own)).toBe(
      " Your emails come from contact@example.com, so these complaints also count against your everyday email. Gmail's complaints aren't in this count: check Google Postmaster Tools.",
    );
    // Shared-From mode: the complaint note only; per-person mode: nothing.
    expect(healthWarningNote("bounce", { replies: "app", evidenceFrom: FROM })).toBe("");
    expect(healthWarningNote("complaint", { replies: "app", evidenceFrom: FROM })).toContain("Your emails come from contact@example.com");
    expect(healthWarningNote("complaint", { replies: "app", evidenceFrom: null })).toBe("");
  });

  it("the bounce warning the Owner gets carries the late-bounce sentence", async () => {
    const { seedEmail } = await import("../mail-events/seed");
    for (let i = 0; i < 3; i++) {
      const e = await seedEmail({ createdById: owner.id, email: `b${i}@bounce.example`, domain: "example.com", followUp: false });
      await dbWrite((c) =>
        c.mailEvent.create({
          data: {
            dedupeKey: `test-bounce-${i}`,
            type: "failed",
            severity: "permanent",
            reason: "bounce",
            occurredAt: new Date(),
            messageId: e.messageId,
            recipient: e.toNorm,
            outboundEmailId: e.emailId,
            source: "LOGS",
            raw: {},
            processedAt: new Date(),
          },
        }),
      );
    }
    const res = await runHealthCheck();
    expect(res.warned).toEqual(["bounce"]);
    const note = await db.notification.findFirstOrThrow({ where: { type: "sending.warning" } });
    expect(note.body).toMatch(/ Bounces that arrive later go to contact@example\.com, not the app, so the real number can be higher\.$/);
  });
});
