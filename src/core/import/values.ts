import { OLD_TOOL_STATUS_MAP, type CompanyStatusValue, type PriorityValue } from "../labels";
import { normalizeText } from "../text";

/**
 * Reading individual imported values: dates, priorities, statuses and multi-value cells.
 * Pure and browser-safe.
 */

// ───────────────────────── dates ─────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, januar: 1, january: 1, janner: 1,
  feb: 2, februar: 2, february: 2, febr: 2,
  mar: 3, marz: 3, maerz: 3, march: 3, mars: 3, mrz: 3,
  apr: 4, april: 4,
  may: 5, mai: 5,
  jun: 6, juni: 6, june: 6,
  jul: 7, juli: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, okt: 10, oktober: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, dez: 12, des: 12, dezember: 12, desember: 12, december: 12,
};

function fullYear(y: number): number {
  if (y >= 100) return y;
  return y < 70 ? 2000 + y : 1900 + y;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** A calendar day as a Date at 12:00 UTC (so it shows as the same day in every time zone). */
function makeDay(y: number, m: number, d: number, hh = 12, mm = 0): Date | null {
  const year = fullYear(y);
  if (year < 1990 || year > 2100) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(year, m)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return new Date(Date.UTC(year, m - 1, d, hh, mm));
}

/** How a column writes "a/b/yyyy": day first (dd/mm, Europe) or month first (mm/dd, US). */
export type DateOrder = "dmy" | "mdy";

const SLASH_DATE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::\d{2})?)?$/;

/** Two numbers from "a/b/yyyy" → [day, month]: the order that can be, else the column's order. */
function dayMonth(a: number, b: number, order: DateOrder): [number, number] {
  if (a > 12) return [a, b];
  if (b > 12) return [b, a];
  return order === "mdy" ? [b, a] : [a, b];
}

/**
 * Decides once for a whole column whether "a/b/yyyy" dates are day-first or month-first:
 * "13/03/2026" proves day-first, "03/13/2026" proves month-first. `sure` is false when the column
 * has no proof either way, or proofs of both (then ambiguous cells are read day-first and noted).
 */
export function detectDateOrder(values: Iterable<string>): { order: DateOrder; sure: boolean } {
  let dmy = 0;
  let mdy = 0;
  for (const v of values) {
    const m = SLASH_DATE.exec(v.trim());
    if (!m) continue;
    const a = +m[1]!;
    const b = +m[2]!;
    if (a > 12 && b <= 12) dmy++;
    else if (b > 12 && a <= 12) mdy++;
  }
  if (mdy > 0 && dmy === 0) return { order: "mdy", sure: true };
  return { order: "dmy", sure: dmy > 0 && mdy === 0 };
}

/** True for "03/04/2026"-style values where day and month could be swapped. */
export function isAmbiguousDate(input: string | null | undefined): boolean {
  const m = SLASH_DATE.exec((input ?? "").trim());
  if (!m) return false;
  const a = +m[1]!;
  const b = +m[2]!;
  return a !== b && a <= 12 && b <= 12;
}

/**
 * Reads "last contacted" style dates: ISO (2026-03-04, with or without a time), Excel serial
 * numbers (46085), dd.mm.yyyy, dd/mm/yyyy and mm/dd/yyyy (ambiguous ones follow `order`, which the
 * importer decides once per column with detectDateOrder; default day first), dd-mm-yyyy,
 * yyyy/mm/dd, and month names in English, German and Norwegian ("3 Mar 2026", "3. März 2026",
 * "March 3, 2026"). Returns null when it can't tell.
 */
export function parseImportDate(input: string | null | undefined, order: DateOrder = "dmy"): Date | null {
  const s = (input ?? "").trim();
  if (!s) return null;

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (m) {
    if (m[7]) {
      const d = new Date(s.replace(" ", "T"));
      return Number.isNaN(d.getTime()) ? null : makeDay(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
    }
    return makeDay(+m[1]!, +m[2]!, +m[3]!, m[4] ? +m[4] : 12, m[5] ? +m[5] : 0);
  }

  m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(s);
  if (m) return makeDay(+m[1]!, +m[2]!, +m[3]!);

  // Excel serial day number (days since 1899-12-30), e.g. 46085 = 2026-03-04.
  m = /^(\d{5})(?:\.\d+)?$/.exec(s);
  if (m) {
    const serial = Number(s);
    if (serial >= 20000 && serial <= 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000);
      return makeDay(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    return null;
  }

  m = /^(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{2}|\d{4})\.?(?:,?\s+(\d{1,2}):(\d{2})(?::\d{2})?)?$/.exec(s);
  if (m) return makeDay(+m[3]!, +m[2]!, +m[1]!, m[4] ? +m[4] : 12, m[5] ? +m[5] : 0);

  m = SLASH_DATE.exec(s);
  if (m) {
    const [d, mo] = dayMonth(+m[1]!, +m[2]!, order);
    return makeDay(+m[3]!, mo, d, m[4] ? +m[4] : 12, m[5] ? +m[5] : 0);
  }

  // Month names: "3 Mar 2026", "3. März 2026", "March 3, 2026", "Mar 3 2026".
  const tokens = normalizeText(s)
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length >= 2 && tokens.length <= 4) {
    let month: number | null = null;
    const numbers: number[] = [];
    for (const t of tokens) {
      if (/^\d+$/.test(t)) numbers.push(Number(t));
      else if (MONTHS[t] !== undefined) month = MONTHS[t]!;
      else if (/^\d+(st|nd|rd|th)$/.test(t)) numbers.push(Number.parseInt(t, 10));
      else return null;
    }
    if (month !== null && numbers.length === 2) {
      const year = numbers.find((n) => n >= 1000) ?? numbers[1]!;
      const day = numbers.find((n) => n !== year) ?? numbers[0]!;
      return makeDay(year, month, day);
    }
    if (month !== null && numbers.length === 1 && numbers[0]! >= 1000) {
      return makeDay(numbers[0]!, month, 1);
    }
  }
  return null;
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "3 Apr 2026" (UTC calendar day), for notes about how a date was read. */
export function formatImportDay(d: Date): string {
  return `${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// ───────────────────────── priority ─────────────────────────

const PRIORITY_WORDS: Record<string, PriorityValue> = {
  high: "HIGH", hoch: "HIGH", hoy: "HIGH", hog: "HIGH", h: "HIGH", "1": "HIGH", a: "HIGH", top: "HIGH",
  wichtig: "HIGH", important: "HIGH", urgent: "HIGH", dringend: "HIGH", viktig: "HIGH", "!!!": "HIGH",
  "very high": "HIGH", "sehr hoch": "HIGH",
  normal: "NORMAL", medium: "NORMAL", mittel: "NORMAL", middels: "NORMAL", med: "NORMAL", m: "NORMAL",
  "2": "NORMAL", b: "NORMAL", standard: "NORMAL", mid: "NORMAL", regular: "NORMAL", vanlig: "NORMAL", "!!": "NORMAL",
  low: "LOW", niedrig: "LOW", gering: "LOW", lav: "LOW", l: "LOW", "3": "LOW", c: "LOW", lo: "LOW", "!": "LOW",
  "very low": "LOW",
};

export function parsePriority(input: string | null | undefined): PriorityValue | null {
  const key = normalizeText(input);
  if (!key) return null;
  return PRIORITY_WORDS[key] ?? PRIORITY_WORDS[key.replace(/\s*priority$/, "").replace(/^prio(rity)?\s*/, "")] ?? null;
}

// ───────────────────────── status ─────────────────────────

const EXTRA_STATUS_WORDS: Record<string, CompanyStatusValue> = {
  "nicht kontaktiert": "NOT_CONTACTED",
  "noch nicht kontaktiert": "NOT_CONTACTED",
  "ikke kontaktet": "NOT_CONTACTED",
  "not yet contacted": "NOT_CONTACTED",
  uncontacted: "NOT_CONTACTED",
  new: "NOT_CONTACTED",
  neu: "NOT_CONTACTED",
  ny: "NOT_CONTACTED",
  open: "NOT_CONTACTED",
  offen: "NOT_CONTACTED",
  todo: "NOT_CONTACTED",
  "to do": "NOT_CONTACTED",
  kontaktiert: "CONTACTED",
  kontaktet: "CONTACTED",
  angeschrieben: "CONTACTED",
  emailed: "CONTACTED",
  sent: "CONTACTED",
  "in contact": "CONTACTED",
  "follow up": "CONTACTED",
  "followed up": "CONTACTED",
  answered: "REPLIED",
  responded: "REPLIED",
  geantwortet: "REPLIED",
  "antwort erhalten": "REPLIED",
  svart: "REPLIED",
  besvart: "REPLIED",
  interested: "REPLIED",
  interessiert: "REPLIED",
  interessert: "REPLIED",
  "in talks": "REPLIED",
  customer: "CLIENT",
  kunde: "CLIENT",
  won: "CLIENT",
  gewonnen: "CLIENT",
  vunnet: "CLIENT",
  signed: "CLIENT",
  booked: "CLIENT",
  declined: "NOT_INTERESTED",
  lost: "NOT_INTERESTED",
  "kein interesse": "NOT_INTERESTED",
  "nicht interessiert": "NOT_INTERESTED",
  abgelehnt: "NOT_INTERESTED",
  "ikke interessert": "NOT_INTERESTED",
  avslatt: "NOT_INTERESTED",
  "don't contact": "DO_NOT_CONTACT",
  "dont contact": "DO_NOT_CONTACT",
  "do not email": "DO_NOT_CONTACT",
  "nicht kontaktieren": "DO_NOT_CONTACT",
  "ikke kontakt": "DO_NOT_CONTACT",
  blacklist: "DO_NOT_CONTACT",
  blacklisted: "DO_NOT_CONTACT",
  "opt out": "DO_NOT_CONTACT",
  "opted out": "DO_NOT_CONTACT",
  unsubscribed: "DO_NOT_CONTACT",
};

/**
 * Old tool statuses (Not Contacted, Contacted, Replied, Hired → Client, Rejected → Not interested),
 * our own labels (so an export re-imports cleanly) and a few German/Norwegian words.
 * Unknown labels → null (the caller uses the starting status and notes the row).
 */
export function mapImportStatus(input: string | null | undefined): CompanyStatusValue | null {
  const key = normalizeText(input).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!key) return null;
  return OLD_TOOL_STATUS_MAP[key] ?? EXTRA_STATUS_WORDS[key] ?? null;
}

// ───────────────────────── notes ─────────────────────────

function containsBlock(lines: string[], block: string[]): boolean {
  for (let i = 0; i + block.length <= lines.length; i++) {
    let j = 0;
    while (j < block.length && lines[i + j] === block[j]) j++;
    if (j === block.length) return true;
  }
  return false;
}

/**
 * Imported notes that the company doesn't have yet. Whole notes are compared (line by line,
 * ignoring case, accents and spacing), never parts of words: "busts" is new next to
 * "Makes resin busts". A multi-line note counts as present when its lines appear together.
 */
export function notesToAdd(existing: string, imported: ReadonlyArray<string>): string[] {
  const lines = existing.split("\n").map(normalizeText).filter(Boolean);
  const out: string[] = [];
  for (const note of imported) {
    const block = note.split("\n").map(normalizeText).filter(Boolean);
    if (block.length === 0 || containsBlock(lines, block)) continue;
    out.push(note);
    lines.push(...block);
  }
  return out;
}

// ───────────────────────── multi-value cells ─────────────────────────

/** "resin; figurines, Busts" → ["resin", "figurines", "Busts"] (tags also split on commas). */
export function splitMulti(value: string, opts: { commas?: boolean } = {}): string[] {
  const re = opts.commas ? /[;,|\n]+/ : /[;|\n]+/;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of value.split(re)) {
    const clean = part.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    const key = normalizeText(clean);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

/** Several addresses in one cell: "a@x.de; b@x.de" or "a@x.de, b@x.de" or "a@x.de / b@x.de". */
export function splitEmails(value: string): string[] {
  const v = value.trim();
  if (!v) return [];
  if ((v.match(/@/g) ?? []).length <= 1) return [v];
  return v
    .split(/[;,\s|/]+/)
    .map((p) => p.trim())
    .filter((p) => p.includes("@"));
}
