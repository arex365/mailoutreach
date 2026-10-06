/**
 * The drafting job (docs/dev/M5-DESIGN.md §8 P8): `ai.draftLines` reads company websites, asks Claude for one line per
 * company, runs the automatic checks and stores the drafts, within the spend guard. Worker only: web code never imports
 * this folder (a unit test greps for it), and `.createLine(` is called nowhere else (the spend guard's premise).
 */
export {
  aiDraftLinesJob,
  AI_JOB_LABEL,
  AI_JOB_WHAT_TO_DO,
  CONSOLE_AI_LOGGER,
  createAiDraftLinesJob,
  DEFAULT_CLAUDE_CONCURRENCY,
  DEFAULT_COMPANY_CONCURRENCY,
  DEFAULT_YIELD_AFTER_MS,
  defaultRetryDelayMs,
  PAUSE_RECHECK_MS,
  readAiRunCarry,
  readAiRunPayload,
  runAiDraftLines,
  startingRunCap,
  TIER_CAP_GRACE_MS,
  type AiDeps,
  type AiLogger,
  type AiRunResult,
} from "./run";
export { SpendGuard, type SpendGuardInit, type SpendGuardState, type SpendRefusal } from "./spend-guard";
export {
  PRACTICE_FLAG,
  PRACTICE_MODEL,
  PRACTICE_NO_LINE_EVERY,
  PRACTICE_QUOTE,
  practiceLine,
  practiceOutcome,
  runPracticeDrafts,
} from "./practice";
export {
  draftCompany,
  IN_PROCESS_RATE_LIMIT_MAX_MS,
  IN_PROCESS_SERVER_RETRIES,
  MAX_UNANSWERED_CALLS,
  Slots,
  usableAnswer,
  type CompanyEnd,
  type DrafterContext,
  type ModelUse,
  type StopRequest,
} from "./drafter";
export * from "./words";
