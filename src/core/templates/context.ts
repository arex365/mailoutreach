/**
 * The values a template's variables take for one person, sent by one teammate (PLAN.md B6.3).
 * Pure and browser-safe; the server loads the rows and calls buildTemplateValues().
 */

import { countryName } from "@/core/geo/display";
import { firstNameFrom } from "@/core/text";
import { isValidVariableName, STANDARD_VARIABLE_NAMES } from "./variables";

export type TemplatePerson = {
  id: number;
  name: string;
  firstName: string | null;
  isGeneric: boolean;
  personalLineOverride: string | null;
  customFields?: unknown;
};

export type TemplateCompany = {
  name: string;
  website: string | null;
  /** Company.domain: set for the company's own site (then {{website}} is just the host). */
  domain?: string | null;
  /** Company.profileKey: the account on a shared site, e.g. "instagram.com/sculpt_by_anna". */
  profileKey?: string | null;
  country: string | null;
  niche: string | null;
  /** The approved personal line only. */
  personalLine: string | null;
  customFields?: unknown;
};

export type TemplateSender = { name: string; signature: string | null };

export type TemplateValueInput = {
  person: TemplatePerson;
  company: TemplateCompany;
  sender: TemplateSender;
  /** Setting "portfolioUrl". */
  portfolioUrl: string | null;
  /** Every CustomField key, so a field that's empty for this company is "missing", not "unknown". */
  customFieldKeys?: readonly string[];
};

/** A custom field's stored value as plain text ("" when empty). */
export function customFieldText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
      .map((v) => String(v).trim())
      .join(", ");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function customObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The website as people write it in a sentence. A company's own site is just its host
 * ("acme.de", "shop.acme.de"); a profile on a shared site keeps the account
 * ("instagram.com/sculpt_by_anna"). `domain`/`profileKey` are the Company columns: a set `domain`
 * means an own site, a set `profileKey` names the account. Without them the path is kept.
 * Empty when there's no website.
 */
export function websiteForTemplate(
  website: string | null | undefined,
  company: { domain?: string | null; profileKey?: string | null } = {},
): string {
  const raw = (website ?? "").trim();
  if (company.profileKey) return company.profileKey;
  if (!raw) return "";
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (!host) return raw;
    if (company.domain) return host;
    const path = u.pathname && u.pathname !== "/" ? u.pathname.replace(/\/+$/, "") : "";
    return host + path;
  } catch {
    return raw.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  }
}

/** Plain-text values for every variable: the standard ones plus every custom field key. */
export function buildTemplateValues(input: TemplateValueInput): Record<string, string> {
  const { person, company, sender } = input;
  const values: Record<string, string> = {};

  // Custom fields first (so the standard names always win): every known key, then the company's
  // values, then the person's own non-empty values on top.
  for (const key of input.customFieldKeys ?? []) {
    if (isValidVariableName(key) && !STANDARD_VARIABLE_NAMES.has(key)) values[key] = "";
  }
  for (const [key, v] of Object.entries(customObject(company.customFields))) {
    if (isValidVariableName(key) && !STANDARD_VARIABLE_NAMES.has(key)) values[key] = customFieldText(v);
  }
  for (const [key, v] of Object.entries(customObject(person.customFields))) {
    if (!isValidVariableName(key) || STANDARD_VARIABLE_NAMES.has(key)) continue;
    const text = customFieldText(v);
    if (text) values[key] = text;
  }

  const firstName = person.isGeneric ? "" : (person.firstName ?? "").trim() || firstNameFrom(person.name, false);
  values.first_name = firstName;
  values.contact_name = person.isGeneric ? "" : (person.name ?? "").trim();
  values.company = (company.name ?? "").trim();
  values.website = websiteForTemplate(company.website, company);
  values.country = company.country ? countryName(company.country) : "";
  values.niche = (company.niche ?? "").trim();
  values.personal_line = (person.personalLineOverride ?? "").trim() || (company.personalLine ?? "").trim();
  values.sender_name = (sender.name ?? "").trim();
  values.sender_signature = (sender.signature ?? "").replace(/\r\n?/g, "\n").trim();
  values.portfolio_url = (input.portfolioUrl ?? "").trim();
  return values;
}
