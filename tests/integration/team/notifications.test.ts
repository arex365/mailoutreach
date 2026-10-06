import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";

const t = await createTestDb("notifications");
const { db, dbTx, dbWrite } = await import("@/server/db");
const n = await import("@/server/notifications");

let ownerId = 0;
let aliId = 0;

beforeAll(async () => {
  const owner = await dbWrite((c) => c.user.create({ data: { email: "arslan@example.com", name: "Arslan", role: "OWNER" } }));
  const ali = await dbWrite((c) => c.user.create({ data: { email: "ali@example.com", name: "Ali" } }));
  ownerId = owner.id;
  aliId = ali.id;
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("notifications", () => {
  it("only keeps in-app links", async () => {
    expect(n.safeNotificationLink("/contacts?company=12")).toBe("/contacts?company=12");
    expect(n.safeNotificationLink("https://evil.example.com")).toBeNull();
    expect(n.safeNotificationLink("//evil.example.com")).toBeNull();
    expect(n.safeNotificationLink("/\\evil.example.com")).toBeNull();
    expect(n.safeNotificationLink("javascript:alert(1)")).toBeNull();
    expect(n.safeNotificationLink("/a b")).toBeNull();
    expect(n.safeNotificationLink(null)).toBeNull();
    // Same shared check as the sign-in redirect (@/core/safe-path).
    expect(n.safeNotificationLink("/\t/evil.example.com")).toBeNull();
    expect(n.safeNotificationLink("/.//evil.example.com")).toBeNull();
    expect(n.safeNotificationLink("/settings/team")).toBe("/settings/team");
    expect(n.safeNotificationLink("/" + "a".repeat(600))).toBeNull();

    const created = await n.createNotification({ userId: aliId, type: "reply.received", title: "  Anna replied  ", link: "https://x.test" });
    expect(created.title).toBe("Anna replied");
    expect(created.link).toBeNull();
  });

  it("notifies the active Owner, also inside a transaction", async () => {
    const direct = await n.notifyOwner({ type: "sending.paused", title: "Sending paused", body: "7 of the last 200 emails bounced." });
    expect(direct?.userId).toBe(ownerId);
    const inTx = await dbTx((tx) => n.notifyOwner({ type: "email.complained", title: "A complaint", link: "/activity" }, tx));
    expect(inTx?.userId).toBe(ownerId);
    expect(inTx?.link).toBe("/activity");
  });

  it("summarises unread notifications and marks them read (only your own)", async () => {
    // Fresh user so earlier tests don't affect the counts.
    const sara = await dbWrite((c) => c.user.create({ data: { email: "sara@example.com", name: "Sara" } }));
    const base = Date.now() - 60_000;
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) {
      const row = await dbWrite((c) =>
        c.notification.create({
          data: { userId: sara.id, type: "reply.received", title: `Reply ${i}`, createdAt: new Date(base + i * 1000) },
        }),
      );
      ids.push(row.id);
    }
    const summary = await n.unreadSummary(sara.id);
    expect(summary.unread).toBe(7);
    expect(summary.latest.map((x) => x.title)).toEqual(["Reply 6", "Reply 5", "Reply 4", "Reply 3", "Reply 2"]);
    expect(typeof summary.latest[0]!.createdAt).toBe("string");

    // Someone else can't mark Sara's notifications read.
    expect(await n.markRead(aliId, [ids[0]!, ids[1]!])).toBe(0);
    expect(await n.markRead(sara.id, [ids[6]!, ids[5]!])).toBe(2);
    expect(await n.markRead(sara.id, [ids[6]!])).toBe(0); // already read
    expect(await n.markRead(sara.id, [])).toBe(0);
    const after = await n.unreadSummary(sara.id);
    expect(after.unread).toBe(5);
    expect(after.latest[0]!.readAt).not.toBeNull();
    expect(after.latest[2]!.readAt).toBeNull();

    expect(await n.markRead(sara.id, "all")).toBe(5);
    expect((await n.unreadSummary(sara.id)).unread).toBe(0);
  });

  it("lists notifications 50 per page, newest first", async () => {
    const pat = await dbWrite((c) => c.user.create({ data: { email: "pat@example.com", name: "Pat" } }));
    const base = Date.now() - 3_600_000;
    await dbWrite((c) =>
      c.notification.createMany({
        data: Array.from({ length: 53 }, (_, i) => ({
          userId: pat.id,
          type: "campaign.finished",
          title: `Campaign ${i}`,
          createdAt: new Date(base + i * 1000),
          readAt: i < 3 ? new Date() : null,
        })),
      }),
    );
    const p1 = await n.listNotifications(pat.id, 1);
    expect(p1.total).toBe(53);
    expect(p1.unread).toBe(50);
    expect(p1.pageCount).toBe(2);
    expect(p1.items).toHaveLength(50);
    expect(p1.items[0]!.title).toBe("Campaign 52");
    const p2 = await n.listNotifications(pat.id, 2);
    expect(p2.items.map((x) => x.title)).toEqual(["Campaign 2", "Campaign 1", "Campaign 0"]);
    // Out-of-range pages clamp to the last page.
    expect((await n.listNotifications(pat.id, 99)).page).toBe(2);
    expect((await n.listNotifications(pat.id, -3)).page).toBe(1);
    const empty = await n.listNotifications(aliId + 1000, 1);
    expect(empty).toMatchObject({ total: 0, unread: 0, page: 1, pageCount: 1, items: [] });
  });

  it("returns null when there is no active Owner", async () => {
    await dbWrite((c) => c.user.update({ where: { id: ownerId }, data: { active: false } }));
    expect(await n.notifyOwner({ type: "x", title: "Nobody" })).toBeNull();
    await dbWrite((c) => c.user.update({ where: { id: ownerId }, data: { active: true } }));
  });
});
