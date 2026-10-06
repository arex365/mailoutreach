import type { Prisma } from "@/generated/prisma/client";
import { aiTokenKey, DRAFT_PROMPT_VERSION, perCallMaxUsd } from "@/core/ai/estimate";
import { normalizeForMatch } from "@/core/ai/normalize";
import {
  IN_PROGRESS_STATUSES,
  resolveProfile,
  SKIP_CODES,
  SNAPSHOT_REUSE_DAYS,
  type CallRecord,
  type ClaimedDraft,
  type DraftFlag,
  type DraftFlagCode,
  type DraftOutcome,
  type ReadPageLike,
  type SkipCode,
  type SnapshotPage,
} from "@/core/ai/types";
import { countryName } from "@/core/geo/display";
import { roundUsd } from "@/core/money";
import { usableCompanyDomain } from "@/core/rules/team-rule";
import { parseAiTokens } from "@/core/system-state-parse";
import { STATE_KEYS } from "@/core/system-state";
import { monthBounds } from "@/core/time/month";
import { db, dbTx, dbWrite, pauseForOtherWriters } from "@/server/db";
import { getSettings } from "@/server/settings";
import { readTyped } from "@/server/state-typed";
import { companySite, extraSharedDomains } from "./select";

/**
 * The writers the drafting job (P8, `ai.draftLines`) uses on AiDraft and WebsiteSnapshot rows (docs/dev/M5-DESIGN.md
 * §3.3, §3.4.9, §3.7, §3.8), plus the spend sums its spend guard reads.
 *
 * Rules kept here:
 *  - A draft moves QUEUED → FETCHING (claim) → DRAFTING → READY / NO_LINE / FAILED, or back to QUEUED. Every one of
 *    those moves is a compare-and-set on `{id, jobId, status}` and reports whether it won; the loser drops its result.
 *  - Money is written only by `recordCall` (one short transaction right after every Claude call, never a
 *    compare-and-set on the status: money spent is recorded whatever the draft's state), and nothing ever lowers it:
 *    requeues, restarts and stops keep `inputTokens`, `outputTokens`, `costUsd`, `calls` and `draftedAt`; a stop deletes
 *    only drafts that never made a call (§0.2 rule 7, D42).
 *  - Spend is counted by `draftedAt` (when the last call ended) in the office month (Setting "sending.capDayTimeZone").
 *  - While a Claude call is out, the draft's `stopReason` holds that call's reserved ceiling ("in-flight:0.011442",
 *    markCallInFlight) until recordCall writes the call's own stop reason; a draft a stopped worker left in DRAFTING is
 *    charged exactly that (M5 review AI-7). No schema column exists for it; `stopReason` is only ever shown as the
 *    last call's stop reason once recordCall has run.
 *  - `readAttempts` counts reads that never finished: a claim adds one, a read that finishes (markDrafting) or a claim
 *    put back without a finished read (requeueDraft from FETCHING: shutdown, a pause) takes it back. So only reads a
 *    crash or a restart interrupted stay counted, and two of them fail the draft (M5 review DATA-05).
 * No network call happens here, and every transaction is short (≤ 500 rows).
 */

/** FAILED text: the draft's page kept the worker from finishing twice in a row (§3.4.9). */
export const UNSAFE_SITE_TEXT = "This website couldn't be read safely.";
/** FAILED text: the run stopped (Stop or its cost cap) after this draft was paid for (§3.9). */
export const STOPPED_TEXT = "Stopped before a line was finished.";
/** FAILED text: the draft's run ended without it (failed, finished, cancelled or deleted, §3.9). */
export const ORPHAN_TEXT = "Claude couldn't be reached. Click Try again.";
/** The cost-estimated flag of a call that never answered (§3.7). */
export const COST_ESTIMATED_TIMEOUT_TEXT = "Part of this draft's cost is an estimate: Claude didn't answer in time.";
/** The cost-estimated flag of a call that may have been billed while the app stopped (§3.8, resetStuckDrafts). */
export const COST_ESTIMATED_RESTART_TEXT = "Part of this draft's cost is an estimate: the app stopped while Claude was writing.";

/** A draft whose read was interrupted (found stuck in FETCHING) this many times is failed instead of read again (§3.4.9 "Poison pages"). */
export const MAX_READ_ATTEMPTS = 2;
/** `stopReason` while a Claude call is out: this prefix and the call's reserved ceiling in dollars. */
export const IN_FLIGHT_PREFIX = "in-flight:";
/** A recent skip is reused this long (no hammering of a failing site, §3.4.9). */
export const SKIP_REUSE_MS = 24 * 3_600_000;
/** Other companies' approved lines that a new line must not repeat (§3.6 "Not a repeat"). */
export const AVOID_OTHERS_MAX = 500;

const CHUNK = 500;
const DAY_MS = 86_400_000;
const WORKING: readonly ("FETCHING" | "DRAFTING")[] = ["FETCHING", "DRAFTING"];
const PAGE_NOTES = ["metadata-only", "hidden-text"] as const;

// ───────────────────────── small readers ─────────────────────────

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const FLAG_CODES: ReadonlySet<string> = new Set<DraftFlagCode>([
  "quote-not-found",
  "approximate-quote",
  "quote-other-page",
  "quote-size",
  "number-not-found",
  "name-not-found",
  "too-long",
  "too-short",
  "not-one-sentence",
  "plain-characters",
  "banned-word",
  "link",
  "repeat",
  "injection-hint",
  "hidden-text",
  "metadata-only",
  "second-page-failed",
  "cost-estimated",
  "practice",
  "generic-line",
]);

/** A stored `flags` JSON as DraftFlag[] (entries of an unknown shape are dropped). */
export function parseDraftFlags(v: unknown): DraftFlag[] {
  if (!Array.isArray(v)) return [];
  const out: DraftFlag[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") continue;
    const { code, text } = x as { code?: unknown; text?: unknown };
    if (typeof code === "string" && FLAG_CODES.has(code) && typeof text === "string") out.push({ code: code as DraftFlagCode, text });
  }
  return out;
}

/** A stored JSON array of strings (e.g. `avoidLines`); anything else reads as []. */
export function parseStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function parsePageNotes(v: unknown): Array<"metadata-only" | "hidden-text"> {
  return parseStringList(v).filter((x): x is "metadata-only" | "hidden-text" => (PAGE_NOTES as readonly string[]).includes(x));
}

/** `flags` plus a stored cost-estimated flag that isn't in them (an estimated cost stays flagged whatever happens next). */
function keepCostFlag(stored: unknown, flags: readonly DraftFlag[]): DraftFlag[] {
  const out = [...flags];
  if (!out.some((f) => f.code === "cost-estimated")) {
    const kept = parseDraftFlags(stored).find((f) => f.code === "cost-estimated");
    if (kept) out.push(kept);
  }
  return out;
}

function withCostFlag(stored: unknown, text: string): DraftFlag[] {
  const flags = parseDraftFlags(stored);
  return flags.some((f) => f.code === "cost-estimated") ? flags : [...flags, { code: "cost-estimated", text }];
}

/**
 * The measured system-prompt tokens of `model` for a prompt version (SystemState "ai.tokens", written by the job with
 * the free countTokens, §3.5.4), else the profile's default.
 */
export async function systemTokensFor(model: string, promptVersion: string = DRAFT_PROMPT_VERSION): Promise<number> {
  const { value } = await readTyped(STATE_KEYS.aiTokens, parseAiTokens);
  const measured = value.entries[aiTokenKey(model, promptVersion)]?.systemTokens;
  if (typeof measured === "number") return measured;
  const s = await getSettings(["ai.customModel", "ai.prices"] as const);
  return resolveProfile(model, s["ai.customModel"], s["ai.prices"]).defaultSystemTokens;
}

// ───────────────────────── restart ─────────────────────────

/**
 * Just before a Claude call (after the spend guard reserved it): the draft's `stopReason` says a call is out and what
 * it may cost ("in-flight:0.011442"), until recordCall writes the call's own stop reason. One short write, no
 * compare-and-set on the status (like recordCall). A draft a stopped worker left in DRAFTING is then charged exactly
 * the reserved ceiling (a retry at the doubled `max_tokens`, a regeneration with its longer message), never less
 * (§3.8, M5 review AI-7).
 */
export async function markCallInFlight(draftId: number, ceilingUsd: number): Promise<void> {
  // Rounded up to the micro-dollar (never below the reservation; the epsilon keeps 0.0054 at 0.0054).
  const ceiling = Number.isFinite(ceilingUsd) && ceilingUsd > 0 ? Math.ceil(ceilingUsd * 1e6 - 1e-6) / 1e6 : 0;
  await dbWrite((c) => c.aiDraft.updateMany({ where: { id: draftId }, data: { stopReason: `${IN_FLIGHT_PREFIX}${ceiling}` } }));
}

/**
 * A call that ended without anything to record (a 5xx, 529, connection error or rate limit: not billed): the
 * in-flight note is removed, so a later restart doesn't charge it. Anything else in `stopReason` is left alone.
 */
export async function clearCallInFlight(draftId: number): Promise<void> {
  await dbWrite((c) =>
    c.aiDraft.updateMany({ where: { id: draftId, stopReason: { startsWith: IN_FLIGHT_PREFIX } }, data: { stopReason: null } }),
  );
}

/** The reserved ceiling of a call that was out (markCallInFlight), or null when the draft's stopReason isn't one. */
export function inFlightCeiling(stopReason: string | null | undefined): number | null {
  if (typeof stopReason !== "string" || !stopReason.startsWith(IN_FLIGHT_PREFIX)) return null;
  const v = Number(stopReason.slice(IN_FLIGHT_PREFIX.length));
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * One Claude call's ceiling per "<model>|<promptVersion>" (rounded dollars; 0 for a model without a price, such as the
 * practice drafter's "practice": no call can have been billed there). Settings and measured tokens are read once. Used
 * for a draft found in DRAFTING without an in-flight note (none was out, or it was left by an older version).
 */
async function ceilingReader(): Promise<(model: string, promptVersion: string) => Promise<number>> {
  const s = await getSettings(["ai.customModel", "ai.prices"] as const);
  const cache = new Map<string, number>();
  return async (model, promptVersion) => {
    const key = aiTokenKey(model, promptVersion);
    let ceiling = cache.get(key);
    if (ceiling === undefined) {
      const profile = resolveProfile(model, s["ai.customModel"], s["ai.prices"]);
      ceiling = profile.prices ? roundUsd(perCallMaxUsd(profile, await systemTokensFor(model, promptVersion))) : 0;
      cache.set(key, ceiling);
    }
    return ceiling;
  };
}

/**
 * The fields that charge a draft found in DRAFTING one call's ceiling: the app stopped while a call may have been
 * billed. `calls + 1`, the cost, `draftedAt`, the cost-estimated flag, and the in-flight note cleared. This can
 * overstate by one call; it never understates (§3.8).
 */
function ceilingCharge(row: { costUsd: number | null; flags: unknown }, ceiling: number, now: Date) {
  return {
    calls: { increment: 1 },
    costUsd: roundUsd((row.costUsd ?? 0) + ceiling),
    draftedAt: now,
    stopReason: null,
    flags: withCostFlag(row.flags, COST_ESTIMATED_RESTART_TEXT) as unknown as Prisma.InputJsonValue,
  };
}

/**
 * What a draft found in DRAFTING is charged: the reserved ceiling of the call that was out (markCallInFlight), else
 * one call's ceiling at the page cap (0 without a price).
 */
async function stuckCeiling(
  d: { model: string; promptVersion: string; stopReason: string | null },
  ceilingOf: (model: string, promptVersion: string) => Promise<number>,
): Promise<number> {
  return inFlightCeiling(d.stopReason) ?? (await ceilingOf(d.model, d.promptVersion));
}

/**
 * At the start of every handler run (after a crash, a restart or a lost lease), and before a stopped queued run's
 * drafts are taken off the list: the job's drafts left in the middle.
 *  - FETCHING → QUEUED, or FAILED "This website couldn't be read safely." once MAX_READ_ATTEMPTS of its reads were
 *    interrupted like this (a page that crashes the worker is never read a third time); the interrupted read stays
 *    counted;
 *  - DRAFTING → QUEUED with the call that was out charged at its reserved ceiling (ceilingCharge, stuckCeiling).
 * Returns how many drafts changed.
 */
export async function resetStuckDrafts(jobId: number, now: Date): Promise<number> {
  const stuck = await db.aiDraft.findMany({
    where: { jobId, status: { in: [...WORKING] } },
    select: { id: true, status: true, readAttempts: true, model: true, promptVersion: true, stopReason: true },
    orderBy: { id: "asc" },
  });
  if (stuck.length === 0) return 0;
  const ceilingOf = await ceilingReader();
  const ceilings = new Map<number, number>();
  for (const d of stuck) if (d.status === "DRAFTING") ceilings.set(d.id, await stuckCeiling(d, ceilingOf));

  let changed = 0;
  for (const part of chunks(stuck)) {
    changed += await dbTx(async (tx) => {
      let n = 0;
      for (const d of part) {
        if (d.status === "FETCHING") {
          const failed = d.readAttempts >= MAX_READ_ATTEMPTS;
          const res = await tx.aiDraft.updateMany({
            where: { id: d.id, jobId, status: "FETCHING" },
            data: failed ? { status: "FAILED", error: UNSAFE_SITE_TEXT } : { status: "QUEUED" },
          });
          n += res.count;
          continue;
        }
        const ceiling = ceilings.get(d.id) ?? 0;
        const row = await tx.aiDraft.findFirst({ where: { id: d.id, jobId, status: "DRAFTING" }, select: { costUsd: true, flags: true } });
        if (!row) continue;
        const res = await tx.aiDraft.updateMany({
          where: { id: d.id, jobId, status: "DRAFTING" },
          data: ceiling > 0 ? { status: "QUEUED", ...ceilingCharge(row, ceiling, now) } : { status: "QUEUED" },
        });
        n += res.count;
      }
      return n;
    });
  }
  return changed;
}

// ───────────────────────── claim and transitions ─────────────────────────

/** Candidates looked at per round while picking drafts with distinct hosts. */
const CLAIM_SCAN = 200;

/**
 * Claims up to `max` QUEUED drafts of the run, oldest first, on distinct hosts that aren't in `busyHosts` (the job's
 * companies in flight): compare-and-set QUEUED → FETCHING, `readAttempts + 1` (taken back when the read finishes, see
 * markDrafting and requeueDraft), `model` = the model actually used (the
 * current setting at claim time, §3.3). A company without a readable website gets a host of its own
 * ("#company-<id>"), so it never blocks another. The company is read as it is now (deleted or not: the job decides).
 */
export async function claimQueuedDrafts(
  jobId: number,
  max: number,
  busyHosts: ReadonlySet<string>,
  model: string,
): Promise<ClaimedDraft[]> {
  const want = Math.max(0, Math.floor(max));
  if (want === 0) return [];
  const extra = await extraSharedDomains();
  const picked: Array<Omit<ClaimedDraft, "model">> = [];
  const hosts = new Set(busyHosts);
  let afterId = 0;
  for (;;) {
    const batch = await db.aiDraft.findMany({
      where: { jobId, status: "QUEUED", id: { gt: afterId } },
      orderBy: { id: "asc" },
      take: CLAIM_SCAN,
      select: { id: true, companyId: true, refetch: true, avoidLines: true, readAttempts: true },
    });
    if (batch.length === 0) break;
    afterId = batch[batch.length - 1]!.id;
    const companies = new Map(
      (
        await db.company.findMany({
          where: { id: { in: [...new Set(batch.map((d) => d.companyId))] } },
          select: { id: true, name: true, website: true, instagram: true, country: true, niche: true, domain: true },
        })
      ).map((c) => [c.id, c]),
    );
    for (const d of batch) {
      const c = companies.get(d.companyId);
      const site = c ? companySite(c, extra) : null;
      const host = site?.kind === "site" ? site.host : `#company-${d.companyId}`;
      if (hosts.has(host)) continue;
      hosts.add(host);
      picked.push({
        id: d.id,
        companyId: d.companyId,
        companyName: c?.name ?? "",
        website: c?.website?.trim() ?? "",
        host,
        countryName: c?.country ? countryName(c.country) || null : null,
        niche: c?.niche?.trim() || null,
        companyDomain: usableCompanyDomain(c?.domain, extra),
        refetch: d.refetch,
        avoidLines: parseStringList(d.avoidLines),
        readAttempts: d.readAttempts,
      });
      if (picked.length >= want) break;
    }
    if (picked.length >= want || batch.length < CLAIM_SCAN) break;
  }
  if (picked.length === 0) return [];

  const won = await dbTx(async (tx) => {
    const ids: number[] = [];
    for (const p of picked) {
      const res = await tx.aiDraft.updateMany({
        where: { id: p.id, jobId, status: "QUEUED" },
        data: { status: "FETCHING", readAttempts: { increment: 1 }, model },
      });
      if (res.count === 1) ids.push(p.id);
    }
    return new Set(ids);
  });
  return picked.filter((p) => won.has(p.id)).map((p) => ({ ...p, readAttempts: p.readAttempts + 1, model }));
}

/**
 * A working draft moved on (compare-and-set on `{id, jobId, status IN (FETCHING, DRAFTING)}`; false = another attempt
 * took it). Leaving FETCHING normally takes back the claim's read attempt: the read finished, or never started, and
 * didn't crash the worker (M5 review DATA-05).
 */
async function moveWorkingDraft(draftId: number, jobId: number, status: "DRAFTING" | "QUEUED"): Promise<boolean> {
  return dbTx(async (tx) => {
    const row = await tx.aiDraft.findFirst({
      where: { id: draftId, jobId, status: { in: [...WORKING] } },
      select: { status: true, readAttempts: true },
    });
    if (!row) return false;
    const res = await tx.aiDraft.updateMany({
      where: { id: draftId, jobId, status: row.status },
      data: { status, ...(row.status === "FETCHING" ? { readAttempts: Math.max(0, row.readAttempts - 1) } : {}) },
    });
    return res.count === 1;
  });
}

/**
 * FETCHING → DRAFTING before the first Claude call, once the pages are there (read, or reused): the read attempt is
 * taken back. Compare-and-set; false = another attempt took the draft.
 */
export async function markDrafting(draftId: number, jobId: number): Promise<boolean> {
  return moveWorkingDraft(draftId, jobId, "DRAFTING");
}

/**
 * After EVERY Claude call (answered or timed out): adds the call to the draft's sums, one short transaction and no
 * compare-and-set on the status (money spent is recorded whatever the draft's state). `calls + 1`, tokens and cost
 * added (cost rounded to 6 decimals), `stopReason` = this call's, `requestId` = this call's (kept when it has none),
 * `draftedAt = now` (monthly spend is counted by it). An `estimated` call (no answer came; its ceiling is the cost)
 * also gets the cost-estimated flag. A `notBilled` call (an error answer of Claude's own: another 4xx) only keeps its
 * request id and clears the in-flight note: it isn't a billed call, so it doesn't count in `calls`, the tokens or
 * `draftedAt`, and the running token averages never see it (M5 review AI-8).
 */
export async function recordCall(draftId: number, call: CallRecord, now: Date): Promise<void> {
  const cost = Number.isFinite(call.costUsd) && call.costUsd > 0 ? call.costUsd : 0;
  const tokens = (n: number) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
  await dbTx(async (tx) => {
    const row = await tx.aiDraft.findUnique({
      where: { id: draftId },
      select: { inputTokens: true, outputTokens: true, costUsd: true, flags: true, requestId: true },
    });
    if (!row) {
      console.error(`[ai] a Claude call for draft #${draftId} couldn't be recorded: the draft is gone`);
      return;
    }
    if (call.notBilled && !call.estimated && cost === 0) {
      await tx.aiDraft.update({
        where: { id: draftId },
        data: { stopReason: call.stopReason, requestId: call.requestId ?? row.requestId },
      });
      return;
    }
    await tx.aiDraft.update({
      where: { id: draftId },
      data: {
        calls: { increment: 1 },
        inputTokens: (row.inputTokens ?? 0) + tokens(call.inputTokens),
        outputTokens: (row.outputTokens ?? 0) + tokens(call.outputTokens),
        costUsd: roundUsd((row.costUsd ?? 0) + cost),
        stopReason: call.stopReason,
        requestId: call.requestId ?? row.requestId,
        draftedAt: now,
        ...(call.estimated
          ? { flags: withCostFlag(row.flags, COST_ESTIMATED_TIMEOUT_TEXT) as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });
  });
}

/**
 * How a draft ends (compare-and-set on `{id, jobId, status IN (FETCHING, DRAFTING)}`; false = lost). READY writes the
 * line, the quote, where it came from and the snapshots; NO_LINE the reason (a skip code, Claude's reason code or
 * model_declined); FAILED a plain sentence (never a provider's own text). Tokens and cost are not touched (recordCall
 * wrote them), and a cost-estimated flag already on the draft is kept.
 */
export async function finishDraft(draftId: number, jobId: number, out: DraftOutcome): Promise<boolean> {
  return dbTx(async (tx) => {
    const row = await tx.aiDraft.findFirst({
      where: { id: draftId, jobId, status: { in: [...WORKING] } },
      select: { flags: true },
    });
    if (!row) return false;
    const flags = keepCostFlag(row.flags, out.flags) as unknown as Prisma.InputJsonValue;
    const data: Prisma.AiDraftUpdateManyMutationInput =
      out.status === "READY"
        ? {
            status: "READY",
            line: out.line,
            evidenceQuote: out.evidenceQuote,
            evidenceSource: out.evidenceSource,
            evidenceUrl: out.evidenceUrl,
            reasonIfNull: null,
            error: null,
            flags,
            homeSnapshotId: out.homeSnapshotId,
            pageSnapshotId: out.pageSnapshotId,
          }
        : out.status === "NO_LINE"
          ? {
              status: "NO_LINE",
              line: null,
              evidenceQuote: null,
              evidenceSource: null,
              evidenceUrl: null,
              reasonIfNull: out.reasonIfNull,
              error: null,
              flags,
              homeSnapshotId: out.homeSnapshotId,
              pageSnapshotId: out.pageSnapshotId,
            }
          : { status: "FAILED", error: out.error, flags };
    const res = await tx.aiDraft.updateMany({ where: { id: draftId, jobId, status: { in: [...WORKING] } }, data });
    return res.count === 1;
  });
}

/**
 * Back to QUEUED (a pause, a rate limit, Claude unreachable, the monthly limit, shutdown): compare-and-set; tokens,
 * cost, calls and `draftedAt` are kept. From FETCHING the read attempt is taken back (the read was stopped on purpose,
 * or never started). False = another attempt already took the draft.
 */
export async function requeueDraft(draftId: number, jobId: number): Promise<boolean> {
  return moveWorkingDraft(draftId, jobId, "QUEUED");
}

/**
 * A stopped run's queue (Stop, or the run's cost cap, §3.9): QUEUED drafts that never made a Claude call are deleted;
 * QUEUED drafts that were already paid for (requeued after a pause) become FAILED "Stopped before a line was
 * finished.", so their cost stays counted and they can be tried again. Drafts being worked on are left to the job.
 */
export async function deleteQueuedDrafts(jobId: number): Promise<{ deleted: number; failed: number }> {
  const rows = await db.aiDraft.findMany({ where: { jobId, status: "QUEUED" }, select: { id: true, calls: true }, orderBy: { id: "asc" } });
  let deleted = 0;
  let failed = 0;
  const parts = chunks(rows);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const free = part.filter((r) => r.calls === 0).map((r) => r.id);
    const paid = part.filter((r) => r.calls > 0).map((r) => r.id);
    const started = Date.now();
    const res = await dbTx(async (tx) => {
      const d = free.length ? await tx.aiDraft.deleteMany({ where: { id: { in: free }, status: "QUEUED", calls: 0 } }) : { count: 0 };
      const f = paid.length
        ? await tx.aiDraft.updateMany({
            where: { id: { in: paid }, status: "QUEUED", calls: { gt: 0 } },
            data: { status: "FAILED", error: STOPPED_TEXT },
          })
        : { count: 0 };
      return { d: d.count, f: f.count };
    });
    deleted += res.d;
    failed += res.f;
    if (i < parts.length - 1) await pauseForOtherWriters(Date.now() - started);
  }
  return { deleted, failed };
}

// ───────────────────────── snapshots (§3.4.9) ─────────────────────────

/**
 * Stores one read of a company's website: every page as a WebsiteSnapshot (`text` exactly what Claude is sent, `notes`
 * so a reused snapshot gives the same flags). A read that ended in a skip is stored as ONE row with `skipReason` and
 * `text ""` (the homepage's address and status kept when it was read), so a skipped page is never reused as a good one.
 * Returns the snapshot ids to put on the draft (`homeId` is the skip row for a skip).
 */
export async function saveSnapshots(
  companyId: number,
  pages: ReadPageLike[],
  skip: { code: SkipCode; detail: string | null; url: string } | null,
  now: Date,
): Promise<{ homeId: number | null; pageId: number | null }> {
  const home = pages.find((p) => p.kind === "homepage") ?? null;
  if (skip) {
    const row = await dbWrite((c) =>
      c.websiteSnapshot.create({
        data: {
          companyId,
          url: skip.url || home?.url || "",
          finalUrl: home?.finalUrl ?? null,
          pageKind: "homepage",
          httpStatus: home?.httpStatus ?? null,
          title: home?.title ?? null,
          contentType: home?.contentType ?? null,
          bytes: home?.bytes ?? null,
          notes: [],
          text: "",
          chars: 0,
          lang: home?.lang ?? null,
          fetchedAt: now,
          skipReason: skip.code,
        },
        select: { id: true },
      }),
    );
    return { homeId: row.id, pageId: null };
  }
  const second = pages.find((p) => p.kind === "second_page") ?? null;
  if (!home && !second) return { homeId: null, pageId: null };
  return dbTx(async (tx) => {
    const save = async (p: ReadPageLike) =>
      (
        await tx.websiteSnapshot.create({
          data: {
            companyId,
            url: p.url,
            finalUrl: p.finalUrl,
            pageKind: p.kind,
            httpStatus: p.httpStatus,
            title: p.title,
            contentType: p.contentType,
            bytes: p.bytes,
            notes: [...p.notes],
            text: p.text,
            chars: p.text.length,
            lang: p.lang,
            fetchedAt: now,
            skipReason: null,
          },
          select: { id: true },
        })
      ).id;
    return { homeId: home ? await save(home) : null, pageId: second ? await save(second) : null };
  });
}

const SNAPSHOT_SELECT = {
  id: true,
  url: true,
  finalUrl: true,
  pageKind: true,
  httpStatus: true,
  title: true,
  contentType: true,
  bytes: true,
  notes: true,
  text: true,
  lang: true,
  fetchedAt: true,
  skipReason: true,
} as const;

type SnapshotRow = Prisma.WebsiteSnapshotGetPayload<{ select: typeof SNAPSHOT_SELECT }>;

function toSnapshotPage(r: SnapshotRow): SnapshotPage {
  return {
    kind: r.pageKind === "second_page" ? "second_page" : "homepage",
    url: r.url,
    finalUrl: r.finalUrl ?? r.url,
    httpStatus: r.httpStatus ?? 200,
    contentType: r.contentType,
    bytes: r.bytes ?? r.text.length,
    title: r.title,
    lang: r.lang,
    text: r.text,
    notes: parsePageNotes(r.notes),
    snapshotId: r.id,
    fetchedAt: r.fetchedAt.toISOString(),
  };
}

/**
 * What the job may use instead of reading the website (null = read it): unless `refetch`, a skip stored in the last
 * 24 hours comes back as the same skip (no hammering of a failing site), else the company's latest good read younger
 * than SNAPSHOT_REUSE_DAYS (its homepage and, from the same read, its second page).
 */
export async function reusableSnapshots(
  companyId: number,
  now: Date,
  refetch: boolean,
): Promise<{ pages: SnapshotPage[]; skip: SkipCode | null } | null> {
  if (refetch) return null;
  const latest = await db.websiteSnapshot.findFirst({
    where: { companyId },
    orderBy: [{ fetchedAt: "desc" }, { id: "desc" }],
    select: { skipReason: true, fetchedAt: true },
  });
  if (!latest) return null;
  if (latest.skipReason && now.getTime() - latest.fetchedAt.getTime() < SKIP_REUSE_MS) {
    const code = (SKIP_CODES as readonly string[]).includes(latest.skipReason) ? (latest.skipReason as SkipCode) : "unreachable";
    return { pages: [], skip: code };
  }
  const home = await db.websiteSnapshot.findFirst({
    where: {
      companyId,
      pageKind: "homepage",
      skipReason: null,
      fetchedAt: { gt: new Date(now.getTime() - SNAPSHOT_REUSE_DAYS * DAY_MS) },
    },
    orderBy: [{ fetchedAt: "desc" }, { id: "desc" }],
    select: SNAPSHOT_SELECT,
  });
  if (!home) return null;
  const second = await db.websiteSnapshot.findFirst({
    where: { companyId, pageKind: "second_page", skipReason: null, fetchedAt: home.fetchedAt },
    orderBy: { id: "desc" },
    select: SNAPSHOT_SELECT,
  });
  return { pages: second ? [toSnapshotPage(home), toSnapshotPage(second)] : [toSnapshotPage(home)], skip: null };
}

// ───────────────────────── spend and avoid lines ─────────────────────────

/** What one run has spent so far: the sum of its drafts' recorded costs (the spend guard's `runSpentUsd`). */
export async function runSpendUsd(jobId: number): Promise<number> {
  const res = await db.aiDraft.aggregate({ where: { jobId }, _sum: { costUsd: true } });
  return roundUsd(res._sum.costUsd ?? 0);
}

/** The office month's AI spend: drafts whose last Claude call ended in the month containing `now` (§3.3, D16). */
export async function monthSpendUsd(now: Date = new Date()): Promise<number> {
  const s = await getSettings(["sending.capDayTimeZone"] as const);
  const { start, end } = monthBounds(now, s["sending.capDayTimeZone"]);
  const res = await db.aiDraft.aggregate({ where: { draftedAt: { gte: start, lt: end } }, _sum: { costUsd: true } });
  return roundUsd(res._sum.costUsd ?? 0);
}

/**
 * The lines a new line for `companyId` must not repeat (checkLine's `avoid`, §3.6): this company's earlier lines that
 * were rejected or regenerated, then the last AVOID_OTHERS_MAX approved lines of other companies (newest first; the
 * same line once).
 */
export async function recentAvoidLines(companyId: number): Promise<string[]> {
  const [own, others] = await Promise.all([
    db.aiDraft.findMany({
      where: { companyId, line: { not: null }, OR: [{ status: "REJECTED" }, { reviewAction: "regenerated" }] },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { line: true },
      take: 50,
    }),
    db.aiDraft.findMany({
      where: { companyId: { not: companyId }, status: "APPROVED" },
      orderBy: [{ reviewedAt: "desc" }, { id: "desc" }],
      select: { finalLine: true, line: true },
      take: AVOID_OTHERS_MAX,
    }),
  ]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of [...own.map((r) => r.line), ...others.map((r) => r.finalLine ?? r.line)]) {
    const key = line ? normalizeForMatch(line) : "";
    if (!line || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

// ───────────────────────── orphans ─────────────────────────

/**
 * Drafts left in QUEUED..DRAFTING by a run that can't finish them any more: the job is gone (deleted after 30 days, or
 * never set), FAILED, DONE or CANCELLED. They become FAILED "Claude couldn't be reached. Click Try again.", except
 * drafts of a cancelled run that never made a call, which are deleted (as Stop does). A draft found in DRAFTING is
 * first charged the call that was out at its reserved ceiling (ceilingCharge, stuckCeiling), so it is never deleted
 * and its possible cost stays counted. Run every 30 minutes (P11) and safe to run any time. Returns how many drafts
 * changed.
 */
export async function failOrphanedDrafts(now: Date = new Date()): Promise<number> {
  const open = await db.aiDraft.findMany({
    where: { status: { in: [...IN_PROGRESS_STATUSES] } },
    select: { id: true, jobId: true, calls: true, status: true, model: true, promptVersion: true, stopReason: true },
    orderBy: { id: "asc" },
  });
  if (open.length === 0) return 0;
  const jobIds = [...new Set(open.map((d) => d.jobId).filter((id): id is number => id !== null))];
  const jobs = new Map<number, string>();
  for (const part of chunks(jobIds)) {
    for (const j of await db.job.findMany({ where: { id: { in: part } }, select: { id: true, status: true } })) jobs.set(j.id, j.status);
  }
  const ceilingOf = await ceilingReader();
  const drop: number[] = [];
  const fail: number[] = [];
  const charge: Array<{ id: number; ceiling: number }> = [];
  for (const d of open) {
    const status = d.jobId === null ? undefined : jobs.get(d.jobId);
    if (status === "QUEUED" || status === "RUNNING") continue;
    const ceiling = d.status === "DRAFTING" ? await stuckCeiling(d, ceilingOf) : 0;
    if (ceiling > 0) charge.push({ id: d.id, ceiling });
    else if (status === "CANCELLED" && d.calls === 0) drop.push(d.id);
    else fail.push(d.id);
  }
  let changed = 0;
  const inProgress = { in: [...IN_PROGRESS_STATUSES] };
  for (const part of chunks(drop)) {
    changed += (await dbWrite((c) => c.aiDraft.deleteMany({ where: { id: { in: part }, status: inProgress, calls: 0 } }))).count;
  }
  for (const part of chunks(fail)) {
    changed += (
      await dbWrite((c) => c.aiDraft.updateMany({ where: { id: { in: part }, status: inProgress }, data: { status: "FAILED", error: ORPHAN_TEXT } }))
    ).count;
  }
  for (const part of chunks(charge)) {
    changed += await dbTx(async (tx) => {
      let n = 0;
      for (const { id, ceiling } of part) {
        const row = await tx.aiDraft.findFirst({ where: { id, status: "DRAFTING" }, select: { costUsd: true, flags: true } });
        if (!row) continue;
        const res = await tx.aiDraft.updateMany({
          where: { id, status: "DRAFTING" },
          data: { status: "FAILED", error: ORPHAN_TEXT, ...ceilingCharge(row, ceiling, now) },
        });
        n += res.count;
      }
      return n;
    });
  }
  return changed;
}
