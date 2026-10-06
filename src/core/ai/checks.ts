/**
 * Milestone 5 (docs/dev/M5-DESIGN.md §3.6): the automatic checks on every Claude answer. Browser-safe, pure.
 *
 * The quote is checked against exactly what Claude saw for each page (`title + "\n" + text`, the same strings the job
 * put in the request), with the step-C normaliser that the review queue's snippet uses too, so both always agree. A
 * failing answer is regenerated once with `problemText(problems[0])` as <previous_problem>; after the second failure
 * the line is kept with `flags` as warnings (the job decides, §3.6 "Order of handling").
 *
 * `flags` always holds every warning (one per problem), the quote notes (`quote-other-page`, `approximate-quote`), the
 * "may be too general" warning (`generic-line`) and the page warnings (`injection-hint`, `hidden-text`); those last
 * three never fail an answer, so they never cost a regeneration. `metadata-only`, `second-page-failed` and
 * `cost-estimated` are the job's own notes; merge with `mergeFlags`.
 */
import { foldForLookup, normalizeForMatch } from "./normalize";
import { PERSONAL_LINE_MAX_WORDS, type DraftFlag, type LineAnswer } from "./types";

/** A line needs at least this many words (the prompt asks for at most PERSONAL_LINE_MAX_WORDS). */
export const LINE_MIN_WORDS = 6;
/** The prompt asks for 5–40 words; one word of tolerance for how words are counted. */
export const QUOTE_MIN_WORDS = 4;
export const QUOTE_MAX_WORDS = 40;
/** A quote whose words are this share of one page's words passes as approximate. */
export const APPROXIMATE_QUOTE_SHARE = 0.9;

/** First words that may be capitalised without appearing on the website ("Leipzig-based…" is still checked). */
export const SENTENCE_STARTERS: readonly string[] = [
  "Your", "You", "With", "Since", "From", "Across", "Each", "Every", "Both", "All", "Many", "Most", "Alongside",
  "Besides", "Beyond", "Using",
];
/** Nationality and language adjectives a translated line may use without the website saying them. */
export const NATIONALITY_WORDS: readonly string[] = [
  "German", "Norwegian", "English", "European", "Scandinavian", "Nordic", "British", "American", "Dutch", "French",
  "Swiss", "Austrian", "Danish", "Swedish", "Finnish", "Italian", "Spanish", "Polish",
];
const CALENDAR_WORDS = [
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November",
  "December", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
];

/** Page text addressed to an AI (research ai-and-fetch C4): a warning only, never a failure. */
export const INJECTION_HINT_PATTERN = /ignore (all|previous) instructions|you are (an|a) (ai|language model)|chatgpt|claude|system prompt/i;

/** One page exactly as Claude was sent it. */
export type CheckLinePage = {
  source: "homepage" | "second_page";
  title: string | null;
  /** For a metadata-only page, its metadata text (that is what was sent). */
  text: string;
  lang: string | null;
  /** The page's reader notes; "hidden-text" adds the hidden-text warning. */
  notes?: ReadonlyArray<"metadata-only" | "hidden-text">;
};

export type CheckLineInput = {
  answer: LineAnswer;
  /** Exactly what Claude was sent for each page: its title and its text (for a metadata-only page, the metadata text). */
  pages: CheckLinePage[];
  companyName: string;
  /** The company's English country name (its words may appear in the line). */
  countryName: string | null;
  /** The company's own domain; its name part may appear capitalised in the line. */
  companyDomain: string | null;
  /** Earlier lines of this company (rejected / regenerated) and the last 500 approved lines of other companies. */
  avoid: string[];
  /** The reader already found text addressed to AI (the pages are also scanned here). */
  injectionHint?: boolean;
};

/** The kinds of wording the banned-wording check refuses ("meta": the line talks about their website, not their work). */
export type BannedKind = "praise" | "meta" | "pitch" | "dash" | "quotes" | "emoji";

/** One failed check. `token` is the offending word or number as it appears in the line (or our own banned phrase). */
export type LineProblem =
  | { code: "inconsistent" }
  | { code: "quote-not-found" }
  | { code: "quote-size"; words: number }
  | { code: "number-not-found"; token: string }
  | { code: "name-not-found"; token: string }
  | { code: "too-long"; words: number }
  | { code: "too-short"; words: number }
  | { code: "not-one-sentence"; multiple: boolean }
  | { code: "plain-characters" }
  | { code: "banned-word"; kind: BannedKind; token: string }
  | { code: "link"; kind: "web" | "email" }
  | { code: "repeat" };

export type CheckLineResult = {
  pass: boolean;
  /** In the order of the §3.6 table; the first one's `problemText` goes into <previous_problem>. */
  problems: LineProblem[];
  flags: DraftFlag[];
  /** The page the quote was found on (exactly or approximately), for the draft's evidence URL; null when not found. */
  quotePage: "homepage" | "second_page" | null;
};

/** At most this many missing names or numbers are reported per answer. */
const MAX_TOKEN_PROBLEMS = 3;

// ───────────── text helpers ─────────────

/** NFKC with invisible format characters (zero-width, bidi controls, soft hyphen) removed; case kept. */
function visibleText(s: string): string {
  return s.normalize("NFKC").replace(/\p{Cf}/gu, "");
}

/** Words as people count them: whitespace-separated pieces with at least one letter or digit. */
export function countWords(s: string): number {
  return visibleText(s)
    .split(/\s+/u)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Letter/digit runs (hyphens, apostrophes and punctuation split words). */
function wordTokens(s: string): string[] {
  return s.match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

/** A token for a warning shown to reviewers: no control or format characters, at most 40 characters. */
function displayToken(t: string): string {
  return Array.from(t.replace(/[\p{Cc}\p{Cf}]/gu, "")).slice(0, 40).join("");
}

/** Leading and trailing spaces, punctuation and quotation marks don't count when a quote is looked up. */
function trimQuote(s: string): string {
  return s.replace(/^[\s"'.,;:!?-]+|[\s"'.,;:!?-]+$/gu, "");
}

/**
 * What a quote is looked up by: normalised (@/core/ai/normalize), without leading and trailing spaces, punctuation and
 * quotation marks. The quote check and the review card's evidence snippet both use it, so the card never says "not
 * found" for a quote the check found word for word.
 */
export function quoteNeedle(quote: string | null | undefined): string {
  return trimQuote(normalizeForMatch(quote ?? ""));
}

/** What a page's quote is looked up in: exactly what Claude saw, normalised. */
function haystack(page: CheckLinePage): string {
  return normalizeForMatch(`${page.title ?? ""}\n${page.text ?? ""}`);
}

/** The key two lines are compared by (normalised, without the final full stop). */
function lineKey(s: string): string {
  return normalizeForMatch(s).replace(/[\s.!?]+$/u, "");
}

// ───────────── numbers ─────────────

const NUMBER_GROUP = /\d+(?:[.,:/x×]\d+)*/g;
const THOUSANDS = /^\d{1,3}(?:[.,]\d{3})+$/;
/** "3D" is exempt from the number check. */
const THREE_D = /(?<!\p{N})3[dD](?!\p{N})/gu;

/** The forms a digit group is looked up by: "," and "." alike, "×" as "x", and without thousands separators. */
function numberForms(group: string): string[] {
  const canon = group.replace(/,/g, ".").replace(/×/g, "x");
  const forms = [canon];
  if (THOUSANDS.test(group)) forms.push(group.replace(/[.,]/g, ""));
  return forms;
}

/** Every digit group of the source, with the parts of ratios and sizes ("1:6" → 1, 6; "20x30" → 20, 30). */
function sourceNumbers(text: string): Set<string> {
  const out = new Set<string>();
  for (const g of text.match(NUMBER_GROUP) ?? []) {
    for (const f of numberForms(g)) out.add(f);
    if (/[:/x×]/.test(g)) for (const part of g.split(/[:/x×]/)) for (const f of numberForms(part)) out.add(f);
  }
  return out;
}

// ───────────── wording ─────────────

/** A pattern as a whole word or phrase (letters and digits around it don't count as a match). */
function phrase(pattern: string, flags = "u"): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, flags);
}

/** Praise and filler (checked on the normalised, lower-case line), with the phrase shown in the problem. */
const PRAISE: ReadonlyArray<readonly [string, RegExp]> = [
  ["amazing", phrase("amazing(?:ly)?")],
  ["awesome", phrase("awesome")],
  ["impressive", phrase("impressive(?:ly)?")],
  ["stunning", phrase("stunning(?:ly)?")],
  ["incredible", phrase("incredibl(?:e|y)")],
  ["beautiful", phrase("beautiful(?:ly)?")],
  ["gorgeous", phrase("gorgeous")],
  ["love", phrase("lov(?:e|ed|es|ely)")],
  ["passion", phrase("passion(?:s|ate|ately)?")],
  ["great work", phrase("great work")],
  ["top-notch", phrase("top[- ]?notch")],
  ["innovative", phrase("innovative")],
  ["cutting-edge", phrase("cutting[- ]?edge")],
  ["world-class", phrase("world[- ]?class")],
  ["outstanding", phrase("outstanding")],
  ["fantastic", phrase("fantastic")],
  ["I noticed", phrase("i noticed")],
  ["I came across", phrase("i came across")],
  ["caught my eye", phrase("caught my eye")],
  ["I was impressed", phrase("i was impressed")],
];
/**
 * The banned "your website" entry of §3.6, with its other spellings: your (web) site, homepage, home page, web page,
 * webpage. A line about their website instead of their work fails and is regenerated like any banned wording (checked
 * on the normalised, lower-case line; the phrase shown is ours, never the line's).
 */
const META: ReadonlyArray<readonly [string, RegExp]> = [
  ["your website", phrase("your web ?sites?")],
  ["your site", phrase("your sites?")],
  ["your homepage", phrase("your home ?pages?")],
  ["your web page", phrase("your web ?pages?")],
];
/**
 * Lines that could be said of almost any company ("Your homepage describes the products your company makes and
 * sells.", seen on the cyrillic.example card in the lead's manual check): a "may be too general" warning for the
 * reviewer only, never a failure, because a false positive must not cost a paid regeneration (M5-DESIGN §3.6 note, M5
 * review LEAD-1). Kept small on purpose; checked on the normalised, lower-case line.
 */
const GENERIC_LINE_PATTERNS: readonly RegExp[] = [
  phrase("the (?:products|goods|items) (?:that )?(?:you|your (?:company|business|shop|store|studio|team)) (?:make|makes|offer|offers|sell|sells|produce|produces)"),
  phrase("an? (?:(?:wide|broad|large|huge|great|diverse) )?(?:range|variety|selection) of (?:products|goods|items)"),
  phrase("high[- ]quality (?:products|goods|items)"),
];
/** Mentions of us or an offer (the lower-case line). */
const PITCH: ReadonlyArray<readonly [string, RegExp]> = [
  ["Polygon Paradise", phrase("polygon ?paradise")],
  ["modelling service", phrase("modell?ing services?")],
  ["collaborate", phrase("collaborat\\p{L}*")],
  ["work together", phrase("work(?:ing)? together")],
  ["partner with", phrase("partner(?:ing|ed)? with")],
];
/** First person, in any case except "US" (the United States). */
const FIRST_PERSON = phrase("we|our|ours|us", "giu");

const DASH_ANYWHERE = /[—―]/u;
const DASH_BETWEEN_SPACES = /\s[-‐-–−]\s/u;
const QUOTATION_MARKS = /["“”„‟«»]/u;
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/u;
const NON_LATIN_LETTER = /(?=\p{L})\P{Script=Latin}/u;

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*/u;
const URL_START = /https?:\/\/|(?<![\p{L}\p{N}])www\./iu;
/** Bare domains, which mail clients turn into links ("firma.de"). */
const BARE_DOMAIN = /(?<![\p{L}\p{N}.@-])[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?![\p{L}\p{N}-])/u;

function firstFirstPerson(clean: string): string | null {
  for (const m of clean.matchAll(FIRST_PERSON)) if (m[0] !== "US") return m[0];
  return null;
}

// ───────────── the checks ─────────────

function quoteChecks(
  answer: LineAnswer,
  pages: readonly CheckLinePage[],
  hay: ReadonlyMap<CheckLinePage, string>,
  problems: LineProblem[],
  notes: DraftFlag[],
): CheckLineResult["quotePage"] {
  const quote = answer.evidence_quote ?? "";
  const needle = quoteNeedle(quote);
  let found: CheckLineResult["quotePage"] = null;
  if (needle) {
    const named = pages.filter((p) => p.source === answer.evidence_source);
    const others = pages.filter((p) => p.source !== answer.evidence_source);
    const exactNamed = named.find((p) => hay.get(p)!.includes(needle));
    const exactOther = exactNamed ? undefined : others.find((p) => hay.get(p)!.includes(needle));
    if (exactNamed) {
      found = exactNamed.source;
    } else if (exactOther) {
      found = exactOther.source;
      if (answer.evidence_source !== "none") notes.push(NOTE_FLAGS.quoteOtherPage);
    } else {
      const quoteWords = wordTokens(needle);
      let best: { share: number; page: CheckLinePage } | null = null;
      for (const page of [...named, ...others]) {
        const pageWords = new Set(wordTokens(hay.get(page)!));
        const hits = quoteWords.filter((w) => pageWords.has(w)).length;
        const share = quoteWords.length ? hits / quoteWords.length : 0;
        if (!best || share > best.share) best = { share, page };
      }
      if (best && best.share >= APPROXIMATE_QUOTE_SHARE) {
        found = best.page.source;
        notes.push(NOTE_FLAGS.approximateQuote);
      }
    }
  }
  if (!found) problems.push({ code: "quote-not-found" });
  const words = countWords(quote);
  if (words < QUOTE_MIN_WORDS || words > QUOTE_MAX_WORDS) problems.push({ code: "quote-size", words });
  return found;
}

function groundingChecks(input: CheckLineInput, clean: string, problems: LineProblem[]): void {
  const source = input.pages.map((p) => `${p.title ?? ""}\n${p.text ?? ""}`).join("\n");

  // Numbers: every digit group of the line is on the pages ("3D" exempt; "28" is found in "28mm").
  const numbers = sourceNumbers(normalizeForMatch(source));
  const missingNumbers: string[] = [];
  for (const g of clean.replace(THREE_D, " ").match(NUMBER_GROUP) ?? []) {
    if (numberForms(g).some((f) => numbers.has(f))) continue;
    if (!missingNumbers.includes(g)) missingNumbers.push(g);
  }
  for (const token of missingNumbers.slice(0, MAX_TOKEN_PROBLEMS)) problems.push({ code: "number-not-found", token });

  // Names: every capitalised word is on the pages, or one of the allowed words.
  const sourceWords = new Set(wordTokens(foldForLookup(source)));
  const allowed = new Set<string>(
    [
      "I",
      ...CALENDAR_WORDS,
      ...NATIONALITY_WORDS,
      ...wordTokens(input.countryName ?? ""),
      ...wordTokens(input.companyName ?? ""),
      ...domainWords(input.companyDomain),
    ].map((w) => foldForLookup(w)),
  );
  const tokens = wordTokens(clean);
  const missingNames: string[] = [];
  tokens.forEach((token, i) => {
    if (!/^\p{Lu}/u.test(token)) return;
    if (i === 0 && SENTENCE_STARTERS.includes(token)) return;
    const folded = foldForLookup(token);
    if (!folded || allowed.has(folded) || isGrounded(folded, sourceWords)) return;
    if (!missingNames.includes(token)) missingNames.push(token);
  });
  for (const token of missingNames.slice(0, MAX_TOKEN_PROBLEMS)) problems.push({ code: "name-not-found", token });
}

/** The name part of the company's domain ("figuren-werkstatt.example" → figuren, werkstatt). */
function domainWords(domain: string | null): string[] {
  if (!domain) return [];
  const labels = domain.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  return labels.slice(0, -1).flatMap((l) => wordTokens(l));
}

/** On the pages as a word, or sharing a prefix of at least five letters with one (plurals, possessives, "Leipziger"). */
function isGrounded(folded: string, sourceWords: ReadonlySet<string>): boolean {
  if (sourceWords.has(folded)) return true;
  for (const w of sourceWords) {
    if ((folded.length >= 5 && w.startsWith(folded)) || (w.length >= 5 && folded.startsWith(w))) return true;
  }
  return false;
}

function formChecks(line: string, clean: string, problems: LineProblem[]): void {
  const words = countWords(line);
  if (words > PERSONAL_LINE_MAX_WORDS) problems.push({ code: "too-long", words });
  else if (words < LINE_MIN_WORDS) problems.push({ code: "too-short", words });

  const t = clean.trim();
  const multiple = /[.!?]\s+\p{Lu}/u.test(t);
  if (multiple || !t.endsWith(".") || /[?!]/.test(t)) problems.push({ code: "not-one-sentence", multiple });

  if (HIDDEN_CHARS.test(line) || NON_LATIN_LETTER.test(line)) problems.push({ code: "plain-characters" });
}

function wordingChecks(line: string, clean: string, problems: LineProblem[]): void {
  const norm = normalizeForMatch(line);
  const praise = PRAISE.find(([, re]) => re.test(norm));
  if (praise) problems.push({ code: "banned-word", kind: "praise", token: praise[0] });
  const meta = META.find(([, re]) => re.test(norm));
  if (meta) problems.push({ code: "banned-word", kind: "meta", token: meta[0] });
  const firstPerson = firstFirstPerson(clean);
  const pitch = firstPerson ? [firstPerson.toLowerCase()] : PITCH.find(([, re]) => re.test(norm));
  if (pitch) problems.push({ code: "banned-word", kind: "pitch", token: pitch[0] });
  if (DASH_ANYWHERE.test(clean) || DASH_BETWEEN_SPACES.test(clean)) problems.push({ code: "banned-word", kind: "dash", token: "—" });
  if (QUOTATION_MARKS.test(clean)) problems.push({ code: "banned-word", kind: "quotes", token: '"' });
  if (EMOJI.test(line)) problems.push({ code: "banned-word", kind: "emoji", token: "emoji" });
  if (EMAIL.test(clean)) problems.push({ code: "link", kind: "email" });
  else if (URL_START.test(clean) || BARE_DOMAIN.test(clean)) problems.push({ code: "link", kind: "web" });
}

/** True when the line matches one of the "could be said of almost any company" patterns (a warning only). */
export function isGenericLine(line: string): boolean {
  const norm = normalizeForMatch(line);
  return GENERIC_LINE_PATTERNS.some((re) => re.test(norm));
}

/** The warnings every answer gets from its pages: text addressed to AI, text hidden from visitors. */
function pageFlags(pages: readonly CheckLinePage[], hay: ReadonlyMap<CheckLinePage, string>, injectionHint: boolean | undefined): DraftFlag[] {
  const out: DraftFlag[] = [];
  const injected = injectionHint === true || pages.some((p) => INJECTION_HINT_PATTERN.test(hay.get(p)!));
  if (injected) out.push(NOTE_FLAGS.injectionHint);
  if (pages.some((p) => p.notes?.includes("hidden-text"))) out.push(NOTE_FLAGS.hiddenText);
  return out;
}

/**
 * Runs every check of §3.6 on one answer. A consistent "no line" answer passes (the job stores NO_LINE with its
 * reason). `pass` is false when any check failed; the page warnings never fail an answer.
 */
export function checkLine(input: CheckLineInput): CheckLineResult {
  const { answer } = input;
  const pages = input.pages ?? [];
  const hay = new Map(pages.map((p) => [p, haystack(p)] as const));
  const problems: LineProblem[] = [];
  const notes: DraftFlag[] = [];

  const lineNull = answer.line === null;
  const quoteNull = answer.evidence_quote === null;
  const noSource = answer.evidence_source === "none";
  const hasReason = answer.reason_if_null !== null;
  if (!(lineNull === quoteNull && quoteNull === noSource && noSource === hasReason)) problems.push({ code: "inconsistent" });

  let quotePage: CheckLineResult["quotePage"] = null;
  if (typeof answer.evidence_quote === "string") quotePage = quoteChecks(answer, pages, hay, problems, notes);

  // Warnings about the line that never fail it (so they never cost a regeneration).
  const lineWarnings: DraftFlag[] = [];
  if (typeof answer.line === "string") {
    const line = answer.line;
    const clean = visibleText(line);
    groundingChecks({ ...input, pages }, clean, problems);
    formChecks(line, clean, problems);
    wordingChecks(line, clean, problems);
    const key = lineKey(line);
    if (key && (input.avoid ?? []).some((a) => typeof a === "string" && lineKey(a) === key)) problems.push({ code: "repeat" });
    if (isGenericLine(line)) lineWarnings.push(GENERIC_LINE_FLAG);
  }

  const warnings = problems.map(problemFlag).filter((f): f is DraftFlag => f !== null);
  return {
    pass: problems.length === 0,
    problems,
    flags: mergeFlags(notes, warnings, lineWarnings, pageFlags(pages, hay, input.injectionHint)),
    quotePage,
  };
}

// ───────────── words ─────────────

/** The notes and page warnings (M5-DESIGN §3.6, §3.8). */
export const NOTE_FLAGS = {
  quoteOtherPage: { code: "quote-other-page", text: "The quote is on the other page that was read." },
  approximateQuote: { code: "approximate-quote", text: "The quote matches the page only approximately; check it against the page." },
  injectionHint: { code: "injection-hint", text: "The website contains text addressed to AI; check the line carefully." },
  hiddenText: { code: "hidden-text", text: "The website hides some text from visitors; check the line carefully." },
} as const satisfies Record<string, DraftFlag>;

/** The "may be too general" warning (never a failure, so never a paid regeneration). */
export const GENERIC_LINE_FLAG: DraftFlag = {
  code: "generic-line",
  text: "May be too general: it could describe almost any company. Check it says something specific about their work.",
};

/** A token may go back to Claude inside <previous_problem> only when it looks like a plain word or number. */
const SAFE_TOKEN = /^[\p{L}\p{N}][\p{L}\p{N}'.,:/x×-]{0,39}$/u;

/** The English sentence for <previous_problem> (M5-DESIGN §3.6); a token from the line only when it is safe. */
export function problemText(p: LineProblem): string {
  switch (p.code) {
    case "inconsistent":
      return "When the line is null, the quote must be null too, and the other way round.";
    case "quote-not-found":
      return "The evidence quote was not found word for word on the page. Copy it exactly.";
    case "quote-size":
      return "The evidence quote must be 5 to 40 words.";
    case "number-not-found":
      return SAFE_TOKEN.test(p.token)
        ? `The line mentions “${p.token}”, but the pages don't.`
        : "The line mentions a number that isn't on the pages.";
    case "name-not-found":
      return SAFE_TOKEN.test(p.token)
        ? `The line mentions “${p.token}”, but the pages don't.`
        : "The line mentions a name that isn't on the pages.";
    case "too-long":
      return `The line has ${p.words} words; use at most ${PERSONAL_LINE_MAX_WORDS}.`;
    case "too-short":
      return "The line is too short; write a full sentence.";
    case "not-one-sentence":
      return "Write exactly one sentence ending with a full stop.";
    case "plain-characters":
      return "Use plain letters only: the line contains hidden or unusual characters.";
    case "banned-word":
      switch (p.kind) {
        case "praise":
          // Our own list's phrase, never text from the line.
          return `The line uses “${p.token}”; write a plain observation without praise.`;
        case "meta":
          // Our own list's phrase, never text from the line.
          return `The line uses “${p.token}”; describe their work, not their website.`;
        case "pitch":
          return "The line mentions us or an offer; describe their work only.";
        case "dash":
          return "The line uses a dash as a pause; write one plain sentence without dashes.";
        case "quotes":
          return "The line contains quotation marks; leave them out.";
        case "emoji":
          return "The line contains an emoji; leave it out.";
      }
      break;
    case "link":
      return "The line contains a web or email address; leave links out.";
    case "repeat":
      return "The line repeats an earlier line; write a different one.";
  }
  return "The line didn't pass the checks; write a new one.";
}

/** The warning shown on the review card after the second failure; null for the consistency check (the draft fails). */
export function problemFlag(p: LineProblem): DraftFlag | null {
  switch (p.code) {
    case "inconsistent":
      return null;
    case "quote-not-found":
      return { code: "quote-not-found", text: "The quote wasn't found word for word on the page." };
    case "quote-size":
      return { code: "quote-size", text: "The quote is shorter than 4 or longer than 40 words." };
    case "number-not-found":
      return { code: "number-not-found", text: `Mentions the number ${displayToken(p.token)}, which isn't on the website.` };
    case "name-not-found":
      return { code: "name-not-found", text: `Mentions “${displayToken(p.token)}”, which isn't on the website.` };
    case "too-long":
      return { code: "too-long", text: `Longer than ${PERSONAL_LINE_MAX_WORDS} words (${p.words}).` };
    case "too-short":
      return { code: "too-short", text: "Very short." };
    case "not-one-sentence":
      return { code: "not-one-sentence", text: p.multiple ? "More than one sentence." : "Not one sentence ending with a full stop." };
    case "plain-characters":
      return { code: "plain-characters", text: "Contains hidden or unusual characters." };
    case "banned-word":
      switch (p.kind) {
        case "praise":
        case "meta":
        case "pitch":
          return { code: "banned-word", text: `Contains “${displayToken(p.token)}”.` };
        case "dash":
          return { code: "banned-word", text: "Contains a dash." };
        case "quotes":
          return { code: "banned-word", text: "Contains quotation marks." };
        case "emoji":
          return { code: "banned-word", text: "Contains an emoji." };
      }
      break;
    case "link":
      return { code: "link", text: p.kind === "email" ? "Contains an email address." : "Contains a web address." };
    case "repeat":
      return { code: "repeat", text: "Same as an earlier line." };
  }
  return null;
}

/** Flag lists joined in order, each flag once (the same code and text). */
export function mergeFlags(...lists: Array<ReadonlyArray<DraftFlag> | null | undefined>): DraftFlag[] {
  const out: DraftFlag[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const f of list ?? []) {
      const key = `${f.code}\u0000${f.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ code: f.code, text: f.text });
    }
  }
  return out;
}
