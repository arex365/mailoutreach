import { parse } from "tldts";
import type { RecipientState } from "@/generated/prisma/client";
import { DAY_MS } from "@/core/rules/team-rule";
import { FREE_MAIL_DOMAINS, PLATFORM_DOMAINS } from "@/core/shared-domains";
import { plural } from "@/core/text";
import { logActivity } from "@/server/activity";
import { db, dbTx, type DbOrTx, type Tx } from "@/server/db";
import { SETTING_DEFAULTS, setSettingIn } from "@/server/settings";

/**
 * Settings › Limits & warm-up › "The 30-day rule" (M6-DESIGN §5.3, L11): the Owner's editor for three rule settings
 * that had no screen before, `teamRule.days` (the 30-day rule's length), `reservations.pausedExpiryDays` (how long a
 * paused campaign keeps its companies) and `sharedDomains.extra` (the Owner's own shared email domains).
 *
 * Saving validates every field, then, unless the Owner already confirmed, works out what the change does to running
 * and paused campaigns and returns those lines without writing anything. The confirmed save writes every changed key
 * and one `settings.updated` activity per key in ONE transaction, so a failure leaves every key as it was. A new
 * paused-campaign expiry also applies to campaigns that are paused now (their companies' reservations get the new end),
 * which is what the "would release … now" line promises; the worker's reservation sweep then releases them and tells
 * whoever launched each campaign and the Owner.
 */

/** The three Settings this card edits, in the card's order. */
export const RULE_SETTING_KEYS = ["teamRule.days", "reservations.pausedExpiryDays", "sharedDomains.extra"] as const;

export const TEAM_RULE_DAYS_RANGE = { min: 1, max: 365 } as const;
export const PAUSED_EXPIRY_DAYS_RANGE = { min: 1, max: 90 } as const;
/** At most this many shared domains of the Owner's own (non-empty lines of the text box). */
export const SHARED_DOMAINS_MAX = 200;

/** The app's own shared domains (free mail, social and marketplace hosts), in the order `@/core/shared-domains` lists them. */
export const BUILT_IN_SHARED_DOMAINS: readonly string[] = [...FREE_MAIL_DOMAINS, ...PLATFORM_DOMAINS];

/** The card's sentences that come from the server (errors and the save messages). */
export const RULES_TEXT = {
  teamRuleDays: "Use a whole number of days from 1 to 365.",
  pausedExpiryDays: "Use a whole number of days from 1 to 90.",
  sharedDomainLine: (line: number) => `Line ${line} isn't a domain. Write it like example.com.`,
  tooManyDomains: `Use at most ${SHARED_DOMAINS_MAX} lines, one domain per line.`,
  needsFixing: "Some rules need fixing. Check the highlighted fields.",
  needsConfirm: "Check what these rules change, then save them.",
  nothingChanged: "Nothing changed, so there was nothing to save.",
  saved: "Rules saved. They apply to new launches and to every email from now on.",
} as const;

/** What the card shows: the saved values and the built-in list (for its help text). */
export type RulesView = { teamRuleDays: number; pausedExpiryDays: number; sharedDomains: string[]; builtIn: string[] };

/** The values the card saves, checked. */
export type RulesValues = { teamRuleDays: number; pausedExpiryDays: number; sharedDomains: string[] };

export type SaveRulesResult = { message: string; needsConfirm?: { lines: string[] }; fieldErrors?: Record<string, string[]> };

/** Recipients who may still get an email (not finished, stopped or left out). */
const OPEN_RECIPIENT_STATES: RecipientState[] = ["PENDING", "SCHEDULED", "WAITING", "HELD", "RECHECK"];

function n(v: number): string {
  return v.toLocaleString("en-US");
}

function wholeIn(v: unknown, range: { min: number; max: number }): number | null {
  const x = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof x === "number" && Number.isInteger(x) && x >= range.min && x <= range.max ? x : null;
}

const BUILT_IN_SET: ReadonlySet<string> = new Set(BUILT_IN_SHARED_DOMAINS);

/**
 * One line of the shared-domains box as the app stores it ("Firma.Example." → "firma.example", an international name
 * in its xn-- form), or null when it isn't a domain: an address (@), a link (/), an IP address, a bare ending such as
 * "com" or "co.uk", or anything tldts can't read as a host name.
 */
export function normalizeSharedDomain(line: string): string | null {
  const v = line.trim().toLowerCase().replace(/\.$/, "");
  if (!v || /[\s@/\\:?#]/.test(v)) return null;
  let host: string;
  try {
    host = new URL(`http://${v}`).hostname;
  } catch {
    return null;
  }
  const p = parse(host, { allowPrivateDomains: true });
  if (p.isIp || !p.hostname || p.hostname !== host || !p.domain) return null;
  return host;
}

/**
 * The shared-domains text box (one domain per line) as a list: blank lines skipped, lower case, duplicates and domains
 * the app already knows (gmail.com, instagram.com, …) dropped silently. The first line that isn't a domain is refused
 * with its line number in the box; more than 200 domains are refused.
 */
export function parseSharedDomains(text: string): { ok: true; domains: string[] } | { ok: false; error: string } {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.filter((l) => l.trim() !== "").length > SHARED_DOMAINS_MAX) return { ok: false, error: RULES_TEXT.tooManyDomains };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of lines.entries()) {
    const trimmed = raw.trim().toLowerCase().replace(/\.$/, "");
    if (!trimmed) continue;
    if (BUILT_IN_SET.has(trimmed)) continue;
    const domain = normalizeSharedDomain(trimmed);
    if (!domain) return { ok: false, error: RULES_TEXT.sharedDomainLine(i + 1) };
    if (BUILT_IN_SET.has(domain) || seen.has(domain)) continue;
    seen.add(domain);
    out.push(domain);
  }
  return { ok: true, domains: out };
}

/** Checks the card's three fields (§5.3): 1–365 days, 1–90 days, and the domains box. Field errors use the input names. */
export function validateRules(input: {
  teamRuleDays: unknown;
  pausedExpiryDays: unknown;
  sharedDomains: unknown;
}): { ok: true; value: RulesValues } | { ok: false; fieldErrors: Record<string, string[]> } {
  const fieldErrors: Record<string, string[]> = {};
  const teamRuleDays = wholeIn(input.teamRuleDays, TEAM_RULE_DAYS_RANGE);
  if (teamRuleDays === null) fieldErrors.teamRuleDays = [RULES_TEXT.teamRuleDays];
  const pausedExpiryDays = wholeIn(input.pausedExpiryDays, PAUSED_EXPIRY_DAYS_RANGE);
  if (pausedExpiryDays === null) fieldErrors.pausedExpiryDays = [RULES_TEXT.pausedExpiryDays];
  const domains = parseSharedDomains(typeof input.sharedDomains === "string" ? input.sharedDomains : "");
  if (!domains.ok) fieldErrors.sharedDomains = [domains.error];
  if (teamRuleDays === null || pausedExpiryDays === null || !domains.ok) return { ok: false, fieldErrors };
  return { ok: true, value: { teamRuleDays, pausedExpiryDays, sharedDomains: domains.domains } };
}

/** The saved rule values from Setting rows (a missing or broken row reads as its default). */
function rulesFrom(rows: ReadonlyArray<{ key: string; value: unknown }>): RulesValues {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const days = Number(map.get("teamRule.days") ?? SETTING_DEFAULTS["teamRule.days"]);
  const expiry = Number(map.get("reservations.pausedExpiryDays") ?? SETTING_DEFAULTS["reservations.pausedExpiryDays"]);
  const extra = map.get("sharedDomains.extra");
  return {
    teamRuleDays: Number.isFinite(days) ? days : SETTING_DEFAULTS["teamRule.days"],
    pausedExpiryDays: Number.isFinite(expiry) ? expiry : SETTING_DEFAULTS["reservations.pausedExpiryDays"],
    sharedDomains: (Array.isArray(extra) ? extra : []).map((d) => String(d).trim().toLowerCase()).filter(Boolean),
  };
}

async function readRules(reader: DbOrTx): Promise<RulesValues> {
  return rulesFrom(await reader.setting.findMany({ where: { key: { in: [...RULE_SETTING_KEYS] } }, select: { key: true, value: true } }));
}

function sameDomains(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((d) => set.has(d));
}

/** The card's values and the built-in list. */
export async function loadRulesView(): Promise<RulesView> {
  const rules = await readRules(db);
  return { ...rules, builtIn: [...BUILT_IN_SHARED_DOMAINS] };
}

/**
 * Companies a longer rule blocks from now on: emailed between the old and the new length ago (`lastEmailedAt` in
 * [now − new, now − old)), with a recipient still to be emailed in a running or scheduled campaign of someone other
 * than whoever emailed them (the campaign's sender, else its creator).
 */
async function companiesNewlyBlocked(oldDays: number, newDays: number, now: Date): Promise<number> {
  const rows = await db.campaignRecipient.findMany({
    where: {
      included: true,
      state: { in: OPEN_RECIPIENT_STATES },
      campaign: { status: { in: ["RUNNING", "SCHEDULED"] } },
      company: {
        deletedAt: null,
        lastEmailedAt: { gte: new Date(now.getTime() - newDays * DAY_MS), lt: new Date(now.getTime() - oldDays * DAY_MS) },
      },
    },
    select: {
      companyId: true,
      campaign: { select: { senderId: true, createdById: true } },
      company: { select: { lastEmailedById: true } },
    },
  });
  const companies = new Set<number>();
  for (const r of rows) {
    const owner = r.campaign.senderId ?? r.campaign.createdById;
    if (owner !== r.company.lastEmailedById) companies.add(r.companyId);
  }
  return companies.size;
}

/** Reservations that still hold a company: not released and not expired. */
function activeReservationWhere(now: Date) {
  return { releasedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

/** Paused campaigns that a shorter expiry releases at once (paused longer ago than the new length), and their companies. */
async function pausedReleases(newDays: number, now: Date): Promise<{ campaigns: number; companies: number }> {
  const paused = await db.campaign.findMany({
    where: { status: "PAUSED", pausedAt: { lt: new Date(now.getTime() - newDays * DAY_MS) } },
    select: { id: true },
  });
  if (paused.length === 0) return { campaigns: 0, companies: 0 };
  const groups = await db.companyReservation.groupBy({
    by: ["campaignId"],
    where: { campaignId: { in: paused.map((c) => c.id) }, ...activeReservationWhere(now) },
    _count: { _all: true },
  });
  const held = groups.filter((g) => g._count._all > 0);
  return { campaigns: held.length, companies: held.reduce((sum, g) => sum + g._count._all, 0) };
}

/** What saving `next` over `current` does to campaigns (§5.3 table), one sentence per effect; empty when nothing needs a look. */
async function impactLines(current: RulesValues, next: RulesValues, now: Date): Promise<string[]> {
  const lines: string[] = [];
  const oldDays = current.teamRuleDays;
  const newDays = next.teamRuleDays;
  if (newDays < oldDays && newDays < 30) {
    lines.push(
      `Companies become free for teammates after ${plural(newDays, "day", "days")} instead of ${n(oldDays)}, so two people may email the same company sooner.`,
    );
  }
  if (newDays > oldDays) {
    const count = await companiesNewlyBlocked(oldDays, newDays, now);
    if (count > 0) {
      lines.push(
        count === 1
          ? `1 company in running campaigns was emailed by a teammate between ${n(oldDays)} and ${n(newDays)} days ago; its people are skipped from their next email on.`
          : `${n(count)} companies in running campaigns were emailed by a teammate between ${n(oldDays)} and ${n(newDays)} days ago; their people are skipped from their next email on.`,
      );
    }
  }
  const added = next.sharedDomains.filter((d) => !current.sharedDomains.includes(d));
  if (added.length > 0) {
    const groups = await db.company.groupBy({
      by: ["domain"],
      where: { domain: { in: added }, deletedAt: null },
      _count: { _all: true },
    });
    const counts = new Map(groups.map((g) => [g.domain, g._count._all]));
    for (const domain of added) {
      const count = counts.get(domain) ?? 0;
      if (count === 0) continue;
      lines.push(
        count === 1
          ? `1 company uses ${domain}. The app would stop grouping it, and replies from it would no longer stop follow-ups there.`
          : `${n(count)} companies use ${domain}. The app would stop grouping them, and replies from it would no longer stop follow-ups there.`,
      );
    }
  }
  if (next.pausedExpiryDays < current.pausedExpiryDays) {
    const r = await pausedReleases(next.pausedExpiryDays, now);
    if (r.companies > 0) {
      lines.push(
        r.campaigns === 1
          ? `1 paused campaign would release its ${plural(r.companies, "company", "companies")} now.`
          : `${n(r.campaigns)} paused campaigns would release their ${plural(r.companies, "company", "companies")} now.`,
      );
    }
  }
  return lines;
}

/** Campaigns paused now keep their companies for the new length, counted from when each was paused. */
async function applyExpiryToPausedCampaigns(tx: Tx, days: number, now: Date): Promise<void> {
  const paused = await tx.campaign.findMany({ where: { status: "PAUSED" }, select: { id: true, pausedAt: true } });
  for (const c of paused) {
    const expiresAt = new Date((c.pausedAt ?? now).getTime() + days * DAY_MS);
    // Only reservations that still hold their company: an expired one the sweep hasn't released yet stays expired, so a
    // company another campaign took meanwhile is never held twice.
    await tx.companyReservation.updateMany({ where: { campaignId: c.id, ...activeReservationWhere(now) }, data: { expiresAt } });
  }
}

/**
 * Saves the card (§5.3). Invalid input → `fieldErrors` (nothing written). Unless `confirmed`, a change that affects
 * campaigns returns `needsConfirm.lines` and writes nothing. Otherwise every changed key and its activity are written in
 * one transaction (the values are read again inside it); nothing changed → no write and no activity.
 */
export async function saveRules(
  actor: { id: number; name: string },
  input: { teamRuleDays: number; pausedExpiryDays: number; sharedDomains: string },
  opts: { confirmed?: boolean; now?: Date } = {},
): Promise<SaveRulesResult> {
  const now = opts.now ?? new Date();
  const checked = validateRules(input);
  if (!checked.ok) return { message: RULES_TEXT.needsFixing, fieldErrors: checked.fieldErrors };
  const next = checked.value;

  const current = await readRules(db);
  const unchanged =
    current.teamRuleDays === next.teamRuleDays &&
    current.pausedExpiryDays === next.pausedExpiryDays &&
    sameDomains(current.sharedDomains, next.sharedDomains);
  if (unchanged) return { message: RULES_TEXT.nothingChanged };

  if (!opts.confirmed) {
    const lines = await impactLines(current, next, now);
    if (lines.length > 0) return { message: RULES_TEXT.needsConfirm, needsConfirm: { lines } };
  }

  const written = await dbTx(async (tx) => {
    const before = await readRules(tx);
    let changes = 0;
    if (before.teamRuleDays !== next.teamRuleDays) {
      await setSettingIn(tx, "teamRule.days", next.teamRuleDays, actor.id);
      await logActivity(
        {
          actorId: actor.id,
          type: "settings.updated",
          summary: `${actor.name} set the 30-day rule to ${plural(next.teamRuleDays, "day", "days")}`,
          data: { key: "teamRule.days", from: before.teamRuleDays, to: next.teamRuleDays },
        },
        tx,
      );
      changes += 1;
    }
    if (before.pausedExpiryDays !== next.pausedExpiryDays) {
      await setSettingIn(tx, "reservations.pausedExpiryDays", next.pausedExpiryDays, actor.id);
      await applyExpiryToPausedCampaigns(tx, next.pausedExpiryDays, now);
      await logActivity(
        {
          actorId: actor.id,
          type: "settings.updated",
          summary: `${actor.name} set paused campaigns to keep their companies for ${plural(next.pausedExpiryDays, "day", "days")}`,
          data: { key: "reservations.pausedExpiryDays", from: before.pausedExpiryDays, to: next.pausedExpiryDays },
        },
        tx,
      );
      changes += 1;
    }
    if (!sameDomains(before.sharedDomains, next.sharedDomains)) {
      await setSettingIn(tx, "sharedDomains.extra", next.sharedDomains, actor.id);
      await logActivity(
        {
          actorId: actor.id,
          type: "settings.updated",
          summary: `${actor.name} changed the shared email domains`,
          data: { key: "sharedDomains.extra", from: before.sharedDomains, to: next.sharedDomains },
        },
        tx,
      );
      changes += 1;
    }
    return changes;
  });
  return { message: written > 0 ? RULES_TEXT.saved : RULES_TEXT.nothingChanged };
}
