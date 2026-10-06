import countries from "i18n-iso-countries";
import { normalizeText } from "../text";
import { DEFAULT_TIME_ZONES } from "./default-zones";

/**
 * Country handling (server/worker only: i18n-iso-countries loads every locale).
 * For display in the browser use countryName() from ./display (Intl-based, no library).
 */

const LOOKUP_LANGS = ["en", "de", "nb", "nn", "no", "sv", "da", "nl", "fr", "es", "it", "pt", "pl", "fi"];

const ALIASES: Record<string, string> = {
  uk: "GB",
  "u.k.": "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  britain: "GB",
  "great britain": "GB",
  holland: "NL",
  usa: "US",
  "u.s.a.": "US",
  america: "US",
  "united states of america": "US",
  el: "GR",
  deutschland: "DE",
  germany: "DE",
  norge: "NO",
  noreg: "NO",
  norway: "NO",
  "south korea": "KR",
  korea: "KR",
  russia: "RU",
  "czech republic": "CZ",
  czechia: "CZ",
  "uae": "AE",
  "u.a.e.": "AE",
  emirates: "AE",
  "hong kong": "HK",
  taiwan: "TW",
  vietnam: "VN",
  "ivory coast": "CI",
};

/** "Germany", "Deutschland", "DE", "DEU", "Norge" … → ISO alpha-2, or null if unknown. */
export function normalizeCountry(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;
  const n = normalizeText(raw).replace(/[.]$/, "");
  if (ALIASES[n]) return ALIASES[n]!;
  if (/^[a-z]{2}$/i.test(raw)) {
    const up = raw.toUpperCase();
    if (up === "UK") return "GB";
    if (up === "EL") return "GR";
    return countries.isValid(up) ? up : null;
  }
  if (/^[a-z]{3}$/i.test(raw)) {
    const a2 = countries.alpha3ToAlpha2(raw.toUpperCase());
    if (a2) return a2;
  }
  for (const lang of LOOKUP_LANGS) {
    const code = countries.getSimpleAlpha2Code(raw, lang) ?? countries.getAlpha2Code(raw, lang);
    if (code) return code;
  }
  return null;
}

/** Default IANA zone for a country (main business zone for multi-zone countries). */
export function defaultTimeZoneFor(iso2: string | null | undefined): string | null {
  if (!iso2) return null;
  return DEFAULT_TIME_ZONES[iso2.toUpperCase()] ?? null;
}

export function isValidTimeZone(tz: string | null | undefined): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
