import type { Prisma } from "@/generated/prisma/client";
import { aiTokenKey, companyWorstCaseUsd, MAX_FACTOR, perCallMaxUsd } from "@/core/ai/estimate";
import { PROMPT_VERSION } from "@/core/ai/prompt";
import { buildSystemTokenRequest } from "@/core/ai/request";
import {
  HAIKU_MODEL,
  resolveProfile,
  RUN_STOP_FACTOR,
  type AiRunCarry,
  type AiRunPayload,
  type ClaimedDraft,
} from "@/core/ai/types";
import { roundUsd, formatUsd } from "@/core/money";
import { AI_NOTIFICATION } from "@/core/notification-types";
import { parseAiTokens } from "@/core/system-state-parse";
import { STATE_KEYS, type AiPauseKind } from "@/core/system-state";
import { monthBounds } from "@/core/time/month";
import { aiPauseText, getClaudeApi, tierCapResetAt, type ClaudeApi } from "@/server/anthropic";
import { db } from "@/server/db";
import { DeferJob, PlainJobError, redactText, type JobContext, type JobHandler } from "@/server/jobs";
import { notifyUsers } from "@/server/notifications";
import { scrubProviderText } from "@/server/secret-values";
import {
  claimQueuedDrafts,
  deleteQueuedDrafts,
  extraSharedDomains,
  getAiPause,
  monthSpendUsd,
  pauseAi,
  resetStuckDrafts,
  runSpendUsd,
  systemTokensFor,
} from "@/server/services/ai";
import { getSetting, getSettings } from "@/server/settings";
import { readTyped, updateTyped } from "@/server/state-typed";
import { defaultWebsiteReader, type WebsiteReader } from "@/server/web";
import type { JobDefinition } from "../../../worker/jobs/types";
import { draftCompany, Slots, type AiLogger, type DrafterContext, type ModelUse, type StopRequest } from "./drafter";
import { PRACTICE_MODEL, runPracticeDrafts } from "./practice";
import { SpendGuard } from "./spend-guard";
import {
  AI_LINES_LINK,
  CLAUDE_UNREACHABLE_TEXT,
  DRAFTS_READY_TITLE,
  draftRunSummary,
  draftsReadyBody,
  pausedSummary,
  progressSummary,
  RATE_LIMITED_SUMMARY,
  RUN_STOPPED_TITLE,
  runStoppedBody,
  stoppedAfterText,
  type DraftRunCounts,
} from "./words";

/**
 * The drafting job, `ai.draftLines` (docs/dev/M5-DESIGN.md §3.1 steps 2–3, §3.3, §3.5.4, §3.7, §3.10, §3.12; §8 P8).
 * It runs in the worker's `ai` lane, one run at a time; the run's AiDraft rows are its queue (P5 created them QUEUED).
 *
 * Every handler run, in order:
 *  1. `resetStuckDrafts`: drafts a stopped worker left behind (FETCHING → QUEUED, or FAILED after two interrupted
 *     reads; DRAFTING → QUEUED with the call that was out charged at its reserved ceiling).
 *  2. The practice copy (Setting "practice.copy", or a run started there: model "practice") uses the practice drafter:
 *     no reader, no network, $0 (§3.12). Injected deps are ignored there.
 *  3. The AI queue's pause: paused → defer until it lifts (or 1 h). No usable key → pause `key_rejected` with
 *     getClaudeApi's sentence and defer 1 h (never a thrown error).
 *  4. The loop, from this top level only (§0.2 rule 12): at every claim the model is resolved from the current settings
 *     (no price → pause `no_price`; a model other than the carry's → the run's cap is rescaled once and the prompt's
 *     tokens measured with the free countTokens), then up to 4 companies on distinct hosts are claimed and drafted at
 *     once, with at most 2 Claude calls in flight and the spend guard before every call.
 *  5. Before claiming: Stop (`cancelRequested`), a yield every 60 s or when a more urgent AI job waits, shutdown.
 *  6. Leaving (§3.7): stop claiming, let every company in flight finish and commit, then: Stop → the not-yet-drafted
 *     drafts are taken off the list ("Stopped after 12 of 30 companies."); the run's cost cap → the same plus
 *     `ai.runStopped` (Contacts and list runs; a one-company run's card shows the outcome); a pause or the monthly
 *     limit → defer until it lifts; a long rate limit → defer by it; Claude unreachable → a plain error, so the runner
 *     tries again after 1, 5 and 15 minutes (the orphan sweep fails the drafts of a run that failed for good);
 *     shutdown or a yield → defer to now. One company whose calls go unanswered fails alone (drafter.ts).
 *  7. Finished: the job's summary, and `ai.draftsReady` to the requester for Contacts and list runs.
 *
 * The run's cost cap is 125 % of its "at most", but never below one company's worst case (companyWorstCaseUsd), so a
 * one-company run (the panel, Regenerate, Try again) can afford the regeneration and the `max_tokens` retry the drafter
 * promises (M5 review AI-3); the monthly limit stays the hard stop. The run's `carry` (AiRunCarry: the model it drafts
 * with and its cap) survives deferrals.
 */

export type { AiLogger } from "./drafter";

export type AiDeps = {
  /** Reads company websites. Default: defaultWebsiteReader() (fixture sites in tests), built per handler run. */
  reader: WebsiteReader;
  /** Claude. Default (missing or null): getClaudeApi() per handler run, with the saved key. */
  claude: ClaudeApi | null;
  /** The clock. Default: the real time. */
  now?: () => Date;
  /** Claude calls in flight at most (default 2). */
  claudeConcurrency?: number;
  /** Companies drafted at once, on distinct hosts (default 4). */
  companyConcurrency?: number;
  /** A handler run yields to the queue after this long (default 60 s). */
  yieldAfterMs?: number;
  /** The wait before in-process retry `n` of a 5xx, 529 or connection error (default 2 s, then 8 s). */
  retryDelayMs?: (n: number) => number;
  /** How the job waits between its own retries (tests pass one that doesn't wait). Rejects or resolves early on abort. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Where the job logs (the worker passes its own). Default: the console with an "[ai]" prefix. */
  logger?: AiLogger;
};

export const AI_JOB_LABEL = "AI drafting";
export const AI_JOB_WHAT_TO_DO = "Open AI lines and start the drafting again.";

/** Defaults of AiDeps. */
export const DEFAULT_CLAUDE_CONCURRENCY = 2;
export const DEFAULT_COMPANY_CONCURRENCY = 4;
export const DEFAULT_YIELD_AFTER_MS = 60_000;
/** A pause without an end, or no usable key: the job looks again after this long (resuming moves it to now). */
export const PAUSE_RECHECK_MS = 3_600_000;
/** Anthropic's own monthly cap lifts at 00:00 UTC on the 1st; the job waits 5 minutes more (§3.7). */
export const TIER_CAP_GRACE_MS = 5 * 60_000;
/** A run whose queue can't be claimed (another claimer holds it briefly) looks again after this long. */
const STUCK_RETRY_MS = 60_000;

/** The in-process retry waits: 2 s, then 8 s (§3.7 "P8's own retries"). */
export function defaultRetryDelayMs(n: number): number {
  return n <= 1 ? 2_000 : 8_000;
}

async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message || err.name : String(err);
}

/** The console, with an "[ai]" prefix and nothing secret-looking (the worker passes its own timestamped log). */
export const CONSOLE_AI_LOGGER: AiLogger = {
  info: (m) => console.log(`[ai] ${m}`),
  warn: (m) => console.warn(`[ai] ${m}`),
  error: (m, err) => console.error(`[ai] ${m}${err === undefined ? "" : `: ${redactText(errorMessage(err))}`}`),
};

// ───────────── payload and carry ─────────────

const SOURCES: readonly AiRunPayload["source"][] = ["contacts", "list", "panel", "regenerate", "retry"];

function money(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** The job's payload (AiRunPayload), read leniently: an unknown source counts as a Contacts run. */
export function readAiRunPayload(v: unknown): AiRunPayload {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const source = SOURCES.find((s) => s === o.source) ?? "contacts";
  return {
    source,
    companyCount: Math.floor(money(o.companyCount)),
    aboutUsd: money(o.aboutUsd),
    atMostUsd: money(o.atMostUsd),
    model: typeof o.model === "string" && o.model.trim() ? o.model.trim() : HAIKU_MODEL,
    listId: typeof o.listId === "number" && Number.isInteger(o.listId) ? o.listId : null,
  };
}

/** The run's carry: the model it drafts with (initially the estimate's) and its rescaled cap (null = startingRunCap). */
export function readAiRunCarry(v: unknown, payload: AiRunPayload): AiRunCarry & { model: string } {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const model = typeof o.model === "string" && o.model ? o.model : payload.model;
  const cap = typeof o.runCapUsd === "number" && Number.isFinite(o.runCapUsd) && o.runCapUsd >= 0 ? o.runCapUsd : null;
  return { model, runCapUsd: cap };
}

// ───────────── counts ─────────────

const OPEN = ["QUEUED", "FETCHING", "DRAFTING"] as const;

/** How many of the run's drafts exist and how many are finished (not QUEUED..DRAFTING). */
async function draftTotals(jobId: number): Promise<{ total: number; done: number }> {
  const [total, open] = await Promise.all([
    db.aiDraft.count({ where: { jobId } }),
    db.aiDraft.count({ where: { jobId, status: { in: [...OPEN] } } }),
  ]);
  return { total, done: total - open };
}

/** What the run ended with: lines drafted (waiting or already reviewed), no line, failed, and its cost. */
async function runCounts(jobId: number): Promise<DraftRunCounts> {
  const rows = await db.aiDraft.groupBy({ by: ["status"], where: { jobId }, _count: { _all: true } });
  const n = (s: string) => rows.find((r) => r.status === s)?._count._all ?? 0;
  return {
    ready: n("READY") + n("APPROVED") + n("REJECTED"),
    noLine: n("NO_LINE"),
    failed: n("FAILED"),
    costUsd: await runSpendUsd(jobId),
  };
}

/** The job's result (its `summary` shows on progress screens; the counts and carry are for the logs and tests). */
export type AiRunResult = {
  summary: string;
  ready: number;
  noLine: number;
  failed: number;
  costUsd: number;
  /** "stop": someone clicked Stop; "cost-cap": the run was about to pass its cost cap (startingRunCap, or the rescaled one). */
  stopped: "stop" | "cost-cap" | null;
  carry: AiRunCarry | null;
};

function toResult(r: AiRunResult): Prisma.InputJsonValue & { summary: string } {
  return { ...r, carry: r.carry ? { model: r.carry.model, runCapUsd: r.carry.runCapUsd } : null };
}

/** Progress after every finished company (the runner throttles the writes). */
class Progress {
  constructor(
    private readonly ctx: JobContext,
    readonly total: number,
    public done: number,
  ) {}

  async report(): Promise<void> {
    await this.ctx.progress(this.done, this.total);
  }

  async bump(): Promise<void> {
    this.done += 1;
    await this.report();
  }
}

// ───────────── the loop ─────────────

type RunStop =
  | { kind: "paused"; until: Date | null; text: string }
  | { kind: "rate-limited"; until: Date }
  | { kind: "unreachable"; detail: string | null }
  | { kind: "run-cap" }
  | { kind: "unexpected"; error: unknown };

type LoopEnd = "finished" | "cancel" | "yield" | "stopped" | "stuck";

type RunSetup = {
  jobId: number;
  ctx: JobContext;
  api: ClaudeApi;
  reader: WebsiteReader;
  guard: SpendGuard;
  carry: AiRunCarry & { model: string };
  progress: Progress;
  now: () => Date;
  logger: AiLogger;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  retryDelayMs: (n: number) => number;
  claudeConcurrency: number;
  companyConcurrency: number;
  yieldAfterMs: number;
  extraShared: ReadonlySet<string>;
  /** Setting "sending.capDayTimeZone" (the office month). */
  capZone: string;
  /** The Owner's zone (Anthropic's tier cap reset time is written in it). */
  ownerZone: string;
};

/** One handler run's pool of companies and what made it stop. */
class DraftingRun implements DrafterContext {
  readonly stops: RunStop[] = [];
  readonly jobId: number;
  readonly api: ClaudeApi;
  readonly reader: WebsiteReader;
  readonly guard: SpendGuard;
  readonly slots: Slots;
  readonly signal: AbortSignal;
  readonly now: () => Date;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly retryDelayMs: (n: number) => number;
  readonly extraShared: ReadonlySet<string>;
  readonly logger: AiLogger;
  carry: AiRunCarry & { model: string };
  #blocked = false;
  #exit: "cancel" | "yield" | null = null;
  /** Drafts whose calls went unanswered since the last answer (any company): two or more → Claude is unreachable. */
  readonly #unanswered = new Set<number>();
  readonly #inFlight = new Map<number, { host: string; done: Promise<void> }>();
  readonly #measured = new Set<string>();
  readonly #systemTokens = new Map<string, number>();
  readonly #startedAt: number;

  constructor(private readonly s: RunSetup) {
    this.jobId = s.jobId;
    this.api = s.api;
    this.reader = s.reader;
    this.guard = s.guard;
    this.slots = new Slots(s.claudeConcurrency);
    this.signal = s.ctx.signal;
    this.now = s.now;
    this.sleep = s.sleep;
    this.retryDelayMs = s.retryDelayMs;
    this.extraShared = s.extraShared;
    this.logger = s.logger;
    this.carry = s.carry;
    this.#startedAt = s.now().getTime();
  }

  callsBlocked(): boolean {
    return this.#blocked || this.signal.aborted;
  }

  /** DrafterContext.unanswered: true once calls of two different companies went unanswered with no answer between. */
  unanswered(draftId: number): boolean {
    this.#unanswered.add(draftId);
    return this.#unanswered.size >= 2;
  }

  /** DrafterContext.answered: any answer shows Claude is reachable. */
  answered(): void {
    this.#unanswered.clear();
  }

  has(kind: RunStop["kind"]): boolean {
    return this.stops.some((x) => x.kind === kind);
  }

  first<K extends RunStop["kind"]>(kind: K): Extract<RunStop, { kind: K }> | null {
    return (this.stops.find((x) => x.kind === kind) as Extract<RunStop, { kind: K }> | undefined) ?? null;
  }

  /** Writes a pause (the first cause wins; the Owner is notified by pauseAi) and remembers why the run stops. */
  async #pause(kind: AiPauseKind, x: { text: string; until: Date | null; model: string; error?: unknown }): Promise<void> {
    this.#blocked = true;
    let detail: string | null = null;
    try {
      if (x.error !== undefined) detail = (await scrubProviderText(errorMessage(x.error))) || null;
      await pauseAi(kind, { text: x.text, until: x.until, model: x.model, detail, now: this.now() });
    } catch (err) {
      this.logger.error(`Couldn't pause AI drafting (${kind})`, err);
    }
    this.stops.push({ kind: "paused", until: x.until, text: x.text });
  }

  /** DrafterContext.stop: a failure that concerns the whole run (§3.7 table). */
  async stop(req: StopRequest): Promise<void> {
    const at = this.now();
    switch (req.kind) {
      case "pause": {
        const until = req.reason === "tier_spend_cap" ? new Date(tierCapResetAt(at).getTime() + TIER_CAP_GRACE_MS) : null;
        const zone = req.reason === "tier_spend_cap" ? this.s.ownerZone : this.s.capZone;
        const text = aiPauseText(req.reason, { model: req.model, timeZone: zone, now: at });
        await this.#pause(req.reason, { text, until, model: req.model, error: req.error });
        return;
      }
      case "monthly-limit": {
        if (this.stops.some((x) => x.kind === "paused")) {
          this.#blocked = true;
          return;
        }
        const bounds = monthBounds(at, this.s.capZone);
        const text = aiPauseText("monthly_limit", {
          model: req.model,
          limitUsd: this.guard.state.monthLimitUsd,
          resetLabel: bounds.resetLabel,
          timeZone: this.s.capZone,
          now: at,
        });
        await this.#pause("monthly_limit", { text, until: bounds.end, model: req.model });
        return;
      }
      case "run-cap":
        if (!this.has("run-cap")) {
          this.stops.push({ kind: "run-cap" });
          const g = this.guard.state;
          this.logger.warn(
            `AI drafting run #${this.jobId} stops: its next call would pass the cost cap (${formatUsd(g.runSpentUsd)} spent, cap ${formatUsd(g.runCapUsd)})`,
          );
        }
        return;
      case "rate-limited":
        this.#blocked = true;
        this.stops.push({ kind: "rate-limited", until: new Date(at.getTime() + Math.max(0, req.afterMs)) });
        return;
      case "unreachable": {
        this.#blocked = true;
        const detail = (await scrubProviderText(errorMessage(req.error)).catch(() => "")) || null;
        this.stops.push({ kind: "unreachable", detail });
        return;
      }
    }
  }

  /** Measures the prompt's tokens for a model once (free countTokens, §3.5.4); a failure is logged and ignored. */
  async #measure(profile: ModelUse["profile"]): Promise<void> {
    if (this.#measured.has(profile.id)) return;
    this.#measured.add(profile.id);
    const key = aiTokenKey(profile.id, PROMPT_VERSION);
    const { value } = await readTyped(STATE_KEYS.aiTokens, parseAiTokens);
    if (value.entries[key]) return;
    try {
      const n = await this.api.countTokens(buildSystemTokenRequest(profile));
      const measuredAt = this.now().toISOString();
      await updateTyped(STATE_KEYS.aiTokens, parseAiTokens, (cur) =>
        cur.entries[key] ? null : { entries: { ...cur.entries, [key]: { systemTokens: Math.max(0, Math.round(n)), measuredAt } } },
      );
    } catch (err) {
      const why = await scrubProviderText(errorMessage(err)).catch(() => "");
      this.logger.warn(`Couldn't measure the prompt's size for ${profile.id}; estimates keep the default${why ? `: ${why}` : ""}`);
    }
  }

  /**
   * The model for the next claim, from the current settings (§3.3, D39): no price → pause `no_price` (no call is made);
   * another model than the run's → the cap is rescaled once for what is left (`runSpent + 125 % × perMax × drafts
   * still to draft`, but at least one company's worst case with the new model). The monthly limit is re-read too, so a
   * raised limit applies at once.
   */
  async #resolveModel(): Promise<ModelUse | null> {
    const s = await getSettings(["ai.model", "ai.customModel", "ai.prices", "ai.monthlyLimitUsd"] as const);
    this.guard.setMonthLimit(money(Number(s["ai.monthlyLimitUsd"])));
    const profile = resolveProfile(s["ai.model"], s["ai.customModel"], s["ai.prices"]);
    if (!profile.prices) {
      const text = aiPauseText("no_price", { model: profile.id, now: this.now() });
      await this.#pause("no_price", { text, until: null, model: profile.id });
      return null;
    }
    await this.#measure(profile);
    let systemTokens = this.#systemTokens.get(profile.id);
    if (systemTokens === undefined) {
      systemTokens = await systemTokensFor(profile.id, PROMPT_VERSION);
      this.#systemTokens.set(profile.id, systemTokens);
    }
    if (this.carry.model !== profile.id) {
      const [left, spent] = await Promise.all([
        db.aiDraft.count({ where: { jobId: this.jobId, status: { in: [...OPEN] } } }),
        runSpendUsd(this.jobId),
      ]);
      const perMax = perCallMaxUsd(profile, systemTokens) * MAX_FACTOR;
      const worst = left > 0 ? companyWorstCaseUsd(profile, systemTokens) : 0;
      const cap = roundUsd(spent + Math.max(RUN_STOP_FACTOR * perMax * left, worst));
      this.logger.info(
        `AI drafting run #${this.jobId} now drafts with ${profile.label} (was ${this.carry.model}); its cost cap is ${formatUsd(cap)} for ${left} companies left`,
      );
      this.carry = { model: profile.id, runCapUsd: cap };
      this.guard.setRunCap(cap);
    }
    return { profile, systemTokens };
  }

  #start(d: ClaimedDraft, use: ModelUse): void {
    const done = (async () => {
      try {
        const end = await draftCompany(d, this, use);
        if (end.status === "READY" || end.status === "NO_LINE" || end.status === "FAILED") await this.s.progress.bump();
      } catch (err) {
        // A database problem: the draft stays as it is (the next handler start resets it) and the run leaves.
        this.#blocked = true;
        this.stops.push({ kind: "unexpected", error: err });
        this.logger.error(`Drafting the line of draft #${d.id} hit a problem`, err);
      } finally {
        this.#inFlight.delete(d.id);
      }
    })();
    this.#inFlight.set(d.id, { host: d.host, done });
  }

  async #shouldYield(rounds: number): Promise<boolean> {
    if (rounds === 0) return false;
    if (this.now().getTime() - this.#startedAt >= this.s.yieldAfterMs) return true;
    return (await this.s.ctx.shouldYield?.()) ?? false;
  }

  /**
   * One safe point before claiming (Stop, a yield), then a claim of up to the free company slots. Returns "finished"
   * or "stuck" when there is nothing left to claim and nothing in flight, else null.
   */
  async #claimRound(state: { rounds: number; emptyRounds: number }): Promise<"finished" | "stuck" | null> {
    if ((await this.s.ctx.cancelRequested?.()) ?? false) {
      this.#exit = "cancel";
      return null;
    }
    if (await this.#shouldYield(state.rounds)) {
      this.#exit = "yield";
      return null;
    }
    state.rounds += 1;
    const use = await this.#resolveModel();
    if (!use || this.signal.aborted) return null;
    const busy = new Set([...this.#inFlight.values()].map((f) => f.host));
    const claimed = await claimQueuedDrafts(this.jobId, this.s.companyConcurrency - this.#inFlight.size, busy, use.profile.id);
    for (const d of claimed) this.#start(d, use);
    if (claimed.length > 0) {
      state.emptyRounds = 0;
      return null;
    }
    if (this.#inFlight.size > 0) return null;
    const left = await db.aiDraft.count({ where: { jobId: this.jobId, status: "QUEUED" } });
    if (left === 0) return "finished";
    // A claim can only lose to another claimer for a moment; after a few empty rounds the run looks again later.
    return ++state.emptyRounds >= 3 ? "stuck" : null;
  }

  /** Claims and drafts until the queue is empty or something makes the run leave; always drains before returning. */
  async loop(): Promise<LoopEnd> {
    const state = { rounds: 0, emptyRounds: 0 };
    for (;;) {
      const leaving = this.#exit !== null || this.stops.length > 0 || this.signal.aborted;
      if (!leaving && this.#inFlight.size < this.s.companyConcurrency) {
        try {
          const end = await this.#claimRound(state);
          if (end) return end;
        } catch (err) {
          // A database problem while claiming: stop claiming, let the companies in flight finish, then leave.
          this.#blocked = true;
          this.stops.push({ kind: "unexpected", error: err });
          this.logger.error(`AI drafting run #${this.jobId} couldn't claim its next companies`, err);
        }
      }
      if (this.#inFlight.size === 0) {
        if (this.#exit !== null) return this.#exit;
        if (this.stops.length > 0 || this.signal.aborted) return "stopped";
        continue;
      }
      await Promise.race([...this.#inFlight.values()].map((f) => f.done));
    }
  }
}

// ───────────── leaving ─────────────

type RunContext = { jobId: number; payload: AiRunPayload; ctx: JobContext; logger: AiLogger };

async function notifyRequester(rc: RunContext, input: { type: string; title: string; body: string }): Promise<void> {
  try {
    await notifyUsers([rc.ctx.createdById], { ...input, link: AI_LINES_LINK });
  } catch (err) {
    rc.logger.error(`Couldn't send the "${input.title}" notification of AI drafting run #${rc.jobId}`, err);
  }
}

/** The queue is empty: the summary, and "AI lines ready to review" for Contacts and list runs (§3.10). */
async function finishRun(rc: RunContext, carry: AiRunCarry | null): Promise<Prisma.InputJsonValue & { summary: string }> {
  const counts = await runCounts(rc.jobId);
  const total = counts.ready + counts.noLine + counts.failed;
  if ((rc.payload.source === "contacts" || rc.payload.source === "list") && total > 0) {
    await notifyRequester(rc, { type: AI_NOTIFICATION.ready, title: DRAFTS_READY_TITLE, body: draftsReadyBody(counts) });
  }
  return toResult({ summary: draftRunSummary(counts), ...counts, stopped: null, carry });
}

/** Runs of one company started from its panel or card (they get no notifications: the panel or card shows the result). */
const SINGLE_SOURCES: ReadonlySet<AiRunPayload["source"]> = new Set(["panel", "regenerate", "retry"]);

/**
 * Stop, or the run's cost cap: the drafts not drafted yet are taken off the list (never-paid ones deleted, paid ones
 * FAILED "Stopped before a line was finished.", §3.9); the cap also tells the requester of a Contacts or list run
 * (`ai.runStopped`). A panel, Regenerate or Try again run tells nobody: its card shows the outcome (M5 review AI-3).
 */
async function stopRun(rc: RunContext, why: "stop" | "cost-cap", carry: AiRunCarry | null): Promise<Prisma.InputJsonValue & { summary: string }> {
  const { total, done } = await draftTotals(rc.jobId);
  await deleteQueuedDrafts(rc.jobId);
  const counts = await runCounts(rc.jobId);
  const stoppedText = stoppedAfterText(done, total);
  if (why === "cost-cap" && !SINGLE_SOURCES.has(rc.payload.source)) {
    await notifyRequester(rc, {
      type: AI_NOTIFICATION.stopped,
      title: RUN_STOPPED_TITLE,
      body: runStoppedBody({ spentUsd: counts.costUsd, atMostUsd: rc.payload.atMostUsd, done, total }),
    });
  }
  const summary = why === "cost-cap" ? `${stoppedText.replace(/\.$/, "")}: this run was about to cost more than expected.` : stoppedText;
  return toResult({ summary, ...counts, stopped: why, carry });
}

// ───────────── the handler ─────────────

/**
 * A run's cost cap before any rescale: 125 % of its "at most" (payload), but never below one company's worst case with
 * the run's model (companyWorstCaseUsd: the regeneration, the `max_tokens` retry and one more try after an unanswered
 * call, each at the page cap). For a big run the first is far larger; a one-company run's "at most" covers one call
 * only, so without this it couldn't afford the regeneration the drafter promises (M5 review AI-3).
 */
export async function startingRunCap(payload: AiRunPayload, model: string): Promise<number> {
  const scaled = RUN_STOP_FACTOR * payload.atMostUsd;
  if (payload.companyCount < 1 || model === PRACTICE_MODEL) return scaled;
  const s = await getSettings(["ai.customModel", "ai.prices"] as const);
  const profile = resolveProfile(model, s["ai.customModel"], s["ai.prices"]);
  if (!profile.prices) return scaled;
  const worst = companyWorstCaseUsd(profile, await systemTokensFor(model, PROMPT_VERSION));
  return roundUsd(Math.max(scaled, worst));
}

/** The Owner's time zone (the tier cap's reset time is written in it), else the office zone. */
async function ownerZone(fallback: string): Promise<string> {
  const owner = await db.user.findFirst({ where: { role: "OWNER", active: true }, orderBy: { id: "asc" }, select: { timeZone: true } });
  return owner?.timeZone || fallback;
}

/** One handler run of `ai.draftLines` (see the file comment). */
export async function runAiDraftLines(payloadRaw: unknown, ctx: JobContext, deps: Partial<AiDeps> = {}): Promise<Prisma.InputJsonValue & { summary: string }> {
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? CONSOLE_AI_LOGGER;
  const payload = readAiRunPayload(payloadRaw);
  const carry = readAiRunCarry(ctx.carry ?? null, payload);
  const rc: RunContext = { jobId: ctx.jobId, payload, ctx, logger };
  const started = now();

  await resetStuckDrafts(ctx.jobId, started);
  const totals = await draftTotals(ctx.jobId);
  const progress = new Progress(ctx, totals.total, totals.done);
  await progress.report();
  const cancelRequested = async () => (await ctx.cancelRequested?.()) ?? false;

  // The practice copy never reads websites or calls Claude (§3.12), whatever was injected.
  if ((await getSetting("practice.copy")) === true || payload.model === PRACTICE_MODEL) {
    const res = await runPracticeDrafts(ctx.jobId, { cancelRequested, onFinished: () => progress.bump(), signal: ctx.signal });
    if (res.cancelled) return stopRun(rc, "stop", null);
    if (res.interrupted) throw new DeferJob(now(), "yield", { summary: progressSummary(progress.done, progress.total) });
    return finishRun(rc, null);
  }

  const pause = await getAiPause(started);
  if (pause.paused) {
    const until = pause.until ? new Date(pause.until) : new Date(started.getTime() + PAUSE_RECHECK_MS);
    throw new DeferJob(until, "paused", { carry, summary: pausedSummary(pause.text) });
  }

  let api = deps.claude ?? null;
  if (!api) {
    const res = await getClaudeApi();
    if (!res.ok) {
      // No usable key (removed, unreadable, or not for this server): pause, never a thrown error (§3.7).
      try {
        await pauseAi("key_rejected", { text: res.text, until: null, now: started });
      } catch (err) {
        logger.error("Couldn't pause AI drafting (no usable key)", err);
      }
      throw new DeferJob(new Date(started.getTime() + PAUSE_RECHECK_MS), "paused", { carry, summary: pausedSummary(res.text) });
    }
    api = res.api;
  }

  const s = await getSettings(["ai.monthlyLimitUsd", "sending.capDayTimeZone"] as const);
  const [monthSpent, runSpent, extraShared, zone, runCap] = await Promise.all([
    monthSpendUsd(started),
    runSpendUsd(ctx.jobId),
    extraSharedDomains(),
    ownerZone(s["sending.capDayTimeZone"]),
    carry.runCapUsd ?? startingRunCap(payload, carry.model),
  ]);
  const guard = new SpendGuard({
    monthSpentUsd: monthSpent,
    monthLimitUsd: money(Number(s["ai.monthlyLimitUsd"])),
    runSpentUsd: runSpent,
    runCapUsd: runCap,
  });

  const run = new DraftingRun({
    jobId: ctx.jobId,
    ctx,
    api,
    reader: deps.reader ?? defaultWebsiteReader(),
    guard,
    carry,
    progress,
    now,
    logger,
    sleep: deps.sleep ?? defaultSleep,
    retryDelayMs: deps.retryDelayMs ?? defaultRetryDelayMs,
    claudeConcurrency: Math.max(1, Math.floor(deps.claudeConcurrency ?? DEFAULT_CLAUDE_CONCURRENCY)),
    companyConcurrency: Math.max(1, Math.floor(deps.companyConcurrency ?? DEFAULT_COMPANY_CONCURRENCY)),
    yieldAfterMs: Math.max(0, deps.yieldAfterMs ?? DEFAULT_YIELD_AFTER_MS),
    extraShared,
    capZone: s["sending.capDayTimeZone"],
    ownerZone: zone,
  });

  const end = await run.loop();
  const leaveCarry = run.carry;
  const at = now();

  // Stop wins (asked again: someone may have clicked it while the companies in flight finished).
  if (end === "cancel" || (await cancelRequested())) return stopRun(rc, "stop", leaveCarry);
  if (run.has("run-cap")) return stopRun(rc, "cost-cap", leaveCarry);

  const paused = run.first("paused");
  if (paused) {
    throw new DeferJob(paused.until ?? new Date(at.getTime() + PAUSE_RECHECK_MS), "paused", {
      carry: leaveCarry,
      summary: pausedSummary(paused.text),
    });
  }
  const rateLimits = run.stops.filter((x): x is Extract<RunStop, { kind: "rate-limited" }> => x.kind === "rate-limited");
  if (rateLimits.length > 0) {
    const until = new Date(Math.max(...rateLimits.map((x) => x.until.getTime())));
    throw new DeferJob(until, "rate-limited", { carry: leaveCarry, summary: RATE_LIMITED_SUMMARY });
  }
  const unexpected = run.first("unexpected");
  if (unexpected) throw unexpected.error;
  const unreachable = run.first("unreachable");
  if (unreachable) throw new PlainJobError(CLAUDE_UNREACHABLE_TEXT, unreachable.detail);

  const summary = progressSummary(progress.done, progress.total);
  if (end === "stuck") throw new DeferJob(new Date(at.getTime() + STUCK_RETRY_MS), "retry-later", { carry: leaveCarry, summary });
  // Shutdown (the companies in flight finished) or a yield: back in the queue at once, carry kept.
  if (end !== "finished") throw new DeferJob(at, "yield", { carry: leaveCarry, summary });
  return finishRun(rc, leaveCarry);
}

/** The drafting job's definition (M5-DESIGN §8 P8); P11 registers it as "ai.draftLines" with the worker's `ai` deps. */
export function createAiDraftLinesJob(deps: Partial<AiDeps> = {}): JobDefinition {
  const handler: JobHandler = (payload, ctx) => runAiDraftLines(payload, ctx, deps);
  return { handler, label: AI_JOB_LABEL, whatToDo: AI_JOB_WHAT_TO_DO, link: AI_LINES_LINK };
}

/** The job with the default deps (the real reader and the saved key). */
export const aiDraftLinesJob: JobDefinition = createAiDraftLinesJob();
