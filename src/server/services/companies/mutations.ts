import { Prisma, type Company } from "@/generated/prisma/client";
import { dbTx, type Tx } from "@/server/db";
import { logActivity } from "@/server/activity";
import { refreshCompanySearchText } from "@/server/company-search";
import { getSettings } from "@/server/settings";
import { normalizeCompanyName, normalizeText } from "@/core/text";
import { INSTAGRAM_NOT_PROFILES, instagramHandle, parseWebsite } from "@/core/shared-domains";
import { defaultTimeZoneFor, isValidTimeZone, normalizeCountry } from "@/core/geo/countries";
import { countryName } from "@/core/geo/display";
import {
  COMPANY_STATUSES,
  COMPANY_STATUS_LABELS,
  PRIORITIES,
  PRIORITY_LABELS,
  type CompanyStatusValue,
  type PriorityValue,
} from "@/core/labels";
import { finishCheck } from "@/server/services/campaigns/control";
import { stopCompaniesForStatus, type StopStatus } from "@/server/services/mail-events/stops";
import { priorityRank } from "./filters";
import { companyCode, customFieldsObject, customValueText } from "./detail";

/** The statuses whose manual setting stops a company's follow-ups (M4-DESIGN §2.7). */
const STOP_STATUSES: ReadonlySet<string> = new Set<StopStatus>(["REPLIED", "CLIENT", "NOT_INTERESTED", "DO_NOT_CONTACT"]);

/** Replied, Client, Not interested or Do not contact: setting it by hand stops the company's follow-ups at once. */
export function isStopStatus(status: string): status is StopStatus {
  return STOP_STATUSES.has(status);
}

/**
 * Changes made from the company panel (PLAN.md A6, B5). Every change:
 *  - runs in one short dbTx,
 *  - logs activity with the person who made it,
 *  - refreshes Company.searchText when a searchable field changed.
 * Errors meant for the user are ServiceError (plain words; the action layer turns them into UserError).
 */

export type Actor = { id: number; name: string };

export type ErrorLink = { href: string; label: string };

/** A problem the user can fix, in plain words. Optional link (e.g. to the company that already has an address). */
export class ServiceError extends Error {
  readonly fieldErrors?: Record<string, string[]>;
  readonly link?: ErrorLink;
  constructor(message: string, opts: { fieldErrors?: Record<string, string[]>; link?: ErrorLink } = {}) {
    super(message);
    this.name = "ServiceError";
    this.fieldErrors = opts.fieldErrors;
    this.link = opts.link;
  }
}

export function companyLink(c: { id: number; name: string }): ErrorLink {
  return { href: `/contacts?company=${c.id}`, label: `${companyCode(c.id)} ${c.name}` };
}

/** Trims and collapses whitespace (single-line values). */
export function cleanLine(v: string | null | undefined): string {
  return (v ?? "").replace(/\s+/g, " ").trim();
}

/** Keeps line breaks but normalises them and trims the ends (notes). */
export function cleanMultiline(v: string | null | undefined): string {
  return (v ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

export const LIMITS = {
  companyName: 200,
  niche: 100,
  notes: 10_000,
  personalLine: 300,
  customValue: 1_000,
  listName: 80,
  tagName: 50,
} as const;

type CompanyRow = Company;

/** A company id that isn't in the database (never happens through the app's own links). */
export const COMPANY_GONE = "This company doesn't exist any more. Refresh the page to see the latest.";

/** Loads a company that exists and isn't deleted, or throws a plain-language error. */
export async function loadActiveCompany(tx: Tx, companyId: number): Promise<CompanyRow> {
  const c = await tx.company.findUnique({ where: { id: companyId } });
  if (!c) throw new ServiceError(COMPANY_GONE);
  if (c.deletedAt) throw new ServiceError("This company was deleted. Restore it first to make changes.");
  return c;
}

async function loadCompany(tx: Tx, companyId: number): Promise<CompanyRow> {
  const c = await tx.company.findUnique({ where: { id: companyId } });
  if (!c) throw new ServiceError(COMPANY_GONE);
  return c;
}

export type ChangeResult = { changed: boolean };

// ───────────────────────── header ─────────────────────────

export async function renameCompany(actor: Actor, companyId: number, input: string): Promise<ChangeResult & { name: string }> {
  const name = cleanLine(input);
  if (!name) throw new ServiceError("Enter the company name.", { fieldErrors: { name: ["Enter the company name."] } });
  if (name.length > LIMITS.companyName) {
    const msg = `Keep the name under ${LIMITS.companyName} characters.`;
    throw new ServiceError(msg, { fieldErrors: { name: [msg] } });
  }
  return dbTx(async (tx) => {
    const c = await loadActiveCompany(tx, companyId);
    if (c.name === name) return { changed: false, name };
    await tx.company.update({ where: { id: c.id }, data: { name, nameNorm: normalizeCompanyName(name) } });
    await refreshCompanySearchText(tx, [c.id]);
    await logActivity(
      {
        actorId: actor.id,
        type: "company.updated",
        summary: `${actor.name} renamed ${c.name} to ${name}`,
        companyId: c.id,
        data: { field: "name", from: c.name, to: name },
      },
      tx,
    );
    return { changed: true, name };
  });
}

/**
 * Sets a company's status by hand. Replied, Client, Not interested and Do not contact stop its follow-ups at once, in
 * every campaign, in the same transaction as the status write (M4-DESIGN §2.7, D18: `stopCompaniesForStatus`, stop
 * code `status:<STATUS>`); campaigns left with nothing to send finish right after. Any other status stops or restarts
 * nothing. Returns `stopped`: how many people's emails stopped.
 *
 * The finish checks run after the status and the stops are saved and never throw (a failure is logged and the
 * sending maintenance repeats it), so a busy database there can't turn this saved change into an error.
 */
export async function setCompanyStatus(
  actor: Actor,
  companyId: number,
  status: CompanyStatusValue,
  opts: { now?: Date } = {},
): Promise<ChangeResult & { label: string; stopped: number }> {
  if (!COMPANY_STATUSES.includes(status)) throw new ServiceError("Pick a status from the list.");
  const label = COMPANY_STATUS_LABELS[status];
  const now = opts.now ?? new Date();
  const res = await dbTx(async (tx) => {
    const c = await loadActiveCompany(tx, companyId);
    if (c.status === status) return { changed: false, label, stopped: 0, campaignIds: [] as number[] };
    await tx.company.update({ where: { id: c.id }, data: { status } });
    await logActivity(
      {
        actorId: actor.id,
        type: "company.status",
        summary: `${actor.name} set status to ${label}`,
        companyId: c.id,
        data: { from: c.status, to: status },
      },
      tx,
    );
    const stop = isStopStatus(status) ? await stopCompaniesForStatus(tx, { companyIds: [c.id], status, now }) : { stopped: 0, campaignIds: [] };
    return { changed: true, label, stopped: stop.stopped, campaignIds: stop.campaignIds };
  });
  // Best effort after the commit: finishCheck logs its own failure and answers false.
  for (const campaignId of res.campaignIds) await finishCheck(campaignId, { now });
  return { changed: res.changed, label: res.label, stopped: res.stopped };
}

export async function setCompanyPriority(
  actor: Actor,
  companyId: number,
  priority: PriorityValue,
): Promise<ChangeResult & { label: string }> {
  if (!PRIORITIES.includes(priority)) throw new ServiceError("Pick a priority from the list.");
  const label = PRIORITY_LABELS[priority];
  return dbTx(async (tx) => {
    const c = await loadActiveCompany(tx, companyId);
    if (c.priority === priority) return { changed: false, label };
    await tx.company.update({ where: { id: c.id }, data: { priority, priorityRank: priorityRank(priority) } });
    await logActivity(
      {
        actorId: actor.id,
        type: "company.priority",
        summary: `${actor.name} set priority to ${label}`,
        companyId: c.id,
        data: { from: c.priority, to: priority },
      },
      tx,
    );
    return { changed: true, label };
  });
}

/** Soft delete: hidden everywhere, history kept (PLAN.md A5.9). */
export async function deleteCompany(actor: Actor, companyId: number): Promise<ChangeResult & { name: string }> {
  return dbTx(async (tx) => {
    const c = await loadCompany(tx, companyId);
    if (c.deletedAt) return { changed: false, name: c.name };
    await tx.company.update({ where: { id: c.id }, data: { deletedAt: new Date() } });
    await logActivity(
      { actorId: actor.id, type: "company.deleted", summary: `${actor.name} deleted ${c.name}`, companyId: c.id },
      tx,
    );
    return { changed: true, name: c.name };
  });
}

export async function restoreCompany(
  actor: Actor,
  companyId: number,
): Promise<ChangeResult & { name: string; domainAlsoUsedBy: ErrorLink | null }> {
  return dbTx(async (tx) => {
    const c = await loadCompany(tx, companyId);
    if (!c.deletedAt) return { changed: false, name: c.name, domainAlsoUsedBy: null };
    await tx.company.update({ where: { id: c.id }, data: { deletedAt: null } });
    await refreshCompanySearchText(tx, [c.id]);
    await logActivity(
      { actorId: actor.id, type: "company.restored", summary: `${actor.name} restored ${c.name}`, companyId: c.id },
      tx,
    );
    let domainAlsoUsedBy: ErrorLink | null = null;
    if (c.domain) {
      const other = await tx.company.findFirst({
        where: { domain: c.domain, deletedAt: null, id: { not: c.id } },
        select: { id: true, name: true },
        orderBy: { id: "asc" },
      });
      if (other) domainAlsoUsedBy = companyLink(other);
    }
    return { changed: true, name: c.name, domainAlsoUsedBy };
  });
}

// ───────────────────────── details ─────────────────────────

export type CountryResult = ChangeResult & {
  country: string | null;
  countryName: string | null;
  timeZone: string | null;
  /** True when the time zone followed the country automatically. */
  timeZoneChanged: boolean;
  /** Set when the user had picked their own zone: we offer the new country's default instead of overwriting it. */
  suggestedTimeZone: string | null;
};

/**
 * Sets the country (any spelling: "Norway", "Norge", "NO"; empty clears it).
 * The time zone follows when it was empty or still the old country's default;
 * a zone the user chose themselves is kept and the new default is only suggested.
 */
export async function setCompanyCountry(actor: Actor, companyId: number, input: string): Promise<CountryResult> {
  const raw = cleanLine(input);
  const country = raw ? normalizeCountry(raw) : null;
  if (raw && !country) {
    const msg = "We don't recognise that country. Pick one from the list.";
    throw new ServiceError(msg, { fieldErrors: { country: [msg] } });
  }
  return dbTx(async (tx) => {
    const c = await loadActiveCompany(tx, companyId);
    const name = country ? countryName(country) : null;
    if (c.country === country) {
      return { changed: false, country, countryName: name, timeZone: c.timeZone, timeZoneChanged: false, suggestedTimeZone: null };
    }
    const oldDefault = defaultTimeZoneFor(c.country);
    const newDefault = defaultTimeZoneFor(country);
    let timeZone = c.timeZone;
    let timeZoneChanged = false;
    let suggestedTimeZone: string | null = null;
    if (newDefault && newDefault !== c.timeZone) {
      if (!c.timeZone || c.timeZone === oldDefault) {
        timeZone = newDefault;
        timeZoneChanged = true;
      } else {
        suggestedTimeZone = newDefault;
      }
    }
    await tx.company.update({ where: { id: c.id }, data: { country, timeZone } });
    await refreshCompanySearchText(tx, [c.id]);
    const what = name ? `set the country to ${name}` : "removed the country";
    await logActivity(
      {
        actorId: actor.id,
        type: "company.updated",
        summary: `${actor.name} ${what}${timeZoneChanged ? ` (time zone now ${timeZone})` : ""}`,
        companyId: c.id,
        data: {
          field: "country",
          from: c.country,
          to: country,
          ...(timeZoneChanged ? { timeZone: { from: c.timeZone, to: timeZone } } : {}),
        },
      },
      tx,
    );
    return { changed: true, country, countryName: name, timeZone, timeZoneChanged, suggestedTimeZone };
  });
}

/** Sets the time zone; pass null to reset it to the country's default. */
export async function setCompanyTimeZone(
  actor: Actor,
  companyId: number,
  zone: string | null,
): Promise<ChangeResult & { timeZone: string }> {
  const wanted = zone === null ? null : zone.trim();
  if (wanted !== null && !isValidTimeZone(wanted)) {
    const msg = "That time zone isn't valid. Pick one from the list.";
    throw new ServiceError(msg, { fieldErrors: { timeZone: [msg] } });
  }
  return dbTx(async (tx) => {
    const c = await loadActiveCompany(tx, companyId);
    const target = wanted ?? defaultTimeZoneFor(c.country);
    if (!target) {
      throw new ServiceError("This company has no country, so there's no default time zone. Pick a time zone from the list.");
    }
    if (c.timeZone === target) return { changed: false, timeZone: target };
    await tx.company.update({ where: { id: c.id }, data: { timeZone: target } });
    const summary =
      wanted === null
        ? `${actor.name} reset the time zone to ${target} (${countryName(c.country)}'s default)`
        : `${actor.name} set the time zone to ${target}`;
    await logActivity(
      {
        actorId: actor.id,
        type: "company.updated",
        summary,
        companyId: c.id,
        data: { field: "timeZone", from: c.timeZone, to: target },
      },
      tx,
    );
    return { changed: true, timeZone: target };
  });
}

async function extraSharedDomains(): Promise<ReadonlySet<string>> {
  const s = await getSettings(["sharedDomains.extra"] as const);
  const list = Array.isArray(s["sharedDomains.extra"]) ? s["sharedDomains.extra"] : [];
  return new Set(list.map((d) => String(d).toLowerCase().trim()).filter(Boolean));
}

/**
 * Website → website/domain/profileKey (PLAN.md B6.13). Social and marketplace pages get no
 * domain (never used for duplicates); a real domain may belong to only one live company.
 */
export async function setCompanyWebsite(
  actor: Actor,
  companyId: number,
  input: string,
): Promise<ChangeResult & { isShared: boolean; host: string | null }> {
  const raw = input.trim();
  const extra = raw ? await extraSharedDomains() : undefined;
  const info = raw ? parseWebsite(raw, extra) : null;
  if (raw && !info) {
    const msg = "That doesn't look like a web address. Type something like acme.de or https://www.acme.de.";
    throw new ServiceError(msg, { fieldErrors: { website: [msg] } });
  }
  return dbTx(async (tx) => {
    const c = await loadActiveCompany(tx, companyId);
    if (info?.domain) {
      const other = await tx.company.findFirst({
        where: { domain: info.domain, deletedAt: null, id: { not: c.id } },
        select: { id: true, name: true },
        orderBy: { id: "asc" },
      });
      if (other) {
        const msg = `${info.domain} already belongs to ${companyCode(other.id)} ${other.name}.`;
        throw new ServiceError(msg, { fieldErrors: { website: [msg] }, link: companyLink(other) });
      }
    }
    const next = { website: info?.url ?? null, domain: info?.domain ?? null, profileKey: info?.profileKey ?? null };
    const result = { isShared: info?.isShared ?? false, host: info?.host ?? null };
    if (c.website === next.website && c.domain === next.domain && c.profileKey === next.profileKey) {
      return { changed: false, ...result };
    }
    await tx.company.update({ where: { id: c.id }, data: next });
    await refreshCompanySearchText(tx, [c.id]);
    await logActivity(
      {
        actorId: actor.id,
        type: "company.updated",
        summary: info ? `${actor.name} changed the website to ${info.host}` : `${actor.name} removed the website`,
        companyId: c.id,
        data: { field: "website", from: c.website, to: next.website },
      },
      tx,
    );
    return { changed: true, ...result };
  });
}

export async function setCompanyInstagram(
  actor: Actor,
  companyId: number,
  input: string,
): Promise<ChangeResult & { instagram: string | null }> {
  const raw = input.trim();
  const handle = raw ? instagramHandle(raw) : null;
  if (raw && (!handle || INSTAGRAM_NOT_PROFILES.has(handle))) {
    const msg = "That doesn't look like an Instagram profile. Paste the profile link or type @name.";
    throw new ServiceError(msg, { fieldErrors: { instagram: [msg] } });
  }
  return dbTx(async (tx) => {
    const c = await loadActiveCompany(tx, companyId);
    if (c.instagram === handle) return { changed: false, instagram: handle };
    await tx.company.update({ where: { id: c.id }, data: { instagram: handle } });
    await refreshCompanySearchText(tx, [c.id]);
    await logActivity(
      {
        actorId: actor.id,
        type: "company.updated",
        summary: handle ? `${actor.name} set Instagram to @${handle}` : `${actor.name} removed the Instagram handle`,
        companyId: c.id,
        data: { field: "instagram", from: c.instagram, to: handle },
      },
      tx,
    );
    return { changed: true, instagram: handle };
  });
}

export async function setCompanyNiche(
  actor: Actor,
  companyId: number,
  input: string,
): Promise<ChangeResult & { niche: string | null }> {
  const niche = cleanLine(input) || null;
  if (niche && niche.length > LIMITS.niche) {
    const msg = `Keep the niche under ${LIMITS.niche} characters.`;
    throw new ServiceError(msg, { fieldErrors: { niche: [msg] } });
  }
  return dbTx(async (tx) => {
    const c = await loadActiveCompany(tx, companyId);
    if (c.niche === niche) return { changed: false, niche };
    await tx.company.update({ where: { id: c.id }, data: { niche } });
    await refreshCompanySearchText(tx, [c.id]);
    await logActivity(
      {
        actorId: actor.id,
        type: "company.updated",
        summary: niche ? `${actor.name} set the niche to ${niche}` : `${actor.name} removed the niche`,
        companyId: c.id,
        data: { field: "niche", from: c.niche, to: niche },
      },
      tx,
    );
    return { changed: true, niche };
  });
}

export async function setCompanyNotes(actor: Actor, companyId: number, input: string): Promise<ChangeResult> {
  const notes = cleanMultiline(input);
  if (notes.length > LIMITS.notes) {
    const msg = `Notes can be up to ${LIMITS.notes.toLocaleString("en-US")} characters. Shorten them a little.`;
    throw new ServiceError(msg, { fieldErrors: { notes: [msg] } });
  }
  return dbTx(async (tx) => {
    const c = await loadActiveCompany(tx, companyId);
    if (c.notes === notes) return { changed: false };
    await tx.company.update({ where: { id: c.id }, data: { notes } });
    await logActivity(
      {
        actorId: actor.id,
        type: "company.notes",
        summary: notes ? `${actor.name} updated the notes` : `${actor.name} cleared the notes`,
        companyId: c.id,
        data: { text: notes },
      },
      tx,
    );
    return { changed: true };
  });
}

/** Personal lines are one sentence: whitespace (including line breaks) collapses to single spaces. */
export function cleanPersonalLine(input: string | null | undefined): string {
  return cleanLine(input);
}

export function personalLineProblem(line: string): string | null {
  if (line.length > LIMITS.personalLine) {
    return `Keep the personal line under ${LIMITS.personalLine} characters (it's ${line.length} now).`;
  }
  return null;
}

export async function setCompanyPersonalLine(
  actor: Actor,
  companyId: number,
  input: string,
): Promise<ChangeResult & { line: string | null }> {
  const line = cleanPersonalLine(input) || null;
  const problem = line ? personalLineProblem(line) : null;
  if (problem) throw new ServiceError(problem, { fieldErrors: { line: [problem] } });
  return dbTx(async (tx) => {
    const c = await loadActiveCompany(tx, companyId);
    if (c.personalLine === line) return { changed: false, line };
    await tx.company.update({
      where: { id: c.id },
      data: {
        personalLine: line,
        personalLineSource: line ? "manual" : null,
        personalLineUpdatedAt: new Date(),
        personalLineUpdatedById: actor.id,
      },
    });
    await logActivity(
      {
        actorId: actor.id,
        type: "company.personalLine",
        summary: line ? `${actor.name} wrote the personal line` : `${actor.name} removed the personal line`,
        companyId: c.id,
        data: { line },
      },
      tx,
    );
    return { changed: true, line };
  });
}

/** Sets one custom field ("members", "est. revenue" …). An empty value removes it. */
export async function setCompanyCustomField(
  actor: Actor,
  companyId: number,
  key: string,
  input: string,
): Promise<ChangeResult & { label: string }> {
  const value = cleanMultiline(input);
  if (value.length > LIMITS.customValue) {
    const msg = `Keep this under ${LIMITS.customValue.toLocaleString("en-US")} characters.`;
    throw new ServiceError(msg, { fieldErrors: { value: [msg] } });
  }
  return dbTx(async (tx) => {
    const c = await loadActiveCompany(tx, companyId);
    const fields = customFieldsObject(c.customFields);
    const def = await tx.customField.findUnique({ where: { key }, select: { label: true, entity: true } });
    const known = Object.prototype.hasOwnProperty.call(fields, key);
    if (!known && (!def || def.entity !== "COMPANY")) {
      throw new ServiceError("That field doesn't exist any more. Refresh the page and try again.");
    }
    const label = def?.label ?? key;
    const before = known ? customValueText(fields[key]) : "";
    if (before === value) return { changed: false, label };
    if (value) fields[key] = value;
    else delete fields[key];
    await tx.company.update({
      where: { id: c.id },
      data: { customFields: Object.keys(fields).length ? (fields as Prisma.InputJsonObject) : Prisma.DbNull },
    });
    await logActivity(
      {
        actorId: actor.id,
        type: "company.updated",
        summary: value ? `${actor.name} set ${label} to ${value.length > 60 ? `${value.slice(0, 59)}…` : value}` : `${actor.name} cleared ${label}`,
        companyId: c.id,
        data: { field: `custom:${key}`, from: before || null, to: value || null },
      },
      tx,
    );
    return { changed: true, label };
  });
}

// ───────────────────────── lists and tags ─────────────────────────

export type NamedTarget = { id: number } | { name: string };

export type MembershipResult = ChangeResult & { id: number; name: string; created: boolean };

function validateName(raw: string, max: number, noun: "list" | "tag"): string {
  const name = cleanLine(raw);
  if (!name) throw new ServiceError(`Type a name for the ${noun}.`, { fieldErrors: { name: [`Type a name for the ${noun}.`] } });
  if (name.length > max) {
    const msg = `Keep the ${noun} name under ${max} characters.`;
    throw new ServiceError(msg, { fieldErrors: { name: [msg] } });
  }
  return name;
}

/** Adds this company to an existing list, or to a new list created on the spot. */
export async function addCompanyToList(actor: Actor, companyId: number, target: NamedTarget): Promise<MembershipResult> {
  const newName = "name" in target ? validateName(target.name, LIMITS.listName, "list") : null;
  return dbTx(async (tx) => {
    const c = await loadActiveCompany(tx, companyId);
    let list: { id: number; name: string } | null;
    let created = false;
    if (newName === null) {
      list = await tx.list.findUnique({ where: { id: (target as { id: number }).id }, select: { id: true, name: true } });
      if (!list) throw new ServiceError("That list doesn't exist any more. Refresh the page and try again.");
    } else {
      const key = normalizeText(newName);
      const all = await tx.list.findMany({ select: { id: true, name: true } });
      list = all.find((l) => normalizeText(l.name) === key) ?? null;
      if (!list) {
        list = await tx.list.create({ data: { name: newName, createdById: actor.id }, select: { id: true, name: true } });
        created = true;
        await logActivity(
          { actorId: actor.id, type: "list.created", summary: `${actor.name} created the list ${list.name}`, data: { listId: list.id } },
          tx,
        );
      }
    }
    const existing = await tx.companyList.findUnique({
      where: { companyId_listId: { companyId: c.id, listId: list.id } },
      select: { listId: true },
    });
    if (existing) return { changed: false, id: list.id, name: list.name, created };
    await tx.companyList.create({ data: { companyId: c.id, listId: list.id, addedById: actor.id } });
    await logActivity(
      {
        actorId: actor.id,
        type: "company.lists",
        summary: `${actor.name} added ${c.name} to ${list.name}`,
        companyId: c.id,
        data: { added: { id: list.id, name: list.name } },
      },
      tx,
    );
    return { changed: true, id: list.id, name: list.name, created };
  });
}

export async function removeCompanyFromList(actor: Actor, companyId: number, listId: number): Promise<MembershipResult> {
  return dbTx(async (tx) => {
    const c = await loadActiveCompany(tx, companyId);
    const list = await tx.list.findUnique({ where: { id: listId }, select: { id: true, name: true } });
    if (!list) return { changed: false, id: listId, name: "", created: false };
    const res = await tx.companyList.deleteMany({ where: { companyId: c.id, listId } });
    if (res.count === 0) return { changed: false, id: list.id, name: list.name, created: false };
    await logActivity(
      {
        actorId: actor.id,
        type: "company.lists",
        summary: `${actor.name} removed ${c.name} from ${list.name}`,
        companyId: c.id,
        data: { removed: { id: list.id, name: list.name } },
      },
      tx,
    );
    return { changed: true, id: list.id, name: list.name, created: false };
  });
}

/** Tags this company with an existing tag, or a new one created on the spot. */
export async function addCompanyTag(actor: Actor, companyId: number, target: NamedTarget): Promise<MembershipResult> {
  const newName = "name" in target ? validateName(target.name, LIMITS.tagName, "tag") : null;
  return dbTx(async (tx) => {
    const c = await loadActiveCompany(tx, companyId);
    let tag: { id: number; name: string } | null;
    let created = false;
    if (newName === null) {
      tag = await tx.tag.findUnique({ where: { id: (target as { id: number }).id }, select: { id: true, name: true } });
      if (!tag) throw new ServiceError("That tag doesn't exist any more. Refresh the page and try again.");
    } else {
      const key = normalizeText(newName);
      const all = await tx.tag.findMany({ select: { id: true, name: true } });
      tag = all.find((t) => normalizeText(t.name) === key) ?? null;
      if (!tag) {
        tag = await tx.tag.create({ data: { name: newName }, select: { id: true, name: true } });
        created = true;
      }
    }
    const existing = await tx.companyTag.findUnique({
      where: { companyId_tagId: { companyId: c.id, tagId: tag.id } },
      select: { tagId: true },
    });
    if (existing) return { changed: false, id: tag.id, name: tag.name, created };
    await tx.companyTag.create({ data: { companyId: c.id, tagId: tag.id } });
    await logActivity(
      {
        actorId: actor.id,
        type: "company.tags",
        summary: `${actor.name} added the tag ${tag.name} to ${c.name}`,
        companyId: c.id,
        data: { added: { id: tag.id, name: tag.name }, created },
      },
      tx,
    );
    return { changed: true, id: tag.id, name: tag.name, created };
  });
}

export async function removeCompanyTag(actor: Actor, companyId: number, tagId: number): Promise<MembershipResult> {
  return dbTx(async (tx) => {
    const c = await loadActiveCompany(tx, companyId);
    const tag = await tx.tag.findUnique({ where: { id: tagId }, select: { id: true, name: true } });
    if (!tag) return { changed: false, id: tagId, name: "", created: false };
    const res = await tx.companyTag.deleteMany({ where: { companyId: c.id, tagId } });
    if (res.count === 0) return { changed: false, id: tag.id, name: tag.name, created: false };
    await logActivity(
      {
        actorId: actor.id,
        type: "company.tags",
        summary: `${actor.name} removed the tag ${tag.name} from ${c.name}`,
        companyId: c.id,
        data: { removed: { id: tag.id, name: tag.name } },
      },
      tx,
    );
    return { changed: true, id: tag.id, name: tag.name, created: false };
  });
}
