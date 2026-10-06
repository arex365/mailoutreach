import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { clearJobs, makeUser, queuedJobs, setSettingValue } from "./helpers";

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
 * "Save From address" (SHARED-FROM-DESIGN §2.7, §3.1, F13, F15): every branch of saveFromAddress, and its Owner-only
 * action. A From change is refused while test or live campaigns are active, ends go-live only after the Owner confirmed
 * (in the same transaction), resets the reply test with its Setup kept, logs the activity and asks for a domain check.
 */

const t = await createTestDb("mg-from-address");
const mg: FakeConnection = await connectFakeMailgun();
const { db, dbWrite } = await import("@/server/db");
const { getSetting } = await import("@/server/settings");
const { TEAM_FROM_TEXTS } = await import("@/core/sending/from-address");
const { GO_LIVE_COPY } = await import("@/core/sending/go-live-copy");
const { loadTeamFrom } = await import("@/server/services/mailgun/team-from");
const connect = await import("@/server/services/mailgun/connect");
const sending = await import("@/app/(app)/settings/sending/actions");

const D = mg.domain; // send.example.com
const OWNER_ONLY = "Only the Owner can do this.";
let owner: TestUser;
let member: TestUser;

function asUser(u: { id: number; email: string; name: string; role: "OWNER" | "MEMBER" }): TestUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, timeZone: "Asia/Karachi", sessionId: 1 };
}

/** A reply test that passed with Setup B for the current From, with answers and a pasted original. */
const PASSED_B = {
  setup: "B",
  status: "passed",
  domain: "send.example.com",
  mailboxes: [{ address: "tess@outlook.com", provider: "microsoft", inboxOk: true, authOk: "pass", authFromHeaders: false, placementOk: true, dmarcOk: "pass" }],
  headersOk: true,
  decidedAt: "2026-09-25T10:00:00.000Z",
  decidedById: 1,
  note: null,
  from: "contact@example.com",
  original: {
    domain: "send.example.com",
    from: "contact@example.com",
    address: "tess@outlook.com",
    testSendId: 1,
    returnPathDomain: "send.example.com",
    returnPathOk: true,
    dmarc: "pass",
    dkimSigner: "example.com",
    mailtoDomain: null,
    mailtoOk: true,
    readAt: "2026-09-25T09:00:00.000Z",
  },
};

async function activityCount(): Promise<number> {
  return db.activityLog.count({ where: { type: "mailgun.fromAddressChanged" } });
}

async function lastActivity() {
  return db.activityLog.findFirstOrThrow({ where: { type: "mailgun.fromAddressChanged" }, orderBy: { id: "desc" } });
}

async function setFrom(value: string | null) {
  await setSettingValue("mailgun.fromAddress", value);
}

beforeAll(async () => {
  owner = asUser(await makeUser("Arslan", { role: "OWNER", replyInbox: "arslan.owner@gmail.com" }));
  member = asUser(await makeUser("Ali", { replyInbox: "ali.khan@gmail.com" }));
});

beforeEach(async () => {
  auth.user = owner;
  await clearJobs();
  await setFrom(null);
  await setSettingValue("sending.goLive", false);
  await setSettingValue("sending.testList", ["tess@outlook.com", "gina.test@gmail.com"]);
  await setSettingValue("practice.copy", false);
  await dbWrite((c) => c.campaign.deleteMany({}));
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("saveFromAddress", () => {
  it("sets a From address: saved lowercase, the reply test reset with Setup B kept, the activity, one domain check", async () => {
    await setSettingValue("mailgun.unsubscribeTest", PASSED_B);
    const before = await activityCount();
    const res = await connect.saveFromAddress(owner, { fromAddress: "  mailto:Contact@Example.com " });
    expect(res).toEqual({
      ok: true,
      message:
        "From now on, campaign emails show From contact@example.com, and replies go to each person's address on send.example.com. Run the reply test before live campaigns (Settings › Domain checklist).",
      fromAddress: "contact@example.com",
      goLiveEnded: false,
    });
    expect(await getSetting("mailgun.fromAddress")).toBe("contact@example.com");
    expect((await loadTeamFrom()).address).toBe("contact@example.com");
    // Answers, the decision, its From and the pasted original are gone; the chosen Setup stays (C1-14).
    expect(await getSetting("mailgun.unsubscribeTest")).toEqual({
      setup: "B",
      status: "untested",
      domain: null,
      mailboxes: [],
      headersOk: null,
      decidedAt: null,
      decidedById: null,
      note: null,
    });
    expect(await activityCount()).toBe(before + 1);
    const log = await lastActivity();
    expect(log).toMatchObject({ actorId: owner.id, summary: "Arslan set the From address to contact@example.com" });
    expect(log.data).toEqual({ from: null, to: "contact@example.com", goLiveEnded: false });
    expect(await queuedJobs("mailgun.checkDomain")).toHaveLength(1);
    // Nothing reached Mailgun: the From address is checked by a pure rule.
    expect(mg.fake.requests.filter((r) => r.path.includes("example.com") && !r.path.includes(D))).toEqual([]);
  });

  it("the same value again: nothing changed, nothing written", async () => {
    await setFrom("contact@example.com");
    const before = await activityCount();
    const res = await connect.saveFromAddress(owner, { fromAddress: "CONTACT@example.com" });
    expect(res).toEqual({ ok: true, message: "Nothing changed.", fromAddress: "contact@example.com", goLiveEnded: false });
    expect(await activityCount()).toBe(before);
    expect(await queuedJobs("mailgun.checkDomain")).toHaveLength(0);
  });

  it("changes and clears it, with the activity sentences; the domain check is queued once", async () => {
    await setFrom("contact@example.com");
    const changed = await connect.saveFromAddress(owner, { fromAddress: "hello@example.com" });
    expect(changed).toMatchObject({ ok: true, fromAddress: "hello@example.com" });
    expect((await lastActivity()).summary).toBe("Arslan changed the From address from contact@example.com to hello@example.com");
    const cleared = await connect.saveFromAddress(owner, { fromAddress: "" });
    expect(cleared).toEqual({
      ok: true,
      message:
        "From now on, each person's campaign emails come from their own address on send.example.com. Run the reply test before live campaigns (Settings › Domain checklist).",
      fromAddress: null,
      goLiveEnded: false,
    });
    expect(await getSetting("mailgun.fromAddress")).toBeNull();
    expect(await loadTeamFrom()).toMatchObject({ address: null, saved: null, problem: null });
    const log = await lastActivity();
    expect(log.summary).toBe("Arslan cleared the From address: each person's own address is the From again");
    expect(log.data).toEqual({ from: "hello@example.com", to: null, goLiveEnded: false });
    // Two saves, one queued check (the dedupe key).
    expect(await queuedJobs("mailgun.checkDomain")).toHaveLength(1);
  });

  it("a check already running when the From changes gets one more check behind it (review SETTING-6)", async () => {
    // The running check may have read the old From address: the usual dedupe key would hand it back.
    const running = await dbWrite((c) =>
      c.job.create({ data: { type: "mailgun.checkDomain", status: "RUNNING", activeDedupeKey: "mailgun:domain-check", priority: 20, startedAt: new Date() } }),
    );
    await connect.saveFromAddress(owner, { fromAddress: "contact@example.com" });
    const queued = await queuedJobs("mailgun.checkDomain");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ activeDedupeKey: "mailgun:domain-check-after-change", priority: 20, createdById: owner.id });
    // A second change while both wait: still one follow-up (it hasn't started, so it reads the newest From).
    await connect.saveFromAddress(owner, { fromAddress: "hello@example.com" });
    expect(await queuedJobs("mailgun.checkDomain")).toHaveLength(1);
    // Once the running check is done, a change queues the usual check again.
    await dbWrite((c) => c.job.update({ where: { id: running.id }, data: { status: "DONE", activeDedupeKey: null, finishedAt: new Date() } }));
    await clearJobs();
    await connect.saveFromAddress(owner, { fromAddress: "" });
    expect((await queuedJobs("mailgun.checkDomain")).map((j) => j.activeDedupeKey)).toEqual(["mailgun:domain-check"]);
  });

  it("a From change moves the setting's change time (the evidence filter, F26)", async () => {
    await setFrom("contact@example.com");
    const before = (await loadTeamFrom()).changedAt!;
    await new Promise((r) => setTimeout(r, 15));
    await connect.saveFromAddress(owner, { fromAddress: "hello@example.com" });
    expect((await loadTeamFrom()).changedAt!.getTime()).toBeGreaterThan(before.getTime());
  });

  it("refuses what doesn't fit, under the field, and writes nothing", async () => {
    const before = await activityCount();
    const cases: Array<[string, string]> = [
      ["arslan@send.example.com", TEAM_FROM_TEXTS.onSendingDomain(D, "example.com")],
      ["contact@other.com", TEAM_FROM_TEXTS.wrongDomain(D, "example.com")],
      ["noreply@example.com", TEAM_FROM_TEXTS.reserved("noreply", "contact@example.com")],
      ["Ali <contact@example.com>", TEAM_FROM_TEXTS.invalid("contact@example.com")],
      ["contact@gmail.com", TEAM_FROM_TEXTS.shared("contact@example.com")],
    ];
    for (const [input, error] of cases) {
      expect(await connect.saveFromAddress(owner, { fromAddress: input }), input).toEqual({ ok: false, field: "fromAddress", error });
    }
    expect(await getSetting("mailgun.fromAddress")).toBeNull();
    expect(await activityCount()).toBe(before);
    expect(await queuedJobs("mailgun.checkDomain")).toHaveLength(0);
  });

  it("refuses an address on the test list (F15)", async () => {
    await setSettingValue("sending.testList", ["tess@outlook.com", "Contact@Example.com"]);
    expect(await connect.saveFromAddress(owner, { fromAddress: "contact@example.com" })).toEqual({
      ok: false,
      field: "fromAddress",
      error: "contact@example.com is on your test list. Remove it from the test list first: it can't be a test mailbox.",
    });
    expect(await getSetting("mailgun.fromAddress")).toBeNull();
  });

  it("refuses while a test or live campaign is active (running or paused), naming them", async () => {
    await dbWrite((c) => c.campaign.create({ data: { name: "Germany Q4", createdById: owner.id, mode: "LIVE", status: "RUNNING" } }));
    expect(await connect.saveFromAddress(owner, { fromAddress: "contact@example.com" })).toEqual({
      ok: false,
      field: null,
      error: "Finish or cancel “Germany Q4” first: it sends with the current From address.",
    });
    await dbWrite((c) => c.campaign.create({ data: { name: "Spain", createdById: owner.id, mode: "TEST", status: "PAUSED" } }));
    expect(await connect.saveFromAddress(owner, { fromAddress: "contact@example.com" })).toMatchObject({
      ok: false,
      error: "Finish or cancel “Germany Q4” and “Spain” first: they send with the current From address.",
    });
    // Dry runs and finished campaigns don't count.
    await dbWrite((c) => c.campaign.updateMany({ data: { status: "FINISHED" } }));
    await dbWrite((c) => c.campaign.create({ data: { name: "Dry", createdById: owner.id, mode: "DRY_RUN", status: "RUNNING" } }));
    expect((await connect.saveFromAddress(owner, { fromAddress: "contact@example.com" })).ok).toBe(true);
  });

  it("while live: refused without the confirmation; with it, going live ends in the same transaction", async () => {
    await setSettingValue("sending.goLive", true);
    await setSettingValue("sending.goLiveAt", "2026-09-20T10:00:00.000Z");
    await setSettingValue("sending.goLiveDomain", D);
    await setSettingValue("sending.goLiveFrom", null);
    await setSettingValue("mailgun.unsubscribeTest", PASSED_B);
    const before = await activityCount();
    expect(await connect.saveFromAddress(owner, { fromAddress: "contact@example.com" })).toEqual({
      ok: false,
      field: null,
      error: "Going live ends: live campaigns only reach your test list until the reply test passes again and you go live again.",
    });
    expect(await getSetting("sending.goLive")).toBe(true);
    expect(await getSetting("mailgun.fromAddress")).toBeNull();
    expect(await activityCount()).toBe(before);

    const res = await connect.saveFromAddress(owner, { fromAddress: "contact@example.com", confirmEndGoLive: true });
    expect(res).toMatchObject({ ok: true, goLiveEnded: true, fromAddress: "contact@example.com" });
    if (res.ok) expect(res.message).toBe(`${TEAM_FROM_TEXTS.savedOn("contact@example.com", D)} ${GO_LIVE_COPY.endedByFromChange}`);
    expect(await getSetting("sending.goLive")).toBe(false);
    // "You were live with …" stays for the card and the dashboard.
    expect(await getSetting("sending.goLiveAt")).toBe("2026-09-20T10:00:00.000Z");
    expect(await getSetting("sending.goLiveDomain")).toBe(D);
    expect(await getSetting("mailgun.unsubscribeTest")).toMatchObject({ setup: "B", status: "untested", mailboxes: [] });
    expect((await lastActivity()).data).toEqual({ from: null, to: "contact@example.com", goLiveEnded: true });
    // The go-live row and the From address were written together: same transaction, same actor.
    const rows = await db.setting.findMany({ where: { key: { in: ["sending.goLive", "mailgun.fromAddress"] } } });
    expect(rows.every((r) => r.updatedById === owner.id)).toBe(true);
  });

  it("the practice copy refuses", async () => {
    await setSettingValue("practice.copy", true);
    expect(await connect.saveFromAddress(owner, { fromAddress: "contact@example.com" })).toEqual({
      ok: false,
      field: null,
      error: "The practice copy never talks to Mailgun, so there is no From address to set here.",
    });
    expect(await getSetting("mailgun.fromAddress")).toBeNull();
  });
});

describe("saveFromAddressAction", () => {
  it("the Owner saves; the toast is the service's sentence", async () => {
    const res = await sending.saveFromAddressAction({ fromAddress: "contact@example.com" });
    expect(res).toEqual({
      ok: true,
      data: { fromAddress: "contact@example.com", goLiveEnded: false },
      message: TEAM_FROM_TEXTS.savedOn("contact@example.com", D),
    });
  });

  it("a refusal on the field comes back as a field error", async () => {
    const res = await sending.saveFromAddressAction({ fromAddress: "contact@send.example.com" });
    const error = TEAM_FROM_TEXTS.onSendingDomain(D, "example.com");
    expect(res).toEqual({ ok: false, error, fieldErrors: { fromAddress: [error] } });
  });

  it("a Member is refused and nothing is written", async () => {
    auth.user = member;
    const before = { from: await getSetting("mailgun.fromAddress"), logs: await activityCount(), jobs: await db.job.count() };
    expect(await sending.saveFromAddressAction({ fromAddress: "contact@example.com" })).toEqual({ ok: false, error: OWNER_ONLY });
    expect(await getSetting("mailgun.fromAddress")).toBe(before.from);
    expect(await activityCount()).toBe(before.logs);
    expect(await db.job.count()).toBe(before.jobs);
  });

  it("checks its input with zod", async () => {
    const res = await sending.saveFromAddressAction({ fromAddress: `${"a".repeat(320)}@example.com` });
    expect(res).toMatchObject({ ok: false, fieldErrors: { fromAddress: ["That address is too long."] } });
  });
});
