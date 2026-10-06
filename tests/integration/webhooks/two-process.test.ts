import { spawn } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { replyTo } from "../helpers/replies";
import { makeMember, makeOwner, seedEmail, type SeededEmail } from "../mail-events/seed";
import { enroll, makeCampaign, makeCompany, makePerson } from "../stops-holds/world";
import type { InboundFailures } from "@/server/services/replies/process";

/**
 * Two processes writing (PLAN B5.8, B12, M3-DESIGN §8 P4): about 200 signed webhooks go through the route handler in
 * this process while a worker child process runs the event lane, claims queued emails and a catch-up that reads the
 * very same events from the fake Mailgun's Logs, all on one temp database. Only 200 or 500 answers (500 = busy, which
 * Mailgun retries); no MailEvent lost or stored twice; no claim undone by a rollback.
 *
 * Milestone 4 (M4-DESIGN §3.8, §10 P6): stored replies are processed by the worker's event lane (here, this process)
 * while the web app (a child process, as "Simulate a reply" does) processes the very same rows: each reply is processed
 * exactly once (one activity, one set of notifications), no busy error reaches either caller, and every recipient
 * ends in the state the reply calls for.
 *
 * Milestone 5 (M5-DESIGN §9.1): the worker (a child process) stores address-check results through `commitCheckResult`
 * while the web app (this process) approves AI lines at the very same companies: every result stored once (with its
 * do-not-email entry where the address doesn't exist), every approval written once, no busy error reaching either side.
 */
const t = await createTestDb("two-process");
const mg = await connectFakeMailgun();
const { db } = await import("@/server/db");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { POST } = await import("@/app/api/webhooks/mailgun/events/route");
const { processPendingMailEvents } = await import("@/server/services/mail-events/process");
const { processInboundMessage, processPendingInbound, INBOUND_BATCH } = await import("@/server/services/replies/process");
const { normalizeWebhookEventData } = await import("@/core/mailgun/events");

const URL = "http://127.0.0.1:3000/api/webhooks/mailgun/events";
const EMAILS = 200;
const QUEUED = 40;
let ownerId: number;
const emails: SeededEmail[] = [];
const events: Array<Record<string, unknown>> = [];
const queuedIds: number[] = [];

beforeAll(async () => {
  ownerId = (await makeOwner()).id;
  const ctx = await getMailgunContext({ retryDelayMs: () => 0 });
  if (!ctx.connected) throw new Error(ctx.text);
  const first = await seedEmail({ createdById: ownerId, followUp: false });
  emails.push(first);
  for (let i = 1; i < EMAILS; i++) {
    // Half of them are UNKNOWN (the send's answer was lost): the events must prove them sent.
    emails.push(await seedEmail({ createdById: ownerId, campaignId: first.campaignId, followUp: false, status: i % 2 ? "UNKNOWN" : "SENT", providerId: null }));
  }
  for (const e of emails) {
    await ctx.sendClient.sendMessage(ctx.domain, {
      from: "Arslan <arslan@send.example.com>",
      to: e.toNorm,
      subject: "Hello",
      text: "Hi",
      html: "<p>Hi</p>",
      messageId: e.messageId,
      tags: ["outreach", "step-0"],
      variables: { send_id: e.sendId },
      purpose: "campaign",
      guard: { goLive: true, testList: new Set() },
      // A campaign launched after go-live: the client's guard lets it reach anyone (M6-DESIGN §2.3).
      testListOnly: false,
    });
    events.push(mg.fake.deliver(e.messageId));
  }
  const dry = await seedEmail({ createdById: ownerId, mode: "DRY_RUN", status: "QUEUED", followUp: false });
  queuedIds.push(dry.emailId);
  for (let i = 1; i < QUEUED; i++) {
    queuedIds.push((await seedEmail({ createdById: ownerId, mode: "DRY_RUN", status: "QUEUED", followUp: false, campaignId: dry.campaignId })).emailId);
  }
}, 120_000);

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

type ChildResult = { pid: number; claimed: number[]; processed: number; catchUps: number; errors: string[] };

function runChild(startAt: number, runFor: number): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join("tests", "integration", "webhooks", "two-process-child.ts"),
        String(startAt),
        String(runFor),
        queuedIds.join(","),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: t.url, OUTREACH_PROCESS: "worker" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("exit", (code) => {
      const line = out.split(/\r?\n/).find((l) => l.startsWith("{"));
      if (code !== 0 || !line) reject(new Error(`child exited ${code}\n${out}\n${err}`));
      else resolve(JSON.parse(line) as ChildResult);
    });
  });
}

/** Posts one webhook like Mailgun: a new signature each time, retried on anything but 200 and 406. */
async function deliverLikeMailgun(data: Record<string, unknown>, statuses: number[]): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await POST(mg.fake.signedEventRequest(URL, data));
    statuses.push(res.status);
    if (res.status === 200 || res.status === 406) return res.status;
    await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
  }
  return statuses[statuses.length - 1]!;
}

describe("two processes writing at once", () => {
  it("loses nothing, stores nothing twice and keeps every claim", async () => {
    const startAt = Date.now() + 3_000;
    const child = runChild(startAt, 6_000);
    while (Date.now() < startAt) await new Promise((r) => setTimeout(r, 2));

    const statuses: number[] = [];
    const finals: number[] = [];
    const queue = [...events];
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        for (let data = queue.shift(); data; data = queue.shift()) finals.push(await deliverLikeMailgun(data, statuses));
      }),
    );
    const result = await child;

    // Only 200 or 500 (busy, retried) answers; every webhook got through in the end.
    expect(new Set(statuses.filter((s) => s !== 200 && s !== 500))).toEqual(new Set());
    expect(finals).toHaveLength(EMAILS);
    expect(finals.every((s) => s === 200)).toBe(true);
    expect(result.catchUps).toBeGreaterThanOrEqual(1);
    // The child's event lane really worked alongside the webhooks.
    expect(result.processed).toBeGreaterThan(0);
    // Only contention (retried on the next round) may have gone wrong in the child, never anything else.
    expect(result.errors.filter((e) => !/busy|locked|timed out|timeout/i.test(e))).toEqual([]);

    // No MailEvent lost or stored twice: exactly one per webhook event, and one accepted event per email (Logs).
    const keys = events.map((e) => normalizeWebhookEventData(e)!.dedupeKey);
    expect(new Set(keys).size).toBe(EMAILS);
    expect(await db.mailEvent.count({ where: { dedupeKey: { in: keys } } })).toBe(EMAILS);
    const ids = emails.map((e) => e.emailId);
    expect(await db.mailEvent.count({ where: { outboundEmailId: { in: ids }, type: "delivered" } })).toBe(EMAILS);
    expect(await db.mailEvent.count({ where: { outboundEmailId: { in: ids }, type: "accepted" } })).toBe(EMAILS);

    // Proof of sending reached every email; every delivery was recorded once.
    await processPendingMailEvents({ limit: 1000 });
    expect(await db.outboundEmail.count({ where: { id: { in: ids }, status: "SENT", deliveredAt: { not: null } } })).toBe(EMAILS);
    expect(await db.mailEvent.count({ where: { processedAt: null } })).toBe(0);
    expect(await db.activityLog.count({ where: { type: "email.delivered", campaignId: emails[0]!.campaignId } })).toBe(EMAILS);
    expect(await db.activityLog.count({ where: { type: "email.sent", campaignId: emails[0]!.campaignId } })).toBe(EMAILS / 2);

    // Every claim the child made is still there (no rollback in this process undid it).
    expect(result.claimed.sort((a, b) => a - b)).toEqual([...queuedIds].sort((a, b) => a - b));
    expect(await db.outboundEmail.count({ where: { id: { in: queuedIds }, status: "SENDING", claimedAt: { not: null }, attempts: 1 } })).toBe(QUEUED);
  }, 180_000);
});

type ReplyChildResult = { pid: number; won: number[]; alreadyDone: number; errors: string[]; startedAt: number; finishedAt: number };

function runReplyChild(startAt: number, warmUpId: number, ids: readonly number[]): Promise<ReplyChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join("tests", "integration", "webhooks", "two-process-replies-child.ts"),
        String(startAt),
        String(warmUpId),
        ids.join(","),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: t.url, OUTREACH_PROCESS: "web" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("exit", (code) => {
      const line = out.split(/\r?\n/).find((l) => l.startsWith("{"));
      if (code !== 0 || !line) reject(new Error(`child exited ${code}\n${out}\n${err}`));
      else resolve(JSON.parse(line) as ReplyChildResult);
    });
  });
}

describe("two processes processing the same replies (Milestone 4)", () => {
  const COMPANIES = 60;
  /** Per company: the reply's id, Anna's (who replied) and Ben's (her colleague) recipient and queued follow-up. */
  const seeded: Array<{ companyId: number; replyId: number; anna: { recipientId: number; queuedId: number }; ben: { recipientId: number; queuedId: number } }> = [];
  /** One reply each process handles before the start line (so both race at full speed). */
  const warmUp: number[] = [];
  let aliId = 0;

  beforeAll(async () => {
    aliId = (await makeMember("Ali", "ali@polygonparadise.test")).id;
    const campaign = await makeCampaign({ createdById: ownerId, senderId: aliId, mode: "LIVE" });
    for (const i of [1, 2]) {
      const company = await makeCompany(`Warm-up ${i}`, { domain: `warm${i}.de` });
      const person = await enroll(campaign, await makePerson(company.id, `anna@warm${i}.de`, "Anna Warm"));
      warmUp.push((await replyTo(mg.fake, person.sentIds[0]!, { text: "Warming up." })).id!);
    }
    for (let i = 0; i < COMPANIES; i++) {
      const company = await makeCompany(`Studio R${i}`, { domain: `r${i}.de` });
      const anna = await enroll(campaign, await makePerson(company.id, `anna@r${i}.de`, "Anna Berg"));
      const ben = await enroll(campaign, await makePerson(company.id, `ben@r${i}.de`, "Ben Braun"));
      // Anna answers the first email; the notify POST goes through the signed inbound webhook and is only stored.
      const posted = await replyTo(mg.fake, anna.sentIds[0]!, { text: `Yes please, send prices (${i}).` });
      expect(posted.status).toBe(200);
      seeded.push({
        companyId: company.id,
        replyId: posted.id!,
        anna: { recipientId: anna.recipientId, queuedId: anna.queuedId! },
        ben: { recipientId: ben.recipientId, queuedId: ben.queuedId! },
      });
    }
    expect(await db.inboundMessage.count({ where: { id: { in: seeded.map((s) => s.replyId) }, processedAt: null } })).toBe(COMPANIES);
  }, 120_000);

  it("processes each reply exactly once, with no busy error reaching the lane or the web app", async () => {
    const ids = seeded.map((s) => s.replyId);
    const startAt = Date.now() + 4_000;
    const child = runReplyChild(startAt, warmUp[0]!, ids);
    await processInboundMessage(warmUp[1]!);
    while (Date.now() < startAt) await new Promise((r) => setTimeout(r, 2));

    // This process is the worker's event lane (oldest first, 20 per round, its own back-off map) until none are left,
    // while the web app works through the same rows newest first.
    const failures: InboundFailures = new Map();
    const laneErrors: string[] = [];
    let laneFailed = 0;
    const laneStartedAt = Date.now();
    const deadline = laneStartedAt + 60_000;
    while (Date.now() < deadline) {
      const r = await processPendingInbound({
        now: new Date(),
        limit: INBOUND_BATCH,
        failures,
        logger: { error: (m, e) => laneErrors.push(`${m}: ${e instanceof Error ? e.message : String(e)}`) },
      });
      laneFailed += r.failed;
      if ((await db.inboundMessage.count({ where: { id: { in: ids }, processedAt: null } })) === 0) break;
      if (r.processed === 0) await new Promise((res) => setTimeout(res, 20));
    }
    const laneFinishedAt = Date.now();
    const result = await child;

    // Nothing failed on either side (no busy error reached either caller), and the two really ran at the same time
    // over the same rows: the web app tried every one of them, and processed those the lane hadn't yet.
    expect(result.errors).toEqual([]);
    expect(laneErrors).toEqual([]);
    expect(laneFailed).toBe(0);
    expect(failures.size).toBe(0);
    expect(result.won.length + result.alreadyDone).toBe(COMPANIES);
    expect(result.startedAt).toBeLessThan(laneFinishedAt);
    expect(laneStartedAt).toBeLessThan(result.finishedAt);

    // Each reply processed once: one timeline entry and one set of notifications (Ali, the sender; the Owner, because
    // the reply reached the catch-all), whichever process won it.
    const replies = await db.inboundMessage.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } });
    expect(replies.every((r) => r.processedAt !== null && r.kind === "REPLY" && r.replyScope === "real")).toBe(true);
    const activity = await db.activityLog.findMany({ where: { type: "reply.received" }, select: { data: true } });
    const logged = activity.map((a) => (a.data as { inboundId?: number }).inboundId).filter((id): id is number => typeof id === "number" && ids.includes(id));
    expect(logged.sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));
    for (const id of ids) {
      const notes = await db.notification.findMany({ where: { link: `/notifications?reply=${id}#replies` }, select: { userId: true, type: true } });
      expect(notes.map((n) => [n.userId, n.type]).sort()).toEqual([
        [ownerId, "reply.received"],
        [aliId, "reply.received"],
      ].sort());
    }

    // Every company stopped once, consistently: Anna replied, Ben's follow-up stopped because someone there replied.
    for (const s of seeded) {
      const [anna, ben] = await Promise.all(
        [s.anna.recipientId, s.ben.recipientId].map((id) =>
          db.campaignRecipient.findUniqueOrThrow({ where: { id }, select: { state: true, stopReason: true, stoppedByInboundId: true } }),
        ),
      );
      expect(anna).toEqual({ state: "STOPPED", stopReason: "replied", stoppedByInboundId: s.replyId });
      expect(ben).toEqual({ state: "STOPPED", stopReason: "company_replied", stoppedByInboundId: s.replyId });
      const queued = await db.outboundEmail.findMany({ where: { id: { in: [s.anna.queuedId, s.ben.queuedId] } }, select: { status: true } });
      expect(queued.map((q) => q.status)).toEqual(["SKIPPED", "SKIPPED"]);
    }
  }, 180_000);
});

type ChecksChildResult = { pid: number; stored: number[]; errors: string[]; startedAt: number; finishedAt: number };

function runChecksChild(startAt: number, warmUpId: number, ids: readonly number[]): Promise<ChecksChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join("tests", "integration", "webhooks", "two-process-checks-child.ts"), String(startAt), String(warmUpId), ids.join(",")],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: t.url, OUTREACH_PROCESS: "worker" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("exit", (code) => {
      const line = out.split(/\r?\n/).find((l) => l.startsWith("{"));
      if (code !== 0 || !line) reject(new Error(`child exited ${code}\n${out}\n${err}`));
      else resolve(JSON.parse(line) as ChecksChildResult);
    });
  });
}

describe("a check commit in the worker while the web app approves AI lines (Milestone 5)", () => {
  const COMPANIES = 60;
  const seeded: Array<{ companyId: number; personId: number; draftId: number; line: string; invalid: boolean }> = [];
  let warmUpPersonId = 0;
  let warmUpDraftId = 0;
  let reviewer: { id: number; name: string; role: "OWNER" | "MEMBER" };

  beforeAll(async () => {
    const owner = await db.user.findUniqueOrThrow({ where: { id: ownerId } });
    reviewer = { id: owner.id, name: owner.name, role: "OWNER" };
    const { dbWrite } = await import("@/server/db");
    const draftAt = async (companyId: number, line: string) =>
      (
        await dbWrite((c) =>
          c.aiDraft.create({
            data: {
              companyId,
              model: "claude-haiku-4-5-20251001",
              promptVersion: "pl-2026-09-26",
              status: "READY",
              line,
              evidenceQuote: "hand-painted miniatures for tabletop games",
              evidenceSource: "homepage",
              calls: 1,
              costUsd: 0.0036,
              draftedAt: new Date(),
            },
          }),
        )
      ).id;
    const warm = await makeCompany("Check warm-up", { domain: "check-warm.de" });
    warmUpPersonId = (await makePerson(warm.id, "anna@check-warm.de", "Anna Warm")).id;
    warmUpDraftId = await draftAt(warm.id, "Your studio paints miniatures for tabletop games by hand.");
    for (let i = 0; i < COMPANIES; i++) {
      const company = await makeCompany(`Check Studio ${i}`, { domain: `check${i}.de` });
      const person = await makePerson(company.id, `anna@check${i}.de`, "Anna Berg");
      const line = `Your studio paints miniature number ${i} for tabletop games by hand.`;
      seeded.push({ companyId: company.id, personId: person.id, draftId: await draftAt(company.id, line), line, invalid: i % 5 === 4 });
    }
  }, 120_000);

  it("stores every result once and writes every approval once, with no busy error on either side", async () => {
    const { approveDraft } = await import("@/server/services/ai/review");
    const startAt = Date.now() + 4_000;
    const child = runChecksChild(
      startAt,
      warmUpPersonId,
      seeded.map((s) => s.personId),
    );
    await approveDraft(reviewer, warmUpDraftId);
    while (Date.now() < startAt) await new Promise((r) => setTimeout(r, 2));

    // This process is the web app: the reviewer approves one line after another, as fast as the queue allows.
    const webErrors: string[] = [];
    const webStartedAt = Date.now();
    for (const s of seeded) {
      try {
        await approveDraft(reviewer, s.draftId);
      } catch (err) {
        webErrors.push(`draft ${s.draftId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const webFinishedAt = Date.now();
    const result = await child;

    expect(result.errors).toEqual([]);
    expect(webErrors).toEqual([]);
    // The two really ran side by side.
    expect(result.startedAt).toBeLessThan(webFinishedAt);
    expect(webStartedAt).toBeLessThan(result.finishedAt);
    expect(result.stored.sort((a, b) => a - b)).toEqual(seeded.map((s) => s.personId).sort((a, b) => a - b));

    // One check row per person, and the person carries its verdict; the "doesn't exist" ones are on the do-not-email list.
    const personIds = seeded.map((s) => s.personId);
    const rows = await db.verificationCheck.findMany({ where: { personId: { in: personIds } }, select: { personId: true, status: true } });
    expect(rows).toHaveLength(COMPANIES);
    const people = new Map((await db.person.findMany({ where: { id: { in: personIds } } })).map((p) => [p.id, p]));
    for (const s of seeded) {
      expect(people.get(s.personId)).toMatchObject({ verificationStatus: s.invalid ? "INVALID" : "VALID", verificationProvider: "mailgun-fake" });
    }
    const invalidEmails = seeded.filter((s) => s.invalid).map((s) => people.get(s.personId)!.emailNorm!);
    const sups = await db.suppression.findMany({ where: { emailNorm: { in: invalidEmails } }, select: { emailNorm: true, reason: true } });
    expect(sups.map((x) => x.reason)).toEqual(Array(invalidEmails.length).fill("INVALID"));

    // Every approval written once: the company's line comes from AI, one activity each.
    const drafts = await db.aiDraft.findMany({ where: { id: { in: seeded.map((s) => s.draftId) } }, select: { status: true } });
    expect(drafts.every((d) => d.status === "APPROVED")).toBe(true);
    const companies = new Map((await db.company.findMany({ where: { id: { in: seeded.map((s) => s.companyId) } } })).map((c) => [c.id, c]));
    for (const s of seeded) expect(companies.get(s.companyId)).toMatchObject({ personalLine: s.line, personalLineSource: "ai" });
    expect(await db.activityLog.count({ where: { type: "company.personalLine", companyId: { in: seeded.map((s) => s.companyId) } } })).toBe(COMPANIES);
  }, 180_000);
});
