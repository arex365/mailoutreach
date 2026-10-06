import fs from "node:fs";
import path from "node:path";
import type { AiDeps, AiLogger } from "@/server/ai/run";
import type { AiActor } from "@/server/services/ai/review";
import type { FixtureTransport, WebsiteReader } from "@/server/web";

/**
 * Helpers for the drafting job's integration tests (docs/dev/M5-DESIGN.md §8 P8). Every function imports the server
 * modules when it runs, so a test file can import this before `createTestDb()` pointed DATABASE_URL at its database.
 * Nothing here reaches the network: websites come from the fixture sites, Claude is the fake server or a stub.
 */

export const SITES = path.resolve("tests/fixtures/sites");

/** Fixture origins (tests/fixtures/sites/<folder>/site.json). */
export const ORIGIN = {
  deFiguren: "https://www.figuren-werkstatt.example",
  noButikk: "https://butikk.example",
  shopGrid: "https://www.gridshop.example",
  jsOnly: "https://js-only.example",
  jsMeta: "https://js-meta.example",
  parked: "https://parked-domain.example",
  blocked: "https://blocked.example",
  injection: "https://injection.example",
  hiddenText: "https://hidden-text.example",
  cookieBanner: "https://cookie-banner.example",
  latin1: "https://latin1.example",
} as const;

/** A site's claude.json answer (the fake Claude's answer for it). */
export function claudeAnswerOf(folder: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(SITES, folder, "claude.json"), "utf8")) as Record<string, unknown>;
}

export type TestUser = AiActor;

/** The Owner (Arslan) and a Member (Ali), both in Europe/Berlin. */
export async function seedUsers(): Promise<{ owner: TestUser; ali: TestUser }> {
  const { dbWrite } = await import("@/server/db");
  const make = (email: string, name: string, role: "OWNER" | "MEMBER") =>
    dbWrite((c) => c.user.create({ data: { email, name, role, timeZone: "Europe/Berlin" }, select: { id: true, name: true, role: true } }));
  return { owner: await make("arslan@example.com", "Arslan", "OWNER"), ali: await make("ali@example.com", "Ali", "MEMBER") };
}

let companySeq = 0;

/** A company with a website (or an Instagram handle only). */
export async function makeCompany(input: { name?: string; website?: string | null; instagram?: string | null; country?: string | null; niche?: string | null }): Promise<number> {
  const { dbWrite } = await import("@/server/db");
  const { parseWebsite } = await import("@/core/shared-domains");
  const name = input.name ?? `Company ${++companySeq}`;
  const site = input.website ? parseWebsite(input.website) : null;
  const row = await dbWrite((c) =>
    c.company.create({
      data: {
        name,
        nameNorm: name.toLowerCase(),
        website: site?.url ?? input.website ?? null,
        domain: site?.domain ?? null,
        instagram: input.instagram ?? null,
        country: input.country ?? null,
        niche: input.niche ?? null,
      },
      select: { id: true },
    }),
  );
  return row.id;
}

/** A reader over the fixture sites with no waiting between requests (a fixed clock would never end the 2 s gap). */
export async function fixtureReader(): Promise<{ reader: WebsiteReader; transport: FixtureTransport }> {
  const { createReader, fixtureTransport, immediatePoliteness, memoryRobotsStore } = await import("@/server/web");
  const transport = fixtureTransport(SITES);
  return { transport, reader: createReader({ transport, politeness: immediatePoliteness, robotsStore: memoryRobotsStore() }) };
}

/** A logger that keeps the lines (tests assert on them) and never prints. */
export function memoryLogger(onWarn?: (m: string) => void): AiLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => lines.push(`info ${m}`),
    warn: (m) => {
      lines.push(`warn ${m}`);
      onWarn?.(m);
    },
    error: (m, err) => lines.push(`error ${m}${err === undefined ? "" : `: ${err instanceof Error ? err.message : String(err)}`}`),
  };
}

const quietRunnerLog = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Claims the next due `ai.draftLines` job (the `ai` lane, due at `now`) and runs it through the real runner with the
 * drafting job built from `deps`. Throws when no AI job is due.
 */
export async function runAiJob(
  deps: Partial<AiDeps>,
  opts: { now?: Date; signal?: AbortSignal } = {},
): Promise<Awaited<ReturnType<typeof import("../../../worker/runner").runClaimedJob>> & { jobId: number }> {
  const { claimNextJob, runClaimedJob, WORKER_LANES } = await import("../../../worker/runner");
  const { createAiDraftLinesJob } = await import("@/server/ai/run");
  const job = await claimNextJob("test-worker", opts.now ?? new Date(), WORKER_LANES.ai);
  if (!job) throw new Error("No ai.draftLines job is due.");
  const res = await runClaimedJob(job, {
    workerId: "test-worker",
    registry: { "ai.draftLines": createAiDraftLinesJob(deps) },
    signal: opts.signal ?? new AbortController().signal,
    logger: quietRunnerLog,
    lane: WORKER_LANES.ai,
  });
  return { ...res, jobId: job.id };
}

/** Runs the due AI jobs until none is due (deferrals to "now" included), at most `max` handler runs. */
export async function runAiJobsUntilIdle(deps: Partial<AiDeps>, max = 20): Promise<number> {
  const { db } = await import("@/server/db");
  let n = 0;
  while (n < max) {
    const due = await db.job.findFirst({ where: { type: "ai.draftLines", status: "QUEUED", runAt: { lte: new Date() } }, select: { id: true } });
    if (!due) break;
    await runAiJob(deps);
    n++;
  }
  return n;
}

/** Test isolation: cancels every queued or running job, lifts the AI pause and restores the AI settings. */
export async function resetAiState(owner: TestUser): Promise<void> {
  const { dbWrite } = await import("@/server/db");
  const { resumeAi } = await import("@/server/services/ai/pause");
  const { SETTING_DEFAULTS, setSetting } = await import("@/server/settings");
  await dbWrite((c) =>
    c.job.updateMany({ where: { status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED", activeDedupeKey: null, finishedAt: new Date() } }),
  );
  await resumeAi(owner);
  await setSetting("ai.model", SETTING_DEFAULTS["ai.model"], owner.id);
  await setSetting("ai.customModel", null, owner.id);
  await setSetting("ai.prices", structuredClone(SETTING_DEFAULTS["ai.prices"]), owner.id);
  await setSetting("ai.monthlyLimitUsd", SETTING_DEFAULTS["ai.monthlyLimitUsd"], owner.id);
  await setSetting("practice.copy", false, owner.id);
}

/** Starts a Contacts run for these companies (as the given person), with the server's own estimate. */
export async function startRun(
  actor: TestUser,
  companyIds: number[],
  opts: { source?: "contacts" | "list" | "panel"; confirmedAtMostUsd?: number; redraft?: boolean } = {},
): Promise<number> {
  const { startDraftRun } = await import("@/server/services/ai/start");
  const res = await startDraftRun(
    actor,
    opts.source === "panel" ? { companyId: companyIds[0]! } : { companyIds },
    { redraft: opts.redraft ?? false, source: opts.source ?? "contacts", confirmedAtMostUsd: opts.confirmedAtMostUsd },
  );
  return res.jobId;
}

/** The run's drafts by company id. */
export async function draftsOf(jobId: number) {
  const { db } = await import("@/server/db");
  const rows = await db.aiDraft.findMany({ where: { jobId }, orderBy: { id: "asc" } });
  return new Map(rows.map((r) => [r.companyId, r]));
}

/** A promise with its resolve function (to hold a stub call open). */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

/** Waits (real time, short polls) until `check` is true, or throws after `ms`. */
export async function waitUntil(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitUntil timed out");
}
