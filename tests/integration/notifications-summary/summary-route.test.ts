import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";

/**
 * GET /api/notifications/summary (M4-DESIGN §5.2): the bell's poll with desktop pop-ups. The signed-in user is set by
 * the test (route handlers read the session from cookies).
 */

type TestUser = { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number };
const auth = vi.hoisted(() => ({ user: null as TestUser | null }));
vi.mock("@/lib/auth/dal", () => ({ getUserOrNull: async () => auth.user }));

const t = await createTestDb("notifications-summary");
const { db, dbWrite } = await import("@/server/db");
const { GET } = await import("@/app/api/notifications/summary/route");

type Summary = import("@/app/(app)/settings/notifications/desktop-popups").SummaryResponse;

const MINUTE = 60_000;
let owner: TestUser;
let member: TestUser;

async function makeUser(name: string, role: "OWNER" | "MEMBER", notifyPrefs?: object): Promise<TestUser> {
  const u = await dbWrite((c) =>
    c.user.create({ data: { name, role, email: `${name.toLowerCase()}@pp.test`, ...(notifyPrefs ? { notifyPrefs } : {}) } }),
  );
  return { id: u.id, email: u.email, name: u.name, role, timeZone: "Europe/Berlin", sessionId: 1 };
}

async function notify(userId: number, type: string, opts: { minutesAgo?: number; read?: boolean; title?: string } = {}) {
  const createdAt = new Date(Date.now() - (opts.minutesAgo ?? 0) * MINUTE);
  return dbWrite((c) =>
    c.notification.create({
      data: {
        userId,
        type,
        title: opts.title ?? `${type} for ${userId}`,
        body: "Body",
        link: "/notifications",
        createdAt,
        readAt: opts.read ? createdAt : null,
      },
    }),
  );
}

async function lastId(): Promise<number> {
  return (await db.notification.findFirst({ orderBy: { id: "desc" }, select: { id: true } }))?.id ?? 0;
}

async function poll(user: TestUser | null, after?: string): Promise<{ status: number; body: Summary & { error?: string }; headers: Headers }> {
  auth.user = user;
  const url = `http://localhost:3000/api/notifications/summary${after === undefined ? "" : `?after=${after}`}`;
  const res = await GET(new Request(url));
  return { status: res.status, body: (await res.json()) as Summary & { error?: string }, headers: res.headers };
}

beforeAll(async () => {
  owner = await makeUser("Arslan", "OWNER");
  member = await makeUser("Ali", "MEMBER", { popupGroups: ["reply", "sending"], desktopReplies: true });
});

beforeEach(() => {
  auth.user = null;
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("the summary route", () => {
  it("answers 401 when signed out", async () => {
    const res = await poll(null, "0");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Sign in again.");
  });

  it("first poll (no after): the bell's menu and the latest id, but no pop-ups", async () => {
    await notify(owner.id, "reply.received", { title: "Old reply" });
    await notify(owner.id, "campaign.finished", { read: true });
    const latest = await lastId();
    const res = await poll(owner);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).toMatchObject({
      userId: owner.id,
      unread: 1,
      latestId: latest,
      legacyDesktopReplies: false,
      popups: { items: [], count: 0, latestId: null },
    });
    expect(res.body.latest.map((n) => n.type)).toEqual(["campaign.finished", "reply.received"]);
    // Junk in `after` counts as a first poll too.
    for (const bad of ["abc", "-1", "1.5", ""]) {
      expect((await poll(owner, bad)).body.popups).toEqual({ items: [], count: 0, latestId: null });
    }
  });

  it("after: only the person's pop-up types, newer than `after`, from the last 10 minutes", async () => {
    const after = await lastId();
    const received = await notify(owner.id, "reply.received");
    const attention = await notify(owner.id, "reply.attention");
    const summary = await notify(owner.id, "reply.summary");
    await notify(owner.id, "campaign.finished"); // not in the default groups ("reply")
    await notify(owner.id, "outage.hold");
    await notify(owner.id, "sending.paused");
    await notify(owner.id, "reply.possible", { minutesAgo: 11 }); // too old to pop up
    await notify(member.id, "reply.received"); // someone else's
    const res = await poll(owner, String(after));
    expect(res.body.popups.items.map((n) => n.id)).toEqual([received.id, attention.id, summary.id]);
    expect(res.body.popups.count).toBe(3);
    expect(res.body.popups.latestId).toBe(summary.id);
    expect(res.body.popups.items[0]).toMatchObject({ type: "reply.received", title: received.title, body: "Body", link: "/notifications" });
    // Nothing new since the latest one.
    expect((await poll(owner, String(await lastId()))).body.popups).toEqual({ items: [], count: 0, latestId: null });
  });

  it("gives at most 5 items, oldest first, with the full count and the highest id (for the batch pop-up)", async () => {
    const after = await lastId();
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) ids.push((await notify(owner.id, "reply.received")).id);
    const res = await poll(owner, String(after));
    expect(res.body.popups.items.map((n) => n.id)).toEqual(ids.slice(0, 5));
    expect(res.body.popups.count).toBe(7);
    expect(res.body.popups.latestId).toBe(ids[6]);
  });

  it("never gives a Member the Owner-only sending types, even when stored", async () => {
    const after = await lastId();
    await notify(member.id, "sending.paused");
    await notify(member.id, "email.complained");
    const reply = await notify(member.id, "reply.unlinked");
    const res = await poll(member, String(after));
    expect(res.body.popups.items.map((n) => n.type)).toEqual(["reply.unlinked"]);
    expect(res.body.popups.latestId).toBe(reply.id);
    expect(res.body.legacyDesktopReplies).toBe(true);

    // The Owner with the sending group gets them.
    await dbWrite((c) => c.user.update({ where: { id: owner.id }, data: { notifyPrefs: { popupGroups: ["sending", "outage"] } } }));
    const ownerAfter = await lastId();
    const paused = await notify(owner.id, "sending.paused");
    const hold = await notify(owner.id, "outage.hold");
    await notify(owner.id, "reply.received");
    const ownerRes = await poll(owner, String(ownerAfter));
    expect(ownerRes.body.popups.items.map((n) => n.id)).toEqual([paused.id, hold.id]);
    // No groups chosen: nothing pops up.
    await dbWrite((c) => c.user.update({ where: { id: owner.id }, data: { notifyPrefs: { popupGroups: [] } } }));
    expect((await poll(owner, String(ownerAfter))).body.popups).toEqual({ items: [], count: 0, latestId: null });
    await dbWrite((c) => c.user.update({ where: { id: owner.id }, data: { notifyPrefs: {} } }));
  });

  it("counts the replies waiting for your answer, without dry-run ones", async () => {
    const sara = await makeUser("Sara", "MEMBER");
    let n = 0;
    const inbound = (data: Record<string, unknown>) =>
      dbWrite((c) =>
        c.inboundMessage.create({
          data: {
            receivedAt: new Date(),
            toAddress: "sara@send.example.com",
            fromEmail: `person${++n}@firma.de`,
            source: "NOTIFY",
            processedAt: new Date(),
            assigneeId: sara.id,
            kind: "REPLY",
            replyScope: "real",
            ...data,
          },
        }),
      );
    await inbound({});
    await inbound({ kind: "POSSIBLE_REPLY" });
    await inbound({ kind: "UNLINKED", replyScope: "none" });
    await inbound({ replyScope: null }); // processed before scopes were stored
    await inbound({ replyScope: "campaign" }); // a simulated reply in a dry run: listed, not counted
    await inbound({ answeredAt: new Date(), answerOutcome: "answered" });
    await inbound({ processedAt: null, kind: null }); // not processed yet
    await inbound({ kind: "AUTO_REPLY" });
    await inbound({ kind: "TEST_REPLY" });
    await inbound({ assigneeId: owner.id });
    const res = await poll(sara);
    expect(res.body.waitingReplies).toBe(4);
    expect(res.body.userId).toBe(sara.id);
  });
});
