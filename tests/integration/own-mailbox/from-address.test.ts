import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { clearJobs, makeUser, queuedJobs, setSettingValue } from "../mailgun-setup/helpers";

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

/**
 * "Save From address" in own-mailbox mode (MAIN-DOMAIN-DESIGN O3, §2.7, §3.2): the own From must be exactly on the
 * sending domain (contact@ allowed, subdomains, other domains and mail-server names refused); clearing it is allowed and
 * then TEST/LIVE can't start (`fromMissing`); the own-mailbox toasts and clearing activity; while live the Owner
 * confirms that going live ends (F13, unchanged); Members are refused. Through the Owner-only action, against the fake.
 */

const t = await createTestDb("own-from-address");
const mg: FakeConnection = await connectFakeMailgun({
  domain: "example.com",
  region: "US",
  replies: "own-mailbox",
  plan: "free",
  fake: { domain: "example.com", region: "US", plan: "free", receivesMail: false },
});
const { db, dbWrite } = await import("@/server/db");
const { getSetting } = await import("@/server/settings");
const { TEAM_FROM_TEXTS } = await import("@/core/sending/from-address");
const { OWN_MAILBOX_TEXTS } = await import("@/core/sending/own-mailbox");
const { GO_LIVE_COPY } = await import("@/core/sending/go-live-copy");
const { loadTeamFrom } = await import("@/server/services/mailgun/team-from");
const sending = await import("@/app/(app)/settings/sending/actions");

const D = mg.domain; // example.com
const OWNER_ONLY = "Only the Owner can do this.";
let owner: TestUser;
let member: TestUser;

function asUser(u: { id: number; email: string; name: string; role: "OWNER" | "MEMBER" }): TestUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, timeZone: "Asia/Karachi", sessionId: 1 };
}

async function lastActivity() {
  return db.activityLog.findFirstOrThrow({ where: { type: "mailgun.fromAddressChanged" }, orderBy: { id: "desc" } });
}

beforeAll(async () => {
  owner = asUser(await makeUser("Arslan", { role: "OWNER", replyInbox: "arslan.owner@gmail.com" }));
  member = asUser(await makeUser("Ali", { replyInbox: "ali.khan@gmail.com" }));
});

beforeEach(async () => {
  auth.user = owner;
  await clearJobs();
  await setSettingValue("mailgun.fromAddress", null);
  await setSettingValue("sending.goLive", false);
  await setSettingValue("sending.testList", ["tess@outlook.com", "gina.test@gmail.com"]);
  await dbWrite((c) => c.campaign.deleteMany({}));
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("Save From address in own-mailbox mode", () => {
  it("nothing saved: TEST/LIVE can't start (fromMissing)", async () => {
    expect(await loadTeamFrom()).toMatchObject({
      replies: "own-mailbox",
      saved: null,
      address: null,
      ownFrom: null,
      evidenceFrom: null,
      problem: OWN_MAILBOX_TEXTS.fromMissing(D),
    });
    expect(OWN_MAILBOX_TEXTS.fromMissing(D)).toBe(
      "Type the address your emails come from in Settings › Sending & Mailgun › From address, for example contact@example.com. Test and live campaigns can't start without it.",
    );
  });

  it("saves contact@ on the sending domain, with the own-mailbox toast, the activity and a domain check", async () => {
    const res = await sending.saveFromAddressAction({ fromAddress: " Contact@Example.com " });
    expect(res).toEqual({
      ok: true,
      data: { fromAddress: "contact@example.com", goLiveEnded: false },
      message: OWN_MAILBOX_TEXTS.savedOn("contact@example.com"),
    });
    expect(OWN_MAILBOX_TEXTS.savedOn("contact@example.com")).toBe(
      "From now on, campaign emails show From contact@example.com. Replies go straight to that mailbox (look in its Spam folder too): when someone answers, click They replied on their company. Run the reply test before live campaigns (Settings › Domain checklist).",
    );
    expect(await getSetting("mailgun.fromAddress")).toBe("contact@example.com");
    expect(await loadTeamFrom()).toMatchObject({
      replies: "own-mailbox",
      address: null,
      ownFrom: "contact@example.com",
      evidenceFrom: "contact@example.com",
      problem: null,
    });
    const log = await lastActivity();
    expect(log.summary).toBe("Arslan set the From address to contact@example.com");
    expect(log.data).toEqual({ from: null, to: "contact@example.com", goLiveEnded: false });
    expect(await queuedJobs("mailgun.checkDomain")).toHaveLength(1);
    // Saving the same address again changes nothing.
    expect(await sending.saveFromAddressAction({ fromAddress: "contact@example.com" })).toMatchObject({ ok: true, message: TEAM_FROM_TEXTS.nothingChanged });
  });

  it("refuses addresses not exactly on the sending domain, mail-server names and anything that isn't one bare address", async () => {
    const cases: Array<[string, string]> = [
      ["a@mail.example.com", OWN_MAILBOX_TEXTS.fromWrongDomain(D)],
      ["contact@other.com", OWN_MAILBOX_TEXTS.fromWrongDomain(D)],
      ["contact@gmail.com", OWN_MAILBOX_TEXTS.fromWrongDomain(D)],
      ["noreply@example.com", TEAM_FROM_TEXTS.reserved("noreply", "contact@example.com")],
      ["postmaster@example.com", TEAM_FROM_TEXTS.reserved("postmaster", "contact@example.com")],
      ['"Ali" <contact@example.com>', TEAM_FROM_TEXTS.invalid("contact@example.com")],
    ];
    for (const [input, error] of cases) {
      expect(await sending.saveFromAddressAction({ fromAddress: input }), input).toMatchObject({
        ok: false,
        error,
        fieldErrors: { fromAddress: [error] },
      });
    }
    expect(OWN_MAILBOX_TEXTS.fromWrongDomain(D)).toBe("The From address must end in @example.com, your sending domain.");
    expect(await getSetting("mailgun.fromAddress")).toBeNull();
    expect(await db.activityLog.count({ where: { type: "mailgun.fromAddressChanged", summary: { contains: "mail.example.com" } } })).toBe(0);
  });

  it("clearing is allowed: the own toast and activity, then fromMissing again", async () => {
    await setSettingValue("mailgun.fromAddress", "contact@example.com");
    const res = await sending.saveFromAddressAction({ fromAddress: "" });
    expect(res).toMatchObject({ ok: true, data: { fromAddress: null }, message: OWN_MAILBOX_TEXTS.savedOff(D) });
    expect(OWN_MAILBOX_TEXTS.savedOff(D)).toBe("The From address is cleared. Test and live campaigns can't start until you type an address on example.com.");
    expect((await lastActivity()).summary).toBe("Arslan cleared the From address");
    expect((await loadTeamFrom()).problem).toBe(OWN_MAILBOX_TEXTS.fromMissing(D));
  });

  it("resets the reply test (answers cleared, Setup kept) and is refused while a test or live campaign is active", async () => {
    await setSettingValue("mailgun.unsubscribeTest", {
      setup: "A",
      status: "passed",
      domain: D,
      mailboxes: [{ address: "tess@outlook.com", provider: "microsoft", inboxOk: true, authOk: null, authFromHeaders: false }],
      headersOk: true,
      decidedAt: "2026-09-25T10:00:00.000Z",
      decidedById: owner.id,
      note: null,
      from: "info@example.com",
      replies: "own-mailbox",
    });
    await setSettingValue("mailgun.fromAddress", "info@example.com");
    expect((await sending.saveFromAddressAction({ fromAddress: "contact@example.com" })).ok).toBe(true);
    expect(await getSetting("mailgun.unsubscribeTest")).toMatchObject({ status: "untested", setup: "A", mailboxes: [], domain: null });

    await dbWrite((c) => c.campaign.create({ data: { name: "Test run", createdById: owner.id, mode: "TEST", status: "RUNNING" } }));
    expect(await sending.saveFromAddressAction({ fromAddress: "hello@example.com" })).toMatchObject({
      ok: false,
      error: "Finish or cancel “Test run” first: it sends with the current From address.",
    });
    expect(await getSetting("mailgun.fromAddress")).toBe("contact@example.com");
  });

  it("while live: asks first (going live ends), then saves and ends go-live", async () => {
    await setSettingValue("sending.goLive", true);
    expect(await sending.saveFromAddressAction({ fromAddress: "contact@example.com" })).toMatchObject({ ok: false, error: TEAM_FROM_TEXTS.confirmBody });
    expect(await getSetting("mailgun.fromAddress")).toBeNull();
    const res = await sending.saveFromAddressAction({ fromAddress: "contact@example.com", confirmEndGoLive: true });
    expect(res).toMatchObject({
      ok: true,
      data: { fromAddress: "contact@example.com", goLiveEnded: true },
      message: `${OWN_MAILBOX_TEXTS.savedOn("contact@example.com")} ${GO_LIVE_COPY.endedByFromChange}`,
    });
    expect(await getSetting("sending.goLive")).toBe(false);
    expect((await lastActivity()).data).toEqual({ from: null, to: "contact@example.com", goLiveEnded: true });
  });

  it("a Member is refused", async () => {
    auth.user = member;
    expect(await sending.saveFromAddressAction({ fromAddress: "contact@example.com" })).toEqual({ ok: false, error: OWNER_ONLY });
    expect(await getSetting("mailgun.fromAddress")).toBeNull();
  });
});
