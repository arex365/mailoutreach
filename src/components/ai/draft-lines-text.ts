import { limitUsdText } from "@/core/ai/estimate";
import { aboutUsd, formatUsd } from "@/core/money";
import { plural } from "@/core/text";

/**
 * The words of the "Draft personal lines" dialog (docs/dev/M5-DESIGN.md §6.8), built from plain facts the server sends
 * (`estimateDraftLinesAction`): who will be drafted and who is skipped, the cost, this month's spend, and why a start
 * would be refused. Pure and browser-safe, so every sentence is unit-tested.
 */

/** Who a start is for: ticked companies (Contacts), a list (its menu) or one company (the company panel). */
export type DraftLinesTarget = { companyIds: number[] } | { listId: number } | { companyId: number };

/** What the dialog sends to start: its target, "Draft new lines for these too", and the "at most" it showed. */
export type StartDraftLinesInput =
  | { companyIds: number[]; redraft: boolean; confirmedAtMostUsd: number }
  | { listId: number; redraft: boolean; confirmedAtMostUsd: number }
  | { companyId: number; redraft?: boolean; confirmedAtMostUsd?: number };

/** What the server knows about a start, without ids or anything secret. */
export type DraftDialogFacts = {
  /** The company panel's "Draft with AI": one company, its own title and sentences. */
  single: boolean;
  /** The one company's name (panel), else null. */
  companyName: string | null;
  /** Companies asked for (a list's members, deleted ones included). */
  companies: number;
  /** Companies that would get a draft. */
  toDraft: number;
  skipped: { deleted: number; noWebsite: number; socialOnly: number; hasLine: number; waiting: number };
  /** Companies with a personal line that "Draft new lines for these too" would add. */
  redraftable: number;
  /** Whether "Draft new lines for these too" is ticked. */
  redraft: boolean;
  estimate: {
    aboutUsd: number;
    atMostUsd: number;
    modelLabel: string;
    practiceCopy: boolean;
    priceMissing: boolean;
    overLimit: boolean;
    mayReachLimit: boolean;
    monthly: { limitUsd: number; spentUsd: number; monthLabel: string; resetLabel: string };
  };
  /** Why the start would be refused right now (the server's own sentence), or null. */
  blocker: string | null;
  isOwner: boolean;
  /** An Anthropic key is saved. */
  hasKey: boolean;
};

/** Everything the dialog shows, in words. */
export type DraftDialogTexts = {
  title: string;
  intro: string;
  /** "30 companies will be drafted." (not for the panel, nor when nobody would be drafted). */
  countLine: string | null;
  /** The skip lines, non-zero only ("4 have no website", …). */
  skipLines: string[];
  /** "1 already has a personal line" with the checkbox below it; null when none has one. */
  hasLineLine: string | null;
  /** "Draft new lines for these too (1)". */
  redraftLabel: string | null;
  /** "About $0.17, at most $0.32 with Claude Haiku 4.5." or the practice copy's sentence. */
  costLine: string | null;
  /** "This month: $3.10 of your $20 limit used." (never in the practice copy). */
  monthLine: string | null;
  /** "This may reach your monthly limit. Drafting stops when it's reached." */
  warning: string | null;
  /** The refusal (an error; the start button is disabled). */
  blocker: string | null;
  /** Owner without a key: [Open Settings › AI]. */
  showSettingsLink: boolean;
  /** "Draft 30 lines" / "Draft line". */
  buttonLabel: string;
  canStart: boolean;
};

export const DRAFT_DIALOG_INTRO =
  "Claude reads each company's website and suggests one sentence about their work. You review every line before it's used in an email.";
export const PRACTICE_COST_LINE = "The practice copy writes made-up lines for free. No website is read.";
export const MAY_REACH_LIMIT_TEXT = "This may reach your monthly limit. Drafting stops when it's reached.";
/** While the dialog asks the server who can be drafted. */
export const DRAFT_DIALOG_LOADING = "Working out which companies can be drafted and what it costs…";

/** "4 have no website" / "1 has no website". */
function countWith(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function capitalise(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** "About $0.17, at most $0.32 with Claude Haiku 4.5." */
export function draftCostLine(e: Pick<DraftDialogFacts["estimate"], "aboutUsd" | "atMostUsd" | "modelLabel">): string {
  return `${capitalise(aboutUsd(e.aboutUsd))}, at most ${formatUsd(e.atMostUsd)} with ${e.modelLabel}.`;
}

/** "This month: $3.10 of your $20 limit used." */
export function draftMonthLine(m: { limitUsd: number; spentUsd: number }): string {
  return `This month: ${formatUsd(m.spentUsd)} of your ${limitUsdText(m.limitUsd)} limit used.`;
}

/** The dialog's words for these facts. */
export function draftDialogTexts(f: DraftDialogFacts): DraftDialogTexts {
  const e = f.estimate;
  const title = f.single ? `Draft a personal line${f.companyName ? ` for ${f.companyName}` : ""}` : "Draft personal lines";
  const skipLines: string[] = [];
  if (!f.single) {
    if (f.skipped.deleted > 0) skipLines.push(countWith(f.skipped.deleted, "was deleted", "were deleted"));
    if (f.skipped.noWebsite > 0) skipLines.push(countWith(f.skipped.noWebsite, "has no website", "have no website"));
    if (f.skipped.socialOnly > 0) {
      skipLines.push(countWith(f.skipped.socialOnly, "only has an Instagram or other social link", "only have an Instagram or other social link"));
    }
    if (f.skipped.waiting > 0) {
      skipLines.push(
        countWith(f.skipped.waiting, "already has a line being drafted or waiting for review", "already have a line being drafted or waiting for review"),
      );
    }
  }
  const showRedraft = !f.single && f.redraftable > 0;
  const priced = !e.practiceCopy && !e.priceMissing && f.toDraft > 0;
  return {
    title,
    intro: DRAFT_DIALOG_INTRO,
    countLine: f.single || f.toDraft === 0 ? null : `${plural(f.toDraft, "company", "companies")} will be drafted.`,
    skipLines,
    hasLineLine: showRedraft ? countWith(f.redraftable, "already has a personal line", "already have a personal line") : null,
    redraftLabel: showRedraft ? `Draft new lines for these too (${f.redraftable.toLocaleString("en-US")})` : null,
    costLine: e.practiceCopy ? PRACTICE_COST_LINE : priced ? draftCostLine(e) : null,
    monthLine: e.practiceCopy ? null : draftMonthLine(e.monthly),
    warning: !e.practiceCopy && !e.overLimit && e.mayReachLimit && f.toDraft > 0 ? MAY_REACH_LIMIT_TEXT : null,
    blocker: f.blocker,
    showSettingsLink: f.isOwner && !f.hasKey && !e.practiceCopy,
    buttonLabel: f.single ? "Draft line" : `Draft ${plural(f.toDraft, "line", "lines")}`,
    canStart: f.blocker === null && f.toDraft > 0,
  };
}
