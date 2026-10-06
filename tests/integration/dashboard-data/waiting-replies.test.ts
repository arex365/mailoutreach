import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeInbound, makeUser } from "../stops-holds/world";

/**
 * The one "waiting reply" rule (M6-DESIGN §4.3, D9) and the dashboard's building blocks on it: the per-person counts
 * behind "You 3 · Ali 1" (the same numbers as the bell), the Team page's count (dry-run replies included, as they move
 * with a switched-off user) and the viewer's list with `take` (§4.2a).
 */

const t = await createTestDb("dashboard-waiting");
const { db, dbWrite } = await import("@/server/db");
const { waitingReplyCount, waitingReplyWhere } = await import("@/server/notifications");
const { waitingReplyCountsByUser } = await import("@/server/services/dashboard/replies");
const { listWaitingReplies, WAITING_PAGE_SIZE } = await import("@/server/services/replies/waiting");
const { listTeam } = await import("@/server/services/users");
const { waitingRepliesLine } = await import("@/core/dashboard/replies");

const HOUR = 3_600_000;

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

beforeEach(async () => {
  await dbWrite(async (c) => {
    await c.inboundMessage.deleteMany({});
    await c.user.deleteMany({});
  });
});

/** Every kind of row the rule has to tell apart, for one assignee. */
async function everyKindFor(userId: number) {
  await makeInbound({ kind: "REPLY", assigneeId: userId, replyScope: "real" });
  await makeInbound({ kind: "POSSIBLE_REPLY", assigneeId: userId, replyScope: "real" });
  await makeInbound({ kind: "UNLINKED", assigneeId: userId, replyScope: "none" });
  await makeInbound({ kind: "REPLY", assigneeId: userId, replyScope: null });
  // Never counted: answered, a twin, unprocessed, automatic, a test reply, a dry-run reply.
  await makeInbound({ kind: "REPLY", assigneeId: userId, answeredAt: new Date(), answerOutcome: "answered" });
  await makeInbound({ kind: "REPLY", assigneeId: userId, answeredAt: new Date(), answerOutcome: "duplicate" });
  await makeInbound({ kind: null, assigneeId: userId, processed: false });
  await makeInbound({ kind: "AUTO_REPLY", assigneeId: userId });
  await makeInbound({ kind: "TEST_REPLY", assigneeId: userId, replyScope: "none" });
  await makeInbound({ kind: "REPLY", assigneeId: userId, replyScope: "campaign" });
}

describe("waitingReplyCountsByUser (the dashboard's per-person counts)", () => {
  it("counts by the bell's rule: no unprocessed, answered or dry-run replies, and no switched-off assignee", async () => {
    const arslan = await makeUser("Arslan", { role: "OWNER" });
    const ali = await makeUser("Ali");
    const sara = await makeUser("Sara");
    const off = await makeUser("Bo", { active: false });
    await everyKindFor(ali.id);
    await makeInbound({ kind: "REPLY", assigneeId: arslan.id });
    await makeInbound({ kind: "UNLINKED", assigneeId: arslan.id, replyScope: "none" });
    await makeInbound({ kind: "REPLY", assigneeId: sara.id, replyScope: "campaign" }); // dry-run only: Sara isn't listed
    await makeInbound({ kind: "REPLY", assigneeId: off.id });
    await makeInbound({ kind: "REPLY", assigneeId: null }); // nobody's

    const rows = await waitingReplyCountsByUser();
    expect(rows).toEqual([
      { userId: ali.id, name: "Ali", count: 4 },
      { userId: arslan.id, name: "Arslan", count: 2 },
    ]);
    // The same number as the bell's line, for every active user.
    for (const u of [arslan, ali, sara]) {
      expect(await waitingReplyCount(u.id), u.name).toBe(rows.find((r) => r.userId === u.id)?.count ?? 0);
    }
    expect(waitingRepliesLine(rows, arslan.id)).toBe("Replies waiting for an answer: You 2 · Ali 4");
    expect(waitingRepliesLine(rows, ali.id)).toBe("Replies waiting for an answer: You 4 · Arslan 2");
    expect(waitingRepliesLine(rows, sara.id)).toBe("Replies waiting for an answer: Ali 4 · Arslan 2");
  });

  it("is empty (and the line null) when nothing waits", async () => {
    const ali = await makeUser("Ali");
    await makeInbound({ kind: "REPLY", assigneeId: ali.id, answeredAt: new Date(), answerOutcome: "not-needed" });
    expect(await waitingReplyCountsByUser()).toEqual([]);
    expect(waitingRepliesLine(await waitingReplyCountsByUser(), ali.id)).toBeNull();
  });

  it("orders ties by name", async () => {
    const zed = await makeUser("Zed");
    const amy = await makeUser("Amy");
    await makeInbound({ kind: "REPLY", assigneeId: zed.id });
    await makeInbound({ kind: "REPLY", assigneeId: amy.id });
    expect((await waitingReplyCountsByUser()).map((r) => r.name)).toEqual(["Amy", "Zed"]);
  });
});

describe("waitingReplyWhere (one rule for the bell, the dashboard, the Team page and the list)", () => {
  it("excludes dry-run replies by default, includes them for lists, and can count only them", async () => {
    const ali = await makeUser("Ali");
    await everyKindFor(ali.id);
    await makeInbound({ kind: "POSSIBLE_REPLY", assigneeId: ali.id, replyScope: "campaign" });
    const count = (where: Parameters<typeof db.inboundMessage.count>[0]) => db.inboundMessage.count(where);
    expect(await count({ where: waitingReplyWhere() })).toBe(4);
    expect(await count({ where: waitingReplyWhere({ assigneeId: ali.id }) })).toBe(4);
    expect(await count({ where: waitingReplyWhere(undefined, { dryRun: "include" }) })).toBe(6);
    expect(await count({ where: waitingReplyWhere(undefined, { dryRun: "only" }) })).toBe(2);
    // `extra` is ANDed, so its own OR never replaces the rule's.
    const extra = { OR: [{ replyScope: "campaign" }, { kind: "UNLINKED" as const }] };
    expect(await count({ where: waitingReplyWhere(extra) })).toBe(1);
  });

  it("the Team page counts the rows a switch-off moves: dry-run replies included, unprocessed ones never", async () => {
    const ali = await makeUser("Ali");
    await everyKindFor(ali.id);
    const team = await listTeam();
    expect(team.find((m) => m.id === ali.id)?.waitingReplies).toBe(5);
  });
});

describe("listWaitingReplies with take (the dashboard's list, §4.2a)", () => {
  it("returns the viewer's oldest `take` replies with the full total, dry-run replies listed", async () => {
    const ali = await makeUser("Ali");
    const sara = await makeUser("Sara");
    const base = Date.now() - 20 * HOUR;
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) {
      const row = await makeInbound({
        kind: "REPLY",
        assigneeId: ali.id,
        replyScope: i === 1 ? "campaign" : "real",
        receivedAt: new Date(base + i * HOUR),
      });
      ids.push(row.id);
    }
    await makeInbound({ kind: "REPLY", assigneeId: sara.id, receivedAt: new Date(base - HOUR) });
    const viewer = { id: ali.id, role: "MEMBER" as const, timeZone: "Europe/Berlin" };

    const top = await listWaitingReplies(viewer, { scope: "mine", take: 5 });
    // Oldest first; the dry-run reply (ids[1]) is listed, though the bell and the dashboard line don't count it.
    expect(top.rows.map((r) => r.id)).toEqual(ids.slice(0, 5));
    expect(top).toMatchObject({ total: 7, mine: 7, everyone: 8, page: 1, pageCount: 2 });
    expect(await waitingReplyCount(ali.id)).toBe(6);
    // "(2 more)" on the dashboard: total − rows.
    expect(top.total - top.rows.length).toBe(2);

    const second = await listWaitingReplies(viewer, { scope: "mine", take: 5, page: 2 });
    expect(second.rows.map((r) => r.id)).toEqual(ids.slice(5));

    const everyone = await listWaitingReplies(viewer, { scope: "everyone", take: 3 });
    expect(everyone.rows).toHaveLength(3);
    expect(everyone).toMatchObject({ total: 8, pageCount: 3 });
  });

  it("caps take at 50, never goes below 1, and keeps 50 per page without it", async () => {
    const ali = await makeUser("Ali");
    await dbWrite((c) =>
      c.inboundMessage.createMany({
        data: Array.from({ length: 55 }, (_, i) => ({
          receivedAt: new Date(Date.now() - (60 - i) * 60_000),
          toAddress: "ali@send.example.com",
          fromEmail: `writer${i}@firma.example`,
          source: "NOTIFY" as const,
          kind: "REPLY" as const,
          replyScope: "real",
          assigneeId: ali.id,
          processedAt: new Date(),
        })),
      }),
    );
    const viewer = { id: ali.id, role: "MEMBER" as const, timeZone: "Europe/Berlin" };
    expect(WAITING_PAGE_SIZE).toBe(50);
    expect((await listWaitingReplies(viewer, { scope: "mine" })).rows).toHaveLength(50);
    const capped = await listWaitingReplies(viewer, { scope: "mine", take: 500 });
    expect(capped.rows).toHaveLength(50);
    expect(capped.pageCount).toBe(2);
    expect((await listWaitingReplies(viewer, { scope: "mine", take: 0 })).rows).toHaveLength(1);
    expect((await listWaitingReplies(viewer, { scope: "mine", take: Number.NaN })).rows).toHaveLength(50);
  });

  it("is empty for a viewer with nothing waiting", async () => {
    const ali = await makeUser("Ali");
    const res = await listWaitingReplies({ id: ali.id, role: "OWNER", timeZone: "Asia/Karachi" }, { scope: "mine", take: 5 });
    expect(res).toMatchObject({ rows: [], total: 0, page: 1, pageCount: 1 });
  });
});
