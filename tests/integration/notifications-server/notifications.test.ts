import { afterAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeInbound, makeUser } from "../stops-holds/world";

const t = await createTestDb("notifications-server");
const { db, dbTx, dbWrite } = await import("@/server/db");
const notifications = await import("@/server/notifications");
const {
  activeOwnerId,
  hasUnreadSince,
  latestNotificationId,
  listNotifications,
  notificationFilterWhere,
  notifyUsers,
  popupsAfter,
  waitingReplyCount,
} = notifications;
const { NOTIFICATION_FILTERS, notificationFilterOf, popupTypesFor } = await import("@/core/notification-types");

const MIN = 60_000;

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

async function note(userId: number, type: string, opts: { createdAt?: Date; readAt?: Date | null; title?: string } = {}) {
  return dbWrite((c) =>
    c.notification.create({
      data: { userId, type, title: opts.title ?? type, createdAt: opts.createdAt ?? new Date(), readAt: opts.readAt ?? null },
    }),
  );
}

describe("activeOwnerId", () => {
  it("is null before there is an Owner, then the first active Owner", async () => {
    expect(await activeOwnerId()).toBeNull();
    await makeUser("Old owner", { role: "OWNER", active: false });
    const owner = await makeUser("Arslan", { role: "OWNER" });
    await makeUser("Second owner", { role: "OWNER" });
    expect(await activeOwnerId()).toBe(owner.id);
    expect(await dbTx((tx) => activeOwnerId(tx))).toBe(owner.id);
  });
});

describe("listNotifications with filters (M4-DESIGN §5.5)", () => {
  const TYPES = [
    "reply.received",
    "reply.possible",
    "reply.summary",
    "campaign.finished",
    "campaign.sender",
    "outage.hold",
    "email.unconfirmed",
    "sending.paused",
    "system.mailgun",
    "email.complained",
    "task.failed",
  ];

  it("each filter's list matches notificationFilterOf; unread is always the whole count", async () => {
    const user = await makeUser("Filter person");
    const other = await makeUser("Someone else");
    const base = Date.now() - 60 * MIN;
    for (let i = 0; i < TYPES.length; i++) {
      await note(user.id, TYPES[i]!, { createdAt: new Date(base + i * MIN), readAt: i % 3 === 0 ? new Date() : null });
    }
    await note(other.id, "reply.received");
    const unreadTotal = TYPES.filter((_, i) => i % 3 !== 0).length;

    for (const filter of NOTIFICATION_FILTERS) {
      const page = await listNotifications(user.id, 1, 50, filter);
      const expected = TYPES.map((type, i) => ({ type, i }))
        .filter(({ type, i }) =>
          filter === "all" ? true : filter === "unread" ? i % 3 !== 0 : notificationFilterOf(type) === filter,
        )
        .map(({ type }) => type)
        .reverse();
      expect(page.items.map((n) => n.type), filter).toEqual(expected);
      expect(page).toMatchObject({ filter, total: expected.length, unread: unreadTotal, page: 1, pageCount: 1 });
    }
    // The old call shape still works (the bell and the M3 page).
    expect((await listNotifications(user.id)).filter).toBe("all");
    expect((await listNotifications(user.id)).items).toHaveLength(TYPES.length);
    // Pages, per filter.
    const p2 = await listNotifications(user.id, 2, 2, "replies");
    expect(p2).toMatchObject({ page: 2, pageCount: 2, total: 3 });
    expect(p2.items.map((n) => n.type)).toEqual(["reply.received"]);
    expect(notificationFilterWhere(user.id, "unread")).toEqual({ userId: user.id, readAt: null });
  });
});

describe("popupsAfter and latestNotificationId (M4-DESIGN §5.2)", () => {
  it("returns the chosen types after the given id, from the last 10 minutes, at most 5 oldest first, with the total and the highest id", async () => {
    const user = await makeUser("Popup person");
    const now = new Date();
    expect(await latestNotificationId(user.id)).toBe(0);
    const old = await note(user.id, "reply.received", { createdAt: new Date(now.getTime() - 11 * MIN) });
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) ids.push((await note(user.id, "reply.received", { createdAt: new Date(now.getTime() - (7 - i) * MIN) })).id);
    const campaign = await note(user.id, "campaign.finished", { createdAt: now });
    const sending = await note(user.id, "sending.paused", { createdAt: now });
    const replyTypes = popupTypesFor(["reply"], "MEMBER");

    const res = await popupsAfter(user.id, { after: 0, types: replyTypes, now });
    expect(res.items.map((n) => n.id)).toEqual(ids.slice(0, 5));
    expect(res.count).toBe(7);
    expect(res.latestId).toBe(ids[6]);
    expect(res.items.some((n) => n.id === old.id)).toBe(false);

    const after = await popupsAfter(user.id, { after: ids[4]!, types: [...replyTypes, "campaign.finished"], now });
    expect(after.items.map((n) => n.id)).toEqual([ids[5], ids[6], campaign.id]);
    expect(after).toMatchObject({ count: 3, latestId: campaign.id });

    // A Member's groups never include the Owner-only "sending" group.
    const member = await popupsAfter(user.id, { after: 0, types: popupTypesFor(["sending"], "MEMBER"), now });
    expect(member).toEqual({ items: [], count: 0, latestId: null });
    const ownerView = await popupsAfter(user.id, { after: 0, types: popupTypesFor(["sending"], "OWNER"), now, max: 1 });
    expect(ownerView).toMatchObject({ count: 1, latestId: sending.id });
    expect(ownerView.items).toHaveLength(1);
    // A wider window (tests) finds the old one; nothing after the last id.
    expect((await popupsAfter(user.id, { after: 0, types: replyTypes, now, windowMs: 60 * MIN })).count).toBe(8);
    expect(await popupsAfter(user.id, { after: sending.id, types: replyTypes, now })).toEqual({ items: [], count: 0, latestId: null });
    expect(await latestNotificationId(user.id)).toBe(sending.id);
  });
});

describe("notifyUsers", () => {
  it("creates one notification per distinct active user and skips nulls and switched-off users, in or out of a transaction", async () => {
    const a = await makeUser("Ali");
    const s = await makeUser("Sara");
    const off = await makeUser("Off", { active: false });
    const input = { type: "reply.received", title: "New reply from Firma GmbH", body: "Anna Berg replied.", link: "/notifications?reply=1#replies" };
    expect(await notifyUsers([a.id, null, s.id, a.id, off.id, undefined, 999_999], input)).toBe(2);
    expect(await db.notification.count({ where: { userId: a.id, type: "reply.received" } })).toBe(1);
    expect(await db.notification.findFirstOrThrow({ where: { userId: s.id } })).toMatchObject(input);
    expect(await db.notification.count({ where: { userId: off.id } })).toBe(0);
    expect(await dbTx((tx) => notifyUsers(new Set([s.id]), { type: "reply.possible", title: "Did Firma GmbH really reply?", link: "https://evil.test/" }, tx))).toBe(1);
    expect((await db.notification.findFirstOrThrow({ where: { userId: s.id, type: "reply.possible" } })).link).toBeNull();
    expect(await notifyUsers([], input)).toBe(0);
    expect(await notifyUsers([off.id], input)).toBe(0);
  });
});

describe("waitingReplyCount and hasUnreadSince (M4-DESIGN §4.1, §5.5)", () => {
  it("counts processed, unanswered REPLY / POSSIBLE_REPLY / UNLINKED rows assigned to the user; dry-run replies are not counted", async () => {
    const ali = await makeUser("Ali waiting");
    const sara = await makeUser("Sara waiting");
    await makeInbound({ kind: "REPLY", assigneeId: ali.id, replyScope: "real" });
    await makeInbound({ kind: "POSSIBLE_REPLY", assigneeId: ali.id, replyScope: "real" });
    await makeInbound({ kind: "UNLINKED", assigneeId: ali.id, replyScope: "none" });
    await makeInbound({ kind: "REPLY", assigneeId: ali.id, replyScope: null });
    // Not counted: answered, a twin, unprocessed, automatic, a test reply, a dry-run reply, someone else's.
    await makeInbound({ kind: "REPLY", assigneeId: ali.id, answeredAt: new Date(), answerOutcome: "answered" });
    await makeInbound({ kind: "REPLY", assigneeId: ali.id, answeredAt: new Date(), answerOutcome: "duplicate" });
    await makeInbound({ kind: null, assigneeId: ali.id, processed: false });
    await makeInbound({ kind: "AUTO_REPLY", assigneeId: ali.id });
    await makeInbound({ kind: "TEST_REPLY", assigneeId: ali.id, replyScope: "none" });
    await makeInbound({ kind: "REPLY", assigneeId: ali.id, replyScope: "campaign" });
    await makeInbound({ kind: "REPLY", assigneeId: sara.id });
    expect(await waitingReplyCount(ali.id)).toBe(4);
    expect(await waitingReplyCount(sara.id)).toBe(1);
  });

  it("finds an unread notification of a type created after a time (read ones and older ones don't count)", async () => {
    const user = await makeUser("Summary person");
    const now = Date.now();
    const since = new Date(now - 24 * 60 * MIN);
    expect(await hasUnreadSince(user.id, "reply.summary", since)).toBe(false);
    await note(user.id, "reply.summary", { createdAt: new Date(now - 25 * 60 * MIN) });
    await note(user.id, "reply.summary", { createdAt: new Date(now - MIN), readAt: new Date() });
    await note(user.id, "reply.received", { createdAt: new Date(now - MIN) });
    expect(await hasUnreadSince(user.id, "reply.summary", since)).toBe(false);
    await note(user.id, "reply.summary", { createdAt: new Date(now - 2 * MIN) });
    expect(await hasUnreadSince(user.id, "reply.summary", since)).toBe(true);
    expect(await dbTx((tx) => hasUnreadSince(user.id, "reply.summary", since, tx))).toBe(true);
  });
});
