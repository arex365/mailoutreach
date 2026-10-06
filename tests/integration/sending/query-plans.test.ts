import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";

/**
 * The email table (OutboundEmail) grows with every email and every row carries the full text, so
 * nothing that runs often may read all of it: every query the sending loop, its maintenance and
 * the campaign screens run against it must use an index (review findings SEC-1 and SEC-2). The
 * test runs those paths through a Prisma client that records its SQL, then asks SQLite for each
 * statement's plan (EXPLAIN QUERY PLAN). Plans don't depend on how many rows there are (no ANALYZE
 * statistics), so a small database is enough.
 */

const t = await createTestDb("query-plans");
const { PrismaClient } = await import("@/generated/prisma/client");
const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
const { databaseFilePath } = await import("@/server/env");
const client = new PrismaClient({
  adapter: new PrismaBetterSqlite3({ url: "file:" + databaseFilePath() }),
  log: [{ emit: "event", level: "query" }],
});
const captured: Array<{ query: string; params: string }> = [];
client.$on("query", (e) => captured.push({ query: e.query, params: e.params }));
// @/server/db reuses this client (it keeps one per process on globalThis).
(globalThis as { __outreachDb?: unknown }).__outreachDb = client;

const { db, dbWrite } = await import("@/server/db");
const { makeCompany, makeDraft, makeUser } = await import("../campaigns/seed");
const { launchCampaign } = await import("@/server/services/campaigns/launch");
const control = await import("@/server/services/campaigns/control");
const queries = await import("@/server/services/campaigns/queries");
const render = await import("@/server/services/render");
const claim = await import("@/server/services/sending/claim");
const { markSent, sweepFollowUps } = await import("@/server/services/sending/mark-sent");
const loop = await import("@/server/services/sending/loop");
const gates = await import("@/server/services/sending/gates");
const { undecidedHolds } = await import("@/server/services/sequences/holds");
const { DEFAULT_WINDOW } = await import("@/core/sending/window");

let campaignId = 0;
let recipientIds: number[] = [];
let userId = 0;

beforeAll(async () => {
  expect(db).toBe(client);
  userId = (await makeUser("Ali", { role: "OWNER" })).id;
  const recipients = [];
  for (let i = 0; i < 3; i++) {
    const { company, people } = await makeCompany({ name: `Plan ${i}`, people: [{ name: `P ${i}`, email: `p${i}@plan${i}.de` }] });
    recipients.push({ companyId: company.id, personId: people[0]!.id });
  }
  const draft = await makeDraft({
    name: "Plans",
    createdById: userId,
    steps: [
      { step: 0, subject: "Hello {{company}}", body: "Hi {{first_name|there}}" },
      { step: 1, body: "Following up", delayDays: 3 },
    ],
    recipients,
  });
  await launchCampaign(draft.id, userId);
  campaignId = draft.id;
  recipientIds = (await db.campaignRecipient.findMany({ where: { campaignId }, orderBy: { id: "asc" } })).map((r) => r.id);
  // One sent (its follow-up waits), one that didn't send (a "problem"), one still waiting.
  const rows = await db.outboundEmail.findMany({ where: { campaignId }, orderBy: { recipientId: "asc" } });
  await claim.claimEmail(rows[0]!.id);
  await markSent(rows[0]!.id, new Date());
  await dbWrite((c) => c.outboundEmail.update({ where: { id: rows[1]!.id }, data: { status: "FAILED", lastError: "Couldn't send this email" } }));
});

afterAll(async () => {
  await client.$disconnect();
  t.cleanup();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * Every statement on the table (OutboundEmail by default) the call ran, with the full scans SQLite would do for it,
 * and (the email table) every `sentAt` range it would read through the (status, dueAt) index instead of `sentAt`.
 */
async function fullScans(run: () => Promise<unknown>, table = "OutboundEmail"): Promise<{ statements: number; scans: string[] }> {
  await settle();
  captured.splice(0);
  await run();
  await settle();
  const list = captured.splice(0);
  const scans: string[] = [];
  let statements = 0;
  for (const q of list) {
    if (!/^\s*(SELECT|UPDATE|DELETE)\b/i.test(q.query) || !q.query.includes(`\`${table}\``)) continue;
    statements += 1;
    const names = new Set([`main.${table}`, table]);
    for (const m of q.query.matchAll(new RegExp(`\`main\`\\.\`${table}\` AS \`(\\w+)\``, "g"))) names.add(m[1]!);
    let params: unknown[] = [];
    try {
      params = JSON.parse(q.params) as unknown[];
    } catch {
      params = [];
    }
    const plan = await client.$queryRawUnsafe<Array<{ detail: string }>>(`EXPLAIN QUERY PLAN ${q.query}`, ...params);
    // A `sentAt` range read through the (status, dueAt) index reads every SENT email ever sent (review DASHBOARD-2).
    const sentAtRange = table === "OutboundEmail" && /`sentAt` (>|>=|<|<=) \?/.test(q.query);
    for (const { detail } of plan) {
      const scanned = /^SCAN (\S+)/.exec(detail)?.[1];
      if (scanned && names.has(scanned)) scans.push(`${detail} ← ${q.query.slice(0, 300)}`);
      if (sentAtRange && detail.includes("OutboundEmail_status_dueAt_idx")) scans.push(`${detail} (a sentAt range) ← ${q.query.slice(0, 300)}`);
    }
  }
  await settle();
  captured.splice(0);
  return { statements, scans };
}

describe("queries on the email table use an index", () => {
  it("(the check itself notices a full scan)", async () => {
    const r = await fullScans(() => db.outboundEmail.findMany({ where: { subject: "nothing like this" }, select: { id: true } }));
    expect(r.statements).toBe(1);
    expect(r.scans).toHaveLength(1);
    expect(r.scans[0]).toMatch(/^SCAN main\.OutboundEmail/);
  });

  it("(the check itself notices a sentAt range read through (status, dueAt))", async () => {
    const since = new Date(Date.now() - 86_400_000);
    const r = await fullScans(() => db.outboundEmail.count({ where: { status: "SENT", sentAt: { gte: since } } }));
    expect(r.statements).toBe(1);
    expect(r.scans).toHaveLength(1);
    expect(r.scans[0]).toMatch(/OutboundEmail_status_dueAt_idx.*\(a sentAt range\)/);
  });

  it("the follow-up sweeper (every 5 minutes)", async () => {
    // Make one recipient need repairing, so the repair transaction runs too.
    const followUp = await db.outboundEmail.findFirstOrThrow({ where: { campaignId, step: 1 } });
    await dbWrite((c) => c.outboundEmail.delete({ where: { id: followUp.id } }));
    let result: Awaited<ReturnType<typeof sweepFollowUps>> | null = null;
    const r = await fullScans(async () => {
      result = await sweepFollowUps(new Date());
    });
    expect(result).toMatchObject({ checked: 1, created: 1 });
    expect(r.statements).toBeGreaterThan(0);
    expect(r.scans).toEqual([]);
  });

  it("the sending loop and its maintenance", async () => {
    const r = await fullScans(async () => {
      await loop.sendingTick();
      await loop.runSendingMaintenance(new Date());
      await claim.resetStuckDryRunSends(new Date(), 0);
      await claim.cancelEmailsOfCancelledCampaigns();
    });
    expect(r.statements).toBeGreaterThan(0);
    expect(r.scans).toEqual([]);
  });

  it("the campaign page: overview, people list (all and problems) and one person's panel", async () => {
    const r = await fullScans(async () => {
      await queries.getCampaignOverview(campaignId);
      await queries.listCampaignRecipients(campaignId, {});
      await queries.listCampaignRecipients(campaignId, { filter: "problems" });
      await queries.getRecipientDetail(campaignId, recipientIds[0]!);
    });
    expect(r.statements).toBeGreaterThanOrEqual(4);
    expect(r.scans).toEqual([]);
  });

  it("the candidate queries with every class due, and the due stats (M4: recipient state filter, per-class queries)", async () => {
    // A gated dry run and a (test-mode) email due as well, so every candidate query and the due-stats SQL run.
    const gated = await dbWrite((c) => c.campaign.update({ where: { id: campaignId }, data: { ignoreWindow: false } }));
    expect(gated.ignoreWindow).toBe(false);
    // A Wednesday, 10:00 in Berlin, long after every email here is due.
    const now = new Date("2030-01-09T09:00:00Z");
    const r = await fullScans(async () => {
      await gates.pickCandidates(now, { window: DEFAULT_WINDOW, defaultZone: "Europe/Berlin", practiceCopy: false });
      await gates.explainCampaignWaiting(campaignId, now);
    });
    await dbWrite((c) => c.campaign.update({ where: { id: campaignId }, data: { ignoreWindow: true } }));
    expect(r.statements).toBeGreaterThanOrEqual(3);
    expect(r.scans).toEqual([]);
  });

  it("the before-every-send guard and undecided messages (M4-DESIGN §2.5.1)", async () => {
    const rows = await db.outboundEmail.findMany({ where: { campaignId }, orderBy: { id: "asc" } });
    const sent = rows.find((x) => x.status === "SENT")!;
    const recipient = await db.campaignRecipient.findUniqueOrThrow({ where: { id: sent.recipientId } });
    await dbWrite(async (c) => {
      await c.inboundMessage.create({
        data: {
          receivedAt: new Date(),
          toAddress: "ali@send.example.com",
          fromEmail: "someone@plan-reply.de",
          subject: "Re: Hello",
          inReplyTo: sent.messageId,
          references: sent.messageId,
          source: "NOTIFY",
        },
      });
      await c.inboundMessage.create({
        data: {
          receivedAt: new Date(),
          toAddress: "ali@send.example.com",
          fromEmail: "maybe@plan-reply.de",
          subject: "Re: Hello",
          source: "NOTIFY",
          kind: "POSSIBLE_REPLY",
          companyId: recipient.companyId,
          replyScope: "real",
          processedAt: new Date(),
        },
      });
    });
    const cands = rows.map((x) => ({
      id: x.id,
      campaignId,
      recipientId: x.recipientId,
      companyId: recipient.companyId,
      toNorm: x.toNorm,
      mode: x.mode,
      step: x.step,
    }));
    const out: { problems?: Awaited<ReturnType<typeof gates.pendingProblemIds>> } = {};
    const onEmails = await fullScans(async () => {
      gates.clearThreadTargetCache();
      out.problems = await gates.pendingProblemIds(cands);
    });
    expect(onEmails.statements).toBeGreaterThan(0);
    expect(onEmails.scans).toEqual([]);
    const onReplies = await fullScans(async () => {
      gates.clearThreadTargetCache();
      await gates.pendingProblemIds(cands);
      await undecidedHolds(db, [recipient.companyId]);
    }, "InboundMessage");
    expect(onReplies.statements).toBeGreaterThanOrEqual(2);
    expect(onReplies.scans).toEqual([]);
    expect(out.problems?.pending.size).toBeGreaterThan(0);
    expect(out.problems?.possibleReply.size).toBe(rows.length);
    await dbWrite((c) => c.inboundMessage.deleteMany({}));
  });

  it("the guard's hold after the PC was off (review SEQ-3): people held, their companies and last emails", async () => {
    // A test-mode email of one person, while another person of the campaign is held for an outage (emailed already).
    const rows = await db.outboundEmail.findMany({ where: { campaignId }, orderBy: { id: "asc" } });
    const held = await db.campaignRecipient.findUniqueOrThrow({ where: { id: recipientIds[1]! } });
    await dbWrite(async (c) => {
      await c.campaign.update({ where: { id: campaignId }, data: { mode: "TEST" } });
      await c.outboundEmail.updateMany({ where: { campaignId }, data: { mode: "TEST" } });
      await c.campaignRecipient.update({ where: { id: held.id }, data: { state: "HELD", holdReason: "outage", heldAt: new Date(), currentStep: 1 } });
      await c.systemState.upsert({
        where: { key: "catchup.outage" },
        create: { key: "catchup.outage", value: { handledAt: new Date().toISOString(), heldFor: "2020-01-01T00:00:00.000Z", heldTo: "2030-01-01T00:00:00.000Z" } },
        update: { value: { handledAt: new Date().toISOString(), heldFor: "2020-01-01T00:00:00.000Z", heldTo: "2030-01-01T00:00:00.000Z" } },
      });
    });
    const cands = rows.map((x) => ({ id: x.id, campaignId, recipientId: x.recipientId, companyId: x.companyId, toNorm: x.toNorm, mode: "TEST" as const, step: 1 }));
    const out: { ids?: Set<number> } = {};
    for (const table of ["OutboundEmail", "CampaignRecipient"]) {
      const r = await fullScans(async () => {
        out.ids = await gates.outageHeldIds(cands);
      }, table);
      expect(r.statements).toBeGreaterThan(0);
      expect(r.scans).toEqual([]);
    }
    // The sent person's follow-up: their sender still has someone held, and their email went before the window's end.
    expect(out.ids?.has(rows.find((x) => x.status === "SENT")!.id)).toBe(true);
    await dbWrite(async (c) => {
      await c.campaign.update({ where: { id: campaignId }, data: { mode: "DRY_RUN" } });
      await c.outboundEmail.updateMany({ where: { campaignId }, data: { mode: "DRY_RUN" } });
      await c.campaignRecipient.update({ where: { id: held.id }, data: { state: held.state, holdReason: null, heldAt: null, currentStep: held.currentStep } });
      await c.systemState.deleteMany({ where: { key: "catchup.outage" } });
    });
  });

  it("the 30-day history joins each email's campaign launch flag and keeps its indexes (M6-DESIGN §2.2)", async () => {
    const { evaluateCompanies, loadEligibilitySettings } = await import("@/server/services/eligibility");
    const companyIds = (await db.company.findMany({ select: { id: true } })).map((c) => c.id);
    const base = await loadEligibilitySettings();
    for (const practiceCopy of [false, true]) {
      const seen: Array<{ query: string; details: string[] }> = [];
      await settle();
      captured.splice(0);
      await evaluateCompanies(companyIds, { mode: "LIVE", phase: "draft", settings: { ...base, practiceCopy, days: 30 } });
      await settle();
      for (const q of captured.splice(0)) {
        if (!/^\s*SELECT\b/i.test(q.query) || !q.query.includes("`OutboundEmail`")) continue;
        const plan = await client.$queryRawUnsafe<Array<{ detail: string }>>(`EXPLAIN QUERY PLAN ${q.query}`, ...(JSON.parse(q.params) as unknown[]));
        seen.push({ query: q.query, details: plan.map((p) => p.detail) });
      }
      const by = (column: string) => seen.filter((s) => new RegExp(`\`OutboundEmail\`\\.\`${column}\` IN \\(`).test(s.query));
      // The three history queries (by company, domain and address) and the "maybe sent" one, each with the launch flag.
      expect(seen.length, JSON.stringify(seen, null, 2)).toBeGreaterThanOrEqual(4);
      for (const s of seen) {
        expect(s.query, "joins the campaign's launch flag").toMatch(/`launchedGoLive`/);
        // No full scan of the email table, and the campaign is found by its primary key.
        expect(s.details.filter((d) => /^SCAN (main\.)?OutboundEmail\b/.test(d)), JSON.stringify(s)).toEqual([]);
        expect(s.details.join(" | "), JSON.stringify(s)).toMatch(/SEARCH \w+ USING INTEGER PRIMARY KEY/);
      }
      for (const [column, index] of [
        ["companyId", "OutboundEmail_companyId_sentAt_idx"],
        ["companyDomain", "OutboundEmail_companyDomain_sentAt_idx"],
        ["toNorm", "OutboundEmail_toNorm_sentAt_idx"],
      ] as const) {
        const list = by(column);
        expect(list.length, `${column} (practice copy ${practiceCopy})`).toBeGreaterThanOrEqual(1);
        for (const s of list) expect(s.details.join(" | "), `${column} (practice copy ${practiceCopy}) ${s.query}`).toContain(`USING INDEX ${index}`);
      }
    }
  });

  it("a sentAt range is read through the sentAt index, never every SENT email through (status, dueAt) (review DASHBOARD-2)", async () => {
    const usage = await import("@/server/services/sending/usage");
    const { loadDryRunSummary } = await import("@/server/services/dashboard/dry-run");
    const { countedSendsBetween, loadWarmupProgress } = await import("@/server/services/sending/warmup-days");
    /** Every SELECT on the email table with a `sentAt` range, and its plan. */
    const sentAtRanges = async (run: () => Promise<unknown>) => {
      await settle();
      captured.splice(0);
      await run();
      await settle();
      const out: Array<{ query: string; details: string }> = [];
      for (const q of captured.splice(0)) {
        if (!/^\s*SELECT\b/i.test(q.query) || !q.query.includes("`OutboundEmail`")) continue;
        if (!/`sentAt` (>|>=|<|<=) \?/.test(q.query)) continue;
        const plan = await client.$queryRawUnsafe<Array<{ detail: string }>>(`EXPLAIN QUERY PLAN ${q.query}`, ...(JSON.parse(q.params) as unknown[]));
        out.push({ query: q.query.slice(0, 400), details: plan.map((p) => p.detail).join(" | ") });
      }
      return out;
    };
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 86_400_000);

    // The check notices the old form: a `status` condition next to the range picks (status, dueAt).
    const old = await sentAtRanges(() =>
      db.outboundEmail.groupBy({ by: ["senderId"], where: { mode: { in: ["LIVE"] }, status: "SENT", sentAt: { gte: dayAgo, lt: now } }, _count: { _all: true } }),
    );
    expect(old).toHaveLength(1);
    expect(old[0]!.details).toContain("OutboundEmail_status_dueAt_idx");

    const seen = await sentAtRanges(async () => {
      await usage.getTodayCap(now);
      await usage.getTodayCap(now, { practiceCopy: true });
      await usage.loadHealthCounts({ since: dayAgo, bounceWindow: 200, complaintWindow: 1000, practiceCopy: false });
      await usage.loadHealthCounts({ since: dayAgo, before: now, bounceWindow: 200, complaintWindow: 1000, practiceCopy: true });
      await loadDryRunSummary(now);
      await countedSendsBetween(dayAgo, now, false);
      await loadWarmupProgress(now);
    });
    // Today's limit (twice), the health samples (two each), the dry-run numbers, a closed day and today's progress.
    expect(seen.length, JSON.stringify(seen, null, 2)).toBeGreaterThanOrEqual(9);
    for (const s of seen) {
      expect(s.details, s.query).not.toContain("OutboundEmail_status_dueAt_idx");
      expect(s.details, s.query).toContain("USING INDEX OutboundEmail_sentAt_idx");
    }

    // Counting from the very start (no baseline, before go-live): the newest emails through the same index, no sort.
    await settle();
    captured.splice(0);
    await usage.loadHealthCounts({ since: null, bounceWindow: 200, complaintWindow: 1000, practiceCopy: false });
    await settle();
    const samples = captured.splice(0).filter((q) => /^\s*SELECT\b/i.test(q.query) && q.query.includes("`OutboundEmail`"));
    expect(samples).toHaveLength(2);
    for (const q of samples) {
      const plan = (await client.$queryRawUnsafe<Array<{ detail: string }>>(`EXPLAIN QUERY PLAN ${q.query}`, ...(JSON.parse(q.params) as unknown[])))
        .map((p) => p.detail)
        .join(" | ");
      expect(plan, q.query).toContain("OutboundEmail_sentAt_idx");
      expect(plan, q.query).not.toContain("TEMP B-TREE");
    }
  });

  it("rendering follow-ups (Review, Schedule, the sender) and editing or skipping one person", async () => {
    const r = await fullScans(async () => {
      await render.renderCampaignEmails({ campaignId, purpose: "preview" });
      await render.renderCampaignEmail({ recipientId: recipientIds[0]!, step: 1, purpose: "preview" });
      await control.editUnsentEmail(recipientIds[0]!, 1, { body: "My own follow-up" }, userId);
      await control.skipRecipient(recipientIds[2]!, userId);
    });
    expect(r.statements).toBeGreaterThanOrEqual(4);
    expect(r.scans).toEqual([]);
  });

  it("own-mailbox mode: the inbox check's company reads, the candidate pages past held rows and the final plan count keep their indexes (reviews SEND-1, SEND-2, SEND-3)", async () => {
    const { setSettingValue } = await import("../campaigns/seed");
    const usage = await import("@/server/services/sending/usage");
    const rows = await db.outboundEmail.findMany({ where: { campaignId }, orderBy: { id: "asc" } });
    await setSettingValue("mailgun.domain", "example.com");
    await setSettingValue("mailgun.fromAddress", "contact@example.com");
    await setSettingValue("mailgun.replies", "own-mailbox");
    await dbWrite(async (c) => {
      await c.campaign.update({ where: { id: campaignId }, data: { mode: "LIVE", ignoreWindow: false } });
      await c.outboundEmail.updateMany({ where: { campaignId }, data: { mode: "LIVE" } });
      // A follow-up due (it waits for the inbox check) ahead of a first email, so a one-row page is read past it.
      await c.outboundEmail.updateMany({ where: { campaignId, status: { in: ["FAILED", "QUEUED"] } }, data: { status: "QUEUED" } });
    });
    try {
      const now = new Date("2030-01-09T09:00:00Z");
      const firsts = rows.map((x) => ({ id: x.id, campaignId, recipientId: x.recipientId, companyId: x.companyId, toNorm: x.toNorm, mode: "LIVE" as const, step: 0 }));
      const out: { held?: Set<number>; picked?: Awaited<ReturnType<typeof gates.pickCandidates>> } = {};
      for (const table of ["OutboundEmail", "ExternalSend"]) {
        const r = await fullScans(async () => {
          out.held = await gates.inboxCheckHeldIds(firsts, now);
          out.picked = await gates.pickCandidates(now, { window: DEFAULT_WINDOW, defaultZone: "Europe/Berlin", practiceCopy: false, limit: 1 });
          await usage.countMailgunSendsSince(new Date(now.getTime() - 86_400_000), db, { exceptEmailId: rows[0]!.id });
        }, table);
        expect(r.statements, table).toBeGreaterThan(0);
        expect(r.scans, table).toEqual([]);
      }
      // Companies whose email went out (now live) got one before that day, so their first emails wait; the others don't.
      const emailed = new Set(rows.filter((x) => x.status === "SENT").map((x) => x.companyId));
      expect(emailed.size).toBeGreaterThan(0);
      expect([...(out.held ?? [])].sort((a, b) => a - b)).toEqual(rows.filter((x) => emailed.has(x.companyId)).map((x) => x.id));
      expect(out.held?.size).toBeLessThan(rows.length);
      expect(out.picked?.gated.length).toBeGreaterThanOrEqual(1);
    } finally {
      await setSettingValue("mailgun.replies", "app");
      await dbWrite(async (c) => {
        await c.campaign.update({ where: { id: campaignId }, data: { mode: "DRY_RUN", ignoreWindow: true } });
        await c.outboundEmail.updateMany({ where: { campaignId }, data: { mode: "DRY_RUN" } });
      });
    }
  });
});
