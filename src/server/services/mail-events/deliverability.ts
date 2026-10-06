import { z } from "zod";
import type { Prisma, SuppressionReason } from "@/generated/prisma/client";
import { healthLine, MAILGUN_LIMITS, type HealthSettings } from "@/core/sending/health";
import { countsFromGoLive, healthCountingSince, healthGoLiveAt } from "@/core/sending/health-since";
import { parseHealthBaseline } from "@/core/system-state-parse";
import { STATE_KEYS } from "@/core/system-state";
import { formatShortDate } from "@/core/time/format";
import { logActivity } from "@/server/activity";
import { db } from "@/server/db";
import { getSettings, setSetting } from "@/server/settings";
import { removableAddresses, type RemovableAddress } from "@/server/services/mailgun/suppressions";
import { loadHealthCounts, type HealthCountsWithIds } from "@/server/services/sending/usage";
import { readTyped } from "@/server/state-typed";

/**
 * Read model and settings for Settings › Deliverability (Owner, M3-DESIGN §5.5, SPEC §8 "show why"): the bounce and
 * complaint counts behind the automatic pause, the emails counted right now (with campaign, company and lists), the
 * thresholds, and the do-not-email list.
 */

// ───────────────────────── health ─────────────────────────

export type ThresholdValues = {
  bounceWindow: number;
  bouncePercent: number;
  complaintWindow: number;
  complaintPercent: number;
  healthyBouncePercent: number;
  healthyComplaintPercent: number;
};

export type HealthView = {
  practiceCopy: boolean;
  thresholds: ThresholdValues;
  counts: HealthCountsWithIds;
  bounceLine: string;
  complaintLine: string;
  /** floor(window × % / 100): sending pauses above these. */
  bounceLimit: number;
  complaintLimit: number;
  /** "Only 45 live emails since 24 Sep; the limit is counted per 200." when the sample is still small. */
  bounceNote: string | null;
  complaintNote: string | null;
  /** "Counting since you resumed on 24 Sep." after a health pause was resumed; "Counting since you went live on 27 Sep." from go-live. */
  sinceNote: string | null;
};

function limitFor(window: number, percent: number): number {
  return Math.floor((Math.floor(window) * Math.round(percent * 1000)) / 100_000);
}

function num(n: number): string {
  return n.toLocaleString("en-US");
}

export async function loadThresholds(): Promise<ThresholdValues> {
  const s = await getSettings([
    "health.bounceWindow",
    "health.bouncePercent",
    "health.complaintWindow",
    "health.complaintPercent",
    "warmup.healthyBouncePercent",
    "warmup.healthyComplaintPercent",
  ] as const);
  return {
    bounceWindow: Number(s["health.bounceWindow"]),
    bouncePercent: Number(s["health.bouncePercent"]),
    complaintWindow: Number(s["health.complaintWindow"]),
    complaintPercent: Number(s["health.complaintPercent"]),
    healthyBouncePercent: Number(s["warmup.healthyBouncePercent"]),
    healthyComplaintPercent: Number(s["warmup.healthyComplaintPercent"]),
  };
}

/**
 * The Health section: both lines, the notes and the ids of the emails counted now. Dates in `timeZone`. The counts
 * start at the health baseline and, on real data, at the first go-live on the sending domain (M6-DESIGN G12, review
 * REPLIES-02), like the health check's.
 */
export async function loadHealthView(timeZone: string, now: Date = new Date()): Promise<HealthView> {
  const thresholds = await loadThresholds();
  const flags = await getSettings(["practice.copy", "sending.goLiveAt", "sending.healthSinceGoLiveAt"] as const);
  const practiceCopy = flags["practice.copy"] === true;
  // The first go-live on this sending domain (review REPLIES-02): a new go-live after a From change keeps counting.
  const goLiveAt = healthGoLiveAt(flags["sending.goLiveAt"], flags["sending.healthSinceGoLiveAt"]);
  const baseline = (await readTyped(STATE_KEYS.healthBaseline, parseHealthBaseline)).value;
  const since = healthCountingSince(baseline.since, goLiveAt, practiceCopy);
  const counts = await loadHealthCounts({
    since,
    bounceWindow: thresholds.bounceWindow,
    complaintWindow: thresholds.complaintWindow,
    practiceCopy,
  });
  const s: HealthSettings = {
    bounceWindow: thresholds.bounceWindow,
    bouncePercent: thresholds.bouncePercent,
    complaintWindow: thresholds.complaintWindow,
    complaintPercent: thresholds.complaintPercent,
  };
  const kind = practiceCopy ? "" : "live ";
  const note = (sample: number, window: number) => {
    if (sample <= 0 || sample >= window) return null;
    const when = since ? `since ${formatShortDate(since, timeZone, now)}` : "so far";
    return `Only ${num(sample)} ${kind}${sample === 1 ? "email" : "emails"} ${when}; the limit is counted per ${num(window)}.`;
  };
  return {
    practiceCopy,
    thresholds,
    counts,
    bounceLine: healthLine("bounce", counts, s),
    complaintLine: healthLine("complaint", counts, s),
    bounceLimit: limitFor(thresholds.bounceWindow, thresholds.bouncePercent),
    complaintLimit: limitFor(thresholds.complaintWindow, thresholds.complaintPercent),
    bounceNote: note(counts.bounceSample, thresholds.bounceWindow),
    complaintNote: note(counts.complaintSample, thresholds.complaintWindow),
    sinceNote: since
      ? countsFromGoLive(since, goLiveAt, practiceCopy)
        ? `Counting since you went live on ${formatShortDate(since, timeZone, now)}.`
        : `Counting since you resumed on ${formatShortDate(since, timeZone, now)}.`
      : null,
  };
}

export type CountedRow = {
  emailId: number;
  address: string;
  companyId: number | null;
  companyName: string;
  campaignId: number;
  campaignName: string;
  lists: string[];
  /** When the bounce or complaint happened (else when the email was sent). */
  at: Date;
  /** Mailgun's reason and code, for "Details". */
  reason: string | null;
  code: number | null;
  message: string | null;
};

function deliveryStatus(raw: unknown): { code: number | null; message: string | null } {
  const ds = raw && typeof raw === "object" ? (raw as Record<string, unknown>)["delivery-status"] : null;
  if (!ds || typeof ds !== "object") return { code: null, message: null };
  const o = ds as Record<string, unknown>;
  const code = typeof o.code === "number" ? o.code : typeof o.code === "string" && /^\d+$/.test(o.code) ? Number(o.code) : null;
  const message = typeof o.description === "string" && o.description ? o.description : typeof o.message === "string" ? o.message : null;
  return { code, message };
}

/** The "Bounces counted now" / "Complaints counted now" tables, in the order of `ids` (newest first). */
export async function loadCountedRows(ids: readonly number[], kind: "bounce" | "complaint"): Promise<CountedRow[]> {
  if (ids.length === 0) return [];
  const emails = await db.outboundEmail.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, toEmail: true, companyId: true, companyName: true, campaignId: true, sentAt: true, campaign: { select: { name: true } } },
  });
  const events = await db.mailEvent.findMany({
    where:
      kind === "bounce"
        ? {
            outboundEmailId: { in: [...ids] },
            type: "failed",
            severity: "permanent",
            isTestMode: false,
            OR: [{ reason: null }, { NOT: { reason: { startsWith: "suppress-" } } }],
          }
        : { outboundEmailId: { in: [...ids] }, type: "complained", isTestMode: false },
    orderBy: { occurredAt: "asc" },
    select: { outboundEmailId: true, occurredAt: true, reason: true, raw: true },
  });
  const firstEvent = new Map<number, (typeof events)[number]>();
  for (const e of events) if (e.outboundEmailId !== null && !firstEvent.has(e.outboundEmailId)) firstEvent.set(e.outboundEmailId, e);
  const companyIds = [...new Set(emails.map((e) => e.companyId).filter((x): x is number => x !== null))];
  const memberships = companyIds.length
    ? await db.companyList.findMany({ where: { companyId: { in: companyIds } }, select: { companyId: true, list: { select: { name: true } } } })
    : [];
  const lists = new Map<number, string[]>();
  for (const m of memberships) lists.set(m.companyId, [...(lists.get(m.companyId) ?? []), m.list.name]);
  const byId = new Map(emails.map((e) => [e.id, e]));
  const out: CountedRow[] = [];
  for (const id of ids) {
    const e = byId.get(id);
    if (!e) continue;
    const ev = firstEvent.get(id);
    const ds = deliveryStatus(ev?.raw);
    out.push({
      emailId: e.id,
      address: e.toEmail,
      companyId: e.companyId,
      companyName: e.companyName,
      campaignId: e.campaignId,
      campaignName: e.campaign.name,
      lists: (e.companyId !== null ? (lists.get(e.companyId) ?? []) : []).sort((a, b) => a.localeCompare(b)),
      at: ev?.occurredAt ?? e.sentAt ?? new Date(0),
      reason: ev?.reason ?? null,
      code: ds.code,
      message: ds.message,
    });
  }
  return out;
}

// ───────────────────────── thresholds ─────────────────────────

const decimal = (min: number, max: number, message: string) =>
  z.coerce.number({ error: message }).refine((v) => Number.isFinite(v) && v >= min && v <= max, { error: message });
const whole = (min: number, max: number, message: string) =>
  z.coerce.number({ error: message }).refine((v) => Number.isInteger(v) && v >= min && v <= max, { error: message });

export const thresholdsSchema = z.object({
  bounceWindow: whole(50, 5_000, "Use a whole number from 50 to 5,000."),
  bouncePercent: decimal(0.5, 10, "Use a number from 0.5 to 10."),
  complaintWindow: whole(200, 20_000, "Use a whole number from 200 to 20,000."),
  complaintPercent: decimal(0.01, 1, "Use a number from 0.01 to 1."),
  healthyBouncePercent: decimal(0.1, 10, "Use a number from 0.1 to 10."),
  healthyComplaintPercent: decimal(0.01, 1, "Use a number from 0.01 to 1."),
});

/** Amber hints for thresholds above Mailgun's own limits (the Owner may still save them). */
export function thresholdWarnings(t: Pick<ThresholdValues, "bouncePercent" | "complaintPercent">): { bounce: string | null; complaint: string | null } {
  return {
    bounce:
      t.bouncePercent > MAILGUN_LIMITS.bouncePercent
        ? `Above Mailgun's own limit of ${MAILGUN_LIMITS.bouncePercent}%: Mailgun may suspend your account before the app pauses.`
        : null,
    complaint:
      t.complaintPercent > MAILGUN_LIMITS.complaintPercent
        ? `Above Mailgun's own limit of ${MAILGUN_LIMITS.complaintPercent}%: Mailgun may suspend your account before the app pauses.`
        : null,
  };
}

const SETTING_OF: Record<keyof ThresholdValues, Parameters<typeof setSetting>[0]> = {
  bounceWindow: "health.bounceWindow",
  bouncePercent: "health.bouncePercent",
  complaintWindow: "health.complaintWindow",
  complaintPercent: "health.complaintPercent",
  healthyBouncePercent: "warmup.healthyBouncePercent",
  healthyComplaintPercent: "warmup.healthyComplaintPercent",
};

/** Saves the thresholds (already validated with thresholdsSchema) and logs `settings.updated` when anything changed. */
export async function saveHealthThresholds(actor: { id: number; name: string }, values: ThresholdValues): Promise<{ changed: string[] }> {
  const current = await loadThresholds();
  const changed: string[] = [];
  for (const key of Object.keys(SETTING_OF) as Array<keyof ThresholdValues>) {
    if (current[key] === values[key]) continue;
    await setSetting(SETTING_OF[key] as "health.bounceWindow", values[key], actor.id);
    changed.push(SETTING_OF[key]);
  }
  if (changed.length > 0) {
    await logActivity({
      actorId: actor.id,
      type: "settings.updated",
      summary: `${actor.name} changed the bounce and complaint limits`,
      data: { keys: changed, values: { ...values } },
    });
  }
  return { changed };
}

// ───────────────────────── the do-not-email list ─────────────────────────

export const SUPPRESSION_FILTERS = ["all", "BOUNCED", "UNSUBSCRIBED", "COMPLAINED", "MANUAL", "INVALID"] as const;
export type SuppressionFilter = (typeof SUPPRESSION_FILTERS)[number];
export const SUPPRESSION_FILTER_LABELS: Readonly<Record<SuppressionFilter, string>> = {
  all: "All",
  BOUNCED: "Bounced",
  UNSUBSCRIBED: "Unsubscribed",
  COMPLAINED: "Complained",
  MANUAL: "Do not email",
  INVALID: "Invalid",
};
export const SUPPRESSIONS_PAGE_SIZE = 50;

export type SuppressionRowView = {
  id: number;
  address: string;
  reason: SuppressionReason;
  why: string;
  detail: string | null;
  companyId: number | null;
  companyName: string | null;
  campaignId: number | null;
  campaignName: string | null;
  from: string;
  createdAt: Date;
  inMailgun: "yes" | "waiting" | "practice";
  removable: RemovableAddress | null;
};

export type SuppressionPage = { rows: SuppressionRowView[]; total: number; page: number; pageCount: number };

function whereFrom(source: string): string {
  if (source === "webhook" || source === "mailgun-sync") return "Mailgun";
  if (source === "verification") return "Address check";
  if (source === "simulated") return "Practice";
  return "You";
}

/** One page (50) of the do-not-email list, newest first, searched by address and filtered by reason. */
export async function listSuppressionPage(opts: { q?: string | null; filter?: SuppressionFilter; page?: number | null }): Promise<SuppressionPage> {
  const q = (opts.q ?? "").trim().toLowerCase().slice(0, 200);
  const filter = opts.filter && SUPPRESSION_FILTERS.includes(opts.filter) ? opts.filter : "all";
  const where: Prisma.SuppressionWhereInput = {
    ...(q ? { emailNorm: { contains: q } } : {}),
    ...(filter !== "all" ? { reason: filter } : {}),
  };
  const total = await db.suppression.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / SUPPRESSIONS_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1) || 1), pageCount);
  if (total === 0) return { rows: [], total, page: 1, pageCount: 1 };
  const rows = await db.suppression.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * SUPPRESSIONS_PAGE_SIZE,
    take: SUPPRESSIONS_PAGE_SIZE,
  });
  const norms = rows.map((r) => r.emailNorm);
  const people = await db.person.findMany({
    where: { emailNorm: { in: norms } },
    select: { emailNorm: true, companyId: true, company: { select: { name: true } } },
  });
  const personOf = new Map(people.map((p) => [p.emailNorm!, p]));
  const emails = await db.outboundEmail.findMany({
    where: { toNorm: { in: norms }, OR: [{ bouncedAt: { not: null } }, { complainedAt: { not: null } }, { unsubscribedAt: { not: null } }] },
    orderBy: { id: "desc" },
    select: { toNorm: true, campaignId: true, campaign: { select: { name: true } } },
  });
  const campaignOf = new Map<string, { id: number; name: string }>();
  for (const e of emails) if (!campaignOf.has(e.toNorm)) campaignOf.set(e.toNorm, { id: e.campaignId, name: e.campaign.name });
  const practiceCopy = (await getSettings(["practice.copy"] as const))["practice.copy"] === true;
  const removable = await removableAddresses();
  return {
    rows: rows.map((r) => {
      const person = personOf.get(r.emailNorm);
      const campaign = campaignOf.get(r.emailNorm);
      return {
        id: r.id,
        address: r.emailNorm,
        reason: r.reason,
        why: SUPPRESSION_FILTER_LABELS[r.reason],
        detail: r.detail,
        companyId: person?.companyId ?? null,
        companyName: person?.company.name ?? null,
        campaignId: campaign?.id ?? null,
        campaignName: campaign?.name ?? null,
        from: whereFrom(r.source),
        createdAt: r.createdAt,
        inMailgun: practiceCopy ? "practice" : r.pushedToMailgunAt ? "yes" : "waiting",
        removable: removable.get(r.emailNorm) ?? null,
      };
    }),
    total,
    page,
    pageCount,
  };
}
