import type { Prisma, RecipientState } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { getSettings } from "@/server/settings";
import { countsAsEmailed } from "@/core/rules/mode";
import { isRealProvider } from "@/core/verification/policy";
import { UNKNOWN_RECHECK_AFTER_MS } from "@/core/verification/types";
import { pickTestSend } from "@/components/company-panel/emailed-text";
import { realCheckProviders } from "@/server/services/eligibility";

/**
 * Everything the company panel shows about one company (PLAN.md A6 "Company panel in detail").
 * Read-only; writes live in ./mutations.ts and ../people.ts.
 */

export type UserRef = { id: number; name: string };

export type SequenceRow = {
  id: number;
  campaignId: number;
  campaignName: string;
  campaignMode: "DRY_RUN" | "TEST" | "LIVE" | null;
  /**
   * The campaign's sends count as "emailed" (countsAsEmailed from @/core/rules/mode, M3-DESIGN §1.7, M6-DESIGN §2.2):
   * live of a campaign launched after go-live (its own launch flag), or a dry run in the practice copy. Picks the
   * " (dry run)" / " (test list)" suffix (M4-DESIGN §2.12).
   */
  countsAsEmailed: boolean;
  personId: number;
  state: RecipientState;
  currentStep: number;
  nextDueAt: Date | null;
  stopReason: string | null;
  /** While HELD: why ("outage", "possible-reply", or both); the panel reads it through heldReasonsOf. */
  holdReason: string | null;
  /** While RECHECK: when the second address check is due (M5-DESIGN §2.7, "waiting for re-check on 27 Sept at 14:05"). */
  recheckAt: Date | null;
  updatedAt: Date;
};

/**
 * The person's latest address check for the panel (M5-DESIGN §5.9, §6.5): the reasons and "Did you mean" of the latest
 * readable check of the current address, and whether a real provider checked this address in the last 24 hours (the
 * panel's Check button is off then: Mailgun would answer the same and charge again). Null when never checked.
 */
export type PersonLastCheck = {
  reasons: string[];
  didYouMean: string | null;
  isRole: boolean;
  checkedByRealProvider: boolean;
  checkedWithin24h: boolean;
};

/**
 * The newest email the app sent that doesn't count as "emailed" (M3-DESIGN §1.7): a live email before go-live (it could
 * only reach a test-list mailbox) or one in Mailgun's test mode. Filled only for a company or person with no counted
 * email (`lastEmailedAt` null), so the panel can say "Test email sent 24 Sept (test list, …)" instead of "Never emailed".
 */
export type TestSendRow = {
  sentAt: Date;
  mode: "LIVE" | "TEST";
  step: number;
  campaignId: number;
  campaignName: string;
};

export type PersonDetail = {
  id: number;
  name: string;
  firstName: string | null;
  role: string | null;
  email: string | null;
  emailNorm: string | null;
  isGeneric: boolean;
  verificationStatus: string | null;
  verificationRisk: string | null;
  verifiedAt: Date | null;
  verificationProvider: string | null;
  personalLineOverride: string | null;
  unsubscribedAt: Date | null;
  bouncedAt: Date | null;
  complainedAt: Date | null;
  repliedAt: Date | null;
  lastEmailedAt: Date | null;
  lastEmailedBy: UserRef | null;
  lastEmailedCampaignId: number | null;
  lastEmailedCampaignName: string | null;
  lastEmailedStep: number | null;
  /** The newest test email to this person, when nothing to them counts as emailed (see TestSendRow). */
  lastTestSend: TestSendRow | null;
  notes: string;
  suppressed: boolean;
  /** The latest address check of this address (see PersonLastCheck), or null. */
  lastCheck: PersonLastCheck | null;
  sequences: SequenceRow[];
  createdAt: Date;
};

export type CustomFieldValue = { key: string; label: string; value: string };

export type CompanyDetail = {
  id: number;
  code: string;
  name: string;
  website: string | null;
  domain: string | null;
  profileKey: string | null;
  country: string | null;
  timeZone: string | null;
  defaultTimeZone: string;
  niche: string | null;
  priority: "HIGH" | "NORMAL" | "LOW";
  status: "NOT_CONTACTED" | "CONTACTED" | "REPLIED" | "CLIENT" | "NOT_INTERESTED" | "DO_NOT_CONTACT";
  notes: string;
  personalLine: string | null;
  personalLineSource: string | null;
  personalLineUpdatedAt: Date | null;
  personalLineUpdatedBy: UserRef | null;
  instagram: string | null;
  customFields: CustomFieldValue[];
  firstContactedBy: UserRef | null;
  firstContactedAt: Date | null;
  lastEmailedAt: Date | null;
  lastEmailedBy: UserRef | null;
  lastEmailedCampaignId: number | null;
  lastEmailedCampaignName: string | null;
  lastEmailedStep: number | null;
  importedLastContactAt: Date | null;
  /** The newest test email to anyone at the company, when nothing there counts as emailed (see TestSendRow). */
  lastTestSend: TestSendRow | null;
  repliedAt: Date | null;
  deletedAt: Date | null;
  deletedBy: UserRef | null;
  createdAt: Date;
  createdBy: UserRef | null;
  updatedAt: Date;
  lists: Array<{ id: number; name: string }>;
  tags: Array<{ id: number; name: string }>;
  people: PersonDetail[];
  sequences: SequenceRow[];
};

/** Recipient states that say something about emailing (drafts and exclusions don't). */
const SHOWN_STATES: RecipientState[] = ["SCHEDULED", "WAITING", "HELD", "RECHECK", "FINISHED", "STOPPED"];

export function companyCode(id: number): string {
  return `C-${id}`;
}

/** Turns a stored custom-field value into display text ("" when empty). */
export function customValueText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

export function customFieldsObject(v: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
}

function humanizeKey(key: string): string {
  const s = key.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : key;
}

/** The reason stored on a charged check whose answer couldn't be read: it says nothing about the address. */
const UNREADABLE_REASON = "app:unreadable_response";
/** Checks read per person to find the latest readable one. */
const LAST_CHECK_ROWS = 5;

/** A stored `reasons` value as a list of strings (a bare string becomes one item). */
function stringList(v: unknown): string[] {
  if (typeof v === "string") return v ? [v] : [];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Each person's latest address check of their current address (PersonLastCheck). Unreadable answers are skipped for
 * the reasons, but any real check in the last 24 hours (its row, or the person's own result) counts for
 * `checkedWithin24h`, exactly as the panel's start refuses (check services, `startCheckRun` source "panel").
 */
async function loadLastChecks(
  people: ReadonlyArray<{ id: number; emailNorm: string | null; verifiedAt: Date | null; verificationProvider: string | null }>,
  now: Date,
): Promise<Map<number, PersonLastCheck>> {
  const real = realCheckProviders();
  const since = new Date(now.getTime() - UNKNOWN_RECHECK_AFTER_MS);
  const withEmail = people.filter((p): p is typeof p & { emailNorm: string } => Boolean(p.emailNorm));
  if (withEmail.length === 0) return new Map();
  const [recentRows, latest] = await Promise.all([
    db.verificationCheck.findMany({
      where: { emailNorm: { in: withEmail.map((p) => p.emailNorm) }, provider: { in: [...real] }, checkedAt: { gt: since } },
      select: { emailNorm: true },
    }),
    Promise.all(
      withEmail.map((p) =>
        db.verificationCheck.findMany({
          where: { personId: p.id, emailNorm: p.emailNorm },
          orderBy: [{ checkedAt: "desc" }, { id: "desc" }],
          take: LAST_CHECK_ROWS,
          select: { provider: true, reasons: true, didYouMean: true, isRole: true },
        }),
      ),
    ),
  ]);
  const recent = new Set(recentRows.map((r) => r.emailNorm));
  const out = new Map<number, PersonLastCheck>();
  withEmail.forEach((p, i) => {
    const rows = latest[i] ?? [];
    const row = rows.find((r) => !stringList(r.reasons).includes(UNREADABLE_REASON)) ?? null;
    const personReal = p.verifiedAt !== null && isRealProvider(p.verificationProvider, real);
    const within24h = recent.has(p.emailNorm) || (personReal && p.verifiedAt !== null && p.verifiedAt > since);
    if (rows.length === 0 && !p.verifiedAt && !within24h) return;
    out.set(p.id, {
      reasons: row ? stringList(row.reasons) : [],
      didYouMean: row?.didYouMean ?? null,
      isRole: row?.isRole ?? false,
      checkedByRealProvider: row ? isRealProvider(row.provider, real) : personReal,
      checkedWithin24h: within24h,
    });
  });
  return out;
}

/**
 * Loads one company (deleted ones too, so the panel can offer Restore). Null if the id doesn't exist. `now` is when
 * "checked in the last 24 hours" is measured from.
 */
export async function getCompanyDetail(companyId: number, opts: { now?: Date } = {}): Promise<CompanyDetail | null> {
  if (!Number.isInteger(companyId) || companyId <= 0) return null;
  const now = opts.now ?? new Date();
  const company = await db.company.findUnique({
    where: { id: companyId },
    include: {
      firstContactedBy: { select: { id: true, name: true } },
      lastEmailedBy: { select: { id: true, name: true } },
      lists: { include: { list: { select: { id: true, name: true } } } },
      tags: { include: { tag: { select: { id: true, name: true } } } },
      people: {
        where: { deletedAt: null },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: { lastEmailedBy: { select: { id: true, name: true } } },
      },
    },
  });
  if (!company) return null;

  const campaignIds = new Set<number>();
  if (company.lastEmailedCampaignId) campaignIds.add(company.lastEmailedCampaignId);
  for (const p of company.people) if (p.lastEmailedCampaignId) campaignIds.add(p.lastEmailedCampaignId);

  const userIds = new Set<number>();
  if (company.createdById) userIds.add(company.createdById);
  if (company.personalLineUpdatedById) userIds.add(company.personalLineUpdatedById);

  const emailNorms = company.people.map((p) => p.emailNorm).filter((e): e is string => Boolean(e));

  // Test emails (who has been emailed, M4 review NOTIFY-01): looked up only for the company and the people with no
  // counted email. markSent records every counted send in lastEmailedAt, so a LIVE email to someone whose
  // lastEmailedAt is still empty belongs to a campaign launched before go-live (test list only, M6-DESIGN §2.2); TEST
  // rows are Mailgun's test mode.
  const companyNeedsTestSend = company.lastEmailedAt === null;
  const peopleNeedingTestSend = company.people.filter((p) => p.lastEmailedAt === null).map((p) => p.id);
  const testSendsQuery =
    companyNeedsTestSend || peopleNeedingTestSend.length > 0
      ? db.outboundEmail.findMany({
          where: {
            companyId,
            sentAt: { not: null },
            mode: { in: ["LIVE", "TEST"] },
            ...(companyNeedsTestSend ? {} : { personId: { in: peopleNeedingTestSend } }),
          },
          orderBy: [{ sentAt: "desc" }, { id: "desc" }],
          take: 500,
          select: {
            personId: true,
            step: true,
            mode: true,
            sentAt: true,
            campaignId: true,
            campaign: { select: { name: true } },
          },
        })
      : Promise.resolve([]);

  const [campaigns, users, recipients, suppressions, fieldDefs, settings, deletion, testSendRows, lastChecks] = await Promise.all([
    campaignIds.size
      ? db.campaign.findMany({ where: { id: { in: [...campaignIds] } }, select: { id: true, name: true } })
      : Promise.resolve([] as Array<{ id: number; name: string }>),
    userIds.size
      ? db.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true } })
      : Promise.resolve([] as UserRef[]),
    db.campaignRecipient.findMany({
      where: {
        companyId,
        included: true,
        state: { in: SHOWN_STATES },
        campaign: { status: { not: "DRAFT" } },
      },
      orderBy: { id: "desc" },
      take: 100,
      include: { campaign: { select: { id: true, name: true, mode: true, launchedGoLive: true } } },
    }),
    emailNorms.length
      ? db.suppression.findMany({ where: { emailNorm: { in: emailNorms } }, select: { emailNorm: true } })
      : Promise.resolve([] as Array<{ emailNorm: string }>),
    db.customField.findMany({ where: { entity: "COMPANY" }, select: { key: true, label: true } }),
    getSettings(["defaultTimeZone", "practice.copy"] as const),
    company.deletedAt
      ? db.activityLog.findFirst({
          where: { companyId, type: "company.deleted" },
          orderBy: [{ at: "desc" }, { id: "desc" }],
          select: { actor: { select: { id: true, name: true } } },
        })
      : Promise.resolve(null),
    testSendsQuery,
    loadLastChecks(company.people, now),
  ]);

  const testSends: Array<TestSendRow & { personId: number | null }> = testSendRows.flatMap((r) =>
    r.sentAt && (r.mode === "LIVE" || r.mode === "TEST")
      ? [{ personId: r.personId, sentAt: r.sentAt, mode: r.mode, step: r.step, campaignId: r.campaignId, campaignName: r.campaign.name }]
      : [],
  );
  const testSendOf = (rows: ReadonlyArray<TestSendRow & { personId: number | null }>): TestSendRow | null => {
    const best = pickTestSend(rows);
    return best
      ? { sentAt: best.sentAt, mode: best.mode, step: best.step, campaignId: best.campaignId, campaignName: best.campaignName }
      : null;
  };

  const campaignName = new Map(campaigns.map((c) => [c.id, c.name]));
  const userById = new Map(users.map((u) => [u.id, u]));
  const suppressed = new Set(suppressions.map((s) => s.emailNorm));
  const labels = new Map(fieldDefs.map((f) => [f.key, f.label]));

  const practiceCopy = settings["practice.copy"] === true;
  const sequences: SequenceRow[] = recipients.map((r) => {
    // Each campaign by its own launch flag (M6-DESIGN §2.2): a test campaign keeps " (test list)" after go-live.
    const emailed = countsAsEmailed(r.campaign.mode, { practiceCopy, launchedGoLive: r.campaign.launchedGoLive });
    return {
      id: r.id,
      campaignId: r.campaignId,
      campaignName: r.campaign.name,
      campaignMode: r.campaign.mode,
      countsAsEmailed: emailed,
      personId: r.personId,
      state: r.state,
      currentStep: r.currentStep,
      nextDueAt: r.nextDueAt,
      stopReason: r.stopReason,
      holdReason: r.holdReason,
      recheckAt: r.recheckAt,
      updatedAt: r.updatedAt,
    };
  });

  const custom = customFieldsObject(company.customFields);
  const customFields: CustomFieldValue[] = Object.entries(custom)
    .map(([key, v]) => ({ key, label: labels.get(key) ?? humanizeKey(key), value: customValueText(v) }))
    .filter((f) => f.value !== "")
    .sort((a, b) => a.label.localeCompare(b.label));

  return {
    id: company.id,
    code: companyCode(company.id),
    name: company.name,
    website: company.website,
    domain: company.domain,
    profileKey: company.profileKey,
    country: company.country,
    timeZone: company.timeZone,
    defaultTimeZone: settings.defaultTimeZone,
    niche: company.niche,
    priority: company.priority,
    status: company.status,
    notes: company.notes,
    personalLine: company.personalLine,
    personalLineSource: company.personalLineSource,
    personalLineUpdatedAt: company.personalLineUpdatedAt,
    personalLineUpdatedBy: company.personalLineUpdatedById
      ? (userById.get(company.personalLineUpdatedById) ?? null)
      : null,
    instagram: company.instagram,
    customFields,
    firstContactedBy: company.firstContactedBy,
    firstContactedAt: company.firstContactedAt,
    lastEmailedAt: company.lastEmailedAt,
    lastEmailedBy: company.lastEmailedBy,
    lastEmailedCampaignId: company.lastEmailedCampaignId,
    lastEmailedCampaignName: company.lastEmailedCampaignId
      ? (campaignName.get(company.lastEmailedCampaignId) ?? null)
      : null,
    lastEmailedStep: company.lastEmailedStep,
    importedLastContactAt: company.importedLastContactAt,
    lastTestSend: companyNeedsTestSend ? testSendOf(testSends) : null,
    repliedAt: company.repliedAt,
    deletedAt: company.deletedAt,
    deletedBy: deletion?.actor ?? null,
    createdAt: company.createdAt,
    createdBy: company.createdById ? (userById.get(company.createdById) ?? null) : null,
    updatedAt: company.updatedAt,
    lists: company.lists.map((l) => l.list).sort((a, b) => a.name.localeCompare(b.name)),
    tags: company.tags.map((t) => t.tag).sort((a, b) => a.name.localeCompare(b.name)),
    people: company.people.map((p) => ({
      id: p.id,
      name: p.name,
      firstName: p.firstName,
      role: p.role,
      email: p.email,
      emailNorm: p.emailNorm,
      isGeneric: p.isGeneric,
      verificationStatus: p.verificationStatus,
      verificationRisk: p.verificationRisk,
      verifiedAt: p.verifiedAt,
      verificationProvider: p.verificationProvider,
      personalLineOverride: p.personalLineOverride,
      unsubscribedAt: p.unsubscribedAt,
      bouncedAt: p.bouncedAt,
      complainedAt: p.complainedAt,
      repliedAt: p.repliedAt,
      lastEmailedAt: p.lastEmailedAt,
      lastEmailedBy: p.lastEmailedBy,
      lastEmailedCampaignId: p.lastEmailedCampaignId,
      lastEmailedCampaignName: p.lastEmailedCampaignId ? (campaignName.get(p.lastEmailedCampaignId) ?? null) : null,
      lastEmailedStep: p.lastEmailedStep,
      lastTestSend: p.lastEmailedAt === null ? testSendOf(testSends.filter((s) => s.personId === p.id)) : null,
      notes: p.notes,
      suppressed: p.emailNorm ? suppressed.has(p.emailNorm) : false,
      lastCheck: lastChecks.get(p.id) ?? null,
      sequences: sequences.filter((s) => s.personId === p.id),
      createdAt: p.createdAt,
    })),
    sequences,
  };
}

export type PanelOptions = {
  lists: Array<{ id: number; name: string }>;
  tags: Array<{ id: number; name: string }>;
  niches: string[];
  customFields: Array<{ key: string; label: string }>;
};

/** Choices for the pickers in the Details section. */
export async function getPanelOptions(): Promise<PanelOptions> {
  const [lists, tags, niches, customFields] = await Promise.all([
    db.list.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.tag.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.company.findMany({
      where: { deletedAt: null, niche: { not: null } },
      distinct: ["niche"],
      select: { niche: true },
      orderBy: { niche: "asc" },
      take: 500,
    }),
    db.customField.findMany({
      where: { entity: "COMPANY" },
      select: { key: true, label: true },
      orderBy: { label: "asc" },
    }),
  ]);
  return {
    lists,
    tags,
    niches: niches.map((n) => n.niche).filter((n): n is string => Boolean(n && n.trim())),
    customFields,
  };
}

// ───────────────────────── timeline ─────────────────────────

export type TimelineFilterValue = "all" | "emails" | "replies" | "changes";

export const TIMELINE_PAGE_SIZE = 30;

export function timelineWhere(companyId: number, filter: TimelineFilterValue): Prisma.ActivityLogWhereInput {
  switch (filter) {
    case "emails":
      return { companyId, type: { startsWith: "email." } };
    case "replies":
      return { companyId, type: { startsWith: "reply." } };
    case "changes":
      return {
        companyId,
        NOT: [{ type: { startsWith: "email." } }, { type: { startsWith: "reply." } }],
      };
    default:
      return { companyId };
  }
}

/** Cursor = "<at in ms>:<id>" of the last row shown (newest first, id breaks ties). */
export function encodeTimelineCursor(row: { at: Date; id: number }): string {
  return `${row.at.getTime()}:${row.id}`;
}

export function decodeTimelineCursor(cursor: string | null | undefined): { at: Date; id: number } | null {
  if (!cursor) return null;
  const m = cursor.match(/^(\d{1,15}):(\d{1,12})$/);
  if (!m) return null;
  return { at: new Date(Number(m[1])), id: Number(m[2]) };
}

export type TimelineEntry = {
  id: number;
  at: Date;
  type: string;
  summary: string;
  data: Prisma.JsonValue | null;
  mode: "DRY_RUN" | "TEST" | "LIVE" | null;
  actorName: string | null;
};

export async function getCompanyTimeline(
  companyId: number,
  opts: { filter?: TimelineFilterValue; cursor?: string | null; limit?: number } = {},
): Promise<{ entries: TimelineEntry[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? TIMELINE_PAGE_SIZE, 1), 100);
  const base = timelineWhere(companyId, opts.filter ?? "all");
  const after = decodeTimelineCursor(opts.cursor);
  const where: Prisma.ActivityLogWhereInput = after
    ? { AND: [base, { OR: [{ at: { lt: after.at } }, { at: after.at, id: { lt: after.id } }] }] }
    : base;
  const rows = await db.activityLog.findMany({
    where,
    orderBy: [{ at: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      at: true,
      type: true,
      summary: true,
      data: true,
      mode: true,
      actor: { select: { name: true } },
    },
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    entries: page.map((r) => ({
      id: r.id,
      at: r.at,
      type: r.type,
      summary: r.summary,
      data: r.data,
      mode: r.mode,
      actorName: r.actor?.name ?? null,
    })),
    nextCursor: rows.length > limit && last ? encodeTimelineCursor(last) : null,
  };
}
