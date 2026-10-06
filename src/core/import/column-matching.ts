import { normalizeText } from "../text";
import { mapImportStatus } from "./values";

/**
 * Column matching for imports (SPEC §4, PLAN.md B6.13): which column of the file goes into
 * which field. Pure and browser-safe (the mapping screen uses it for its preview).
 *
 * A dictionary of English, German and Norwegian header names plus the old tool's columns.
 * Unmatched columns default to "Keep as custom field" (key = slug of the header).
 * To add a new target, add it to TARGET_FIELDS and to the dictionary below.
 *
 * The missing-emails round trip (M5-DESIGN §4.2): a `company_id` column ("C-1042", from
 * "Export for Claude" or any Contacts export) makes the file a round trip, which only adds people
 * to companies that already exist. Its source and note columns then go to "Notes about the person"
 * instead of the website and the company notes (`suggestMapping`'s round-trip switch).
 */

export const TARGET_FIELDS = [
  { key: "company", label: "Company name", section: "company" },
  { key: "website", label: "Website", section: "company" },
  { key: "country", label: "Country", section: "company" },
  { key: "niche", label: "Niche", section: "company" },
  { key: "instagram", label: "Instagram", section: "company" },
  { key: "priority", label: "Priority", section: "company" },
  { key: "status", label: "Status", section: "company" },
  { key: "tags", label: "Tags", section: "company", multi: true },
  { key: "notes", label: "Notes", section: "company", multi: true },
  { key: "personal_line", label: "Personal line", section: "company" },
  { key: "last_contacted", label: "Last contacted", section: "company" },
  { key: "list", label: "List name", section: "company", multi: true },
  { key: "company_id", label: "Company ID (like C-1042)", section: "company" },
  { key: "email", label: "Email", section: "person", multi: true },
  { key: "name", label: "Person's full name", section: "person" },
  { key: "first_name", label: "First name", section: "person" },
  { key: "last_name", label: "Last name", section: "person" },
  { key: "role", label: "Role or job title", section: "person" },
  { key: "person_notes", label: "Notes about the person", section: "person", multi: true },
] as const satisfies ReadonlyArray<{ key: string; label: string; section: "company" | "person"; multi?: boolean }>;

export type TargetKey = (typeof TARGET_FIELDS)[number]["key"];

export const TARGET_KEYS: ReadonlyArray<TargetKey> = TARGET_FIELDS.map((t) => t.key);

export const TARGET_LABELS: Record<TargetKey, string> = Object.fromEntries(
  TARGET_FIELDS.map((t) => [t.key, t.label]),
) as Record<TargetKey, string>;

/** Targets that collect every mapped column (several emails, tags, notes, lists). */
export const MULTI_TARGETS: ReadonlySet<TargetKey> = new Set(
  TARGET_FIELDS.filter((t) => "multi" in t && t.multi).map((t) => t.key),
);

/** Targets that tell us which company (or person) a row is about. */
export const IDENTITY_TARGETS: ReadonlySet<TargetKey> = new Set([
  "company",
  "website",
  "email",
  "instagram",
  "name",
  "first_name",
  "last_name",
]);

export type ColumnMapping =
  | { target: TargetKey }
  | { target: "custom"; key: string; label: string }
  | { target: "ignore" };

export type Confidence = "high" | "medium" | "low";

export type SuggestedColumn = { mapping: ColumnMapping; confidence: Confidence };

/** The old tool's extra columns, kept as custom fields (SPEC §2). */
export const KNOWN_CUSTOM_FIELDS: Record<string, string> = {
  followers: "Followers",
  est_revenue: "Est. revenue",
  platforms: "Platforms",
  phone: "Phone",
};

/** Names that templates already use ({{company}}, {{first_name}} …): custom fields never take them. */
const RESERVED_KEYS = new Set([
  "company",
  "website",
  "country",
  "niche",
  "first_name",
  "last_name",
  "contact_name",
  "personal_line",
  "sender_name",
  "sender_signature",
  "portfolio_url",
  "email",
  "name",
  "role",
  "tags",
  "notes",
  "status",
  "priority",
  "instagram",
  "list",
  "unsubscribe_url",
]);

// ───────────────────────── header normalisation ─────────────────────────

/** "E-Mail-Adresse" → "emailadresse", "Est. revenue" → "estrevenue", "Følgere" → "folgere". */
export function compactHeader(header: string): string {
  return normalizeText(header).replace(/[^a-z0-9]+/g, "");
}

function headerTokens(header: string): string[] {
  return normalizeText(header)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Custom-field key from a header: "Est. revenue" → "est_revenue", "2024 sales" → "f_2024_sales". */
export function customFieldKey(header: string, fallbackIndex = 0): string {
  let slug = normalizeText(header)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
    .replace(/_+$/, "");
  if (!slug) slug = `column_${fallbackIndex + 1}`;
  if (/^[0-9]/.test(slug)) slug = `f_${slug}`;
  if (RESERVED_KEYS.has(slug)) slug = `${slug}_field`;
  return slug;
}

export function isValidCustomKey(key: string): boolean {
  return /^[a-z][a-z0-9_]{0,59}$/.test(key) && !RESERVED_KEYS.has(key);
}

// ───────────────────────── dictionary ─────────────────────────

type DictTarget = TargetKey | "ignore" | `custom:${string}` | "ambiguous-name" | "ambiguous-contact";

const DICTIONARY: Record<string, DictTarget> = {};
function add(target: DictTarget, ...headers: string[]) {
  for (const h of headers) DICTIONARY[compactHeader(h)] = target;
}

add(
  "company",
  "company", "company name", "companyname", "business", "business name", "organisation", "organization",
  "organisation name", "organization name", "brand", "brand name", "studio", "studio name", "shop", "shop name",
  "store", "store name", "account", "account name", "customer", "customer name", "client", "client name", "creator",
  "creator name", "firm", "firma", "firmenname", "firmierung", "unternehmen", "unternehmensname", "betrieb", "kunde",
  "kundenname", "bedrift", "bedriftsnavn", "selskap", "selskapsnavn", "firmanavn", "foretak", "foretaksnavn",
  "virksomhet", "kundenavn",
);
add(
  "website",
  "website", "web site", "website url", "web", "webseite", "web-seite", "internetseite", "internetadresse",
  "webadresse", "homepage", "home page", "url", "domain", "domain name", "domene", "site", "www", "link", "web link",
  "webpage", "web page", "nettside", "nettsted", "hjemmeside", "nettadresse", "online shop", "shop url",
);
add(
  "email",
  "email", "e-mail", "e mail", "email address", "e-mail address", "e-mail-adresse", "emailadresse", "email adresse",
  "mail", "mail address", "mailadresse", "emails", "e-mails", "e-post", "epost", "e-postadresse", "epostadresse",
  "contact email", "kontakt email", "kontakt e-mail", "kontakt-e-mail", "business email", "work email", "email 1",
  "email 2", "email 3", "e-mail 1", "e-mail 2", "primary email", "secondary email",
);
add(
  "name",
  "contact name", "contact person", "contactperson", "person", "person name", "full name", "fullname",
  "ansprechpartner", "ansprechperson", "kontaktperson", "kontakt person", "kontaktnavn", "vollstandiger name",
  "fullt navn", "owner", "owner name", "founder", "inhaber", "eier", "person name", "person_name", "contact_name",
);
add("first_name", "first name", "firstname", "first", "given name", "forename", "vorname", "fornavn");
add("last_name", "last name", "lastname", "surname", "family name", "nachname", "familienname", "etternavn");
add(
  "role",
  "role", "title", "job title", "jobtitle", "job", "position", "job position", "designation", "funktion", "stellung",
  "rolle", "titel", "berufsbezeichnung", "stilling", "tittel", "jobbtittel", "stillingstittel",
);
add(
  "country",
  "country", "country code", "countrycode", "country name", "country iso", "land", "landcode", "laendercode",
  "landkode", "nation", "staat", "location", "standort", "sted",
);
add(
  "niche",
  "niche", "nische", "nisje", "category", "categories", "kategorie", "kategorien", "kategori", "branche",
  "bransje", "industry", "industries", "sector", "sektor", "segment", "type", "typ", "business type", "focus",
  "fokus", "specialty", "speciality", "spezialisierung", "genre",
);
add("tags", "tags", "tag", "labels", "label", "schlagworte", "schlagwort", "stichworte", "stikkord", "keywords", "etiketter", "merkelapper");
add(
  "notes",
  "notes", "note", "notizen", "notiz", "notater", "notat", "kommentar", "kommentare", "comments", "comment",
  "bemerkung", "bemerkungen", "anmerkungen", "remarks", "memo", "merknad", "merknader", "description",
  "beschreibung", "beskrivelse", "info", "details",
);
add(
  "personal_line",
  "personal line", "personal_line", "personalised line", "personalized line", "personalisation",
  "personalization", "icebreaker", "ice breaker", "opener", "opening line", "personliche zeile",
  "persoenliche zeile", "personlig linje",
);
add(
  "instagram",
  "instagram", "insta", "ig", "instagram handle", "instagram url", "instagram link", "instagram profile",
  "instagram account", "instagram name", "ig handle", "handle",
);
add("priority", "priority", "prio", "priorität", "prioritat", "prioritaet", "prioritet", "wichtigkeit", "importance");
add(
  "status",
  "status", "stage", "phase", "lead status", "contact status", "kontaktstatus", "outreach status", "stand",
);
add(
  "last_contacted",
  "last contact", "last contacted", "last contact date", "last contacted date", "date last contacted",
  "last emailed", "last_emailed", "last email", "last outreach", "contacted on", "contacted date", "date contacted",
  "letzter kontakt", "zuletzt kontaktiert", "kontaktiert am", "letztes kontaktdatum", "kontaktdatum",
  "sist kontaktet", "sist kontakt", "kontaktet dato", "dato kontaktet",
);
add("list", "list", "list name", "lists", "liste", "listen", "listenname", "lister", "tab", "gruppe", "group");
add(
  "custom:followers",
  "members", "member", "member count", "members count", "followers", "follower", "follower count",
  "followers count", "mitglieder", "medlemmer", "folgere", "følgere", "abonnenten", "fans", "subscribers", "audience",
);
add(
  "custom:est_revenue",
  "est. revenue", "est revenue", "estimated revenue", "revenue", "revenue (est.)", "umsatz", "jahresumsatz",
  "geschatzter umsatz", "omsetning", "turnover",
);
add("custom:platforms", "platforms", "platform", "plattformen", "plattform", "plattformer", "channels", "kanale", "kanaler", "socials", "social media");
add(
  "custom:phone",
  "phone", "phone number", "telephone", "tel", "tel.", "mobile", "mobil", "handy", "telefon", "telefonnummer",
  "telefonnr", "mobilnummer",
);
// Our own company code ("C-1042"): the missing-emails round trip. A bare "id" or "#" stays ignored
// (too ambiguous in other people's files).
add(
  "company_id",
  "company_id", "company id", "companyid", "company code", "firmen_id", "firmen-id", "bedrift_id", "bedrifts-id",
);
// Columns from our own export (or bookkeeping) that shouldn't become fields.
add("ignore", "id", "#", "no", "nr", "row", "emailed_by", "emailed by", "verification", "unsubscribed", "lists_in_app");
add("ambiguous-name", "name", "navn", "namn", "nom", "names");
add("ambiguous-contact", "contact", "kontakt", "contacts");

/**
 * In a round trip these columns hold where Claude found the address and its remark, so they go to
 * "Notes about the person" instead of the website and the company notes (M5-DESIGN §4.2).
 */
const ROUND_TRIP_NOTE_HEADERS: ReadonlySet<string> = new Set(
  ["source_url", "source", "quelle", "kilde", "note", "notes", "notiz", "merknad"].map(compactHeader),
);

/** True for a header that becomes "Notes about the person" in a round trip ("source_url", "note", "Quelle" …). */
export function isRoundTripNoteHeader(header: string): boolean {
  return ROUND_TRIP_NOTE_HEADERS.has(compactHeader(header));
}

/** A mapping with a Company ID column: the file only adds people to existing companies (M5-DESIGN §4.2). */
export function isRoundTripMapping(mapping: ReadonlyArray<ColumnMapping>): boolean {
  return mapping.some((m) => m.target === "company_id");
}

// ───────────────────────── value sniffing ─────────────────────────

const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const URL_LIKE = /^(https?:\/\/|www\.)\S+$|^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?$/i;
const HANDLE_LIKE = /^@[a-z0-9._]{2,30}$/i;

function share(values: string[], re: RegExp): number {
  const filled = values.filter((v) => v.trim() !== "");
  if (filled.length === 0) return -1;
  return filled.filter((v) => re.test(v.trim().split(/[;,\s]+/)[0] ?? "")).length / filled.length;
}

// ───────────────────────── suggestion ─────────────────────────

function containsRule(header: string, samples: string[]): { target: DictTarget; confidence: Confidence } | null {
  const c = compactHeader(header);
  const tokens = headerTokens(header);
  const has = (...parts: string[]) => parts.some((p) => c.includes(p));
  const tok = (...parts: string[]) => parts.some((p) => tokens.includes(p));
  const emailShare = share(samples, EMAIL_LIKE);
  const urlShare = share(samples, URL_LIKE);

  if (has("follower", "mitglied", "medlem", "abonnent", "subscriber")) return { target: "custom:followers", confidence: "medium" };
  if (has("revenue", "umsatz", "omsetning", "turnover")) return { target: "custom:est_revenue", confidence: "medium" };
  if (has("platform", "plattform")) return { target: "custom:platforms", confidence: "medium" };
  if (has("phone", "telefon", "mobil")) return { target: "custom:phone", confidence: "medium" };
  if (has("instagram") || tok("ig", "insta")) return { target: "instagram", confidence: "medium" };
  if ((has("email", "epost") || tok("mail")) && (emailShare < 0 || emailShare >= 0.5)) {
    return { target: "email", confidence: "medium" };
  }
  if (has("website", "webseite", "homepage", "nettside", "hjemmeside", "domain", "domene") || tok("url", "web", "www")) {
    if (urlShare < 0 || urlShare >= 0.5) return { target: "website", confidence: "medium" };
  }
  if ((has("contact", "kontakt") && has("last", "letzt", "sist", "zuletzt", "date", "dato", "datum")) || has("lastcontact")) {
    return { target: "last_contacted", confidence: "medium" };
  }
  if (has("firstname", "vorname", "fornavn")) return { target: "first_name", confidence: "medium" };
  if (has("lastname", "nachname", "etternavn", "surname")) return { target: "last_name", confidence: "medium" };
  if (has("contactperson", "ansprechpartner", "kontaktperson")) return { target: "name", confidence: "medium" };
  if (has("jobtitle", "position", "rolle", "stilling")) return { target: "role", confidence: "medium" };
  if (tok("country", "land", "countrycode")) return { target: "country", confidence: "medium" };
  if (has("niche", "nische", "kategor", "categor", "branche", "bransje", "industr")) return { target: "niche", confidence: "medium" };
  if (tok("tags", "tag", "labels") || has("schlagw")) return { target: "tags", confidence: "medium" };
  if (has("note", "notiz", "notat", "kommentar", "comment", "bemerkung", "remark")) return { target: "notes", confidence: "medium" };
  if (has("prio")) return { target: "priority", confidence: "medium" };
  if (has("status")) {
    // "Email status: valid/bounced" is not a company status.
    const filled = samples.filter((v) => v.trim());
    const known = filled.filter((v) => mapImportStatus(v) !== null).length;
    if (filled.length === 0 || known / filled.length >= 0.5) return { target: "status", confidence: "medium" };
  }
  if (
    has("company", "firma", "firmen", "unternehmen", "bedrift", "selskap") &&
    !has("size", "type", "count", "anzahl", "grosse", "storrelse", "id")
  ) {
    return { target: "company", confidence: "medium" };
  }
  return null;
}

function sampleRule(samples: string[]): { target: DictTarget; confidence: Confidence } | null {
  if (share(samples, EMAIL_LIKE) >= 0.6) return { target: "email", confidence: "medium" };
  if (share(samples, HANDLE_LIKE) >= 0.6) return { target: "instagram", confidence: "medium" };
  if (share(samples, URL_LIKE) >= 0.6) return { target: "website", confidence: "medium" };
  return null;
}

function toMapping(target: DictTarget, header: string, index: number): ColumnMapping {
  if (target === "ignore") return { target: "ignore" };
  if (target.startsWith("custom:")) {
    const key = target.slice("custom:".length);
    return { target: "custom", key, label: KNOWN_CUSTOM_FIELDS[key] ?? header };
  }
  if (target === "ambiguous-name" || target === "ambiguous-contact") return { target: "name" };
  if ((TARGET_KEYS as readonly string[]).includes(target)) return { target: target as TargetKey };
  return { target: "custom", key: customFieldKey(header, index), label: header };
}

export type SuggestOptions = {
  /**
   * The round-trip switch (M5-DESIGN §4.2): source and note columns go to "Notes about the person".
   * Default: on when some column is suggested as the Company ID.
   */
  roundTrip?: boolean;
};

/**
 * Suggests a mapping for every column. `sampleRows` (a few data rows) help with vague
 * headers ("Contact", "Links") and guard against wrong guesses ("Email status").
 */
export function suggestMapping(
  headers: ReadonlyArray<string>,
  sampleRows: ReadonlyArray<ReadonlyArray<string>> = [],
  opts: SuggestOptions = {},
): SuggestedColumn[] {
  const samplesFor = (i: number) => sampleRows.map((r) => r[i] ?? "").slice(0, 50);
  const raw = headers.map((header, i) => {
    const samples = samplesFor(i);
    const exact = DICTIONARY[compactHeader(header)];
    if (exact === "ambiguous-contact") {
      const target: DictTarget = share(samples, EMAIL_LIKE) >= 0.5 ? "email" : "name";
      return { target, confidence: "medium" as Confidence, ambiguous: false };
    }
    if (exact) return { target: exact, confidence: "high" as Confidence, ambiguous: exact === "ambiguous-name" };
    const contains = containsRule(header, samples);
    if (contains) return { ...contains, ambiguous: false };
    const sniffed = sampleRule(samples);
    if (sniffed) return { ...sniffed, ambiguous: false };
    return { target: `custom:${customFieldKey(header, i)}` as DictTarget, confidence: "low" as Confidence, ambiguous: false };
  });

  // "Name": the company when there is no company column, otherwise the person's name.
  const hasCompany = raw.some((r) => r.target === "company");
  const ambiguous = raw.filter((r) => r.ambiguous);
  let usedAsCompany = false;
  for (const r of ambiguous) {
    if (!hasCompany && !usedAsCompany) {
      r.target = "company";
      usedAsCompany = true;
    } else {
      r.target = "name";
    }
    r.confidence = "medium";
  }

  // A round trip: where Claude found the address, and its note, belong to the person.
  const roundTrip = opts.roundTrip ?? raw.some((r) => r.target === "company_id");
  if (roundTrip) {
    raw.forEach((r, i) => {
      if (isRoundTripNoteHeader(headers[i]!)) {
        r.target = "person_notes";
        r.confidence = "high";
      }
    });
  }

  const suggestions = raw.map((r, i) => ({ mapping: toMapping(r.target, headers[i]!, i), confidence: r.confidence }));
  return ensureUniqueCustomKeys(suggestions.map((s) => s.mapping)).map((mapping, i) => ({
    mapping,
    confidence: suggestions[i]!.confidence,
  }));
}

/** Two columns can't write to the same custom field: the second becomes "phone_2". */
export function ensureUniqueCustomKeys(mapping: ReadonlyArray<ColumnMapping>): ColumnMapping[] {
  const seen = new Set<string>();
  return mapping.map((m) => {
    if (m.target !== "custom") return m;
    let key = m.key;
    let n = 2;
    while (seen.has(key)) key = `${m.key}_${n++}`;
    seen.add(key);
    return key === m.key ? m : { ...m, key };
  });
}

/** The mapping for a column when the user picks "Keep as custom field". */
export function customMappingFor(header: string, index: number): ColumnMapping {
  const known = DICTIONARY[compactHeader(header)];
  if (known && known.startsWith("custom:")) {
    const key = known.slice(7);
    return { target: "custom", key, label: KNOWN_CUSTOM_FIELDS[key] ?? header };
  }
  return { target: "custom", key: customFieldKey(header, index), label: header };
}

/**
 * The mapping after the round-trip switch flipped (a column was set to, or away from, Company ID),
 * M5-DESIGN §4.2:
 *  - into a round trip: the source and note columns that still hold their ordinary suggestion
 *    go to "Notes about the person" (columns the person chose themselves stay as they are);
 *  - out of it: every "Notes about the person" column goes back to its ordinary suggestion, since
 *    only a round trip writes person notes.
 * Also applied to the suggestion itself, so the hints under the selects stay right.
 */
export function retargetRoundTripColumns(
  headers: ReadonlyArray<string>,
  sampleRows: ReadonlyArray<ReadonlyArray<string>>,
  mapping: ReadonlyArray<ColumnMapping>,
  roundTrip: boolean,
): ColumnMapping[] {
  const affected = (m: ColumnMapping, i: number) =>
    roundTrip ? isRoundTripNoteHeader(headers[i] ?? "") : m.target === "person_notes";
  if (!mapping.some(affected)) return [...mapping];
  const ordinary = suggestMapping(headers, sampleRows, { roundTrip: false });
  return mapping.map((m, i) => {
    if (!affected(m, i)) return m;
    const plain = ordinary[i]?.mapping ?? { target: "ignore" };
    if (roundTrip) return sameColumnMapping(m, plain) ? { target: "person_notes" } : m;
    return plain;
  });
}

/** Two mappings point at the same place (custom fields by key). */
export function sameColumnMapping(a: ColumnMapping | undefined, b: ColumnMapping | undefined): boolean {
  if (!a || !b || a.target !== b.target) return false;
  if (a.target === "custom" && b.target === "custom") return a.key === b.key;
  return true;
}

/** Shown when a round-trip file has no email column: it would add nobody. */
export const ROUND_TRIP_NEEDS_EMAIL =
  "Match the column with the email addresses too: a file with a company_id column adds people by their email address.";

/** Plain-language problem with a mapping, or null when it can be used. */
export function mappingProblem(mapping: ReadonlyArray<ColumnMapping>): string | null {
  if (isRoundTripMapping(mapping)) {
    // The Company ID says which company; only the email says who to add.
    return mapping.some((m) => m.target === "email") ? null : ROUND_TRIP_NEEDS_EMAIL;
  }
  if (!mapping.some((m) => m.target !== "ignore" && m.target !== "custom" && IDENTITY_TARGETS.has(m.target))) {
    return "Match at least one column to Company name, Website, Email, Instagram or a person's name, so we know which company each row belongs to.";
  }
  return null;
}

// ───────────────────────── applying a mapping ─────────────────────────

export type MappedRow = {
  /** Non-empty values per target, in column order. */
  fields: Partial<Record<TargetKey, string[]>>;
  custom: Array<{ key: string; label: string; value: string }>;
};

/** Cell values that mean "nothing here" in spreadsheets. */
const PLACEHOLDERS = new Set(["-", "--", "–", "—", "n/a", "#n/a", "none", "null", "nil", "(blank)"]);

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDERS.has(value.trim().toLowerCase());
}

export function mapRow(mapping: ReadonlyArray<ColumnMapping>, cells: ReadonlyArray<string>): MappedRow {
  const fields: Partial<Record<TargetKey, string[]>> = {};
  const custom: MappedRow["custom"] = [];
  mapping.forEach((m, i) => {
    const value = (cells[i] ?? "").trim();
    if (!value || m.target === "ignore" || isPlaceholder(value)) return;
    if (m.target === "custom") {
      custom.push({ key: m.key, label: m.label, value });
      return;
    }
    (fields[m.target] ??= []).push(value);
  });
  return { fields, custom };
}

/** First non-empty value for single-value targets (several columns may point at the same field). */
export function firstValue(row: MappedRow, target: TargetKey): string {
  return row.fields[target]?.[0] ?? "";
}

export type PreviewColumn = { id: string; label: string };

/** Columns of the mapping preview: each used target once, in the order of the file's columns. */
export function previewColumns(mapping: ReadonlyArray<ColumnMapping>): PreviewColumn[] {
  const out: PreviewColumn[] = [];
  const seen = new Set<string>();
  for (const m of mapping) {
    if (m.target === "ignore") continue;
    const id = m.target === "custom" ? `custom:${m.key}` : m.target;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: m.target === "custom" ? m.label : TARGET_LABELS[m.target] });
  }
  return out;
}

export function previewCell(row: MappedRow, columnId: string): string {
  if (columnId.startsWith("custom:")) {
    const key = columnId.slice(7);
    return row.custom.find((c) => c.key === key)?.value ?? "";
  }
  const target = columnId as TargetKey;
  const values = row.fields[target] ?? [];
  return MULTI_TARGETS.has(target) ? values.join(", ") : (values[0] ?? "");
}
