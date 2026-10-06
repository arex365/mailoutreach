import { DEFAULT_TIME_ZONES } from "./default-zones";

/** Browser-safe country helpers (Intl only, no libraries). */

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

export function countryName(iso2: string | null | undefined): string {
  if (!iso2) return "";
  try {
    return regionNames.of(iso2.toUpperCase()) ?? iso2;
  } catch {
    return iso2;
  }
}

/** All countries we know a zone for, sorted by English name — for pickers. */
export function countryOptions(): Array<{ code: string; name: string }> {
  return Object.keys(DEFAULT_TIME_ZONES)
    .map((code) => ({ code, name: countryName(code) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Common IANA zones for the time-zone picker (plus whatever a record already uses). */
export function timeZoneOptions(): string[] {
  const set = new Set(Object.values(DEFAULT_TIME_ZONES));
  for (const z of [
    "UTC",
    "Asia/Karachi",
    "America/Los_Angeles",
    "America/Chicago",
    "America/Denver",
    "America/Phoenix",
    "America/Vancouver",
    "America/Edmonton",
    "America/Winnipeg",
    "America/Halifax",
    "Australia/Perth",
    "Australia/Adelaide",
    "Australia/Brisbane",
    "Australia/Melbourne",
    "Europe/Kaliningrad",
    "Asia/Yekaterinburg",
    "Asia/Novosibirsk",
    "Asia/Vladivostok",
  ]) {
    set.add(z);
  }
  return [...set].sort();
}
