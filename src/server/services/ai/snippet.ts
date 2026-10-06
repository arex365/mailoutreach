import { quoteNeedle } from "@/core/ai/checks";
import { withPositionMap } from "@/core/ai/normalize";
import { stripOurTags } from "@/core/ai/prompt";

/**
 * The evidence snippet on a review card (docs/dev/M5-DESIGN.md §3.9 "Snippet"): where Claude's quote sits on the saved
 * page, with up to 300 characters on each side. It searches exactly what Claude was sent for the page and what the
 * automatic quote check (P2 `checkLine`) searched: `title + "\n" + text` after `stripOurTags` (tag imitations and
 * invisible characters removed), with the check's own needle (`quoteNeedle`: the contract normaliser, without leading
 * and trailing punctuation and quotation marks). So a quote the check found word for word is always found here (curly
 * quotes, dashes, no-break spaces, soft hyphens and zero-width characters on the page included; M5 review AI-9). The
 * snippet's words come from the stripped text. Pure: no database, safe to unit-test.
 */

/** Characters of context on each side of the match. */
export const SNIPPET_CONTEXT = 300;

export type EvidenceSnippet = { before: string; match: string; after: string };

/**
 * What Claude saw for one page, as the drafting job sent and checked it: its title, a line break, then its text, each
 * through `stripOurTags` (an empty title is left out, §3.6).
 */
export function pageSource(page: { title: string | null; text: string }): string {
  const title = page.title == null ? "" : stripOurTags(page.title).trim();
  const text = stripOurTags(page.text ?? "");
  return title ? `${title}\n${text}` : text;
}

/** Runs of whitespace (line breaks included) as one space: the card shows the snippet as one flowing paragraph. */
function flat(s: string): string {
  return s.replace(/\s+/g, " ");
}

/** The last `max` characters of `s`, starting at a word boundary, with "…" in front when something was cut. */
function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(s.length - max);
  // The window starts inside a word: drop that partial word (unless the whole window is one word).
  if (!/\s/.test(s[s.length - max - 1]!)) {
    const space = cut.search(/\s/);
    if (space >= 0 && space < cut.length - 1) cut = cut.slice(space + 1);
  }
  return `…${cut}`;
}

/** The first `max` characters of `s`, ending at a word boundary, with "…" after when something was cut. */
function head(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  // The window ends inside a word: drop that partial word (unless the whole window is one word).
  if (!/\s/.test(s[max]!)) {
    let space = -1;
    for (let i = cut.length - 1; i > 0; i--) {
      if (/\s/.test(cut[i]!)) {
        space = i;
        break;
      }
    }
    if (space > 0) cut = cut.slice(0, space);
  }
  return `${cut}…`;
}

/**
 * The quote on the page with ±300 characters around it (cut at word boundaries, "…" at cut ends, whitespace runs shown
 * as single spaces), or null when the check's needle isn't in the normalised page (an approximate quote, an empty
 * quote, or a different page).
 */
export function evidenceSnippet(page: { title: string | null; text: string }, quote: string | null | undefined): EvidenceSnippet | null {
  const q = quoteNeedle(quote);
  if (!q) return null;
  const original = pageSource(page);
  const map = withPositionMap(original);
  const at = map.text.indexOf(q);
  if (at < 0) return null;
  const from = map.start[at]!;
  const to = map.end[at + q.length - 1]!;
  return {
    before: flat(tail(original.slice(0, from), SNIPPET_CONTEXT)).trimStart(),
    match: flat(original.slice(from, to)).trim(),
    after: flat(head(original.slice(to), SNIPPET_CONTEXT)).trimEnd(),
  };
}
