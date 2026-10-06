import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { clearJobs, makeUser, queuedJobs } from "../mailgun-setup/helpers";

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

const t = await createTestDb("sender-addresses");
const mg: FakeConnection = await connectFakeMailgun();
const { db, dbWrite } = await import("@/server/db");
const sa = await import("@/server/services/sender-addresses");
const users = await import("@/server/services/users");
const { LOCAL_PART_TEXTS, reservedLocalPartText } = await import("@/core/sender-address");
const { updateProfileAction } = await import("@/app/(app)/settings/profile/actions");
const { setSetting } = await import("@/server/settings");

const D = mg.domain;
let owner: TestUser;
let ali: TestUser;
let sara: TestUser;

function asUser(u: { id: number; email: string; name: string; role: "OWNER" | "MEMBER" }): TestUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, timeZone: "Europe/Berlin", sessionId: 1 };
}

async function expectRefused(p: Promise<unknown>, text: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(sa.SenderAddressError);
  expect((err as Error).message).toBe(text);
}

beforeAll(async () => {
  owner = asUser(await makeUser("Arslan", { role: "OWNER", replyInbox: "arslan.owner@gmail.com" }));
  ali = asUser(await makeUser("Ali", { replyInbox: "ali.khan@gmail.com" }));
  sara = asUser(await makeUser("Sara", { replyInbox: "sara.b@outlook.com" }));
});

beforeEach(async () => {
  await clearJobs();
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("setSenderLocalPart", () => {
  it("checks the name first: empty, badly formed and reserved names", async () => {
    await expectRefused(sa.setSenderLocalPart(ali, ali.id, " "), LOCAL_PART_TEXTS.empty);
    await expectRefused(sa.setSenderLocalPart(ali, ali.id, "al..i"), LOCAL_PART_TEXTS.invalid);
    await expectRefused(sa.setSenderLocalPart(ali, ali.id, "Postmaster"), reservedLocalPartText("postmaster"));
    expect(await db.senderAddress.count()).toBe(0);
  });

  it("waits for a sending domain", async () => {
    await dbWrite((c) => c.sendingDomain.updateMany({ data: { active: false } }));
    try {
      await expectRefused(sa.setSenderLocalPart(ali, ali.id, "ali"), sa.SENDER_ADDRESS_TEXTS.noDomain);
      expect(await sa.getSenderAddressInfo(ali.id)).toMatchObject({ domain: null, address: null });
    } finally {
      await dbWrite((c) => c.sendingDomain.updateMany({ data: { active: true } }));
    }
  });

  it("sets a Member's address: pending route, logged, the Owner told, a route sync queued", async () => {
    const res = await sa.setSenderLocalPart(ali, ali.id, "  Ali ");
    expect(res).toEqual({ changed: true, address: `ali@${D}` });
    const row = await db.senderAddress.findUniqueOrThrow({ where: { address: `ali@${D}` } });
    expect(row).toMatchObject({ userId: ali.id, domainId: mg.domainId, localPart: "ali", routeStatus: "pending", retiredAt: null });
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "user.senderAddress" }, orderBy: { id: "desc" } });
    expect(log).toMatchObject({ actorId: ali.id, summary: `Ali set their sending address to ali@${D}` });
    const note = await db.notification.findFirstOrThrow({ where: { type: "user.senderAddress" } });
    expect(note).toMatchObject({ userId: owner.id, title: "Ali changed their sending address", body: `From now on Ali's campaigns come from ali@${D}.` });
    const jobs = await queuedJobs("mailgun.syncRoutes");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.activeDedupeKey).toBe("mailgun:routes");
    expect(await sa.getSenderAddressInfo(ali.id)).toMatchObject({ address: `ali@${D}`, localPart: "ali", domain: D, routeStatus: "pending", blockedBy: [] });
  });

  it("the same name again changes nothing", async () => {
    const before = await db.activityLog.count({ where: { type: "user.senderAddress" } });
    expect(await sa.setSenderLocalPart(ali, ali.id, "ali")).toEqual({ changed: false, address: `ali@${D}` });
    expect(await db.activityLog.count({ where: { type: "user.senderAddress" } })).toBe(before);
    expect(await queuedJobs("mailgun.syncRoutes")).toHaveLength(0);
  });

  it("keeps names unique, retired addresses included, and gives your own retired address back", async () => {
    await expectRefused(sa.setSenderLocalPart(sara, sara.id, "ali"), sa.senderAddressTakenText(`ali@${D}`));
    const first = await db.senderAddress.findUniqueOrThrow({ where: { address: `ali@${D}` } });
    await sa.setSenderLocalPart(ali, ali.id, "ali.k");
    expect((await db.senderAddress.findUniqueOrThrow({ where: { id: first.id } })).retiredAt).not.toBeNull();
    // Retired, but still Ali's.
    await expectRefused(sa.setSenderLocalPart(sara, sara.id, "ali"), sa.senderAddressTakenText(`ali@${D}`));
    await sa.setSenderLocalPart(ali, ali.id, "ali");
    const back = await db.senderAddress.findUniqueOrThrow({ where: { address: `ali@${D}` } });
    expect(back.id).toBe(first.id);
    expect(back.retiredAt).toBeNull();
    expect((await db.senderAddress.findUniqueOrThrow({ where: { address: `ali.k@${D}` } })).retiredAt).not.toBeNull();
    expect(await db.senderAddress.count({ where: { userId: ali.id, retiredAt: null } })).toBe(1);
  });

  it("can't change while that sender's test or live campaigns are scheduled, running or paused (dry runs don't matter)", async () => {
    await dbWrite((c) => c.campaign.create({ data: { name: "Dry one", createdById: owner.id, senderId: ali.id, mode: "DRY_RUN", status: "RUNNING" } }));
    await sa.setSenderLocalPart(ali, ali.id, "ali.dry");
    const live = await dbWrite((c) =>
      c.campaign.create({ data: { name: "Test mailboxes", createdById: owner.id, senderId: ali.id, mode: "TEST", status: "SCHEDULED" } }),
    );
    await expectRefused(sa.setSenderLocalPart(ali, ali.id, "ali"), sa.senderAddressBlockedText(["Test mailboxes"]));
    expect((await sa.getSenderAddressInfo(ali.id)).blockedBy).toEqual(["Test mailboxes"]);
    await dbWrite((c) => c.campaign.update({ where: { id: live.id }, data: { status: "FINISHED" } }));
    expect((await sa.setSenderLocalPart(ali, ali.id, "ali")).changed).toBe(true);
  });

  it("only the Owner changes someone else's; no notice when the Owner does", async () => {
    await expectRefused(sa.setSenderLocalPart(sara, ali.id, "x"), sa.SENDER_ADDRESS_TEXTS.notYours);
    const notes = await db.notification.count({ where: { type: "user.senderAddress" } });
    await sa.setSenderLocalPart(owner, sara.id, "sara");
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "user.senderAddress" }, orderBy: { id: "desc" } });
    expect(log.summary).toBe(`Arslan set Sara's sending address to sara@${D}`);
    await sa.setSenderLocalPart(owner, owner.id, "arslan");
    expect(await db.notification.count({ where: { type: "user.senderAddress" } })).toBe(notes);
  });
});

describe("users.ts and reply routes", () => {
  it("refuses a reply inbox on (or under) a sending domain", async () => {
    const profile = { name: "Ali", senderDisplayName: "Ali from Polygon Paradise", signature: "", timeZone: "Europe/Berlin" };
    for (const inbox of [`ali@${D}`, `ali@reply.${D}`]) {
      const err = await users.updateProfile(ali.id, { ...profile, replyInbox: inbox }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(users.TeamError);
      expect((err as InstanceType<typeof users.TeamError>).fieldErrors?.replyInbox).toEqual([users.replyInboxOnSendingDomainText(D)]);
    }
    expect(users.replyInboxOnSendingDomainText(D)).toBe(
      `Your reply inbox can't be on the sending domain ${D}: replies would go round in circles. Use your normal mailbox, such as Gmail or Outlook.com.`,
    );
  });

  it("queues a route sync when a sender's reply inbox changes, and when a sender is switched off or on", async () => {
    const profile = { name: "Ali", senderDisplayName: "Ali from Polygon Paradise", signature: "", timeZone: "Europe/Berlin" };
    await users.updateProfile(ali.id, { ...profile, replyInbox: "ali.khan@gmail.com" });
    await clearJobs();
    await users.updateProfile(ali.id, { ...profile, replyInbox: "ali.new@gmail.com" });
    expect(await queuedJobs("mailgun.syncRoutes")).toHaveLength(1);
    await clearJobs();
    await users.updateProfile(ali.id, { ...profile, replyInbox: "ali.new@gmail.com", signature: "Ali" });
    expect(await queuedJobs("mailgun.syncRoutes")).toHaveLength(0);

    await users.deactivateUser(owner.id, ali.id);
    expect(await queuedJobs("mailgun.syncRoutes")).toHaveLength(1);
    await clearJobs();
    await users.reactivateUser(owner.id, ali.id);
    expect(await queuedJobs("mailgun.syncRoutes")).toHaveLength(1);

    // Someone without a sending address doesn't need a sync.
    const mira = await makeUser("Mira");
    await clearJobs();
    await users.deactivateUser(owner.id, mira.id);
    expect(await queuedJobs("mailgun.syncRoutes")).toHaveLength(0);
  });

  it("queues a route sync when someone else becomes the Owner (the catch-all, dmarc@ and switched-off senders' routes follow)", async () => {
    // Only someone who has signed in can become the Owner (and hand it back).
    await dbWrite((c) => c.user.updateMany({ where: { id: { in: [sara.id, owner.id] } }, data: { passwordHash: "argon2-placeholder" } }));
    await clearJobs();
    await users.transferOwnership(owner.id, sara.id);
    try {
      const jobs = await queuedJobs("mailgun.syncRoutes");
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ activeDedupeKey: "mailgun:routes", createdById: owner.id });
    } finally {
      await users.transferOwnership(sara.id, owner.id);
      await clearJobs();
    }
    // No active sending domain: nothing to sync.
    await dbWrite((c) => c.sendingDomain.updateMany({ data: { active: false } }));
    try {
      await users.transferOwnership(owner.id, sara.id);
      await users.transferOwnership(sara.id, owner.id);
      expect(await queuedJobs("mailgun.syncRoutes")).toHaveLength(0);
    } finally {
      await dbWrite((c) => c.sendingDomain.updateMany({ data: { active: true } }));
    }
  });
});

describe("My profile action (everyone)", () => {
  const base = { senderDisplayName: "Sara from Polygon Paradise", replyInbox: "sara.b@outlook.com", signature: "", timeZone: "Europe/Berlin" };

  it("a Member saves the profile and a new sending address together", async () => {
    auth.user = sara;
    const res = await updateProfileAction({ ...base, name: "Sara", senderLocalPart: "sara.b" });
    expect(res).toMatchObject({ ok: true, data: { address: `sara.b@${D}` } });
    expect(await db.senderAddress.findUniqueOrThrow({ where: { address: `sara.b@${D}` } })).toMatchObject({ userId: sara.id, retiredAt: null });
    expect(res.ok && res.message).toBe(`Profile saved. Your sending address is now sara.b@${D}; its reply route is being set up.`);
  });

  it("a bad name before the @ saves nothing, with the error on that field", async () => {
    auth.user = sara;
    const res = await updateProfileAction({ ...base, name: "Sara Berg", senderLocalPart: "no-reply" });
    expect(res).toMatchObject({ ok: false, fieldErrors: { senderLocalPart: [reservedLocalPartText("no-reply")] } });
    expect((await db.user.findUniqueOrThrow({ where: { id: sara.id } })).name).toBe("Sara");
  });

  it("an address taken by someone else: the rest is saved, and the message says so", async () => {
    auth.user = sara;
    const res = await updateProfileAction({ ...base, name: "Sara Berg", senderLocalPart: "ali" });
    expect(res).toMatchObject({
      ok: false,
      error: `Your profile is saved, but your sending address didn't change: ${sa.senderAddressTakenText(`ali@${D}`)}`,
      fieldErrors: { senderLocalPart: [sa.senderAddressTakenText(`ali@${D}`)] },
    });
    expect((await db.user.findUniqueOrThrow({ where: { id: sara.id } })).name).toBe("Sara Berg");
  });

  it("signed out: refused", async () => {
    auth.user = null;
    expect(await updateProfileAction({ ...base, name: "X" })).toEqual({ ok: false, error: "Your session has ended. Please sign in again." });
  });
});

/**
 * SHARED-FROM-DESIGN §3.6 (F19): with a shared From address saved (and fitting the sending domain), the person's own
 * address is the Reply-To, and every sentence about it says "reply address". Per-person mode keeps "sending address"
 * (the cases above run without a From address and stay unchanged).
 */
describe("shared-From mode: the reply address", () => {
  const base = { senderDisplayName: "Sara from Polygon Paradise", replyInbox: "sara.b@outlook.com", signature: "", timeZone: "Europe/Berlin" };
  const clearFrom = () => dbWrite((c) => c.setting.deleteMany({ where: { key: "mailgun.fromAddress" } }));

  beforeAll(async () => {
    await setSetting("mailgun.fromAddress", "contact@example.com", null);
  });
  afterAll(async () => {
    await clearFrom();
    auth.user = null;
  });

  it("the text functions: 'sending address' per person (unchanged), 'reply address' with a shared From", () => {
    expect(sa.senderAddressNotYoursText()).toBe(sa.SENDER_ADDRESS_TEXTS.notYours);
    expect(sa.senderAddressNotYoursText(false)).toBe("Only the Owner can change someone else's sending address.");
    expect(sa.senderAddressNotYoursText(true)).toBe("Only the Owner can change someone else's reply address.");
    expect(sa.senderAddressBlockedText(["Q4", "Norway"])).toBe(
      "You can't change your sending address while your campaigns are running or paused (Q4, Norway). Wait until they finish, or ask the Owner to cancel them.",
    );
    expect(sa.senderAddressBlockedText(["Q4"], true)).toBe(
      "You can't change your reply address while your campaigns are running or paused (Q4). Wait until they finish, or ask the Owner to cancel them.",
    );
    expect(sa.profileSavedWithAddressText("ali@mail.example.com")).toBe(
      "Profile saved. Your sending address is now ali@mail.example.com; its reply route is being set up.",
    );
    expect(sa.profileSavedWithAddressText("ali@mail.example.com", true)).toBe(
      "Profile saved. Your reply address is now ali@mail.example.com; its reply route is being set up.",
    );
    expect(sa.profileSavedAddressUnchangedText("Why.")).toBe("Your profile is saved, but your sending address didn't change: Why.");
    expect(sa.profileSavedAddressUnchangedText("Why.", true)).toBe("Your profile is saved, but your reply address didn't change: Why.");
    // The Playwright-pinned per-person empty text is unchanged.
    expect(sa.noSenderAddressesText()).toBe("Nobody has a sending address yet. Each person adds one in Settings › My profile.");
    expect(sa.noSenderAddressesText(true)).toBe("Nobody has a reply address yet. Each person adds one in Settings › My profile.");
    expect(sa.senderAddressNoticeText("Ali", "ali@mail.example.com")).toEqual({
      title: "Ali changed their sending address",
      body: "From now on Ali's campaigns come from ali@mail.example.com.",
    });
    expect(sa.senderAddressNoticeText("Ali", "ali@mail.example.com", true)).toEqual({
      title: "Ali changed their reply address",
      body: "From now on, replies to Ali's campaigns go to ali@mail.example.com.",
    });
    const self = { actorName: "Ali", userName: "Ali", self: true, address: "ali@mail.example.com" };
    const other = { actorName: "Arslan", userName: "Sara", self: false, address: "sara@mail.example.com" };
    expect(sa.senderAddressActivityText(self)).toBe("Ali set their sending address to ali@mail.example.com");
    expect(sa.senderAddressActivityText(self, true)).toBe("Ali set their reply address to ali@mail.example.com");
    expect(sa.senderAddressActivityText(other)).toBe("Arslan set Sara's sending address to sara@mail.example.com");
    expect(sa.senderAddressActivityText(other, true)).toBe("Arslan set Sara's reply address to sara@mail.example.com");
    // The no-domain sentence is the same in both modes (no From address can be saved before a domain exists).
    expect(sa.SENDER_ADDRESS_TEXTS.noDomain).toBe(
      "Your sending address is set up once the Owner connects the sending domain in Settings › Sending & Mailgun.",
    );
  });

  it("getSenderAddressInfo carries the shared From address; a saved one that doesn't fit counts as per-person", async () => {
    expect(await sa.getSenderAddressInfo(ali.id)).toMatchObject({ address: `ali@${D}`, domain: D, teamFrom: "contact@example.com" });
    await setSetting("mailgun.fromAddress", "contact@other.com", null);
    try {
      expect((await sa.getSenderAddressInfo(ali.id)).teamFrom).toBeNull();
    } finally {
      await setSetting("mailgun.fromAddress", "contact@example.com", null);
    }
    await clearFrom();
    try {
      expect((await sa.getSenderAddressInfo(ali.id)).teamFrom).toBeNull();
    } finally {
      await setSetting("mailgun.fromAddress", "contact@example.com", null);
    }
  });

  it("a Member's new reply address: the activity and the Owner's notice say reply address", async () => {
    expect(await sa.setSenderLocalPart(ali, ali.id, "ali.r")).toEqual({ changed: true, address: `ali.r@${D}` });
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "user.senderAddress" }, orderBy: { id: "desc" } });
    expect(log).toMatchObject({ actorId: ali.id, summary: `Ali set their reply address to ali.r@${D}` });
    const note = await db.notification.findFirstOrThrow({ where: { type: "user.senderAddress" }, orderBy: { id: "desc" } });
    expect(note).toMatchObject({
      userId: owner.id,
      title: "Ali changed their reply address",
      body: `From now on, replies to Ali's campaigns go to ali.r@${D}.`,
      link: "/settings/team",
    });
    await sa.setSenderLocalPart(owner, sara.id, "sara.c");
    const byOwner = await db.activityLog.findFirstOrThrow({ where: { type: "user.senderAddress" }, orderBy: { id: "desc" } });
    // Sara is "Sara Berg" by now (the profile action above renamed her).
    expect(byOwner.summary).toBe(`Arslan set Sara Berg's reply address to sara.c@${D}`);
  });

  it("someone else's address and a change while campaigns run: the refusals say reply address", async () => {
    await expectRefused(sa.setSenderLocalPart(sara, ali.id, "x"), "Only the Owner can change someone else's reply address.");
    const running = await dbWrite((c) =>
      c.campaign.create({ data: { name: "Shared Q4", createdById: owner.id, senderId: ali.id, mode: "LIVE", status: "RUNNING" } }),
    );
    try {
      await expectRefused(sa.setSenderLocalPart(ali, ali.id, "ali.z"), sa.senderAddressBlockedText(["Shared Q4"], true));
      expect(sa.senderAddressBlockedText(["Shared Q4"], true)).toContain("You can't change your reply address while");
    } finally {
      await dbWrite((c) => c.campaign.update({ where: { id: running.id }, data: { status: "FINISHED" } }));
    }
  });

  it("the profile action: the toast and the didn't-change sentence say reply address", async () => {
    auth.user = sara;
    const saved = await updateProfileAction({ ...base, name: "Sara", senderLocalPart: "sara.d" });
    expect(saved).toMatchObject({ ok: true, data: { address: `sara.d@${D}` } });
    expect(saved.ok && saved.message).toBe(`Profile saved. Your reply address is now sara.d@${D}; its reply route is being set up.`);
    const taken = await updateProfileAction({ ...base, name: "Sara Blom", senderLocalPart: "ali.r" });
    expect(taken).toMatchObject({
      ok: false,
      error: `Your profile is saved, but your reply address didn't change: ${sa.senderAddressTakenText(`ali.r@${D}`)}`,
      fieldErrors: { senderLocalPart: [sa.senderAddressTakenText(`ali.r@${D}`)] },
    });
  });
});
