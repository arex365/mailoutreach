/**
 * Text normalisation used for search, grouping and duplicate detection.
 * Pure functions: safe in the browser, the server and the worker.
 */

const SPECIAL: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  ø: "o",
  œ: "oe",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
  ı: "i",
};

/** Lowercase, strip accents (ü→u, ø→o, ß→ss), collapse whitespace, trim. */
export function normalizeText(input: string | null | undefined): string {
  if (!input) return "";
  let s = input.toLowerCase();
  s = s.replace(/[ßæøœłđðþı]/g, (ch) => SPECIAL[ch] ?? ch);
  s = s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  return s.replace(/\s+/g, " ").trim();
}

const LEGAL_SUFFIXES = [
  "gmbh & co. kg",
  "gmbh & co kg",
  "gmbh",
  "mbh",
  "ug (haftungsbeschrankt)",
  "ug",
  "ag",
  "kg",
  "ohg",
  "gbr",
  "e.k.",
  "ek",
  "e.v.",
  "as",
  "a/s",
  "asa",
  "ans",
  "da",
  "ab",
  "aps",
  "oy",
  "ltd",
  "ltd.",
  "limited",
  "llc",
  "l.l.c.",
  "inc",
  "inc.",
  "corp",
  "corp.",
  "co",
  "co.",
  "plc",
  "bv",
  "b.v.",
  "nv",
  "sarl",
  "sas",
  "sa",
  "srl",
  "s.r.l.",
  "spa",
  "s.p.a.",
  "sl",
  "s.l.",
  "pty",
  "pty ltd",
  "kft",
  "sro",
  "s.r.o.",
  "sp. z o.o.",
];

/**
 * Company name key for grouping/duplicate detection:
 * "Müller 3D-Druck GmbH & Co. KG" → "muller 3d druck".
 */
export function normalizeCompanyName(input: string | null | undefined): string {
  let s = normalizeText(input);
  if (!s) return "";
  // Remove legal suffixes at the end (repeat: "xyz gmbh & co. kg").
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of LEGAL_SUFFIXES) {
      if (s.endsWith(" " + suf) || s === suf) {
        s = s.slice(0, s.length - suf.length).replace(/[\s,&]+$/, "").trim();
        changed = true;
      }
    }
  }
  return s
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Builds the lowercase search column from any number of parts. */
export function buildSearchText(parts: Array<string | null | undefined>): string {
  return parts
    .map((p) => normalizeText(p))
    .filter(Boolean)
    .join(" ");
}

/** First word of a person's name, for {{first_name}}. Empty for "General inbox". */
export function firstNameFrom(fullName: string | null | undefined, isGeneric = false): string {
  if (isGeneric || !fullName) return "";
  const cleaned = fullName.trim().replace(/^(mr|mrs|ms|dr|herr|frau|prof)\.?\s+/i, "");
  const first = cleaned.split(/\s+/)[0] ?? "";
  return first.replace(/[,;]+$/, "");
}

/** Plural helper for plain-language counts: plural(3, "company", "companies"). */
export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}
