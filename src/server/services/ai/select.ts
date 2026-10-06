import { siteBuilderSite } from "@/core/ai/site-rules";
import { MAX_COMPANIES_PER_RUN } from "@/core/ai/types";
import { instagramHandle, parseWebsite } from "@/core/shared-domains";
import { db } from "@/server/db";
import { LIST_GONE } from "@/server/services/companies/bulk";
import { ServiceError } from "@/server/services/companies/mutations";
import { getSetting } from "@/server/settings";

/**
 * Who a "Draft personal lines" start drafts, and who it skips and why (docs/dev/M5-DESIGN.md §3.2, SPEC §6):
 *  - deleted:    the company was deleted (or doesn't exist);
 *  - noWebsite:  no website (an Instagram handle alone counts as social, below);
 *  - socialOnly: the website is a shared host (social, marketplace, link-in-bio: `parseWebsite(...).isShared`, the
 *                Setting "sharedDomains.extra" included), or the company only has an Instagram ("Skip Instagram
 *                pages"). Hosted subdomains such as anna.wixsite.com, and site-builder sites such as
 *                anna.wordpress.com (`siteBuilderSite`), are the company's own site and are drafted;
 *  - waiting:    a draft of the company is being drafted (QUEUED, FETCHING, DRAFTING) or waits for review (READY);
 *  - hasLine:    the company already has a personal line (any source): drafted only with `redraft` ("Draft new lines
 *                for these too").
 * A website that can't even be parsed is drafted: the website reader then says why ("The website address isn't
 * valid"), without paying for Claude. The practice copy uses the same rules.
 */

export type DraftSelection = {
  /** Distinct companies asked for (for a list: its members, deleted ones included). */
  companies: number;
  /** Company ids that will get a QUEUED draft, in the order asked. */
  toDraft: number[];
  /** `hasLine` counts only companies left out: with `redraft` they are in `toDraft` and this is 0. */
  skipped: { deleted: number; noWebsite: number; socialOnly: number; hasLine: number; waiting: number };
  /** hasLine companies that "Draft new lines for these too" would add (listed with or without `redraft`). */
  redraftable: number[];
};

export type DraftSkipReason = keyof DraftSelection["skipped"];

/** Draft statuses that keep a company out of a new run: being drafted, or waiting for review. */
export const OPEN_DRAFT_STATUSES = ["QUEUED", "FETCHING", "DRAFTING", "READY"] as const;

const IN_CHUNK = 500;

function chunks<T>(items: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Setting "sharedDomains.extra" as a lowercase set (the Owner's own shared hosts). */
export async function extraSharedDomains(): Promise<ReadonlySet<string>> {
  const extra = await getSetting("sharedDomains.extra");
  return new Set((Array.isArray(extra) ? extra : []).map((d) => String(d).trim().toLowerCase()).filter(Boolean));
}

/** What a company's website means for drafting. `host` (without "www.") is what the job keeps distinct per claim. */
export type CompanySite = { kind: "site"; host: string } | { kind: "social" } | { kind: "none" };

/** The drafting view of a company's website and Instagram (the rules above). */
export function companySite(c: { website: string | null; instagram: string | null }, extraShared?: ReadonlySet<string>): CompanySite {
  const website = c.website?.trim() ?? "";
  const hasInstagram = Boolean(c.instagram?.trim());
  if (!website) return hasInstagram ? { kind: "social" } : { kind: "none" };
  const info = parseWebsite(website, extraShared);
  if (!info) {
    // "@anna" typed as the website is a social handle; anything else goes to the reader, which says "bad_url".
    if (hasInstagram || (website.startsWith("@") && instagramHandle(website))) return { kind: "social" };
    return { kind: "site", host: website.toLowerCase() };
  }
  // A site builder's "<name>.<builder>" site (anna.wordpress.com, dragonforge.bigcartel.com) is the company's own
  // website, as the reader treats it (siteBuilderSite), although parseWebsite groups it under the shared platform.
  return info.isShared && !siteBuilderSite(info.host) ? { kind: "social" } : { kind: "site", host: info.host };
}

/** Distinct positive whole ids, in the order given. */
function distinctIds(ids: readonly number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** The ids asked for: the given ids, or a list's members (throws "That list doesn't exist any more…"). */
async function askedIds(input: { companyIds: number[] } | { listId: number }): Promise<number[]> {
  if ("companyIds" in input) return distinctIds(input.companyIds);
  const list = await db.list.findUnique({ where: { id: input.listId }, select: { id: true } });
  if (!list) throw new ServiceError(LIST_GONE);
  const rows = await db.companyList.findMany({ where: { listId: input.listId }, select: { companyId: true }, orderBy: { companyId: "asc" } });
  return distinctIds(rows.map((r) => r.companyId));
}

/** Who a start would draft and who it skips (read-only; the start re-checks inside its transaction). */
export async function selectForDrafting(
  input: { companyIds: number[] } | { listId: number },
  opts: { redraft: boolean },
): Promise<DraftSelection> {
  const ids = await askedIds(input);
  const extra = await extraSharedDomains();
  const companies = new Map<number, { website: string | null; instagram: string | null; personalLine: string | null; deletedAt: Date | null }>();
  const open = new Set<number>();
  for (const part of chunks(ids)) {
    const [rows, drafts] = await Promise.all([
      db.company.findMany({
        where: { id: { in: part } },
        select: { id: true, website: true, instagram: true, personalLine: true, deletedAt: true },
      }),
      db.aiDraft.findMany({
        where: { companyId: { in: part }, status: { in: [...OPEN_DRAFT_STATUSES] } },
        select: { companyId: true },
        distinct: ["companyId"],
      }),
    ]);
    for (const r of rows) companies.set(r.id, r);
    for (const d of drafts) open.add(d.companyId);
  }

  const out: DraftSelection = {
    companies: ids.length,
    toDraft: [],
    skipped: { deleted: 0, noWebsite: 0, socialOnly: 0, hasLine: 0, waiting: 0 },
    redraftable: [],
  };
  for (const id of ids) {
    const c = companies.get(id);
    if (!c || c.deletedAt) {
      out.skipped.deleted++;
      continue;
    }
    const site = companySite(c, extra);
    if (site.kind === "none") {
      out.skipped.noWebsite++;
      continue;
    }
    if (site.kind === "social") {
      out.skipped.socialOnly++;
      continue;
    }
    if (open.has(id)) {
      out.skipped.waiting++;
      continue;
    }
    if (c.personalLine?.trim()) {
      out.redraftable.push(id);
      if (!opts.redraft) {
        out.skipped.hasLine++;
        continue;
      }
    }
    out.toDraft.push(id);
  }
  return out;
}

/** "That's 1,240 companies. Draft at most 1,000 at a time." */
export function tooManyText(count: number): string {
  return `That's ${count.toLocaleString("en-US")} companies. Draft at most ${MAX_COMPANIES_PER_RUN.toLocaleString("en-US")} at a time.`;
}

/** The sentence when nothing can be drafted from a Contacts or list start (the skip lines are shown with it). */
export const NOTHING_TO_DRAFT_TEXT = "None of these companies can be drafted.";

/**
 * Why one company (the panel, Regenerate, Try again) can't be drafted, in the panel dialog's words (§6.8 "Panel
 * skip"). `drafting`: the company has a draft being drafted right now (not only one waiting for review).
 */
export function singleSkipText(reason: DraftSkipReason, companyName: string, opts: { drafting?: boolean } = {}): string {
  switch (reason) {
    case "deleted":
      return "This company was deleted.";
    case "noWebsite":
      return `${companyName} has no website, so there's nothing to read.`;
    case "socialOnly":
      return `${companyName} only has an Instagram or other social link, so there's nothing to read.`;
    case "waiting":
      return opts.drafting ? `A line for ${companyName} is already being drafted.` : `A line for ${companyName} is already waiting for review.`;
    case "hasLine":
      return `${companyName} already has a personal line.`;
  }
}

/** The first skip reason of a one-company selection, or null when it will be drafted. */
export function singleSkipReason(sel: DraftSelection): DraftSkipReason | null {
  if (sel.toDraft.length > 0) return null;
  const order: DraftSkipReason[] = ["deleted", "noWebsite", "socialOnly", "waiting", "hasLine"];
  return order.find((k) => sel.skipped[k] > 0) ?? "deleted";
}
