import { normalizeCompanyName, plural } from "../text";
import { isRoundTripMapping } from "./column-matching";
import {
  DEFAULT_IMPORT_OPTIONS,
  roundTripSummarySentence,
  type CheckSummary,
  type ImportOptions,
  type ImportResultSummary,
} from "./types";

/**
 * The missing-emails round trip with Claude (SPEC §4, PLAN.md B6.13, M5-DESIGN §4): the instruction
 * "Export for Claude" hands over, reading the company codes back, and the sentences of the round-trip
 * import screens. Pure and browser-safe.
 *
 * A round trip is an import whose mapping has a Company ID column (`isRoundTripMapping`). It only adds
 * people to companies that already exist: rows are grouped by the company code, company-level values
 * are ignored, and no company is ever created or changed.
 */

export { isRoundTripMapping, roundTripSummarySentence };

/** The instruction to paste into Claude together with the exported file (PLAN.md B6.13, verbatim). */
export const CLAUDE_MISSING_EMAILS_INSTRUCTION =
  "I've attached a CSV of companies. For each row, find the best email address for contacting this company about 3D " +
  "modelling work (print-ready 3D models such as figurines, creatures, busts and statues). Prefer, in this order: a named " +
  "person responsible for products, design or purchasing; then the company's general address (info@, hello@, kontakt@, " +
  "post@). Use only addresses published on the company's own website, its official social profiles or a business " +
  "directory. Never guess or construct an address. Return a CSV with exactly these columns: company_id, company, email, " +
  "contact_name, role, source_url, note. Keep company_id exactly as given. If you find two good contacts, add a second " +
  "row with the same company_id. If you find nothing, leave email empty and say why in note.";

/** "C-1042", "c1042", "C 1042", "1042" (spaces around, one leading apostrophe from a spreadsheet). */
const COMPANY_CODE = /^\s*c?\s*-?\s*(\d{1,9})\s*$/i;

/**
 * The company id in a round-trip file's company_id cell, or null when it isn't one. Strips one
 * leading `'` (spreadsheets add it to keep a value as text), then accepts `C-1042`, `c1042`,
 * `C 1042` and `1042`. Zero is never a company.
 */
export function parseCompanyCode(value: string | null | undefined): number | null {
  let s = (value ?? "").trim();
  if (s.startsWith("'")) s = s.slice(1);
  const m = COMPANY_CODE.exec(s);
  if (!m) return null;
  const id = Number.parseInt(m[1]!, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Screen copy of the round-trip import (M5-DESIGN §6.10). */
export const ROUND_TRIP_COPY = {
  /** The mapping and options steps, when a column is mapped to the Company ID. */
  note: "This file has a company_id column, so it adds people to companies that already exist. No companies are created or changed.",
  /** Under the note on the mapping step: a Contacts export also has a company_id column. */
  optOut: "To import it as an ordinary file instead, set the company_id column to “Ignore this column”.",
  /** Under a company column (website, country …) the round trip doesn't read. */
  unusedColumn: "Not used: this file only adds people.",
} as const;

/** "C-1042" (the code people see everywhere in the app). */
export function companyCodeText(id: number): string {
  return `C-${id}`;
}

/** The options a round trip saves on the Options step: the defaults, unchanged (its planner ignores them). */
export const ROUND_TRIP_OPTIONS: Pick<ImportOptions, "list" | "startStatus" | "tag" | "duplicates" | "grouping"> = {
  list: DEFAULT_IMPORT_OPTIONS.list,
  startStatus: DEFAULT_IMPORT_OPTIONS.startStatus,
  tag: DEFAULT_IMPORT_OPTIONS.tag,
  duplicates: DEFAULT_IMPORT_OPTIONS.duplicates,
  grouping: DEFAULT_IMPORT_OPTIONS.grouping,
};

// ───────────────────────── person notes ─────────────────────────

/** Person notes longer than this are cut (a note is a line or two; the cell limit is 10,000 characters). */
export const PERSON_NOTES_MAX = 2_000;
/** How much of Claude's note a "no email found" row quotes. */
const QUOTED_NOTE_MAX = 200;

const URL_VALUE = /^(https?:\/\/|www\.)\S+$/i;

/** True for a value that is a link (where Claude found the address), not a remark. */
export function isLinkValue(value: string): boolean {
  return URL_VALUE.test(value.trim());
}

function cleanValues(values: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const clean = v.replace(/\s+/g, " ").trim();
    if (!clean || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    out.push(clean);
  }
  return out;
}

/**
 * `Person.notes` from a row's "Notes about the person" values: links (source URLs) first, then the
 * remarks, joined with " · " (M5-DESIGN §4.2). Empty values and repeats are left out; null when nothing
 * is left.
 */
export function personNotesText(values: ReadonlyArray<string>): string | null {
  const clean = cleanValues(values);
  const ordered = [...clean.filter(isLinkValue), ...clean.filter((v) => !isLinkValue(v))];
  const text = ordered.join(" · ");
  if (!text) return null;
  return text.length > PERSON_NOTES_MAX ? `${text.slice(0, PERSON_NOTES_MAX - 1).trimEnd()}…` : text;
}

/** Claude's remark in a row (its non-link notes), or null. */
export function claudeNoteOf(values: ReadonlyArray<string>): string | null {
  const text = cleanValues(values)
    .filter((v) => !isLinkValue(v))
    .join(" · ");
  if (!text) return null;
  return text.length > QUOTED_NOTE_MAX ? `${text.slice(0, QUOTED_NOTE_MAX - 1).trimEnd()}…` : text;
}

/**
 * Notes for a person who already has some (an address filled in, a removed person brought back):
 * the new text on its own line, unless it is already there.
 */
export function appendPersonNotes(existing: string | null | undefined, added: string | null | undefined): string | null {
  const add = (added ?? "").trim();
  if (!add) return null;
  const current = (existing ?? "").trim();
  if (!current) return add;
  if (current.split("\n").some((line) => line.trim() === add)) return null;
  const joined = `${current}\n${add}`;
  return joined.length > PERSON_NOTES_MAX * 2 ? null : joined;
}

// ───────────────────────── company names ─────────────────────────

/**
 * True when the file's company name clearly isn't ours: their normalised names (legal suffixes and
 * punctuation removed) share no word. Empty names never differ.
 */
export function companyNamesDiffer(fileName: string | null | undefined, ourName: string | null | undefined): boolean {
  const a = normalizeCompanyName(fileName).split(" ").filter(Boolean);
  const b = new Set(normalizeCompanyName(ourName).split(" ").filter(Boolean));
  if (a.length === 0 || b.size === 0) return false;
  return !a.some((w) => b.has(w));
}

// ───────────────────────── row texts (M5-DESIGN §4.2) ─────────────────────────

function quoted(value: string, max = 60): string {
  const v = value.replace(/\s+/g, " ").trim();
  return `“${v.length > max ? `${v.slice(0, max - 1)}…` : v}”`;
}

/** "C-1042 (Firma GmbH)". */
function codeAndName(id: number, name: string): string {
  return `${companyCodeText(id)} (${name})`;
}

/** The texts of the round-trip row rules. The check screen shows them after "Row 5: ". */
export const ROUND_TRIP_TEXT = {
  noCompanyId: "No company_id. Use the file exported from the app.",
  notACompanyId: (raw: string) => `${quoted(raw)} isn't a company ID like C-1042.`,
  unknownCompany: (id: number) => `${companyCodeText(id)} isn't a company in the app.`,
  deletedCompany: (id: number, name: string) => `${codeAndName(id, name)} was deleted. Restore it first, or leave this row out.`,
  noEmail: (note: string | null) => (note ? `No email found. Claude's note: ${quoted(note, QUOTED_NOTE_MAX)}` : "No email found."),
  alreadyAtCompany: (email: string, id: number, name: string) => `${email} is already at ${codeAndName(id, name)}.`,
  removedPersonElsewhere: (email: string, id: number, name: string) =>
    `${email} belonged to a removed person at ${codeAndName(id, name)}. Restore that person there, or leave this row out.`,
  nameDiffers: (fileName: string, id: number, name: string) =>
    `The file says ${quoted(fileName)} for ${codeAndName(id, name)}; the ID is used.`,
} as const;

// ───────────────────────── summaries ─────────────────────────

/** "37 people" / "1 person". */
function people(n: number): string {
  return plural(n, "person", "people");
}

/** The check step's summary lines: "Adds 37 people to 30 companies." · "5 rows have no email (…)." · "2 rows need a look." */
export function roundTripCheckLines(s: Pick<CheckSummary, "peopleToAdd" | "updateCompanies" | "noEmailRows" | "problemRows" | "invalidEmails">): string[] {
  const lines = [
    s.peopleToAdd > 0 ? `Adds ${people(s.peopleToAdd)} to ${plural(s.updateCompanies, "company", "companies")}.` : "Adds no new people.",
  ];
  if (s.noEmailRows > 0) {
    lines.push(`${plural(s.noEmailRows, "row has", "rows have")} no email (Claude's notes are listed below).`);
  }
  const look = s.problemRows + s.invalidEmails;
  if (look > 0) lines.push(`${plural(look, "row needs", "rows need")} a look.`);
  return lines;
}

/** The result step's lines: "Added 37 people to 30 companies." · "5 rows had no email." · "2 rows need a look." */
export function roundTripResultLines(s: Pick<ImportResultSummary, "peopleAdded" | "updated" | "noEmailRows" | "problems" | "invalidEmails">): string[] {
  const lines = [
    s.peopleAdded > 0 ? `Added ${people(s.peopleAdded)} to ${plural(s.updated, "company", "companies")}.` : "No people were added.",
  ];
  if (s.noEmailRows > 0) lines.push(`${plural(s.noEmailRows, "row", "rows")} had no email.`);
  const look = s.problems + s.invalidEmails;
  if (look > 0) lines.push(`${plural(look, "row needs", "rows need")} a look.`);
  return lines;
}
