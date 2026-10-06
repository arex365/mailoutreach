/** Milestone 5 contract (docs/dev/M5-DESIGN.md §3.6): text normalisation for quote matching. Browser-safe, pure. */
export type PositionMap = {
  /** The normalised text. */
  text: string;
  /** For each UTF-16 unit of `text`: where the character cluster that produced it starts and ends in the original. */
  start: number[];
  end: number[];
};

/**
 * One cluster normalised: NFKC, lowercase, curly single quotes (‘ ’ ‚ ‛) → ', double quotes and guillemets (“ ” „ ‟ « »)
 * → ", hyphens and dashes (U+2010–U+2015, minus U+2212) → -, the ellipsis → "...", no-break spaces (U+00A0, U+202F) →
 * space, invisible characters (soft hyphen, zero-width space/joiners, word joiner, BOM) removed. Written with \u escapes
 * so no invisible character sits in the source.
 */
function normUnit(u: string): string {
  return u
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[  ]/g, " ")
    .replace(/[­​-‍⁠﻿]/g, "");
}

/** Normalises cluster by cluster (a base character with its combining marks), keeping where each output unit came from. */
export function withPositionMap(original: string): PositionMap {
  let text = "";
  const start: number[] = [];
  const end: number[] = [];
  let pos = 0;
  let space: { s: number; e: number } | null = null;
  for (const unit of original.match(/\P{M}\p{M}*|\p{M}+/gu) ?? []) {
    const s = pos;
    const e = (pos += unit.length);
    for (const ch of normUnit(unit)) {
      if (/\s/u.test(ch)) {
        space ??= { s, e };
        continue;
      }
      if (space && text.length > 0) {
        text += " ";
        start.push(space.s);
        end.push(space.e);
      }
      space = null;
      for (let k = 0; k < ch.length; k++) {
        start.push(s);
        end.push(e);
      }
      text += ch;
    }
  }
  return { text, start, end };
}

/** NFKC, lowercase, quotes/dashes/ellipsis unified, invisible characters removed, whitespace collapsed and trimmed. */
export function normalizeForMatch(s: string): string {
  return withPositionMap(s).text;
}

/** For word lookups: also without diacritics, ß → ss, ø → o, æ → ae (å → a comes from dropping the ring). */
export function foldForLookup(s: string): string {
  return normalizeForMatch(s).normalize("NFKD").replace(/\p{M}+/gu, "").replace(/ß/g, "ss").replace(/ø/g, "o").replace(/æ/g, "ae");
}
