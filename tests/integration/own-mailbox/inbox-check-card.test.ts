import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { makeCompany, makeUser, setSettingValue } from "../campaigns/seed";

/**
 * The daily inbox check (MAIN-DOMAIN-DESIGN O33, §2.9, §3.9, §8 P6): "I've read contact@…" writes SystemState
 * "sending.inboxCheck" and the activity, only in own-mailbox mode, for anyone signed in; the card lists the companies
 * whose LIVE follow-ups (running or paused campaigns) are due within 24 hours, at most 20; the Notifications page shows
 * it first in own-mailbox mode and never in app mode.
 */

type TestUser = { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number };
const auth = vi.hoisted(() => ({ user: null as TestUser | null }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => "/notifications",
  redirect: (href: string) => {
    throw new Error(`redirect ${href}`);
  },
  notFound: () => {
    throw new Error("not found");
  },
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
    requireUser: async () => {
      if (!auth.user) throw new Error("redirect /login");
      return auth.user;
    },
  };
});

const t = await createTestDb("own-inbox-check");
const { db, dbWrite } = await import("@/server/db");
const { markInboxChecked, loadInboxCheck, INBOX_CHECK_LIST_MAX } = await import("@/server/services/sending/inbox-check");
const { markInboxCheckedAction } = await import("@/components/replies/inbox-check-actions");
const { default: NotificationsPage } = await import("@/app/(app)/notifications/page");
const { INBOX_CHECK_TEXTS, OWN_MAILBOX_TEXTS } = await import("@/core/sending/own-mailbox");

const DAY = 86_400_000;
const HOUR = 3_600_000;
const KEY = "sending.inboxCheck";
let mg: FakeConnection;
let owner: TestUser;
let member: TestUser;
let seq = 0;

async function user(name: string, role: "OWNER" | "MEMBER"): Promise<TestUser> {
  const u = await makeUser(name, { role });
  await dbWrite((c) => c.user.update({ where: { id: u.id }, data: { timeZone: "Europe/Berlin" } }));
  return { id: u.id, email: u.email, name: u.name, role, timeZone: "Europe/Berlin", sessionId: 1 };
}

async function writeCheck(value: { at: string | null; byUserId: number | null }) {
  await dbWrite(async (c) => {
    await c.systemState.deleteMany({ where: { key: KEY } });
    await c.systemState.create({ data: { key: KEY, version: 1, value } });
  });
}

async function readCheck() {
  return (await db.systemState.findUnique({ where: { key: KEY } }))?.value as { at: string | null; byUserId: number | null } | undefined;
}

type EmailSpec = { companyId: number; personId: number; emailNorm: string; step: number; dueAt: Date; status?: "QUEUED" | "SKIPPED" };

/** A launched campaign with the given emails (and a recipient for each person). */
async function campaign(opts: { mode: "LIVE" | "TEST" | "DRY_RUN"; status: "RUNNING" | "PAUSED" | "CANCELLED"; emails: EmailSpec[] }) {
  return dbWrite(async (c) => {
    const camp = await c.campaign.create({
      data: {
        name: `Campaign ${++seq}`,
        createdById: owner.id,
        senderId: owner.id,
        status: opts.status,
        mode: opts.mode,
        launchedGoLive: true,
        launchedAt: new Date(Date.now() - 5 * DAY),
      },
    });
    const recipients = new Map<number, number>();
    for (const e of opts.emails) {
      let recipientId = recipients.get(e.personId);
      if (recipientId === undefined) {
        const r = await c.campaignRecipient.create({
          data: { campaignId: camp.id, companyId: e.companyId, personId: e.personId, emailNorm: e.emailNorm, state: "WAITING", currentStep: e.step },
        });
        recipientId = r.id;
        recipients.set(e.personId, recipientId);
      }
      seq += 1;
      await c.outboundEmail.create({
        data: {
          campaignId: camp.id,
          recipientId,
          personId: e.personId,
          companyId: e.companyId,
          senderId: owner.id,
          step: e.step,
          mode: opts.mode,
          toEmail: e.emailNorm,
          toNorm: e.emailNorm,
          companyName: "Snapshot",
          fromAddress: "contact@example.com",
          subject: "Hi",
          text: "t",
          html: "h",
          messageId: `pp.inbox${seq}@example.com`,
          sendId: `inbox-${seq}`,
          dueAt: e.dueAt,
          status: e.status ?? "QUEUED",
        },
      });
    }
    return camp;
  });
}

async function render(): Promise<string> {
  const el = await NotificationsPage({ params: Promise.resolve({}), searchParams: Promise.resolve({}) } as never);
  return renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

beforeAll(async () => {
  mg = await connectFakeMailgun({
    domain: "example.com",
    region: "US",
    replies: "own-mailbox",
    fromAddress: "contact@example.com",
    plan: "free",
    fake: { domain: "example.com", region: "US", plan: "free", receivesMail: false },
  });
  owner = await user("Arslan", "OWNER");
  member = await user("Ali", "MEMBER");
});

beforeEach(() => {
  auth.user = owner;
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("I've read contact@…", () => {
  it("is refused in app mode and writes nothing", async () => {
    await setSettingValue("mailgun.replies", "app");
    try {
      await expect(markInboxChecked(owner)).rejects.toThrow(INBOX_CHECK_TEXTS.notOwnMailbox);
      expect(await markInboxCheckedAction()).toEqual({ ok: false, error: INBOX_CHECK_TEXTS.notOwnMailbox });
      expect(await readCheck()).toBeUndefined();
      expect(await db.activityLog.count({ where: { type: "sending.inboxChecked" } })).toBe(0);
    } finally {
      await setSettingValue("mailgun.replies", "own-mailbox");
    }
  });

  it("writes the state and the activity in own-mailbox mode; a click a moment later with a clock a few seconds behind keeps the later time", async () => {
    const now = new Date();
    expect(await markInboxChecked(owner, now)).toEqual({ at: now, from: "contact@example.com" });
    expect(await readCheck()).toEqual({ at: now.toISOString(), byUserId: owner.id });
    const logged = await db.activityLog.findFirstOrThrow({ where: { type: "sending.inboxChecked" }, orderBy: { id: "desc" } });
    expect(logged).toMatchObject({ actorId: owner.id, summary: "Arslan read contact@example.com (inbox and Spam)", companyId: null });
    expect(logged.data).toEqual({ from: "contact@example.com" });

    // A click whose clock read 20 seconds earlier (two clicks at once) keeps the later check.
    await markInboxChecked(member, new Date(now.getTime() - 20_000));
    expect(await readCheck()).toEqual({ at: now.toISOString(), byUserId: owner.id });

    const view = await loadInboxCheck(new Date(now.getTime() + 60_000));
    expect(view).toMatchObject({ byName: "Arslan", today: true });
    expect(view.at?.getTime()).toBe(now.getTime());
  });

  it("review SECURITY-02: a check stamped in the future isn't today's check, and the next click replaces it", async () => {
    const now = new Date();
    // A click while the PC clock ran ahead: a month, or an hour (more than a minute is a wrong clock).
    for (const ahead of [30 * DAY, HOUR, 2 * 60_000]) {
      await writeCheck({ at: new Date(now.getTime() + ahead).toISOString(), byUserId: owner.id });
      expect(await loadInboxCheck(now), `${ahead} ms ahead`).toMatchObject({ at: null, byName: null, today: false });
    }
    // The card then says nobody has read it today, and the button is the primary one again.
    auth.user = member;
    expect(await render()).toContain("Nobody has read it today.");
    // A few seconds ahead is the same clock read a moment later: it counts.
    await writeCheck({ at: new Date(now.getTime() + 30_000).toISOString(), byUserId: owner.id });
    expect(await loadInboxCheck(now)).toMatchObject({ byName: "Arslan", today: true });

    // Back to a month ahead: the next click (right clock) replaces it.
    await writeCheck({ at: new Date(now.getTime() + 30 * DAY).toISOString(), byUserId: owner.id });
    await markInboxChecked(member, now);
    expect(await readCheck()).toEqual({ at: now.toISOString(), byUserId: member.id });
    expect(await loadInboxCheck(new Date(now.getTime() + 60_000))).toMatchObject({ byName: "Ali", today: true });
    // An hour behind a stored check (a clock put back after running ahead) replaces it too.
    await markInboxChecked(owner, new Date(now.getTime() - HOUR));
    expect(await readCheck()).toEqual({ at: new Date(now.getTime() - HOUR).toISOString(), byUserId: owner.id });
  });

  it("a Member may do it through the action, which answers with the toast", async () => {
    auth.user = member;
    const res = await markInboxCheckedAction();
    expect(res).toMatchObject({ ok: true, message: INBOX_CHECK_TEXTS.done });
    expect((await readCheck())?.byUserId).toBe(member.id);
    expect(await db.activityLog.findFirstOrThrow({ where: { type: "sending.inboxChecked" }, orderBy: { id: "desc" } })).toMatchObject({
      actorId: member.id,
      summary: "Ali read contact@example.com (inbox and Spam)",
    });
    auth.user = null;
    expect(await markInboxCheckedAction()).toEqual({ ok: false, error: "Your session has ended. Please sign in again." });
  });

  it("a check of an earlier cap day isn't today's; nobody's check is nobody's", async () => {
    await writeCheck({ at: new Date(Date.now() - 2 * DAY).toISOString(), byUserId: owner.id });
    expect(await loadInboxCheck()).toMatchObject({ today: false, byName: "Arslan" });
    await writeCheck({ at: null, byUserId: null });
    expect(await loadInboxCheck()).toMatchObject({ at: null, byName: null, today: false });
  });
});

describe("the follow-ups the card lists", () => {
  it("lists companies with LIVE follow-ups due within 24 hours in running and paused campaigns, soonest first, at most 20", async () => {
    const now = Date.now();
    const listed: Array<{ id: number; name: string }> = [];
    const due: EmailSpec[][] = [[], []];
    for (let i = 1; i <= 22; i++) {
      const name = `Studio ${String(i).padStart(2, "0")}`;
      const { company, people } = await makeCompany({
        name,
        domain: `studio${i}.example`,
        people: i === 1 ? [{ name: "A" }, { name: "B" }] : [{ name: "A" }],
      });
      listed.push({ id: company.id, name });
      for (const p of people) {
        // Studio 01 is overdue, the rest are due later today, in order.
        due[i % 2]!.push({ companyId: company.id, personId: p.id, emailNorm: p.emailNorm!, step: 1, dueAt: new Date(now - HOUR + i * 60_000) });
      }
    }
    await campaign({ mode: "LIVE", status: "RUNNING", emails: due[0]! });
    await campaign({ mode: "LIVE", status: "PAUSED", emails: due[1]! });

    // None of these count: a first email, a follow-up due in two days, test mode, a dry run, a cancelled campaign, a
    // follow-up already stopped.
    const { company: other, people: op } = await makeCompany({ name: "Not listed", domain: "notlisted.example", people: [{ name: "N" }] });
    const base = { companyId: other.id, personId: op[0]!.id, emailNorm: op[0]!.emailNorm! };
    await campaign({ mode: "LIVE", status: "RUNNING", emails: [{ ...base, step: 0, dueAt: new Date(now) }] });
    await campaign({ mode: "LIVE", status: "RUNNING", emails: [{ ...base, step: 1, dueAt: new Date(now + 2 * DAY) }] });
    await campaign({ mode: "TEST", status: "RUNNING", emails: [{ ...base, step: 1, dueAt: new Date(now) }] });
    await campaign({ mode: "DRY_RUN", status: "RUNNING", emails: [{ ...base, step: 1, dueAt: new Date(now) }] });
    await campaign({ mode: "LIVE", status: "CANCELLED", emails: [{ ...base, step: 1, dueAt: new Date(now) }] });
    await campaign({ mode: "LIVE", status: "RUNNING", emails: [{ ...base, step: 1, dueAt: new Date(now), status: "SKIPPED" }] });

    const view = await loadInboxCheck(new Date(now));
    expect(INBOX_CHECK_LIST_MAX).toBe(20);
    expect(view.waiting).toHaveLength(20);
    expect(view.waitingCompanies).toBe(22);
    expect(view.waitingTotal).toBe(23);
    expect(view.waiting[0]).toEqual({ companyId: listed[0]!.id, companyName: "Studio 01", count: 2 });
    expect(view.waiting.map((w) => w.companyName)).toEqual(listed.slice(0, 20).map((c) => c.name));
    expect(view.waiting.some((w) => w.companyId === other.id)).toBe(false);
  });
});

describe("the Notifications page", () => {
  it("own-mailbox mode: the card comes first, with the companies, the last check and the button; the replies list says where replies go", async () => {
    await writeCheck({ at: null, byUserId: null });
    auth.user = member;
    const html = await render();
    expect(html).not.toContain("You're all caught up.");
    expect(html).toContain('id="inbox-check"');
    expect(html).toContain("Today's inbox check");
    expect(html).toContain(INBOX_CHECK_TEXTS.intro("contact@example.com"));
    expect(html).toContain("Follow-ups due in the next 24 hours:");
    expect(html).toContain("Studio 01");
    expect(html).toContain('href="/contacts?company=');
    expect(html).toContain("2 follow-ups");
    expect(html).toContain("and 2 more");
    expect(html).toContain("Nobody has read it today.");
    expect(html).toContain("I've read contact@example.com");
    expect(html.indexOf('id="inbox-check"')).toBeLessThan(html.indexOf("Replies waiting for an answer"));
    expect(html).toContain(OWN_MAILBOX_TEXTS.repliesEmpty("contact@example.com"));
    expect(html).not.toContain("No replies are waiting for an answer.");

    await markInboxChecked(owner);
    const done = await render();
    expect(done).toMatch(/Last read today at \d\d:\d\d by Arslan\./);
    expect(done).not.toContain("Nobody has read it today.");
  });

  it("app mode: no card, and the page is as before", async () => {
    await setSettingValue("mailgun.replies", "app");
    try {
      auth.user = member;
      const html = await render();
      expect(html).not.toContain('id="inbox-check"');
      expect(html).not.toContain("Today's inbox check");
      expect(html).toContain("You're all caught up.");
    } finally {
      await setSettingValue("mailgun.replies", "own-mailbox");
    }
  });
});
