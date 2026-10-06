import type { DraftFlag } from "@/core/ai/types";
import { formatUsd, smallUsd } from "@/core/money";
import { plural } from "@/core/text";

/**
 * Every sentence the drafting job writes (docs/dev/M5-DESIGN.md §3.7, §3.8, §3.10, §3.12): the notifications to the
 * requester, the job's summaries, the notes on a draft and the plain FAILED sentences (never a provider's own text,
 * §0.2 rule 13). Pure, so the texts are unit-tested.
 */

// ───────────── notifications (§3.10) ─────────────

export const DRAFTS_READY_TITLE = "AI lines ready to review";
export const RUN_STOPPED_TITLE = "AI drafting stopped early";
export const AI_LINES_LINK = "/ai-lines";

/** What a run ended with: lines drafted (waiting, or already reviewed), companies without a line, failures, cost. */
export type DraftRunCounts = { ready: number; noLine: number; failed: number; costUsd: number };

/** "5 companies got no line and 1 failed." / "1 company got no line." / "2 companies failed." / "". */
function noLineAndFailed(c: DraftRunCounts): string {
  if (c.noLine > 0 && c.failed > 0) return `${plural(c.noLine, "company", "companies")} got no line and ${c.failed.toLocaleString("en-US")} failed.`;
  if (c.noLine > 0) return `${plural(c.noLine, "company", "companies")} got no line.`;
  if (c.failed > 0) return `${plural(c.failed, "company", "companies")} failed.`;
  return "";
}

/** "Cost $0.16." (left out when nothing was spent). */
function costPart(c: DraftRunCounts): string {
  return c.costUsd > 0 ? `Cost ${formatUsd(c.costUsd)}.` : "";
}

function sentences(parts: string[]): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * The `ai.draftsReady` body: "27 lines are waiting for you. 5 companies got no line and 1 failed. Cost $0.16." Each
 * part only when it isn't zero.
 */
export function draftsReadyBody(c: DraftRunCounts): string {
  return sentences([c.ready > 0 ? `${plural(c.ready, "line is", "lines are")} waiting for you.` : "", noLineAndFailed(c), costPart(c)]);
}

/**
 * The `ai.runStopped` body: "This run was about to cost more than expected ($3.33 so far; at most $2.70 was estimated),
 * so it stopped after 180 of 300 companies. The drafted lines are waiting for review." Amounts under a dollar get three
 * decimals ("$0.014 so far; at most $0.011"), so two small amounts never read the same.
 */
export function runStoppedBody(x: { spentUsd: number; atMostUsd: number; done: number; total: number }): string {
  return (
    `This run was about to cost more than expected (${smallUsd(x.spentUsd)} so far; at most ${smallUsd(x.atMostUsd)} was estimated), ` +
    `so it stopped after ${x.done.toLocaleString("en-US")} of ${plural(x.total, "company", "companies")}. The drafted lines are waiting for review.`
  );
}

// ───────────── job summaries (progress screens) ─────────────

/** A finished run: "3 lines are waiting for review. 1 company got no line. Cost $0.01." */
export function draftRunSummary(c: DraftRunCounts): string {
  const text = sentences([c.ready > 0 ? `${plural(c.ready, "line is", "lines are")} waiting for review.` : "", noLineAndFailed(c), costPart(c)]);
  return text || "No lines were drafted.";
}

/** A stopped run (Stop, or its cost cap): "Stopped after 12 of 30 companies." (the same words as P5's stopDraftRun). */
export function stoppedAfterText(done: number, total: number): string {
  return done > 0 ? `Stopped after ${done.toLocaleString("en-US")} of ${plural(total, "company", "companies")}.` : "Drafting stopped before it started.";
}

/** While the run waits for its next turn: "12 of 30 companies drafted so far." */
export function progressSummary(done: number, total: number): string {
  return `${done.toLocaleString("en-US")} of ${plural(total, "company", "companies")} drafted so far.`;
}

/** While the AI queue is paused: "Paused: <the pause sentence>". */
export function pausedSummary(text: string): string {
  return `Paused: ${text}`;
}

/** While Claude asked us to slow down (a 429 with a long retry-after). */
export const RATE_LIMITED_SUMMARY = "Waiting: Claude asked us to slow down.";

// ───────────── draft notes (§3.8 flags) ─────────────

/** The page needed JavaScript, so Claude was sent its metadata only (§3.4.8). */
export const METADATA_ONLY_FLAG: DraftFlag = {
  code: "metadata-only",
  text: "The website needs JavaScript, so only its short description was read; check the line carefully.",
};
/** The second page couldn't be read (or wasn't the company's content), so only the homepage was used. */
export const SECOND_PAGE_FAILED_FLAG: DraftFlag = {
  code: "second-page-failed",
  text: "The second page couldn't be read, so only the homepage was used.",
};

// ───────────── FAILED sentences (§3.7, §3.6) ─────────────

/** Claude refused this company's request with an error of its own (another 4xx). */
export const CLAUDE_FAILED_TEXT = "Claude couldn't write a line for this company. Click Try again later.";
/** The consistency check failed twice (§3.6). */
export const ANSWER_MISMATCH_TEXT = "Claude's answer didn't fit together.";
/** Two answers in a row couldn't be read at all (not JSON, cut off twice, an unknown stop reason). */
export const ANSWER_UNREADABLE_TEXT = "Claude's answer couldn't be read. Click Try again.";
/** Two calls for this company brought no answer in time (the rest of the run goes on, M5 review AI-2). */
export const CLAUDE_TOO_SLOW_TEXT = "Claude took too long to answer for this company. Click Try again.";
/** The job's error when Claude couldn't be reached (the runner tries again after 1, 5 and 15 minutes). */
export const CLAUDE_UNREACHABLE_TEXT = "Claude couldn't be reached.";
