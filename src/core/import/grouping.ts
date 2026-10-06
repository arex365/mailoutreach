import { GENERAL_INBOX_NAME, isRoleAddress, parseEmail } from "../email-address";
import { normalizeCountry } from "../geo/countries";
import type { CompanyStatusValue, PriorityValue } from "../labels";
import { instagramHandle, parseWebsite, usableEmailDomain, type WebsiteInfo } from "../shared-domains";
import { firstNameFrom, normalizeCompanyName, normalizeText } from "../text";
import { firstValue, isPlaceholder, mapRow, type ColumnMapping } from "./column-matching";
import type { GroupingMode } from "./types";
import {
  detectDateOrder,
  formatImportDay,
  isAmbiguousDate,
  mapImportStatus,
  parseImportDate,
  parsePriority,
  splitEmails,
  splitMulti,
  type DateOrder,
} from "./values";

/**
 * Import step 4, the pure part (PLAN.md B6.13): normalise every row, then join rows into
 * companies with union-find. Rows are joined when they share
 *  - a usable website domain, or a usable (non-free-mail) email domain — the same key,
 *  - the same normalised company name and the same country,
 *  - the same exact email address, Instagram handle or profile link (always the same contact).
 * Shared hosts (gmail.com, instagram.com, linktr.ee …) never join rows by themselves:
 * 500 Instagram profiles stay 500 companies, and gmail.com users stay apart.
 * Server/worker only (country names need i18n-iso-countries).
 */

export type { GroupingMode };

export type RowPerson = {
  emailNorm: string | null;
  email: string | null;
  /** Usable (non-shared) domain of the address, or null. */
  emailDomain: string | null;
  name: string;
  firstName: string | null;
  role: string | null;
  isGeneric: boolean;
};

export type RowIssueKind = "empty" | "invalid-email" | "no-identity" | "duplicate-in-file" | "note";
export type RowIssue = { kind: RowIssueKind; message: string };

export type NormalizedRow = {
  rowNumber: number;
  /** Nothing in a mapped column. */
  empty: boolean;
  /** True when the row tells us which company it is about. */
  hasIdentity: boolean;
  explicitName: string | null;
  nameNorm: string;
  website: WebsiteInfo | null;
  country: string | null;
  niche: string | null;
  notes: string[];
  personalLine: string | null;
  instagram: string | null;
  priority: PriorityValue | null;
  status: CompanyStatusValue | null;
  lastContactedAt: Date | null;
  tags: string[];
  lists: string[];
  custom: Record<string, string>;
  customLabels: Record<string, string>;
  people: RowPerson[];
  invalidEmails: string[];
  issues: RowIssue[];
  /** Normalised content, to spot rows that are exact copies of an earlier row. */
  fingerprint: string;
};

export type GroupPerson = RowPerson & { rowNumber: number };

export type ImportGroupDraft = {
  /** Stable id: "r" + the first row number. */
  key: string;
  rowNumbers: number[];
  name: string;
  nameNorm: string;
  /** The rows name the company themselves (name, website or Instagram), not only a person. */
  hasOwnIdentity: boolean;
  hasExplicitName: boolean;
  website: WebsiteInfo | null;
  domains: string[];
  profileKeys: string[];
  instagrams: string[];
  emails: string[];
  country: string | null;
  niche: string | null;
  notes: string[];
  personalLine: string | null;
  instagram: string | null;
  priority: PriorityValue | null;
  status: CompanyStatusValue | null;
  lastContactedAt: Date | null;
  tags: string[];
  lists: string[];
  custom: Record<string, string>;
  customLabels: Record<string, string>;
  people: GroupPerson[];
};

export type PreparedImport = {
  rows: NormalizedRow[];
  groups: ImportGroupDraft[];
  /** Row number → group key (rows that belong to no company are missing). */
  rowGroup: Map<number, string>;
  /** Row number → notes and problems found while reading the row. */
  rowIssues: Map<number, RowIssue[]>;
  /** Rows that are exact copies of an earlier row (nothing new to import). */
  duplicateRows: Map<number, number>;
};

export type PrepareOptions = {
  grouping: GroupingMode;
  /** Extra shared domains from Settings. */
  extraShared?: ReadonlySet<string>;
  /** "Now", for refusing last-contacted dates in the future (tests pass a fixed time). */
  now?: Date;
};

/** A last-contacted date more than this far in the future is a mistake (a swapped day and month, a typo). */
const FUTURE_SLACK_MS = 36 * 3_600_000;

export type RowContext = {
  extraShared?: ReadonlySet<string>;
  readCountry?: (raw: string) => string | null;
  /** How the file's "a/b/yyyy" dates are written, decided once for the column (detectDateOrder). */
  dateOrder?: DateOrder;
  /** False when the column gave no proof of its date order: ambiguous dates get a note. */
  dateOrderSure?: boolean;
  now?: Date;
};

// ───────────────────────── row normalisation ─────────────────────────

/** "Last contacted: never" in English, German and Norwegian. */
const NEVER = new Set(["never", "not yet", "no", "nie", "noch nie", "nein", "aldri", "ikke", "nei", "ingen", "keine", "0"]);

function quote(v: string): string {
  const s = v.length > 60 ? v.slice(0, 57) + "…" : v;
  return `'${s}'`;
}

function makeCountryReader() {
  const cache = new Map<string, string | null>();
  return (raw: string): string | null => {
    if (cache.has(raw)) return cache.get(raw)!;
    let code = normalizeCountry(raw);
    if (!code) {
      // "Berlin, Germany", "Oslo / Norway", "Munich (DE)"
      const parts = raw
        .split(/[,/;|()]+/)
        .map((p) => p.trim())
        .filter(Boolean);
      for (const p of [...parts].reverse()) {
        code = normalizeCountry(p);
        if (code) break;
      }
    }
    cache.set(raw, code);
    return code;
  };
}

export function normalizeRow(
  rowNumber: number,
  cells: ReadonlyArray<string>,
  mapping: ReadonlyArray<ColumnMapping>,
  ctx: RowContext = {},
): NormalizedRow {
  const readCountry = ctx.readCountry ?? makeCountryReader();
  const mapped = mapRow(mapping, cells);
  const f = mapped.fields;
  const issues: RowIssue[] = [];
  const note = (message: string) => issues.push({ kind: "note", message });

  const empty = Object.keys(f).length === 0 && mapped.custom.length === 0;
  const explicitName = firstValue(mapped, "company").replace(/\s+/g, " ").trim() || null;

  // Website (a cell holding an email or an @handle is moved where it belongs).
  const extraEmails: string[] = [];
  let handleFromWebsite: string | null = null;
  let website: WebsiteInfo | null = null;
  for (const raw of f.website ?? []) {
    if (/^[^\s/@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
      extraEmails.push(raw);
      continue;
    }
    if (/^@[A-Za-z0-9._]{1,30}$/.test(raw)) {
      handleFromWebsite ??= instagramHandle(raw);
      continue;
    }
    const parsed = parseWebsite(raw, ctx.extraShared);
    if (parsed) {
      if (!website || (website.isShared && !parsed.isShared)) website = parsed;
    } else if (!website) {
      note(`couldn't read the website ${quote(raw)}`);
    }
  }

  // Instagram: the column, else a handle typed as the website, else an instagram.com website.
  // A link to a post or reel (instagram.com/p/…) is not a profile: it's noted, never used.
  let instagram: string | null = null;
  const unreadableInstagram: string[] = [];
  for (const raw of f.instagram ?? []) {
    instagram = instagramHandle(raw);
    if (instagram) break;
    unreadableInstagram.push(raw);
  }
  if (!instagram && unreadableInstagram.length) {
    note(`${quote(unreadableInstagram[0]!)} isn't an Instagram profile (a link to a post or reel, or not a handle)`);
  }
  instagram ??= handleFromWebsite;
  if (!instagram && website?.profileKey?.startsWith("instagram.com/")) {
    instagram = website.profileKey.slice("instagram.com/".length) || null;
  }

  // Country.
  let country: string | null = null;
  const countryRaw = firstValue(mapped, "country");
  if (countryRaw) {
    country = readCountry(countryRaw);
    if (!country) note(`unknown country ${quote(countryRaw)}`);
  }

  // Priority, status, last contacted.
  const priorityRaw = firstValue(mapped, "priority");
  const priority = priorityRaw ? parsePriority(priorityRaw) : null;
  if (priorityRaw && !priority) note(`unknown priority ${quote(priorityRaw)}, so it stays Normal`);
  const statusRaw = firstValue(mapped, "status");
  const status = statusRaw ? mapImportStatus(statusRaw) : null;
  if (statusRaw && !status) note(`unknown status ${quote(statusRaw)}, so the starting status is used`);
  const dateRaw = firstValue(mapped, "last_contacted");
  let lastContactedAt = dateRaw ? parseImportDate(dateRaw, ctx.dateOrder ?? "dmy") : null;
  if (dateRaw && !lastContactedAt && !NEVER.has(normalizeText(dateRaw))) note(`couldn't read the date ${quote(dateRaw)}`);
  const now = ctx.now ?? new Date();
  if (lastContactedAt && lastContactedAt.getTime() > now.getTime() + FUTURE_SLACK_MS) {
    // Kept out: a future date would count as "contacted just now" for a long time and can't be undone by a later import.
    note(`the date ${quote(dateRaw)} is in the future, so it wasn't used`);
    lastContactedAt = null;
  } else if (lastContactedAt && !ctx.dateOrderSure && isAmbiguousDate(dateRaw)) {
    const first = (ctx.dateOrder ?? "dmy") === "mdy" ? "month" : "day";
    const other = first === "day" ? "month" : "day";
    note(
      `read the date ${quote(dateRaw)} as ${formatImportDay(lastContactedAt)} (${first} first); if the ${other} comes first, change the date in the file`,
    );
  }

  // Custom fields.
  const custom: Record<string, string> = {};
  const customLabels: Record<string, string> = {};
  for (const c of mapped.custom) {
    if (custom[c.key] === undefined) {
      custom[c.key] = c.value;
      customLabels[c.key] = c.label;
    }
  }

  // People.
  const first = firstValue(mapped, "first_name");
  const last = firstValue(mapped, "last_name");
  let personName = (firstValue(mapped, "name") || [first, last].filter(Boolean).join(" ")).replace(/\s+/g, " ").trim();
  // Our own export writes "General inbox" for info@-style addresses: that's not a person's name.
  if (normalizeText(personName) === normalizeText(GENERAL_INBOX_NAME)) personName = "";
  const role = firstValue(mapped, "role") || null;
  const people: RowPerson[] = [];
  const invalidEmails: string[] = [];
  const seenEmails = new Set<string>();
  for (const cell of [...(f.email ?? []), ...extraEmails]) {
    for (const raw of splitEmails(cell)) {
      const parsed = parseEmail(raw);
      if (!parsed) {
        invalidEmails.push(raw);
        issues.push({ kind: "invalid-email", message: `${quote(raw)} isn't a valid email address` });
        continue;
      }
      if (seenEmails.has(parsed.norm)) continue;
      seenEmails.add(parsed.norm);
      const isFirst = people.length === 0;
      const name = isFirst ? personName || parsed.displayName || "" : parsed.displayName || "";
      const generic = !name && isRoleAddress(parsed.email);
      const finalName = generic ? GENERAL_INBOX_NAME : name;
      people.push({
        emailNorm: parsed.norm,
        email: parsed.email,
        emailDomain: usableEmailDomain(parsed.domain, ctx.extraShared),
        name: finalName,
        firstName: isFirst && first && !generic ? first : firstNameFrom(finalName, generic) || null,
        role: isFirst ? role : null,
        isGeneric: generic,
      });
    }
  }
  if (people.length === 0 && personName) {
    people.push({
      emailNorm: null,
      email: null,
      emailDomain: null,
      name: personName,
      firstName: first || firstNameFrom(personName) || null,
      role,
      isGeneric: false,
    });
  }

  const hasIdentity = Boolean(explicitName || website || instagram || people.length > 0);
  if (empty) {
    issues.push({ kind: "empty", message: "empty row" });
  } else if (!hasIdentity && invalidEmails.length === 0) {
    issues.push({ kind: "no-identity", message: "no company name, website or email, so there's nothing to import" });
  }

  return {
    rowNumber,
    empty,
    hasIdentity,
    explicitName,
    nameNorm: normalizeCompanyName(explicitName),
    website,
    country,
    niche: firstValue(mapped, "niche") || null,
    notes: f.notes ?? [],
    personalLine: firstValue(mapped, "personal_line") || null,
    instagram,
    priority,
    status,
    lastContactedAt,
    tags: splitMulti((f.tags ?? []).join(";"), { commas: true }),
    lists: splitMulti((f.list ?? []).join(";")),
    custom,
    customLabels,
    people,
    invalidEmails,
    issues,
    fingerprint: cells.map((c) => normalizeText(c)).join("\u0001"),
  };
}

// ───────────────────────── union-find ─────────────────────────

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    let root = i;
    while (this.parent[root] !== root) root = this.parent[root]!;
    while (this.parent[i] !== root) {
      const next = this.parent[i]!;
      this.parent[i] = root;
      i = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // Keep the earliest row as the root, so group keys are stable.
    if (ra < rb) this.parent[rb] = ra;
    else this.parent[ra] = rb;
  }
}

/** The keys that join rows into one company, for the chosen grouping mode. */
export function groupingKeys(row: NormalizedRow, mode: GroupingMode): string[] {
  const keys: string[] = [];
  for (const p of row.people) if (p.emailNorm) keys.push(`m:${p.emailNorm}`);
  if (mode !== "name") {
    if (row.website?.domain) keys.push(`d:${row.website.domain}`);
    if (row.website?.profileKey) keys.push(`p:${row.website.profileKey}`);
    if (row.instagram) keys.push(`ig:${row.instagram}`);
    for (const p of row.people) if (p.emailDomain) keys.push(`d:${p.emailDomain}`);
  }
  if (mode !== "website" && row.nameNorm) keys.push(`n:${row.nameNorm}|${row.country ?? ""}`);
  return keys;
}

function fallbackName(rows: NormalizedRow[], website: WebsiteInfo | null, instagram: string | null): string {
  if (website && !website.isShared) return website.host;
  if (instagram) return `@${instagram}`;
  for (const r of rows) for (const p of r.people) if (p.name && !p.isGeneric) return p.name;
  if (website?.profileKey) return website.profileKey;
  for (const r of rows) for (const p of r.people) if (p.email) return p.emailDomain ?? p.email;
  return "Unnamed company";
}

function buildGroup(rows: NormalizedRow[]): ImportGroupDraft {
  const first = <T>(pick: (r: NormalizedRow) => T | null | undefined): T | null => {
    for (const r of rows) {
      const v = pick(r);
      if (v !== null && v !== undefined && v !== "") return v;
    }
    return null;
  };
  const explicitName = first((r) => r.explicitName);
  const website = first((r) => (r.website && !r.website.isShared ? r.website : null)) ?? first((r) => r.website);
  const instagram = first((r) => r.instagram);
  const name = explicitName ?? fallbackName(rows, website, instagram);

  const domains = new Set<string>();
  const profileKeys = new Set<string>();
  const instagrams = new Set<string>();
  const emails = new Set<string>();
  const tags: string[] = [];
  const lists: string[] = [];
  const notes: string[] = [];
  const pushUnique = (target: string[], seen: Set<string>, value: string) => {
    const key = normalizeText(value);
    if (!key || seen.has(key)) return;
    seen.add(key);
    target.push(value);
  };
  const tagKeys = new Set<string>();
  const listKeys = new Set<string>();
  const noteKeys = new Set<string>();
  const custom: Record<string, string> = {};
  const customLabels: Record<string, string> = {};
  const people: GroupPerson[] = [];
  const peopleNames = new Set<string>();
  let lastContactedAt: Date | null = null;

  for (const r of rows) {
    if (r.website?.domain) domains.add(r.website.domain);
    if (r.website?.profileKey) profileKeys.add(r.website.profileKey);
    if (r.instagram) instagrams.add(r.instagram);
    for (const t of r.tags) pushUnique(tags, tagKeys, t);
    for (const l of r.lists) pushUnique(lists, listKeys, l);
    for (const n of r.notes) pushUnique(notes, noteKeys, n);
    for (const [k, v] of Object.entries(r.custom)) {
      if (custom[k] === undefined) {
        custom[k] = v;
        customLabels[k] = r.customLabels[k] ?? k;
      }
    }
    if (r.lastContactedAt && (!lastContactedAt || r.lastContactedAt > lastContactedAt)) lastContactedAt = r.lastContactedAt;
    for (const p of r.people) {
      if (p.emailDomain) domains.add(p.emailDomain);
      if (p.emailNorm) {
        if (emails.has(p.emailNorm)) continue;
        emails.add(p.emailNorm);
      } else {
        const key = normalizeText(p.name);
        if (!key || peopleNames.has(key)) continue;
      }
      if (p.name && !p.isGeneric) peopleNames.add(normalizeText(p.name));
      people.push({ ...p, rowNumber: r.rowNumber });
    }
  }
  // A person without an email is dropped when someone with an email has the same name.
  const named = new Set(people.filter((p) => p.emailNorm && p.name).map((p) => normalizeText(p.name)));
  const finalPeople = people.filter((p) => p.emailNorm || !named.has(normalizeText(p.name)));

  return {
    key: `r${rows[0]!.rowNumber}`,
    rowNumbers: rows.map((r) => r.rowNumber),
    name,
    nameNorm: normalizeCompanyName(name),
    hasOwnIdentity: Boolean(explicitName || website || instagram),
    hasExplicitName: Boolean(explicitName),
    website,
    domains: [...domains],
    profileKeys: [...profileKeys],
    instagrams: [...instagrams],
    emails: [...emails],
    country: first((r) => r.country),
    niche: first((r) => r.niche),
    notes,
    personalLine: first((r) => r.personalLine),
    instagram,
    priority: first((r) => r.priority),
    status: first((r) => r.status),
    lastContactedAt,
    tags,
    lists,
    custom,
    customLabels,
    people: finalPeople,
  };
}

/**
 * Joins two groups that turned out to be the same existing company (for example one found by
 * website, one by name and country). The earlier group's values win; lists are combined.
 */
export function mergeGroupDrafts(a: ImportGroupDraft, b: ImportGroupDraft): ImportGroupDraft {
  const [first, second] = a.rowNumbers[0]! <= b.rowNumbers[0]! ? [a, b] : [b, a];
  const uniq = (xs: string[]) => {
    const seen = new Set<string>();
    return xs.filter((x) => {
      const k = normalizeText(x);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const emails = new Set(first.people.map((p) => p.emailNorm).filter(Boolean));
  const names = new Set(first.people.map((p) => normalizeText(p.name)).filter(Boolean));
  const people = [
    ...first.people,
    ...second.people.filter((p) => (p.emailNorm ? !emails.has(p.emailNorm) : !names.has(normalizeText(p.name)))),
  ];
  const website =
    first.website && !first.website.isShared ? first.website : second.website && !second.website.isShared ? second.website : (first.website ?? second.website);
  const name = first.hasExplicitName || !second.hasExplicitName ? first.name : second.name;
  const later = (x: Date | null, y: Date | null) => (x && y ? (x > y ? x : y) : (x ?? y));
  return {
    ...first,
    rowNumbers: [...first.rowNumbers, ...second.rowNumbers].sort((x, y) => x - y),
    name,
    nameNorm: normalizeCompanyName(name),
    hasOwnIdentity: first.hasOwnIdentity || second.hasOwnIdentity,
    hasExplicitName: first.hasExplicitName || second.hasExplicitName,
    website,
    domains: [...new Set([...first.domains, ...second.domains])],
    profileKeys: [...new Set([...first.profileKeys, ...second.profileKeys])],
    instagrams: [...new Set([...first.instagrams, ...second.instagrams])],
    emails: [...new Set([...first.emails, ...second.emails])],
    country: first.country ?? second.country,
    niche: first.niche ?? second.niche,
    notes: uniq([...first.notes, ...second.notes]),
    personalLine: first.personalLine ?? second.personalLine,
    instagram: first.instagram ?? second.instagram,
    priority: first.priority ?? second.priority,
    status: first.status ?? second.status,
    lastContactedAt: later(first.lastContactedAt, second.lastContactedAt),
    tags: uniq([...first.tags, ...second.tags]),
    lists: uniq([...first.lists, ...second.lists]),
    custom: { ...second.custom, ...first.custom },
    customLabels: { ...second.customLabels, ...first.customLabels },
    people,
  };
}

/** Normalises every row and groups the rows into companies. */
export function prepareImport(
  input: ReadonlyArray<{ rowNumber: number; cells: ReadonlyArray<string> }>,
  mapping: ReadonlyArray<ColumnMapping>,
  opts: PrepareOptions,
): PreparedImport {
  const readCountry = makeCountryReader();
  const sorted = [...input].sort((a, b) => a.rowNumber - b.rowNumber);
  // Day-first or month-first is decided once, from every value in the last-contacted column(s).
  const dateColumns = mapping.flatMap((m, i) => (m.target === "last_contacted" ? [i] : []));
  const dateValues = function* () {
    for (const r of sorted) {
      for (const i of dateColumns) {
        const v = (r.cells[i] ?? "").trim();
        if (v && !isPlaceholder(v)) yield v;
      }
    }
  };
  const { order: dateOrder, sure: dateOrderSure } = detectDateOrder(dateValues());
  const ctx: RowContext = { extraShared: opts.extraShared, readCountry, dateOrder, dateOrderSure, now: opts.now ?? new Date() };
  const rows = sorted.map((r) => normalizeRow(r.rowNumber, r.cells, mapping, ctx));

  const rowIssues = new Map<number, RowIssue[]>();
  for (const r of rows) if (r.issues.length) rowIssues.set(r.rowNumber, [...r.issues]);
  const addIssue = (rowNumber: number, issue: RowIssue) => {
    const list = rowIssues.get(rowNumber);
    if (list) list.push(issue);
    else rowIssues.set(rowNumber, [issue]);
  };

  // Exact copies of an earlier row add nothing: they're skipped with a note.
  const duplicateRows = new Map<number, number>();
  const fingerprints = new Map<string, number>();
  for (const r of rows) {
    if (!r.hasIdentity) continue;
    const earlier = fingerprints.get(r.fingerprint);
    if (earlier !== undefined) {
      duplicateRows.set(r.rowNumber, earlier);
      addIssue(r.rowNumber, { kind: "duplicate-in-file", message: `duplicate within the file: same as row ${earlier}` });
    } else {
      fingerprints.set(r.fingerprint, r.rowNumber);
    }
  }

  // Union-find over the grouping keys.
  const candidates = rows.filter((r) => r.hasIdentity);
  const uf = new UnionFind(candidates.length);
  const owner = new Map<string, number>();
  candidates.forEach((r, i) => {
    for (const key of groupingKeys(r, opts.grouping)) {
      const j = owner.get(key);
      if (j === undefined) owner.set(key, i);
      else uf.union(i, j);
    }
  });
  const byRoot = new Map<number, NormalizedRow[]>();
  candidates.forEach((r, i) => {
    const root = uf.find(i);
    const list = byRoot.get(root);
    if (list) list.push(r);
    else byRoot.set(root, [r]);
  });

  const groups: ImportGroupDraft[] = [];
  const rowGroup = new Map<number, string>();
  for (const members of byRoot.values()) {
    const group = buildGroup(members);
    groups.push(group);
    for (const r of members) rowGroup.set(r.rowNumber, group.key);
    // The same person twice in one company: note it on the later rows (unless the whole row is a copy).
    const seen = new Map<string, number>();
    for (const r of members) {
      for (const p of r.people) {
        if (!p.emailNorm) continue;
        const earlier = seen.get(p.emailNorm);
        if (earlier === undefined) seen.set(p.emailNorm, r.rowNumber);
        else if (earlier !== r.rowNumber && !duplicateRows.has(r.rowNumber)) {
          addIssue(r.rowNumber, { kind: "duplicate-in-file", message: `duplicate within the file: ${p.email} is also on row ${earlier}` });
        }
      }
    }
  }
  groups.sort((a, b) => a.rowNumbers[0]! - b.rowNumbers[0]!);
  return { rows, groups, rowGroup, rowIssues, duplicateRows };
}
