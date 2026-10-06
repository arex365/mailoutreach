import { isSharedDomain } from "@/core/shared-domains";
import { timeAgo } from "@/core/time/format";
import { possessive, stepName } from "./wording";

/**
 * The 30-day team rule (SPEC §3, PLAN.md A5.2, B6.1). Pure: the caller loads the history.
 *
 * A company is blocked when, within the last N days (Setting "teamRule.days", default 30):
 *  - anyone (the checking person included) sent it a real email, matched by
 *      · the company id, or
 *      · the company's own website domain (Company.domain, which is null for shared hosts such as
 *        gmail.com or instagram.com, so those never match), or
 *      · the address of any of its people;
 *  - Mailgun's logs show a live send the app has no row for (ExternalSend, e.g. after a restore);
 *  - the old tool's "last contacted" date (Company.importedLastContactAt) is that recent;
 * or when another active campaign holds its reservation ("Waiting in Sara's campaign …").
 *
 * Sends and reservations of the campaign being checked never block it: all steps and all people
 * inside one campaign are exempt. There is no override.
 */

export const DAY_MS = 86_400_000;

/** A real (counted) email from OutboundEmail, with the names needed for the reason text. */
export type TeamRuleSend = {
  toNorm: string;
  companyId: number | null;
  /** Snapshot of the recipient company's domain at send time (null for shared hosts). */
  companyDomain: string | null;
  sentAt: Date;
  campaignId: number;
  campaignName: string | null;
  senderName: string | null;
  step: number;
};

/** A live send found in Mailgun's logs with no matching row (ExternalSend). */
export type TeamRuleExternalSend = {
  toNorm: string;
  companyId: number | null;
  companyDomain: string | null;
  sentAt: Date;
};

/** An active reservation on the company (already filtered to active campaigns and unexpired rows). */
export type TeamRuleReservation = {
  campaignId: number;
  campaignName: string;
  /** Whose campaign it is: the sender, else the person who created it. */
  ownerName: string | null;
};

export type TeamRuleInput = {
  companyId: number;
  /** Company.domain (registrable domain, null for shared hosts). */
  companyDomain: string | null;
  /** The company's people's addresses (normalised). */
  emailNorms: readonly string[];
  /** The old tool's "last contacted" date. */
  importedLastContactAt: Date | null;
  sends: readonly TeamRuleSend[];
  externalSends?: readonly TeamRuleExternalSend[];
  reservations?: readonly TeamRuleReservation[];
  /** The campaign being checked (its own sends and reservation never block it); null for none. */
  campaignId: number | null;
  now: Date;
  /** Setting "teamRule.days". 0 or less switches the history part off (reservations still count). */
  days: number;
  /** Setting "sharedDomains.extra", as an extra safety net on top of the stored domain. */
  extraShared?: ReadonlySet<string>;
};

export type TeamRuleMatch = "company" | "domain" | "address";

export type TeamRuleBlock =
  | {
      kind: "emailed";
      text: string;
      at: Date;
      matchedBy: TeamRuleMatch;
      campaignId: number;
      campaignName: string | null;
      senderName: string | null;
      step: number;
      toNorm: string;
    }
  | { kind: "external"; text: string; at: Date; matchedBy: TeamRuleMatch; toNorm: string }
  | { kind: "old-tool"; text: string; at: Date }
  | { kind: "reserved"; text: string; campaignId: number; campaignName: string; ownerName: string | null };

/** The company's domain when it can be used for matching (never a shared or free-mail host). */
export function usableCompanyDomain(domain: string | null | undefined, extraShared?: ReadonlySet<string>): string | null {
  const d = (domain ?? "").trim().toLowerCase();
  if (!d || !d.includes(".")) return null;
  return isSharedDomain(d, extraShared) ? null : d;
}

/** True when `at` lies within the last `days` days before `now` (dates in the future count too). */
export function withinDays(at: Date, now: Date, days: number): boolean {
  if (!(days > 0)) return false;
  return now.getTime() - at.getTime() < days * DAY_MS;
}

/** "Waiting in Sara's campaign 'Norway prints'". */
export function reservedText(ownerName: string | null | undefined, campaignName: string): string {
  const owner = ownerName?.trim();
  return owner ? `Waiting in ${possessive(owner)} campaign '${campaignName}'` : `Waiting in the campaign '${campaignName}'`;
}

function emailedText(s: TeamRuleSend, matchedBy: TeamRuleMatch, domain: string | null, now: Date): string {
  const ago = timeAgo(s.sentAt, now);
  const by = s.senderName?.trim() ? ` by ${s.senderName.trim()}` : "";
  const where = s.campaignName?.trim() ? `${s.campaignName.trim()}, ${stepName(s.step)}` : stepName(s.step);
  if (matchedBy === "address") return `${s.toNorm} was emailed${by} ${ago} (${where})`;
  if (matchedBy === "domain" && domain) return `Someone at ${domain} was emailed${by} ${ago} (${where})`;
  return `Emailed${by} ${ago} (${where})`;
}

/**
 * Returns why the company can't be emailed now, or null when the rule allows it. When several
 * things match, the most recent contact is reported; a reservation is reported only when there is
 * no recent contact.
 */
export function teamRule(input: TeamRuleInput): TeamRuleBlock | null {
  const { now, days, campaignId } = input;
  const domain = usableCompanyDomain(input.companyDomain, input.extraShared);
  const norms = new Set(input.emailNorms.map((e) => e.trim().toLowerCase()).filter(Boolean));

  const matchOf = (s: { companyId: number | null; companyDomain: string | null; toNorm: string }): TeamRuleMatch | null => {
    if (s.companyId !== null && s.companyId === input.companyId) return "company";
    if (domain && s.companyDomain && s.companyDomain.trim().toLowerCase() === domain) return "domain";
    if (norms.has(s.toNorm.trim().toLowerCase())) return "address";
    return null;
  };

  type ContactBlock = Exclude<TeamRuleBlock, { kind: "reserved" }>;
  const contacts: ContactBlock[] = [];

  for (const s of input.sends) {
    if (campaignId !== null && s.campaignId === campaignId) continue;
    if (!withinDays(s.sentAt, now, days)) continue;
    const matchedBy = matchOf(s);
    if (!matchedBy) continue;
    contacts.push({
      kind: "emailed",
      text: emailedText(s, matchedBy, domain, now),
      at: s.sentAt,
      matchedBy,
      campaignId: s.campaignId,
      campaignName: s.campaignName,
      senderName: s.senderName,
      step: s.step,
      toNorm: s.toNorm,
    });
  }

  for (const e of input.externalSends ?? []) {
    if (!withinDays(e.sentAt, now, days)) continue;
    const matchedBy = matchOf(e);
    if (!matchedBy) continue;
    const ago = timeAgo(e.sentAt, now);
    const text =
      matchedBy === "address"
        ? `${e.toNorm} was emailed ${ago} (found in Mailgun's logs)`
        : `Emailed ${ago} (found in Mailgun's logs)`;
    contacts.push({ kind: "external", text, at: e.sentAt, matchedBy, toNorm: e.toNorm });
  }

  if (input.importedLastContactAt && withinDays(input.importedLastContactAt, now, days)) {
    contacts.push({
      kind: "old-tool",
      text: `Contacted in the old tool ${timeAgo(input.importedLastContactAt, now)}`,
      at: input.importedLastContactAt,
    });
  }

  // The most recent contact wins (on a tie, the first found: app emails before logs before the old tool).
  let latest: ContactBlock | null = null;
  for (const c of contacts) if (!latest || c.at.getTime() > latest.at.getTime()) latest = c;
  if (latest) return latest;

  for (const r of input.reservations ?? []) {
    if (campaignId !== null && r.campaignId === campaignId) continue;
    return {
      kind: "reserved",
      text: reservedText(r.ownerName, r.campaignName),
      campaignId: r.campaignId,
      campaignName: r.campaignName,
      ownerName: r.ownerName,
    };
  }
  return null;
}
