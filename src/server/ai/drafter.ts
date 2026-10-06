import { checkLine, mergeFlags, problemText, type CheckLineInput, type CheckLinePage, type CheckLineResult } from "@/core/ai/checks";
import { callCeilingUsd, costUsd, totalInputTokens } from "@/core/ai/cost";
import { readLineAnswer } from "@/core/ai/parse";
import { stripOurTags, type LineMessageInput, type LinePageInput } from "@/core/ai/prompt";
import { buildLineRequest, retryMaxTokens, type LineRequest } from "@/core/ai/request";
import type {
  ClaimedDraft,
  DraftFlag,
  DraftOutcome,
  LineAnswer,
  NoLineCode,
  ReadPageLike,
  ResolvedProfile,
  SkipCode,
} from "@/core/ai/types";
import { countryName } from "@/core/geo/display";
import { usableCompanyDomain } from "@/core/rules/team-rule";
import type { AiPauseKind } from "@/core/system-state";
import { classifyAnthropicError, requestIdOfError, type AiFailure, type ClaudeAnswer, type ClaudeApi } from "@/server/anthropic";
import { db } from "@/server/db";
import { scrubProviderText } from "@/server/secret-values";
import {
  companySite,
  COMPANY_DELETED_TEXT,
  clearCallInFlight,
  finishDraft,
  markCallInFlight,
  markDrafting,
  recentAvoidLines,
  recordCall,
  requeueDraft,
  reusableSnapshots,
  saveSnapshots,
} from "@/server/services/ai";
import type { WebsiteReader } from "@/server/web";
import type { SpendGuard, SpendRefusal } from "./spend-guard";
import {
  ANSWER_MISMATCH_TEXT,
  ANSWER_UNREADABLE_TEXT,
  CLAUDE_FAILED_TEXT,
  CLAUDE_TOO_SLOW_TEXT,
  METADATA_ONLY_FLAG,
  SECOND_PAGE_FAILED_FLAG,
} from "./words";

/**
 * One company of a drafting run (docs/dev/M5-DESIGN.md §3.1 step 2, §3.4.9, §3.6, §3.7): the company re-read, the skip
 * rules again, the website (its snapshots reused, or read and stored), then Claude: at most 2 calls plus one retry after
 * a `max_tokens` stop, the automatic checks on every answer against exactly what Claude was sent, and the draft's
 * outcome through the compare-and-set helpers (a lost compare-and-set drops the result).
 *
 * Money rules (§0.2 rule 11, §3.3): the spend guard reserves every call's ceiling before the call, and the draft notes
 * that ceiling while the call is out (markCallInFlight: a restart charges exactly it); `recordCall` runs after every
 * call that returned an answer or may have been billed (a timeout or an unreadable answer: its ceiling, flag
 * cost-estimated). The paid call never gets the job's signal: shutdown only stops reading and the start of new calls.
 * Failures that concern the whole run (a pause, a rate limit, Claude unreachable, a limit reached) are handed to the
 * run (`stop`), which stops claiming, drains and then leaves (§3.7 "Leaving rule").
 *
 * A call that may have been billed but brought no answer (a timeout, an unreadable 200) concerns this company first
 * (M5 review AI-2): it is tried once more, and after MAX_UNANSWERED_CALLS such calls only this company fails ("Claude
 * took too long…"), with a usable first answer kept instead. Only when calls of different companies go unanswered with
 * no answer in between does the whole run stop as "Claude unreachable". So one slow company can't fail a whole run,
 * and each company pays at most MAX_UNANSWERED_CALLS ceilings for it per handler run.
 */

// ───────────── shared with the run ─────────────

/** Log lines of the drafting job: ids and hosts only, never website text or addresses (§0.2 rules 6 and 9). */
export type AiLogger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
};

/** A failure that ends or pauses the whole run (the run writes the pause and decides how to leave). */
export type StopRequest =
  | { kind: "pause"; reason: Exclude<AiPauseKind, "monthly_limit" | "no_price">; model: string; error: unknown }
  | { kind: "monthly-limit"; model: string }
  | { kind: "run-cap" }
  | { kind: "rate-limited"; afterMs: number }
  | { kind: "unreachable"; error: unknown };

/** A counting semaphore: at most `size` Claude calls in flight (§3.1 "at most 2 Claude calls in flight"). */
export class Slots {
  #free: number;
  readonly #waiters: Array<() => void> = [];

  constructor(size: number) {
    this.#free = Math.max(1, Math.floor(size) || 1);
  }

  async acquire(): Promise<void> {
    if (this.#free > 0) {
      this.#free -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  release(): void {
    const next = this.#waiters.shift();
    if (next) next();
    else this.#free += 1;
  }
}

/** What a company's drafting needs from its run. */
export type DrafterContext = {
  jobId: number;
  api: ClaudeApi;
  reader: WebsiteReader;
  guard: SpendGuard;
  slots: Slots;
  /** The worker's shutdown signal: it stops reading and the start of new calls; a call in flight is never aborted. */
  signal: AbortSignal;
  now: () => Date;
  /** Waits between P8's own retries; resolves early when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The wait before in-process retry `n` (1, 2) of a 5xx, 529 or connection error. */
  retryDelayMs: (n: number) => number;
  /** Setting "sharedDomains.extra". */
  extraShared: ReadonlySet<string>;
  logger: AiLogger;
  /** True once the run stops for a reason that makes new calls pointless (a pause, a rate limit, Claude unreachable, shutdown). */
  callsBlocked: () => boolean;
  /** Hands a run-level failure to the run; resolves once a pause (if any) was written. */
  stop: (request: StopRequest) => Promise<void>;
  /**
   * A call of this draft may have been billed but brought no answer (a timeout, an unreadable answer). True when calls
   * of two or more different companies did so with no answer in between: Claude itself looks unreachable, so the run
   * stops. One slow company alone doesn't stop the run (M5 review AI-2).
   */
  unanswered: (draftId: number) => boolean;
  /** A call came back with an answer: Claude is reachable (the unanswered companies are forgotten). */
  answered: () => void;
};

/** The model a company is drafted with (resolved from the current settings when it was claimed, §3.3). */
export type ModelUse = { profile: ResolvedProfile; systemTokens: number };

/** How a company's draft ended in this run. */
export type CompanyEnd =
  | { status: "READY" | "NO_LINE" | "FAILED" }
  /** Back to QUEUED (a pause, a rate limit, shutdown…): drafted again later. */
  | { status: "requeued" }
  /** A compare-and-set lost: another attempt owns the draft; the result was dropped. */
  | { status: "lost" };

/** An ordinary 429 with a retry-after up to this long is waited for in-process, once (§3.7 "P8's own retries"). */
export const IN_PROCESS_RATE_LIMIT_MAX_MS = 20_000;
/** In-process retries of a 5xx, 529 or connection error (after 2 s and 8 s by default). */
export const IN_PROCESS_SERVER_RETRIES = 2;
/**
 * Calls of one company that may have been billed but brought no answer (a timeout, an unreadable answer) before only
 * that company fails (M5 review AI-2). With the regeneration and the `max_tokens` retry this keeps a company at
 * DRAFTER_MAX_CALLS (@/core/ai/estimate) calls at most.
 */
export const MAX_UNANSWERED_CALLS = 2;

// ───────────── pages ─────────────

/** A page as Claude is sent it, with where it is stored. */
type UsedPage = ReadPageLike;

type SitePages =
  | { kind: "pages"; pages: UsedPage[]; noteFlags: DraftFlag[]; injectionHint: boolean | undefined; homeId: number | null; pageId: number | null }
  | { kind: "skip"; code: SkipCode; snapshotId: number | null }
  | { kind: "requeue" };

/** The read's notes as draft flags (hidden-text comes from the checks, which see the page notes). */
function noteFlags(notes: readonly string[]): DraftFlag[] {
  const out: DraftFlag[] = [];
  if (notes.includes("metadata-only")) out.push(METADATA_ONLY_FLAG);
  if (notes.includes("second-page-failed")) out.push(SECOND_PAGE_FAILED_FLAG);
  return out;
}

/**
 * The company's pages: the latest snapshots (unless the draft asks to read the website again), else a fresh read that
 * is stored as snapshots (a skip as one skip row). Reading stops at shutdown; the draft then goes back to the queue and
 * nothing is stored.
 */
async function sitePages(d: ClaimedDraft, website: string, companyName: string, cx: DrafterContext): Promise<SitePages> {
  const now = cx.now();
  const reused = await reusableSnapshots(d.companyId, now, d.refetch);
  if (reused?.skip) return { kind: "skip", code: reused.skip, snapshotId: null };
  if (reused && reused.pages.length > 0) {
    const home = reused.pages.find((p) => p.kind === "homepage") ?? null;
    const second = reused.pages.find((p) => p.kind === "second_page") ?? null;
    return {
      kind: "pages",
      pages: reused.pages,
      noteFlags: noteFlags(reused.pages.flatMap((p) => p.notes)),
      injectionHint: undefined,
      homeId: home?.snapshotId ?? null,
      pageId: second?.snapshotId ?? null,
    };
  }
  const read = await cx.reader.read({ website, companyName }, { signal: cx.signal, now });
  if (cx.signal.aborted) return { kind: "requeue" };
  if (!read.ok) {
    const ids = await saveSnapshots(d.companyId, read.pages, { code: read.skip, detail: read.detail, url: website }, now);
    return { kind: "skip", code: read.skip, snapshotId: ids.homeId };
  }
  if (read.pages.length === 0) {
    const ids = await saveSnapshots(d.companyId, [], { code: "thin", detail: null, url: website }, now);
    return { kind: "skip", code: "thin", snapshotId: ids.homeId };
  }
  const ids = await saveSnapshots(d.companyId, read.pages, null, now);
  return {
    kind: "pages",
    pages: read.pages,
    noteFlags: noteFlags(read.notes),
    injectionHint: read.injectionHint,
    homeId: ids.homeId,
    pageId: ids.pageId,
  };
}

/** A title exactly as the user message carries it (stripped and trimmed; empty is no title). */
function sentTitle(title: string | null): string | null {
  if (title == null) return null;
  const t = stripOurTags(title).trim();
  return t ? t : null;
}

/** The page lines of the request (the final URL: where the text really came from). */
function linePages(pages: readonly UsedPage[]): LinePageInput[] {
  return pages.map((p) => ({ source: p.kind, url: p.finalUrl || p.url, lang: p.lang, title: p.title, text: p.text }));
}

/** The pages for the checks: exactly the title and text the request carried (after stripOurTags), with the notes. */
function checkPages(pages: readonly UsedPage[]): CheckLinePage[] {
  return pages.map((p) => ({ source: p.kind, title: sentTitle(p.title), text: stripOurTags(p.text), lang: p.lang, notes: p.notes }));
}

// ───────────── outcomes ─────────────

async function finish(cx: DrafterContext, d: ClaimedDraft, out: DraftOutcome): Promise<CompanyEnd> {
  return (await finishDraft(d.id, cx.jobId, out)) ? { status: out.status } : { status: "lost" };
}

async function requeue(cx: DrafterContext, d: ClaimedDraft): Promise<CompanyEnd> {
  return (await requeueDraft(d.id, cx.jobId)) ? { status: "requeued" } : { status: "lost" };
}

function noLine(code: NoLineCode, flags: DraftFlag[], ids: { homeId: number | null; pageId: number | null }): DraftOutcome {
  return { status: "NO_LINE", reasonIfNull: code, flags, homeSnapshotId: ids.homeId, pageSnapshotId: ids.pageId };
}

/** One checked answer. */
type Candidate = { answer: LineAnswer; check: CheckLineResult };

/** An answer that can be shown as a line: a line and a quote from a named page, consistent (§3.6). */
export function usableAnswer(c: Candidate | null): c is Candidate {
  if (!c) return false;
  const { line, evidence_quote: quote, evidence_source: source } = c.answer;
  return (
    typeof line === "string" &&
    line.trim() !== "" &&
    typeof quote === "string" &&
    quote.trim() !== "" &&
    source !== "none" &&
    !c.check.problems.some((p) => p.code === "inconsistent")
  );
}

/**
 * The READY outcome of a usable answer. The evidence page is where the checks found the quote (else the page Claude
 * named); the URL is that page's final URL. Flags: the answer's warnings and notes, plus the read's notes.
 */
function readyOutcome(c: Candidate, pages: readonly UsedPage[], site: Extract<SitePages, { kind: "pages" }>): DraftOutcome {
  const source = c.check.quotePage ?? (c.answer.evidence_source === "second_page" ? "second_page" : "homepage");
  const page = pages.find((p) => p.kind === source) ?? null;
  return {
    status: "READY",
    line: (c.answer.line ?? "").trim(),
    evidenceQuote: (c.answer.evidence_quote ?? "").trim(),
    evidenceSource: source,
    evidenceUrl: page ? page.finalUrl || page.url : null,
    flags: mergeFlags(c.check.flags, site.noteFlags),
    homeSnapshotId: site.homeId,
    pageSnapshotId: site.pageId,
  };
}

// ───────────── one Claude call ─────────────

type CallResult =
  | { kind: "answer"; answer: ClaudeAnswer }
  /** The spend guard refused the call: nothing was sent. */
  | { kind: "refused"; why: SpendRefusal }
  /** The run is stopping (or the worker shuts down): nothing was sent. */
  | { kind: "blocked" }
  | { kind: "failed"; failure: AiFailure; error: unknown };

/** Waits `ms`; false when shutdown or a run-level stop came meanwhile (no new call is started then). */
async function waitBeforeRetry(cx: DrafterContext, ms: number): Promise<boolean> {
  if (ms > 0) {
    try {
      await cx.sleep(ms, cx.signal);
    } catch {
      // Aborted: handled below.
    }
  }
  return !cx.callsBlocked();
}

/**
 * One request to Claude with P8's own retries (§3.7): a 5xx, 529 or connection error is tried again after
 * retryDelayMs(1) and retryDelayMs(2); an ordinary 429 whose retry-after is at most 20 s is waited for once. Every try
 * reserves its ceiling first (acquiring a call slot before, so waiting calls don't hold reservations), notes it on the
 * draft while the call is out (markCallInFlight) and settles it after: the recorded cost for an answer, the ceiling for
 * a call that may have been billed, 0 otherwise.
 */
async function callClaude(cx: DrafterContext, d: ClaimedDraft, req: LineRequest, use: ModelUse): Promise<CallResult> {
  const ceiling = callCeilingUsd(use.profile, use.systemTokens, req.messages[0].content, req.max_tokens);
  let serverRetries = 0;
  let waitedRateLimit = false;
  for (;;) {
    if (cx.callsBlocked()) return { kind: "blocked" };
    await cx.slots.acquire();
    let token = -1;
    let answer: ClaudeAnswer | null = null;
    let error: unknown = null;
    try {
      if (cx.callsBlocked()) return { kind: "blocked" };
      const reservation = cx.guard.reserve(ceiling);
      if (!reservation.ok) return { kind: "refused", why: reservation.why };
      token = reservation.token;
      try {
        // A restart while the call is out charges exactly this ceiling (M5 review AI-7). No note, no call.
        await markCallInFlight(d.id, ceiling);
      } catch (err) {
        cx.guard.settle(token, 0);
        throw err;
      }
      try {
        // Never the job's signal: a paid call is not aborted from outside (§0.2 rule 11); it has its own timeout.
        answer = await cx.api.createLine(req);
      } catch (err) {
        error = err;
      }
    } finally {
      cx.slots.release();
    }

    if (answer) {
      cx.answered();
      const cost = costUsd(answer.usage, use.profile.prices);
      try {
        await recordCall(
          d.id,
          {
            inputTokens: totalInputTokens(answer.usage),
            outputTokens: answer.usage.outputTokens,
            costUsd: cost,
            requestId: answer.requestId,
            stopReason: answer.stopReason,
            estimated: false,
          },
          cx.now(),
        );
      } finally {
        cx.guard.settle(token, cost);
      }
      return { kind: "answer", answer };
    }

    const failure = classifyAnthropicError(error, { now: cx.now() });
    if (failure.kind === "backoff" && failure.mayBeBilled) {
      // The request left and no usable answer came (a timeout, an unreadable 200): recorded at its ceiling (never
      // understated), with its request id when the answer's headers came. draftWithClaude decides on one more try.
      try {
        await recordCall(
          d.id,
          { inputTokens: 0, outputTokens: 0, costUsd: ceiling, requestId: requestIdOfError(error), stopReason: null, estimated: true },
          cx.now(),
        );
      } finally {
        cx.guard.settle(token, ceiling);
      }
      return { kind: "failed", failure, error };
    }
    cx.guard.settle(token, 0);
    if (failure.kind === "fail_draft") {
      // Not billed: only the request id is kept (the Failed card's Details show it); it isn't counted as a call.
      await recordCall(
        d.id,
        { inputTokens: 0, outputTokens: 0, costUsd: 0, requestId: requestIdOfError(error), stopReason: null, estimated: false, notBilled: true },
        cx.now(),
      );
      return { kind: "failed", failure, error };
    }
    // Not billed and nothing to record: the call is no longer out.
    await clearCallInFlight(d.id);
    if (failure.kind === "backoff" && serverRetries < IN_PROCESS_SERVER_RETRIES) {
      serverRetries += 1;
      if (!(await waitBeforeRetry(cx, cx.retryDelayMs(serverRetries)))) return { kind: "blocked" };
      continue;
    }
    if (failure.kind === "requeue" && failure.afterMs <= IN_PROCESS_RATE_LIMIT_MAX_MS && !waitedRateLimit) {
      waitedRateLimit = true;
      if (!(await waitBeforeRetry(cx, failure.afterMs))) return { kind: "blocked" };
      continue;
    }
    return { kind: "failed", failure, error };
  }
}

/** A failure after P8's own retries, as §3.7's table says. */
async function onFailure(
  cx: DrafterContext,
  d: ClaimedDraft,
  res: Extract<CallResult, { kind: "failed" }>,
  use: ModelUse,
): Promise<CompanyEnd> {
  const f = res.failure;
  switch (f.kind) {
    case "fail_draft": {
      // The API's own message goes to the worker log only (scrubbed), with the draft and request ids.
      const detail = await scrubProviderText(f.message);
      cx.logger.warn(`Claude couldn't write a line for draft #${d.id} (request ${requestIdOfError(res.error) ?? "none"}): ${detail}`);
      return finish(cx, d, { status: "FAILED", error: CLAUDE_FAILED_TEXT, flags: [] });
    }
    case "pause":
      await cx.stop({ kind: "pause", reason: f.reason, model: use.profile.id, error: res.error });
      return requeue(cx, d);
    case "requeue":
      await cx.stop({ kind: "rate-limited", afterMs: f.afterMs });
      return requeue(cx, d);
    case "backoff":
      // Not billed (5xx, 529, connection errors after P8's own retries): Claude is unreachable for the whole run.
      // (A call that may have been billed but brought no answer is handled per company in draftWithClaude.)
      await cx.stop({ kind: "unreachable", error: res.error });
      return requeue(cx, d);
  }
}

// ───────────── the company ─────────────

/**
 * Drafts one claimed company (FETCHING). Returns how its draft ended; throws only on unexpected errors (the database),
 * which leave the draft as it is for the next handler start (resetStuckDrafts).
 */
export async function draftCompany(d: ClaimedDraft, cx: DrafterContext, use: ModelUse): Promise<CompanyEnd> {
  const company = await db.company.findUnique({
    where: { id: d.companyId },
    select: { id: true, name: true, website: true, instagram: true, country: true, niche: true, domain: true, deletedAt: true },
  });
  if (!company || company.deletedAt) return finish(cx, d, { status: "FAILED", error: COMPANY_DELETED_TEXT, flags: [] });

  // The skip rules again (§3.2): the company may have changed since the start.
  const site = companySite(company, cx.extraShared);
  const noIds = { homeId: null, pageId: null };
  if (site.kind === "none") return finish(cx, d, noLine("no_website", [], noIds));
  if (site.kind === "social") return finish(cx, d, noLine("social_only", [], noIds));
  if (cx.callsBlocked()) return requeue(cx, d);

  const website = (company.website ?? "").trim();
  const got = await sitePages(d, website, company.name, cx);
  if (got.kind === "requeue") return requeue(cx, d);
  if (got.kind === "skip") return finish(cx, d, noLine(got.code, [], { homeId: got.snapshotId, pageId: null }));

  if (!(await markDrafting(d.id, cx.jobId))) return { status: "lost" };

  const country = countryName(company.country) || null;
  const input: LineMessageInput = {
    company: { name: company.name, country, niche: company.niche?.trim() || null },
    pages: linePages(got.pages),
  };
  const checkBase: Omit<CheckLineInput, "answer"> = {
    pages: checkPages(got.pages),
    companyName: company.name,
    countryName: country,
    companyDomain: usableCompanyDomain(company.domain, cx.extraShared),
    avoid: [...(await recentAvoidLines(d.companyId)), ...d.avoidLines],
    injectionHint: got.injectionHint,
  };
  return draftWithClaude(cx, d, use, input, checkBase, got);
}

/**
 * §3.6 "Order of handling": call 1 → parse → a null line is NO_LINE (no regeneration) → checks pass: READY → checks
 * fail on the first call: call 2 with the failing line added to <avoid_repeating> and the first problem's text as
 * <previous_problem> → call 2 passes: READY; fails: READY with the warnings, unless no usable answer came (the
 * consistency check failed twice: FAILED). A `max_tokens` stop is retried once with double `max_tokens` (it doesn't
 * count as the failed call); `refusal` is NO_LINE model_declined.
 *
 * When a later call can't be made (the spend guard refuses it, the run stops, the worker shuts down), a usable first
 * answer is kept (READY with its warnings) instead of paying for it again; otherwise the draft goes back to the queue.
 *
 * A call that may have been billed but brought no answer (a timeout, an unreadable answer; recorded at its ceiling) is
 * made once more; the second such call ends this company only: a usable first answer is kept, else FAILED "Claude took
 * too long…". Only unanswered calls of several companies in a row stop the run as "Claude unreachable" (M5 review AI-2).
 */
async function draftWithClaude(
  cx: DrafterContext,
  d: ClaimedDraft,
  use: ModelUse,
  input: LineMessageInput,
  checkBase: Omit<CheckLineInput, "answer">,
  site: Extract<SitePages, { kind: "pages" }>,
): Promise<CompanyEnd> {
  const ids = { homeId: site.homeId, pageId: site.pageId };
  let maxTokens = use.profile.maxTokens;
  let maxTokensRetried = false;
  let attempt: 1 | 2 = 1;
  let avoid = [...d.avoidLines];
  let previousProblem: string | null = null;
  let first: Candidate | null = null;
  let unanswered = 0;

  const keepFirstOrRequeue = async (): Promise<CompanyEnd> =>
    usableAnswer(first) ? finish(cx, d, readyOutcome(first, site.pages, site)) : requeue(cx, d);

  for (;;) {
    const req = buildLineRequest({ ...input, avoid, previousProblem }, use.profile, { maxTokens });
    const res = await callClaude(cx, d, req, use);
    if (res.kind === "refused") {
      await cx.stop(res.why === "run_cap" ? { kind: "run-cap" } : { kind: "monthly-limit", model: use.profile.id });
      return keepFirstOrRequeue();
    }
    if (res.kind === "blocked") return keepFirstOrRequeue();
    if (res.kind === "failed" && res.failure.kind === "backoff" && res.failure.mayBeBilled) {
      unanswered += 1;
      if (cx.unanswered(d.id)) {
        // Other companies' calls went unanswered too: Claude itself looks unreachable, so the whole run stops (§3.7).
        await cx.stop({ kind: "unreachable", error: res.error });
        return keepFirstOrRequeue();
      }
      // The same request once more (a new reservation; the unanswered call stays charged at its ceiling).
      if (unanswered < MAX_UNANSWERED_CALLS) continue;
      cx.logger.warn(
        `Claude didn't answer ${unanswered} calls for draft #${d.id} (request ${requestIdOfError(res.error) ?? "none"}); only this company is given up`,
      );
      return usableAnswer(first)
        ? finish(cx, d, readyOutcome(first, site.pages, site))
        : finish(cx, d, { status: "FAILED", error: CLAUDE_TOO_SLOW_TEXT, flags: [] });
    }
    if (res.kind === "failed") return onFailure(cx, d, res, use);

    const read = readLineAnswer(res.answer);
    if (read.kind === "max_tokens" && !maxTokensRetried) {
      maxTokensRetried = true;
      maxTokens = retryMaxTokens(maxTokens);
      continue;
    }
    if (read.kind === "refusal") return finish(cx, d, noLine("model_declined", site.noteFlags, ids));

    let candidate: Candidate | null = null;
    if (read.kind === "ok") {
      // The second answer must not repeat the first one either.
      const firstLine = attempt === 2 && typeof first?.answer.line === "string" ? first.answer.line : null;
      const check = checkLine({ ...checkBase, avoid: firstLine ? [...checkBase.avoid, firstLine] : checkBase.avoid, answer: read.value });
      if (check.pass) {
        return read.value.line === null
          ? finish(cx, d, noLine(read.value.reason_if_null ?? "content_unreadable", site.noteFlags, ids))
          : finish(cx, d, readyOutcome({ answer: read.value, check }, site.pages, site));
      }
      candidate = { answer: read.value, check };
    } else if (read.kind === "bad") {
      cx.logger.warn(`Claude's answer for draft #${d.id} couldn't be used (request ${res.answer.requestId ?? "none"}): ${read.reason}`);
    }

    if (attempt === 1) {
      // Regenerate once: the failing line joins the lines not to repeat; the first problem is named.
      attempt = 2;
      first = candidate;
      if (candidate && typeof candidate.answer.line === "string" && candidate.answer.line.trim()) {
        avoid = [...d.avoidLines, candidate.answer.line];
      }
      previousProblem = candidate && candidate.check.problems.length > 0 ? problemText(candidate.check.problems[0]!) : null;
      continue;
    }

    // Second failure: the newest usable answer is shown with its warnings; reviewers decide.
    const final = usableAnswer(candidate) ? candidate : usableAnswer(first) ? first : null;
    if (final) return finish(cx, d, readyOutcome(final, site.pages, site));
    const error = candidate || first ? ANSWER_MISMATCH_TEXT : ANSWER_UNREADABLE_TEXT;
    return finish(cx, d, { status: "FAILED", error, flags: [] });
  }
}
