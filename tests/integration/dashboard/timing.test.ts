import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";

/**
 * The dashboard at post-go-live volumes (M6-DESIGN §4.6): 10,000 companies (9,500 people), 100,000 OutboundEmail rows,
 * 100,000 ActivityLog rows (almost all `email.sent`, and the newest ones) and 20,000 MailEvent rows, inserted with
 * recursive-CTE `INSERT … SELECT`.
 *
 * - No N+1: one `loadDashboard` sends a fixed, small number of queries, whatever the volumes (counted on `db`).
 * - Time: the design's bound is 1 second on this machine (the target is 150 ms of server time). Run alone it takes
 *   about 0.55 s of this process's CPU here; the full suite runs many test files at once, which roughly doubles the
 *   work of each (shared cores and caches), so the bound checked is 2 seconds of CPU, best of three runs, and 5 seconds
 *   on the clock. Today's limit, the health sample and the dry-run numbers read only their own days through the
 *   `sentAt` index, never every SENT email through (status, dueAt) (review DASHBOARD-2; the plans are checked in
 *   tests/integration/sending/query-plans.test.ts).
 */

const counter = vi.hoisted(() => ({ queries: 0, on: false }));

vi.mock("server-only", () => ({}));
// Counts every query sent through `db` (model calls and raw queries) while `counter.on` is set.
vi.mock("@/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db")>();
  const counted = <F extends (...args: never[]) => unknown>(fn: F, self: object): F =>
    ((...args: Parameters<F>) => {
      if (counter.on) counter.queries += 1;
      return fn.apply(self, args);
    }) as F;
  const delegate = (model: object) =>
    new Proxy(model, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? counted(value as (...args: never[]) => unknown, target) : value;
      },
    });
  const db = new Proxy(actual.db, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof prop !== "string") return value;
      if (prop.startsWith("$query")) return counted(value as (...args: never[]) => unknown, target);
      if (!prop.startsWith("$") && value !== null && typeof value === "object") return delegate(value);
      return value;
    },
  });
  return { ...actual, db };
});

const t = await createTestDb("dashboard-timing");
const { db, dbWrite } = await import("@/server/db");
const { loadDashboard } = await import("@/app/(app)/dashboard/load");

// Wednesday 23 Sep 2026, 15:00 in Karachi.
const NOW = new Date("2026-09-23T10:00:00.000Z");
/** The clock as SQLite's date functions read it (UTC). */
const BASE = "'2026-09-23 10:00:00'";
/** A date in Prisma's stored form ("2026-09-23T10:00:00.000+00:00") from SQLite modifiers. */
const isoAt = (modifier: string) => `strftime('%Y-%m-%dT%H:%M:%f', ${BASE}, ${modifier}) || '+00:00'`;
const seq = (count: number) => `WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < ${count})`;

/** This process's CPU time for one `loadDashboard`, best of three (see the header). */
const CPU_LIMIT_MS = 2_000;
/** The clock-time bound (a hang or a runaway query), loose because other test files run at the same time. */
const WALL_LIMIT_MS = 5_000;
/**
 * Queries one `loadDashboard` may send: 68 here (every one a count, a groupBy or a list with a `take`; the health
 * counts look up their events in chunks of 400 emails, so a full sample adds a few), with room for small additions.
 */
const QUERY_LIMIT = 90;

const COMPANIES = 10_000;
const EMAILS = 100_000;
const ACTIVITY = 100_000;
const EVENTS = 20_000;

let viewer: Parameters<typeof loadDashboard>[0];
let member: Parameters<typeof loadDashboard>[0];

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

beforeAll(async () => {
  const owner = await dbWrite((c) => c.user.create({ data: { name: "Arslan", email: "arslan@example.com", role: "OWNER", timeZone: "Asia/Karachi" } }));
  const ali = await dbWrite((c) => c.user.create({ data: { name: "Ali", email: "ali@example.com", role: "MEMBER", timeZone: "Asia/Karachi" } }));
  viewer = { id: owner.id, email: owner.email, name: owner.name, role: "OWNER", timeZone: "Asia/Karachi", sessionId: 1 };
  member = { id: ali.id, email: ali.email, name: ali.name, role: "MEMBER", timeZone: "Asia/Karachi", sessionId: 2 };

  await dbWrite(async (c) => {
    for (const [key, value] of [
      ["practice.copy", false],
      ["sending.capDayTimeZone", "Asia/Karachi"],
      ["mailgun.domain", "send.example.com"],
      ["sending.goLive", true],
      ["sending.goLiveAt", "2026-08-25T09:00:00.000Z"],
      ["sending.goLiveDomain", "send.example.com"],
    ] as const) {
      await c.setting.create({ data: { key, value: value as never } });
    }
    await c.secret.create({ data: { key: "mailgun.apiKey", ciphertext: "not-decryptable", last4: "abcd" } });
    await c.workerLease.create({ data: { id: 1, workerId: "test", heartbeatAt: new Date(NOW.getTime() - 5_000), startedAt: NOW } });
  });

  // 10,000 companies: every other one emailed in the last 60 days, one in ten of those replied, one in 20 has no person.
  await dbWrite((c) =>
    c.$executeRawUnsafe(`${seq(COMPANIES)}
      INSERT INTO "Company" ("name", "nameNorm", "status", "firstContactedAt", "repliedAt", "createdAt", "updatedAt")
      SELECT 'Company ' || n, 'company ' || n,
        CASE WHEN n % 10 = 0 THEN 'REPLIED' WHEN n % 2 = 0 THEN 'CONTACTED' ELSE 'NOT_CONTACTED' END,
        CASE WHEN n % 2 = 0 THEN ${isoAt("'-' || (n % 60) || ' days'")} END,
        CASE WHEN n % 10 = 0 THEN ${isoAt("'-' || (n % 5) || ' days'")} END,
        ${isoAt("'-90 days'")}, ${isoAt("'-1 days'")}
      FROM s`),
  );
  await dbWrite((c) =>
    c.$executeRawUnsafe(`
      INSERT INTO "Person" ("companyId", "name", "email", "emailNorm", "createdAt", "updatedAt")
      SELECT "id", 'Person ' || "id", 'p' || "id" || '@c' || "id" || '.example', 'p' || "id" || '@c' || "id" || '.example',
        ${isoAt("'-90 days'")}, ${isoAt("'-90 days'")}
      FROM "Company" WHERE "id" % 20 <> 0`),
  );

  // One big live campaign with everyone, and eight smaller running or scheduled ones.
  const big = await dbWrite((c) =>
    c.campaign.create({
      data: {
        name: "Big",
        status: "RUNNING",
        mode: "LIVE",
        createdById: owner.id,
        senderId: owner.id,
        launchedAt: new Date(NOW.getTime() - 40 * 86_400_000),
        launchedGoLive: true,
        steps: { create: [{ step: 0, subject: "Hello", body: "Hi" }, { step: 1, body: "Again", delayDays: 3 }] },
      },
    }),
  );
  for (let i = 0; i < 8; i++) {
    await dbWrite((c) =>
      c.campaign.create({
        data: {
          name: `Small ${i}`,
          status: i % 2 === 0 ? "RUNNING" : "SCHEDULED",
          mode: i % 3 === 0 ? "DRY_RUN" : "LIVE",
          createdById: owner.id,
          senderId: ali.id,
          launchedAt: new Date(NOW.getTime() - i * 3_600_000),
          launchedGoLive: true,
        },
      }),
    );
  }
  await dbWrite((c) =>
    c.$executeRawUnsafe(`
      INSERT INTO "CampaignRecipient" ("campaignId", "companyId", "personId", "emailNorm", "state", "currentStep", "createdAt", "updatedAt")
      SELECT ${big.id}, "companyId", "id", "emailNorm", 'WAITING', 1, ${isoAt("'-40 days'")}, ${isoAt("'-1 days'")}
      FROM "Person"`),
  );
  const recipients = await db.campaignRecipient.aggregate({ _min: { id: true }, _count: { _all: true } });
  const first = recipients._min.id!;
  const count = recipients._count._all;

  // 100,000 sent live emails over the last 30 days (about 140 of them today in Karachi).
  await dbWrite((c) =>
    c.$executeRawUnsafe(`${seq(EMAILS)}
      INSERT INTO "OutboundEmail" ("campaignId", "recipientId", "personId", "companyId", "senderId", "step", "mode", "toEmail", "toNorm",
        "companyName", "fromAddress", "subject", "text", "html", "messageId", "sendId", "dueAt", "status", "claimedAt", "sentAt",
        "createdAt", "updatedAt")
      SELECT r."campaignId", r."id", r."personId", r."companyId", ${owner.id}, (s.n - 1) / ${count}, 'LIVE', r."emailNorm", r."emailNorm",
        'Snapshot', 'Arslan <arslan@send.example.com>', 'Hello', 'Hi', '<p>Hi</p>', 'm' || s.n || '@send.example.com', 's' || s.n,
        ${isoAt("'-' || (s.n % 43200) || ' minutes'")}, 'SENT', ${isoAt("'-' || (s.n % 43200) || ' minutes'")},
        ${isoAt("'-' || (s.n % 43200) || ' minutes'")}, ${isoAt("'-30 days'")}, ${isoAt("'-1 days'")}
      FROM s JOIN "CampaignRecipient" r ON r."id" = ${first} + ((s.n - 1) % ${count})`),
  );

  // 20,000 events: delivered, and one in 50 a permanent bounce.
  await dbWrite((c) =>
    c.$executeRawUnsafe(`${seq(EVENTS)}
      INSERT INTO "MailEvent" ("dedupeKey", "type", "severity", "occurredAt", "outboundEmailId", "source", "raw", "createdAt")
      SELECT 'e' || n, CASE WHEN n % 50 = 0 THEN 'failed' ELSE 'delivered' END, CASE WHEN n % 50 = 0 THEN 'permanent' END,
        ${isoAt("'-' || (n % 43200) || ' minutes'")}, n * 5, 'WEBHOOK', '{}', ${isoAt("'-1 days'")}
      FROM s`),
  );

  // 100,000 activity rows: all but 200 are `email.sent` and newer than every other row, the worst case for the tile.
  await dbWrite((c) =>
    c.$executeRawUnsafe(`${seq(ACTIVITY)}
      INSERT INTO "ActivityLog" ("at", "actorId", "type", "summary", "mode")
      SELECT CASE WHEN n <= 200 THEN ${isoAt("'-' || (2 + n) || ' days'")} ELSE ${isoAt("'-' || (n % 1440) || ' minutes'")} END,
        CASE WHEN n <= 200 THEN ${owner.id} END,
        CASE WHEN n <= 200 THEN 'company.status' ELSE 'email.sent' END,
        CASE WHEN n <= 200 THEN 'Arslan set status to Client' ELSE 'Email sent' END,
        CASE WHEN n <= 200 THEN NULL ELSE 'LIVE' END
      FROM s`),
  );

  // A few waiting replies and paused campaigns for the attention list.
  await dbWrite(async (c) => {
    for (let i = 0; i < 30; i++) {
      await c.inboundMessage.create({
        data: {
          receivedAt: new Date(NOW.getTime() - (i + 1) * 3_600_000),
          toAddress: "arslan@send.example.com",
          fromEmail: `p${i + 1}@c${i + 1}.example`,
          subject: "Re: Hello",
          snippet: "Thanks",
          kind: "REPLY",
          replyScope: "real",
          assigneeId: i % 3 === 0 ? ali.id : owner.id,
          source: "NOTIFY",
          processedAt: new Date(NOW.getTime() - i * 3_600_000),
        },
      });
    }
    for (let i = 0; i < 4; i++) {
      await c.campaign.create({
        data: { name: `Paused ${i}`, status: "PAUSED", mode: "LIVE", createdById: owner.id, pausedAt: new Date(NOW.getTime() - i * 86_400_000), pauseReason: "Paused by Arslan" },
      });
    }
  });
}, 120_000);

describe("loadDashboard at post-go-live volumes", () => {
  it("has the volumes it claims", async () => {
    expect(await db.company.count()).toBe(COMPANIES);
    expect(await db.outboundEmail.count()).toBe(EMAILS);
    expect(await db.activityLog.count()).toBe(ACTIVITY);
    expect(await db.mailEvent.count()).toBe(EVENTS);
  });

  it("sends a fixed, small number of queries (no N+1)", async () => {
    await loadDashboard(viewer, NOW);
    const count = async (who: typeof viewer) => {
      counter.queries = 0;
      counter.on = true;
      try {
        await loadDashboard(who, NOW);
      } finally {
        counter.on = false;
      }
      return counter.queries;
    };
    const owner = await count(viewer);
    expect(owner).toBeGreaterThan(20);
    expect(owner).toBeLessThanOrEqual(QUERY_LIMIT);
    // The same again, and a Member needs no more (the Owner's team step adds two counts).
    expect(await count(viewer)).toBe(owner);
    expect(await count(member)).toBeLessThanOrEqual(owner);
  });

  it("loads within the time bounds, with every tile", async () => {
    await loadDashboard(viewer, NOW); // the first call compiles the queries
    const { cpuMs, wallMs, view: v } = await timed(viewer);
    expect(cpuMs).toBeLessThan(CPU_LIMIT_MS);
    expect(wallMs).toBeLessThan(WALL_LIMIT_MS);

    for (const tile of [v.replies, v.pipeline, v.today, v.health, v.campaigns, v.activity]) expect(tile).not.toBeNull();
    expect(v.pipeline?.counts.all).toBe(COMPANIES);
    expect(v.pipeline?.replyRate.emailed).toBe(COMPANIES / 2);
    expect(v.pipeline?.replyRate.replied).toBe(COMPANIES / 10);
    // The 28 identical changes of the last 30 days are one bulk run: one row with its count (review DASHBOARD-4).
    expect(v.activity).toHaveLength(1);
    expect(v.activity?.[0]).toMatchObject({ summary: "Arslan set status to Client", company: null, group: { count: 28, companies: false, atLeast: false } });
    expect(v.campaigns?.items).toHaveLength(5);
    expect(v.replies?.rows).toHaveLength(5);
    expect(v.replies?.total).toBe(20);
    expect(v.health?.bounce.count).toBeGreaterThan(0);
    const keys = v.attention.map((i) => i.key);
    expect(keys).toEqual(expect.arrayContaining(["replies-waiting", "paused-campaigns", "missing-emails"]));
    expect(v.attention.find((i) => i.key === "missing-emails")?.text).toBe("500 companies have no email address.");
    expect(v.today?.used).toBeGreaterThan(0);

    const forMember = await timed(member);
    expect(forMember.cpuMs).toBeLessThan(CPU_LIMIT_MS);
    expect(forMember.wallMs).toBeLessThan(WALL_LIMIT_MS);
  }, 60_000);
});

/**
 * The best of three runs of `loadDashboard`: the time this process spent working on it (CPU, user + system; the
 * database runs on this thread) and the time on the clock.
 */
async function timed(who: Parameters<typeof loadDashboard>[0]) {
  let cpuMs = Number.POSITIVE_INFINITY;
  let wallMs = Number.POSITIVE_INFINITY;
  let view: Awaited<ReturnType<typeof loadDashboard>> | null = null;
  for (let i = 0; i < 3; i++) {
    const cpu = process.cpuUsage();
    const started = performance.now();
    view = await loadDashboard(who, NOW);
    wallMs = Math.min(wallMs, performance.now() - started);
    const used = process.cpuUsage(cpu);
    cpuMs = Math.min(cpuMs, (used.user + used.system) / 1000);
  }
  return { cpuMs, wallMs, view: view! };
}