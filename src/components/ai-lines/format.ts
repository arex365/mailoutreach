import { AI_QUEUE_TABS, AI_TAB_LABELS, PERSONAL_LINE_MAX_WORDS, type AiDraftStatusValue, type AiQueueTab, type DraftFlagCode } from "@/core/ai/types";
import { formatUsd } from "@/core/money";
import { plural } from "@/core/text";
import { formatShortDate, formatTime } from "@/core/time/format";
import type { ActiveRun, DraftCardView } from "@/server/services/ai/queue";

/**
 * The words of the AI lines page (docs/dev/M5-DESIGN.md §6.7): tabs and their addresses, the run cards, the review
 * cards' lines, the empty tabs and the edit counter. Pure and browser-safe (dates in the viewer's zone are formatted on
 * the server and handed to the client components as text), so every sentence is unit-tested.
 */

export const AI_LINES_TITLE = "AI lines";
export const AI_LINES_DESCRIPTION = "Lines Claude drafted from each company's website. Only lines you approve are used in emails.";

/** "/ai-lines", "/ai-lines?tab=approved", "/ai-lines?tab=failed&page=2". */
export function aiLinesHref(tab: AiQueueTab, page = 1): string {
  const params = new URLSearchParams();
  if (tab !== "waiting") params.set("tab", tab);
  if (page > 1) params.set("page", String(Math.floor(page)));
  const q = params.toString();
  return q ? `/ai-lines?${q}` : "/ai-lines";
}

/** The tab from `?tab=`, Waiting for anything else. */
export function parseAiTab(v: string | null | undefined): AiQueueTab {
  return v && (AI_QUEUE_TABS as readonly string[]).includes(v) ? (v as AiQueueTab) : "waiting";
}

/** "Waiting (27)". */
export function tabLabel(tab: AiQueueTab, count: number): string {
  return `${AI_TAB_LABELS[tab]} (${Math.max(0, count).toLocaleString("en-US")})`;
}

/** The pager's noun per tab ("Page 2 of 5 · 230 lines"). */
export function pagerNoun(tab: AiQueueTab): [string, string] {
  return tab === "no-line" || tab === "failed" ? ["company", "companies"] : ["line", "lines"];
}

/** Each tab's empty state (§6.7): the sentence, and whether it points at Contacts or back at the Waiting tab. */
export const EMPTY_TABS: Readonly<Record<AiQueueTab, { title: string; description: string | null; next: "contacts" | "waiting" }>> = {
  waiting: {
    title: "Nothing to review.",
    description: "On Contacts, select companies and choose Draft personal lines.",
    next: "contacts",
  },
  approved: { title: "No approved lines yet.", description: "Approve lines on the Waiting tab.", next: "waiting" },
  rejected: { title: "No rejected lines.", description: null, next: "waiting" },
  "no-line": { title: "Every drafted company got a line.", description: null, next: "waiting" },
  failed: { title: "Nothing failed.", description: null, next: "waiting" },
};

/** The website languages the reader recognises, as the card says them ("German website"). */
export const LANGUAGE_NAMES: Readonly<Record<string, string>> = { de: "German", nb: "Norwegian", no: "Norwegian", nn: "Norwegian", en: "English" };

function capitalise(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** Lower-cases the first letter of a sentence part ("Written by Ali" → "written by Ali"), never of "AI". */
export function lowerFirst(s: string): string {
  if (s.length > 1 && /\p{Lu}/u.test(s[0]!) && /\p{Ll}/u.test(s[1]!)) return s[0]!.toLowerCase() + s.slice(1);
  return s;
}

/** "German website · read 3 Oct" / "Read 3 Oct" / "German website" (the language of the page the quote came from). */
export function readLine(card: Pick<DraftCardView, "pageLang" | "readAt">, timeZone: string, now: Date): string | null {
  const lang = card.pageLang ? LANGUAGE_NAMES[card.pageLang.toLowerCase()] : undefined;
  const parts = [lang ? `${lang} website` : null, card.readAt ? `read ${formatShortDate(card.readAt, timeZone, now)}` : null].filter(
    (p): p is string => p !== null,
  );
  return parts.length ? capitalise(parts.join(" · ")) : null;
}

/** "Checked 3 Oct" on a No line or Failed card. */
export function checkedLine(readAt: string | null, timeZone: string, now: Date): string | null {
  return readAt ? `Checked ${formatShortDate(readAt, timeZone, now)}` : null;
}

/** "18 words" / "1 word". */
export function wordsText(n: number): string {
  return plural(Math.max(0, n), "word", "words");
}

/** "22 words (aim for 25 or fewer)": the edit box's counter. */
export function editCounterText(words: number): string {
  return `${wordsText(words)} (aim for ${PERSONAL_LINE_MAX_WORDS} or fewer)`;
}

/** The edit box's own error past 300 characters (the server says the same with the exact length). */
export const EDIT_TOO_LONG_TEXT = "Keep the personal line under 300 characters. Shorter lines read better.";

/** "Replaces the current line: “…” (written by Ali on 3 Mar)". */
export function currentLineText(current: { line: string; sourceText: string } | null): string | null {
  if (!current) return null;
  const source = current.sourceText.trim();
  return `Replaces the current line: “${current.line}”${source ? ` (${lowerFirst(source)})` : ""}`;
}

/** Flags that are notes about how the line was made, not problems with it (shown with an info icon). */
export const NOTE_FLAG_CODES: ReadonlySet<DraftFlagCode> = new Set<DraftFlagCode>([
  "quote-other-page",
  "metadata-only",
  "second-page-failed",
  "cost-estimated",
  "practice",
]);

/** A link to a page only when it is plain http(s) (website text is untrusted: never a javascript: link). */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** A review card as the client component shows it: the service's card plus its lines in words. */
export type DraftCardDisplay = {
  id: number;
  status: AiDraftStatusValue;
  companyId: number;
  companyName: string;
  /** "firma.de" (the company's website host). */
  host: string | null;
  /** The company's website as a safe link (No line cards). */
  websiteHref: string | null;
  /** "German website · read 3 Oct" (Waiting, Approved, Rejected) or "Checked 3 Oct" (No line, Failed). */
  metaLine: string | null;
  /** The line shown: Claude's, or the approved (final) one. */
  line: string | null;
  wordsText: string | null;
  snippet: { before: string; match: string; after: string } | null;
  snippetNote: string | null;
  quote: string | null;
  /** "Open the page": the quote's page, only when it is a plain http(s) address. */
  pageHref: string | null;
  flags: Array<{ code: DraftFlagCode; text: string; note: boolean }>;
  noLineText: string | null;
  error: string | null;
  requestId: string | null;
  currentLineText: string | null;
  reviewedText: string | null;
  canUndoUntil: string | null;
  costText: string;
};

/** The card's words for the viewer (their zone, now). */
export function toDraftCardDisplay(card: DraftCardView, timeZone: string, now: Date): DraftCardDisplay {
  const finished = card.status === "NO_LINE" || card.status === "FAILED";
  const shown = card.status === "APPROVED" ? (card.finalLine ?? card.line) : card.line;
  return {
    id: card.id,
    status: card.status,
    companyId: card.company.id,
    companyName: card.company.name || "A deleted company",
    host: card.company.host,
    websiteHref: safeHttpUrl(card.company.website),
    metaLine: finished ? checkedLine(card.readAt, timeZone, now) : readLine(card, timeZone, now),
    line: shown,
    wordsText: shown ? wordsText(card.words) : null,
    snippet: card.snippet,
    snippetNote: card.snippetNote,
    quote: card.quote,
    pageHref: safeHttpUrl(card.evidenceUrl),
    flags: card.flags.map((f) => ({ code: f.code, text: f.text, note: NOTE_FLAG_CODES.has(f.code) })),
    noLineText: card.noLineText,
    error: card.error,
    requestId: card.requestId,
    currentLineText: currentLineText(card.currentLine),
    reviewedText: card.reviewedText,
    canUndoUntil: card.canUndoUntil,
    costText: card.costText,
  };
}

/** "14:05" today, else "27 Sep at 14:05", in the viewer's zone. */
export function runWhenText(iso: string, timeZone: string, now: Date): string {
  const day = formatShortDate(iso, timeZone, now);
  const time = formatTime(iso, timeZone);
  return day === formatShortDate(now, timeZone, now) ? time : `${day} at ${time}`;
}

/** A run card's sentence (§6.7): running, queued (after the current run), or waiting after a deferral. */
export function runText(run: ActiveRun, ctx: { timeZone: string; now: Date; anotherRunning: boolean }): string {
  const companies = plural(run.total, "company", "companies");
  const by = run.requestedByName ? ` Started by ${run.requestedByName}.` : "";
  if (run.status === "RUNNING") {
    const what = run.total === 1 ? "a line" : "lines";
    return `Drafting ${what} for ${companies}: ${run.done.toLocaleString("en-US")} done, ${formatUsd(run.spentUsd)} so far.${by}`;
  }
  if (run.waitingUntil) {
    const at = runWhenText(run.waitingUntil, ctx.timeZone, ctx.now);
    switch (run.deferred) {
      case "rate-limited":
        return `Waiting: Claude asked us to slow down. Drafting goes on at ${at}.${by}`;
      case "paused":
        return `Waiting: AI drafting is paused. The app checks again at ${at}.${by}`;
      case "yield":
        return `Waiting: a smaller drafting run goes first. Drafting goes on at ${at}.${by}`;
      case "retry-later":
        return `Waiting: Claude couldn't be reached. Drafting goes on at ${at}.${by}`;
      default:
        return `Waiting: drafting goes on at ${at}.${by}`;
    }
  }
  return `Waiting to start: ${companies}${ctx.anotherRunning ? ", after the current run" : ""}.${by}`;
}

/** "The 18 companies not drafted yet are taken off the list. Lines already drafted stay." */
export function stopDialogText(run: Pick<ActiveRun, "total" | "done">): string {
  const left = Math.max(0, run.total - run.done);
  return left === 1
    ? "The 1 company not drafted yet is taken off the list. Lines already drafted stay."
    : `The ${left.toLocaleString("en-US")} companies not drafted yet are taken off the list. Lines already drafted stay.`;
}
