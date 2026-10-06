import { Prisma } from "@/generated/prisma/client";
import { GENERAL_INBOX_NAME, isRoleAddress, parseEmail } from "@/core/email-address";
import { defaultTimeZoneFor, normalizeCountry } from "@/core/geo/countries";
import { countryName } from "@/core/geo/display";
import { COMPANY_STATUS_LABELS, type CompanyStatusValue, type PriorityValue } from "@/core/labels";
import { instagramHandle, parseWebsite, usableEmailDomain } from "@/core/shared-domains";
import { firstNameFrom, normalizeCompanyName } from "@/core/text";
import { logActivity } from "@/server/activity";
import { refreshCompanySearchText } from "@/server/company-search";
import { db, dbTx, type DbOrTx } from "@/server/db";
import { getSetting } from "@/server/settings";
import type { Actor } from "./bulk";
import { priorityRank } from "./filters";

/**
 * "Add company" (one company by hand, optionally with its first person).
 * Fields are derived exactly like the importer (docs/dev/CONVENTIONS.md "Company fields
 * derived on write"), and duplicates are caught before anything is written:
 *  - same usable website domain, same profile (the same account on Instagram, Etsy, …), or
 *    same person email → hard stop (soft-deleted companies included: their history must keep counting);
 *  - same normalised name in the same country → a warning the user can override.
 * The duplicate checks run inside the same transaction as the insert: the app shares one
 * database connection, so a check made outside it could see another request's unfinished
 * (and later undone) insert, or miss one that commits just before ours.
 */

export type NewCompanyInput = {
  name: string;
  website?: string | null;
  /** ISO 3166-1 alpha-2 from the picker (or anything normalizeCountry understands). */
  country?: string | null;
  niche?: string | null;
  priority?: PriorityValue;
  status?: CompanyStatusValue;
  listId?: number | null;
  person?: { name?: string | null; email?: string | null; role?: string | null } | null;
};

export type DuplicateMatch = {
  companyId: number;
  companyName: string;
  country: string | null;
  deleted: boolean;
  reason: "domain" | "profile" | "email" | "name";
};

export type CreateCompanyResult =
  | { kind: "created"; companyId: number; companyName: string; personId: number | null }
  | { kind: "duplicate"; match: DuplicateMatch; message: string }
  | { kind: "possible-duplicate"; match: DuplicateMatch; message: string }
  | { kind: "invalid"; message: string; fieldErrors: Record<string, string[]> };

const code = (id: number) => `C-${id}`;

function blank(v: string | null | undefined): string {
  return (v ?? "").replace(/\s+/g, " ").trim();
}

export function duplicateMessage(match: DuplicateMatch, email?: string | null): string {
  const who = `${code(match.companyId)} ${match.companyName}`;
  if (match.deleted) {
    return match.reason === "email" && email
      ? `${email} belongs to ${who}, which was deleted. Its email history still counts, so restore it instead of adding it again.`
      : `Already in your contacts as ${who}, which was deleted. Its email history still counts, so restore it instead of adding it again.`;
  }
  if (match.reason === "email" && email) return `${email} is already in your contacts, at ${who}.`;
  return `Already in your contacts as ${who}.`;
}

export function possibleDuplicateMessage(match: DuplicateMatch): string {
  const where = match.country ? ` in ${countryName(match.country)}` : "";
  const deleted = match.deleted ? " It was deleted earlier." : "";
  return `There's already a company called ${match.companyName}${where}: ${code(match.companyId)}.${deleted} If this is a different company, choose Create anyway.`;
}

type CompanyHit = { id: number; name: string; country: string | null; deletedAt: Date | null };

const HIT_SELECT = { id: true, name: true, country: true, deletedAt: true } satisfies Prisma.CompanySelect;

/** Prefers a live company over a deleted one, then the oldest. */
async function firstCompany(c: DbOrTx, where: Prisma.CompanyWhereInput): Promise<CompanyHit | null> {
  const live = await c.company.findFirst({ where: { AND: [where, { deletedAt: null }] }, orderBy: { id: "asc" }, select: HIT_SELECT });
  if (live) return live;
  return c.company.findFirst({ where: { AND: [where, { deletedAt: { not: null } }] }, orderBy: { id: "asc" }, select: HIT_SELECT });
}

type Found = Exclude<CreateCompanyResult, { kind: "created" }>;

/**
 * The duplicate checks, in order: the same address, website domain, profile, email domain
 * (hard stops), then the same name in the same country (a warning, unless forced).
 */
async function findDuplicate(
  c: DbOrTx,
  input: {
    email: { email: string; norm: string } | null;
    domain: string | null;
    profileKey: string | null;
    emailDomain: string | null;
    nameNorm: string;
    country: string | null;
    force: boolean;
  },
): Promise<Found | null> {
  if (input.email) {
    const owner = await c.person.findUnique({
      where: { emailNorm: input.email.norm },
      select: { company: { select: HIT_SELECT } },
    });
    if (owner) {
      const match = toMatch(owner.company, "email");
      return { kind: "duplicate", match, message: duplicateMessage(match, input.email.email) };
    }
  }
  const hard: Array<[Prisma.CompanyWhereInput | null, DuplicateMatch["reason"]]> = [
    [input.domain ? { domain: input.domain } : null, "domain"],
    [input.profileKey ? { profileKey: input.profileKey } : null, "profile"],
    [!input.domain && input.emailDomain ? { domain: input.emailDomain } : null, "domain"],
  ];
  for (const [where, reason] of hard) {
    if (!where) continue;
    const hit = await firstCompany(c, where);
    if (hit) {
      const match = toMatch(hit, reason);
      return { kind: "duplicate", match, message: duplicateMessage(match) };
    }
  }
  if (!input.force) {
    const hit = await firstCompany(c, { nameNorm: input.nameNorm, country: input.country });
    if (hit) {
      const match = toMatch(hit, "name");
      return { kind: "possible-duplicate", match, message: possibleDuplicateMessage(match) };
    }
  }
  return null;
}

function toMatch(hit: CompanyHit, reason: DuplicateMatch["reason"]): DuplicateMatch {
  return { companyId: hit.id, companyName: hit.name, country: hit.country, deleted: hit.deletedAt !== null, reason };
}

async function sharedDomainsExtra(): Promise<ReadonlySet<string>> {
  try {
    const extra = await getSetting("sharedDomains.extra");
    return new Set((Array.isArray(extra) ? extra : []).map((d) => String(d).trim().toLowerCase()).filter(Boolean));
  } catch {
    return new Set();
  }
}

export async function createCompany(
  input: NewCompanyInput,
  actor: Actor,
  opts: { force?: boolean } = {},
): Promise<CreateCompanyResult> {
  const fieldErrors: Record<string, string[]> = {};
  const name = blank(input.name);
  if (!name) fieldErrors.name = ["Type the company's name."];
  else if (name.length > 200) fieldErrors.name = ["Keep the name under 200 characters."];

  const extra = await sharedDomainsExtra();
  const websiteRaw = blank(input.website);
  const site = websiteRaw ? parseWebsite(websiteRaw, extra) : null;
  if (websiteRaw && !site) {
    fieldErrors.website = ["That doesn't look like a web address. Try something like acme.de or instagram.com/acme."];
  }

  const countryRaw = blank(input.country);
  const country = countryRaw ? normalizeCountry(countryRaw) : null;
  if (countryRaw && !country) fieldErrors.country = ["Pick a country from the list, or choose Unknown."];

  const niche = blank(input.niche) || null;
  if (niche && niche.length > 100) fieldErrors.niche = ["Keep the niche under 100 characters."];

  const personName = blank(input.person?.name);
  const personRole = blank(input.person?.role) || null;
  const emailRaw = blank(input.person?.email);
  const email = emailRaw ? parseEmail(emailRaw) : null;
  if (emailRaw && !email) {
    fieldErrors.personEmail = [`"${emailRaw}" isn't a valid email address. Check it for typos, for example anna@studio.de.`];
  }
  if (personName.length > 200) fieldErrors.personName = ["Keep the name under 200 characters."];
  if (personRole && personRole.length > 100) fieldErrors.personRole = ["Keep the role under 100 characters."];

  if (Object.keys(fieldErrors).length) {
    return { kind: "invalid", message: "Some details need fixing. Check the highlighted fields.", fieldErrors };
  }

  const nameNorm = normalizeCompanyName(name) || name.toLowerCase();
  const emailDomain = email ? usableEmailDomain(email.domain, extra) : null;
  const status: CompanyStatusValue = input.status ?? "NOT_CONTACTED";
  const priority: PriorityValue = input.priority ?? "NORMAL";
  const isInstagram = site ? /(^|\.)instagram\.com$/.test(site.host) || site.host === "instagr.am" : false;
  const hasPerson = Boolean(email || personName || personRole);
  const isGeneric = Boolean(email && !personName && isRoleAddress(email.email));
  const finalPersonName = personName || (isGeneric ? GENERAL_INBOX_NAME : "");

  try {
    return await dbTx(async (tx): Promise<CreateCompanyResult> => {
      // The list and the duplicates are checked in the same transaction as the insert.
      let list: { id: number; name: string } | null = null;
      if (input.listId) {
        list = await tx.list.findUnique({ where: { id: input.listId }, select: { id: true, name: true } });
        if (!list) {
          return {
            kind: "invalid",
            message: "Some details need fixing. Check the highlighted fields.",
            fieldErrors: { listId: ["That list doesn't exist any more. Pick another list or none."] },
          };
        }
      }
      const found = await findDuplicate(tx, {
        email,
        domain: site?.domain ?? null,
        profileKey: site?.profileKey ?? null,
        emailDomain,
        nameNorm,
        country: country ?? null,
        force: Boolean(opts.force),
      });
      if (found) return found;

      const company = await tx.company.create({
        data: {
          name,
          nameNorm,
          website: site?.url ?? null,
          domain: site?.domain ?? null,
          profileKey: site?.profileKey ?? null,
          instagram: isInstagram && site ? instagramHandle(site.url) : null,
          country,
          timeZone: defaultTimeZoneFor(country),
          niche,
          priority,
          priorityRank: priorityRank(priority),
          status,
          createdById: actor.id,
        },
        select: { id: true, name: true },
      });
      let personId: number | null = null;
      if (hasPerson) {
        const person = await tx.person.create({
          data: {
            companyId: company.id,
            name: finalPersonName,
            firstName: firstNameFrom(finalPersonName, isGeneric) || null,
            role: personRole,
            email: email?.email ?? null,
            emailNorm: email?.norm ?? null,
            isGeneric,
          },
          select: { id: true },
        });
        personId = person.id;
      }
      let listName: string | null = null;
      const listId = list?.id ?? null;
      if (list) {
        await tx.companyList.create({ data: { companyId: company.id, listId: list.id, addedById: actor.id } });
        listName = list.name;
      }
      await refreshCompanySearchText(tx, [company.id]);
      await logActivity(
        {
          actorId: actor.id,
          type: "company.created",
          summary: `${actor.name} added this company${status !== "NOT_CONTACTED" ? ` as ${COMPANY_STATUS_LABELS[status]}` : ""}`,
          companyId: company.id,
          data: { source: "manual", ...(listName ? { listId, listName } : {}) },
        },
        tx,
      );
      if (personId) {
        const label = finalPersonName && !isGeneric ? finalPersonName : (email?.email ?? finalPersonName);
        await logActivity(
          {
            actorId: actor.id,
            type: "person.created",
            summary: `${actor.name} added ${label}`,
            companyId: company.id,
            personId,
          },
          tx,
        );
      }
      return { kind: "created" as const, companyId: company.id, companyName: company.name, personId };
    });
  } catch (err) {
    // Someone added the same address a moment ago.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && email) {
      const owner = await db.person.findUnique({
        where: { emailNorm: email.norm },
        select: { company: { select: HIT_SELECT } },
      });
      if (owner) {
        const match = toMatch(owner.company, "email");
        return { kind: "duplicate", match, message: duplicateMessage(match, email.email) };
      }
    }
    throw err;
  }
}

/** Brings back a soft-deleted company (with its people, lists and history). */
export async function restoreCompany(
  companyId: number,
  actor: Actor,
): Promise<{ ok: true; companyName: string } | { ok: false; error: string }> {
  return dbTx(async (tx) => {
    const company = await tx.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, deletedAt: true } });
    if (!company) return { ok: false as const, error: "That company doesn't exist." };
    if (!company.deletedAt) return { ok: true as const, companyName: company.name };
    await tx.company.updateMany({ where: { id: companyId, deletedAt: { not: null } }, data: { deletedAt: null } });
    await logActivity(
      { actorId: actor.id, type: "company.restored", summary: `${actor.name} restored this company`, companyId },
      tx,
    );
    return { ok: true as const, companyName: company.name };
  });
}
