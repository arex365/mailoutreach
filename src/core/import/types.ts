import { COMPANY_STATUSES, type CompanyStatusValue } from "../labels";
import { plural } from "../text";
import { isValidCustomKey, TARGET_KEYS, type ColumnMapping, type Confidence, type TargetKey } from "./column-matching";

/**
 * Shapes shared by the import screens, the server actions and the worker job.
 * Browser-safe (no server imports).
 */

export type GroupingMode = "website-and-name" | "name" | "website";
export const GROUPING_MODES: ReadonlyArray<GroupingMode> = ["website-and-name", "name", "website"];

export type ListOption = { mode: "none" } | { mode: "existing"; listId: number } | { mode: "new"; name: string };

export type DuplicateMode = "skip" | "update";

/** The user's answer for one group that needs a decision. */
export type GroupChoice = { action: "new" } | { action: "merge"; companyId: number } | { action: "restore" };

export type ImportOptions = {
  list: ListOption;
  startStatus: CompanyStatusValue;
  tag: string | null;
  duplicates: DuplicateMode;
  grouping: GroupingMode;
  /** Default for "possible duplicate: choose" groups the user didn't answer. */
  possibleDuplicates: "new" | "merge";
  /** Default for groups that match a deleted company. */
  deletedMatches: "restore" | "new";
  /** Group key → the user's answer. */
  choices: Record<string, GroupChoice>;
};

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  list: { mode: "none" },
  startStatus: "NOT_CONTACTED",
  tag: null,
  duplicates: "skip",
  grouping: "website-and-name",
  possibleDuplicates: "new",
  deletedMatches: "restore",
  choices: {},
};

export const LIST_NAME_MAX = 80;
export const TAG_NAME_MAX = 50;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Reads options stored as JSON, falling back to defaults for anything missing or odd. */
export function readImportOptions(json: unknown): ImportOptions {
  const o = isObject(json) ? json : {};
  const d = DEFAULT_IMPORT_OPTIONS;
  let list: ListOption = d.list;
  if (isObject(o.list)) {
    if (o.list.mode === "existing" && typeof o.list.listId === "number") list = { mode: "existing", listId: o.list.listId };
    else if (o.list.mode === "new" && typeof o.list.name === "string" && o.list.name.trim()) {
      list = { mode: "new", name: o.list.name.trim().slice(0, LIST_NAME_MAX) };
    }
  }
  const choices: Record<string, GroupChoice> = {};
  if (isObject(o.choices)) {
    for (const [k, v] of Object.entries(o.choices)) {
      if (!isObject(v)) continue;
      if (v.action === "new" || v.action === "restore") choices[k] = { action: v.action };
      else if (v.action === "merge" && typeof v.companyId === "number") choices[k] = { action: "merge", companyId: v.companyId };
    }
  }
  return {
    list,
    startStatus: COMPANY_STATUSES.includes(o.startStatus as CompanyStatusValue) ? (o.startStatus as CompanyStatusValue) : d.startStatus,
    tag: typeof o.tag === "string" && o.tag.trim() ? o.tag.replace(/\s+/g, " ").trim().slice(0, TAG_NAME_MAX) : null,
    duplicates: o.duplicates === "update" ? "update" : "skip",
    grouping: GROUPING_MODES.includes(o.grouping as GroupingMode) ? (o.grouping as GroupingMode) : d.grouping,
    possibleDuplicates: o.possibleDuplicates === "merge" ? "merge" : "new",
    deletedMatches: o.deletedMatches === "new" ? "new" : "restore",
    choices,
  };
}

/** Reads a stored mapping; null when it doesn't fit the headers (then a fresh suggestion is used). */
export function readMapping(json: unknown, columnCount: number): ColumnMapping[] | null {
  if (!Array.isArray(json) || json.length !== columnCount) return null;
  const out: ColumnMapping[] = [];
  for (const m of json) {
    if (!isObject(m)) return null;
    if (m.target === "ignore") out.push({ target: "ignore" });
    else if (m.target === "custom" && typeof m.key === "string" && isValidCustomKey(m.key)) {
      out.push({ target: "custom", key: m.key, label: typeof m.label === "string" && m.label ? m.label : m.key });
    } else if (typeof m.target === "string" && (TARGET_KEYS as readonly string[]).includes(m.target)) {
      out.push({ target: m.target as TargetKey });
    } else return null;
  }
  return out;
}

// ───────────────────────── check (step 4) ─────────────────────────

export type ImportFlag = { tone: "neutral" | "warning" | "danger"; text: string };

export type CompanyRef = { id: number; code: string; name: string; country: string | null; deleted: boolean };

export type GroupDecision =
  | null
  | { kind: "possible-duplicate"; candidates: CompanyRef[]; selected: "new" | number }
  | { kind: "restore"; company: CompanyRef; label: string; selected: "restore" | "new" };

export type GroupOutcome = "create" | "update" | "skip";

export type CheckGroupView = {
  key: string;
  rowNumbers: number[];
  rowCount: number;
  name: string;
  website: string | null;
  country: string | null;
  people: Array<{ name: string; email: string | null }>;
  peopleCount: number;
  outcome: GroupOutcome;
  existing: CompanyRef | null;
  decision: GroupDecision;
  flags: ImportFlag[];
  /** Row notes inside this company ("Row 14: 'anna@@studio.de' isn't a valid email address"). */
  rowNotes: string[];
  needsLook: boolean;
};

/** "no-email": a round-trip row where Claude found no address (its note is the message). */
export type RowIssueTone = "empty" | "invalid" | "problem" | "note" | "duplicate" | "no-email";

export type CheckRowIssueView = { rowNumber: number; tone: RowIssueTone; message: string };

export type CheckSummary = {
  rows: number;
  companies: number;
  newCompanies: number;
  updateCompanies: number;
  skipCompanies: number;
  restoreCompanies: number;
  /** Groups that match a deleted company (restore or create new). */
  deletedFound: number;
  possibleDuplicates: number;
  peopleToAdd: number;
  alreadyEmailed: number;
  emptyRows: number;
  invalidEmails: number;
  problemRows: number;
  noteRows: number;
  /** Round trip: rows without an email address (their Claude notes are listed with the rows). 0 otherwise. */
  noEmailRows: number;
};

export type CheckView = {
  summary: CheckSummary;
  groups: CheckGroupView[];
  totalGroups: number;
  rowIssues: CheckRowIssueView[];
  totalRowIssues: number;
  onlyProblems: boolean;
  duplicates: DuplicateMode;
  possibleDuplicates: "new" | "merge";
  deletedMatches: "restore" | "new";
  /**
   * The file has a Company ID column (M5-DESIGN §4.2): it only adds people to companies that already
   * exist. Groups are those companies (`existing`), their `people` are the people to add, and
   * `summary.updateCompanies` counts the companies that get someone.
   */
  roundTrip: boolean;
};

// ───────────────────────── result (step 5) ─────────────────────────

export type ImportResultSummary = {
  rows: number;
  created: number;
  /** Existing companies that really changed (fields or people). Each company counts once. */
  updated: number;
  /** Existing companies the file matched in "update" mode where nothing needed changing. */
  unchanged: number;
  restored: number;
  skipped: number;
  peopleAdded: number;
  peopleUpdated: number;
  invalidEmails: number;
  emptyRows: number;
  problems: number;
  notes: number;
  listId: number | null;
  listName: string | null;
  tagName: string | null;
  /**
   * The missing-emails round trip (M5-DESIGN §4.2): no company was created or changed; `peopleAdded`
   * counts everyone who got an address in the app (new, filled in or brought back) and `updated` the
   * companies they went to.
   */
  roundTrip: boolean;
  /** Round trip: rows where Claude found no email. */
  noEmailRows: number;
};

export const EMPTY_RESULT: ImportResultSummary = {
  rows: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  restored: 0,
  skipped: 0,
  peopleAdded: 0,
  peopleUpdated: 0,
  invalidEmails: 0,
  emptyRows: 0,
  problems: 0,
  notes: 0,
  listId: null,
  listName: null,
  tagName: null,
  roundTrip: false,
  noEmailRows: 0,
};

export function readResultSummary(json: unknown): ImportResultSummary | null {
  if (!isObject(json)) return null;
  const n = (k: keyof ImportResultSummary) => (typeof json[k] === "number" ? (json[k] as number) : 0);
  return {
    rows: n("rows"),
    created: n("created"),
    updated: n("updated"),
    unchanged: n("unchanged"),
    restored: n("restored"),
    skipped: n("skipped"),
    peopleAdded: n("peopleAdded"),
    peopleUpdated: n("peopleUpdated"),
    invalidEmails: n("invalidEmails"),
    emptyRows: n("emptyRows"),
    problems: n("problems"),
    notes: n("notes"),
    listId: typeof json.listId === "number" ? json.listId : null,
    listName: typeof json.listName === "string" ? json.listName : null,
    tagName: typeof json.tagName === "string" ? json.tagName : null,
    roundTrip: json.roundTrip === true,
    noEmailRows: n("noEmailRows"),
  };
}

/**
 * "Imported customers.xlsx: 120 new companies, 14 updated, 5 already up to date, 9 companies skipped
 * because they already exist, 150 people added, 3 invalid emails, 2 empty rows." With an actor name:
 * "Ali imported customers.xlsx: …" (for the activity log). A round trip has its own sentence
 * (`roundTripSummarySentence`).
 */
export function importSummarySentence(label: string, s: ImportResultSummary, actorName?: string): string {
  if (s.roundTrip) return roundTripSummarySentence(label, s, actorName);
  const parts = [plural(s.created, "new company", "new companies")];
  if (s.updated) parts.push(`${s.updated.toLocaleString("en-US")} updated`);
  if (s.unchanged) parts.push(`${s.unchanged.toLocaleString("en-US")} already up to date`);
  if (s.restored) parts.push(`${s.restored.toLocaleString("en-US")} restored`);
  if (s.skipped) parts.push(`${plural(s.skipped, "company", "companies")} skipped because they already exist`);
  parts.push(plural(s.peopleAdded, "person added", "people added"));
  if (s.invalidEmails) parts.push(plural(s.invalidEmails, "invalid email", "invalid emails"));
  if (s.emptyRows) parts.push(plural(s.emptyRows, "empty row", "empty rows"));
  if (s.problems) parts.push(`${plural(s.problems, "row needs", "rows need")} a look`);
  return `${actorName ? `${actorName} imported` : "Imported"} ${label}: ${parts.join(", ")}.`;
}

/**
 * The missing-emails round trip's summary (M5-DESIGN §4.2): "Ali imported claude.csv: 37 people added to
 * 30 companies, 5 rows without an email." Invalid emails and rows that need a look follow when there are any.
 */
export function roundTripSummarySentence(label: string, s: ImportResultSummary, actorName?: string): string {
  const parts = [
    s.peopleAdded > 0
      ? `${plural(s.peopleAdded, "person", "people")} added to ${plural(s.updated, "company", "companies")}`
      : "0 people added",
  ];
  if (s.noEmailRows) parts.push(plural(s.noEmailRows, "row without an email", "rows without an email"));
  if (s.invalidEmails) parts.push(plural(s.invalidEmails, "invalid email", "invalid emails"));
  if (s.problems) parts.push(`${plural(s.problems, "row needs", "rows need")} a look`);
  return `${actorName ? `${actorName} imported` : "Imported"} ${label}: ${parts.join(", ")}.`;
}

/** What to call the source in sentences: the file name, or "pasted rows". */
export function importSourceLabel(fileName: string, kind: string): string {
  return kind === "paste" ? "pasted rows" : fileName;
}

// ───────────────────────── the session as the screens see it ─────────────────────────

/** What POST /api/imports returns (or { error } with a 4xx/5xx status). */
export type UploadResponse = {
  id: number;
  fileName: string;
  kind: string;
  sheet: string | null;
  sheets: Array<{ name: string; rows: number }>;
  rowCount: number;
};

export type ImportStatusValue = "UPLOADED" | "MAPPED" | "COMMITTING" | "DONE" | "FAILED" | "CANCELLED";

export type ImportSessionView = {
  id: number;
  fileName: string;
  kind: string;
  sheet: string | null;
  sheetNames: string[];
  headers: string[];
  rowCount: number;
  sampleRows: string[][];
  mapping: ColumnMapping[];
  /** The automatic match, and how sure it is, per column (for the hint under each select). */
  suggestedMapping: ColumnMapping[];
  confidence: Confidence[];
  options: ImportOptions;
  status: ImportStatusValue;
  jobId: number | null;
  summary: ImportResultSummary | null;
  createdByName: string;
  createdAt: string;
};
