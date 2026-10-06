import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeMember, makeOwner, seedEmail } from "../mail-events/seed";

/**
 * Two dashboard sources (M6-DESIGN §4.2 item 8, §4.3 "Recent team activity"): the emails that need a decision, and the
 * team's recent activity without per-email rows (one `findMany` with a `take`, never a count of the log).
 */

const t = await createTestDb("dashboard-unconfirmed-activity");
const { db, dbWrite } = await import("@/server/db");
const { unconfirmedEmails } = await import("@/server/services/dashboard/unconfirmed");
const { recentTeamActivity, TEAM_ACTIVITY_MAX_TAKE } = await import("@/server/services/dashboard/activity");

const MIN = 60_000;
const DAY = 86_400_000;
let ownerId: number;
let memberId: number;

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

beforeAll(async () => {
  ownerId = (await makeOwner()).id;
  memberId = (await makeMember("Ali", "ali@polygonparadise.test")).id;
});

describe("unconfirmedEmails", () => {
  beforeEach(async () => {
    await dbWrite(async (c) => {
      await c.outboundEmail.deleteMany({});
      await c.campaignRecipient.deleteMany({});
      await c.campaignStep.deleteMany({});
      await c.campaign.deleteMany({});
    });
  });

  it("is 0 and no campaign when nothing needs a decision", async () => {
    await seedEmail({ createdById: ownerId, status: "SENT" });
    await seedEmail({ createdById: ownerId, status: "UNKNOWN" }); // still being checked: no decision yet
    await seedEmail({ createdById: ownerId, status: "FAILED" });
    expect(await unconfirmedEmails()).toEqual({ count: 0, firstCampaignId: null });
  });

  it("counts UNCONFIRMED emails and names the campaign of the oldest one", async () => {
    const first = await seedEmail({ createdById: ownerId, status: "UNCONFIRMED", followUp: false });
    await seedEmail({ createdById: ownerId, status: "UNCONFIRMED", campaignId: first.campaignId, followUp: false });
    const second = await seedEmail({ createdById: memberId, status: "UNCONFIRMED", campaignStatus: "PAUSED", followUp: false });
    await seedEmail({ createdById: memberId, status: "SENT" });
    expect(await unconfirmedEmails()).toEqual({ count: 3, firstCampaignId: first.campaignId });
    expect(second.campaignId).not.toBe(first.campaignId);
  });

  it("leaves out a cancelled campaign's email (it can't be retried, so nobody could clear the item)", async () => {
    const cancelled = await seedEmail({ createdById: ownerId, status: "UNCONFIRMED", followUp: false });
    await dbWrite((c) => c.campaign.update({ where: { id: cancelled.campaignId }, data: { status: "CANCELLED" } }));
    expect(await unconfirmedEmails()).toEqual({ count: 0, firstCampaignId: null });
    const running = await seedEmail({ createdById: ownerId, status: "UNCONFIRMED", followUp: false });
    expect(await unconfirmedEmails()).toEqual({ count: 1, firstCampaignId: running.campaignId });
  });
});

describe("recentTeamActivity", () => {
  const NOW = new Date("2026-09-23T10:00:00.000Z");

  beforeEach(async () => {
    await dbWrite((c) => c.activityLog.deleteMany({}));
  });

  async function activity(type: string, at: Date, opts: { actorId?: number | null; mode?: "DRY_RUN" | "TEST" | "LIVE" | null } = {}) {
    return dbWrite((c) =>
      c.activityLog.create({
        data: { type, summary: `${type} at ${at.toISOString()}`, at, actorId: opts.actorId ?? null, mode: opts.mode ?? null },
      }),
    );
  }

  it("returns the 8 newest rows of the last 30 days, skipping 500 newer per-email rows", async () => {
    const wanted: number[] = [];
    for (let i = 0; i < 10; i++) {
      const row = await activity(i % 2 ? "campaign.launched" : "company.statusChanged", new Date(NOW.getTime() - (60 + i) * MIN), {
        actorId: i % 3 === 0 ? memberId : null,
        mode: i === 0 ? "DRY_RUN" : null,
      });
      wanted.push(row.id);
    }
    // 500 newer email.* rows (email.sent is logged for every email) must not push them out.
    await dbWrite((c) =>
      c.activityLog.createMany({
        data: Array.from({ length: 500 }, (_, i) => ({
          type: i % 50 === 0 ? "email.bounced" : "email.sent",
          summary: "Email sent",
          at: new Date(NOW.getTime() - (i % 50) * MIN),
          mode: "LIVE" as const,
        })),
      }),
    );
    // Older than 30 days: never shown, even with room left.
    await activity("campaign.finished", new Date(NOW.getTime() - 30 * DAY - MIN));

    const rows = await recentTeamActivity(NOW, 8);
    expect(rows.map((r) => r.id)).toEqual(wanted.slice(0, 8));
    expect(rows[0]).toEqual({
      id: wanted[0],
      at: new Date(NOW.getTime() - 60 * MIN).toISOString(),
      summary: `company.statusChanged at ${new Date(NOW.getTime() - 60 * MIN).toISOString()}`,
      actorName: "Ali",
      mode: "DRY_RUN",
      company: null,
      group: null,
    });
    expect(rows[1]).toMatchObject({ actorName: null, mode: null });
    // The default is 8 as well.
    expect((await recentTeamActivity(NOW)).map((r) => r.id)).toEqual(wanted.slice(0, 8));
  });

  it("asks for at most 10 rows and at least 1", async () => {
    for (let i = 0; i < 12; i++) await activity("list.created", new Date(NOW.getTime() - (i + 1) * MIN), { actorId: ownerId });
    expect(TEAM_ACTIVITY_MAX_TAKE).toBe(10);
    expect(await recentTeamActivity(NOW, 50)).toHaveLength(10);
    expect(await recentTeamActivity(NOW, 0)).toHaveLength(1);
    expect(await recentTeamActivity(NOW, 3)).toHaveLength(3);
    expect((await recentTeamActivity(NOW, 1))[0]).toMatchObject({ actorName: "Arslan" });
  });

  it("orders rows of the same moment newest id first, and keeps a row exactly 30 days old", async () => {
    const at = new Date(NOW.getTime() - 5 * MIN);
    const a = await activity("tag.created", at);
    const b = await activity("tag.renamed", at);
    const edge = await activity("list.renamed", new Date(NOW.getTime() - 30 * DAY));
    expect((await recentTeamActivity(NOW, 10)).map((r) => r.id)).toEqual([b.id, a.id, edge.id]);
  });

  it("is empty without activity", async () => {
    expect(await recentTeamActivity(NOW)).toEqual([]);
  });

  describe("names the company and collapses bulk changes (reviews DASHBOARD-3, DASHBOARD-4)", () => {
    let seq = 0;
    async function company(name: string, opts: { deleted?: boolean } = {}) {
      return dbWrite((c) => c.company.create({ data: { name, nameNorm: name.toLowerCase(), deletedAt: opts.deleted ? NOW : null } }));
    }
    /** One row, `minutesAgo` before NOW (a later call with the same minute is newer by id). */
    async function log(
      minutesAgo: number,
      type: string,
      summary: string,
      opts: { actorId?: number | null; companyId?: number | null; data?: Record<string, unknown> } = {},
    ) {
      seq += 1;
      return dbWrite((c) =>
        c.activityLog.create({
          data: {
            at: new Date(NOW.getTime() - minutesAgo * MIN),
            type,
            summary,
            actorId: opts.actorId === undefined ? memberId : opts.actorId,
            companyId: opts.companyId ?? null,
            data: (opts.data ?? { seq }) as never,
          },
        }),
      );
    }

    it("names and links the company a row is about, like the Activity page; a deleted one by name only", async () => {
      const figuren = await company("Figuren Werkstatt");
      const gone = await company("Old Studio", { deleted: true });
      await log(30, "company.created", "Ali added this company", { companyId: figuren.id });
      await log(20, "company.deleted", "Ali deleted this company", { companyId: gone.id });
      await log(10, "list.created", 'Ali created the list "Germany"');
      const rows = await recentTeamActivity(NOW);
      expect(rows.map((r) => [r.summary, r.company, r.group])).toEqual([
        ['Ali created the list "Germany"', null, null],
        ["Ali deleted this company", { id: gone.id, name: "Old Studio", deleted: true }, null],
        ["Ali added this company", { id: figuren.id, name: "Figuren Werkstatt", deleted: false }, null],
      ]);
    });

    it("collapses a bulk change of 12 companies into one row with its count, and keeps 8 rows after collapsing", async () => {
      const ids: number[] = [];
      for (let i = 0; i < 12; i++) ids.push((await company(`Bulk ${i}`)).id);
      for (let i = 0; i < 9; i++) await log(100 + i, "tag.created", `Ali created the tag "t${i}"`);
      for (const id of ids) await log(50, "company.status", "Ali set status to Contacted", { companyId: id, data: { from: "NOT_CONTACTED", to: "CONTACTED", bulk: true } });
      await log(10, "company.status", "Ali set status to Client", { companyId: ids[0]! });
      const rows = await recentTeamActivity(NOW, 8);
      expect(rows).toHaveLength(8);
      expect(rows[0]).toMatchObject({ summary: "Ali set status to Client", company: { id: ids[0], name: "Bulk 0" }, group: null });
      expect(rows[1]).toMatchObject({ summary: "Ali set status to Contacted", company: null, group: { count: 12, companies: true, atLeast: false } });
      expect(rows.slice(2).map((r) => r.summary)).toEqual([0, 1, 2, 3, 4, 5].map((i) => `Ali created the tag "t${i}"`));
    });

    it("the same change repeated on one company counts times; a different actor or change starts a new row", async () => {
      const one = await company("Studio Eins");
      await log(40, "company.notes", "Ali changed the notes", { companyId: one.id });
      await log(30, "company.notes", "Ali changed the notes", { companyId: one.id });
      await log(20, "company.notes", "Arslan changed the notes", { companyId: one.id, actorId: ownerId });
      await log(10, "company.notes", "Ali changed the notes", { companyId: one.id });
      const rows = await recentTeamActivity(NOW);
      expect(rows.map((r) => [r.summary, r.group])).toEqual([
        ["Ali changed the notes", null],
        ["Arslan changed the notes", null],
        ["Ali changed the notes", { count: 2, companies: false, atLeast: false }],
      ]);
      expect(rows[2]!.company).toMatchObject({ id: one.id, name: "Studio Eins" });
    });

    it("leaves out an import's per-company rows once its 'import.done' row is among them", async () => {
      const ids: number[] = [];
      for (let i = 0; i < 30; i++) ids.push((await company(`Imported ${i}`)).id);
      await log(200, "list.created", 'Ali created the list "Spain"');
      for (const id of ids) await log(60, "company.created", "Imported from spain.csv by Ali", { companyId: id, data: { importSessionId: "s-1" } });
      await log(59, "import.done", "Ali imported spain.csv: 30 companies added", { data: { importSessionId: "s-1", created: 30 } });
      // Another import still running: its rows are collapsed instead.
      for (const id of ids.slice(0, 5)) await log(5, "company.updated", "Updated from more.csv by Ali (website)", { companyId: id, data: { importSessionId: "s-2" } });
      const rows = await recentTeamActivity(NOW);
      expect(rows.map((r) => [r.summary, r.group])).toEqual([
        ["Updated from more.csv by Ali (website)", { count: 5, companies: true, atLeast: false }],
        ["Ali imported spain.csv: 30 companies added", null],
        ['Ali created the list "Spain"', null],
      ]);
    });

    it("reads at most 200 rows: a longer run says 'at least'", async () => {
      await log(500, "list.created", 'Ali created the list "Old"');
      await dbWrite((c) =>
        c.activityLog.createMany({
          data: Array.from({ length: 250 }, (_, i) => ({
            at: new Date(NOW.getTime() - (10 + i) * 1000),
            type: "company.deleted",
            summary: "Ali deleted this company",
            actorId: memberId,
          })),
        }),
      );
      const rows = await recentTeamActivity(NOW);
      expect(rows).toEqual([expect.objectContaining({ summary: "Ali deleted this company", group: { count: 200, companies: false, atLeast: true } })]);
    });
  });
});
