import type { CampaignStatus, Prisma, RecipientState, SendMode, SendStatus } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { getSetting, getSettings } from "@/server/settings";
import { readTyped } from "@/server/state-typed";
import { countsAsEmailed, countsAsReal } from "@/core/rules/mode";
import { heldReasonsOf } from "@/core/sequences/hold-reasons";
import { parseOutageState } from "@/core/system-state-parse";
import { STATE_KEYS } from "@/core/system-state";
import { normalizeText } from "@/core/text";
import {
  CAMPAIGN_TAB_STATUS,
  CLOSED_RECIPIENT_STATES,
  OPEN_RECIPIENT_STATES,
  PROBLEM_EMAIL_STATUSES,
  RESOLVED_EMAIL_STATUSES,
  campaignProgress,
  emptyRecipientCounts,
  emptyTabCounts,
  recipientName,
  tabForStatus,
  type CampaignHolds,
  type CampaignListInput,
  type CampaignResults,
  type CampaignTab,
  type CampaignTabCounts,
  type CompanySequence,
  type Progress,
  type RecipientCounts,
  type RecipientFilter,
  type StepProgress,
  type TimelineActivity,
} from "@/components/campaigns/format";

/**
 * Read models for the campaign screens (PLAN.md A6 "Campaigns" and "Campaign page", SPEC §7 "The
 * campaign screen shows"), the dry-run outbox and the Contacts "Sequence" column. Read-only: every
 * change goes through the engine (@/server/services/campaigns/control, launch, sending/*).
 *
 * Kept quick for big campaigns: counts come from grouped queries, lists are paginated, and the
 * Contacts column adds one query for the page's companies only. The wording and the pure maths
 * live in @/components/campaigns/format (browser-safe, unit-tested).
 */

const OPEN_STATES = [...OPEN_RECIPIENT_STATES] as RecipientState[];
const CLOSED_STATES = [...CLOSED_RECIPIENT_STATES] as RecipientState[];
const RESOLVED = new Set<SendStatus>(RESOLVED_EMAIL_STATUSES as SendStatus[]);
const PROBLEM_STATUSES = [...PROBLEM_EMAIL_STATUSES] as SendStatus[];

function clampPage(page: number | null | undefined, pageCount: number): number {
  const p = Math.floor(Number(page) || 1);
  return Math.min(Math.max(1, p), Math.max(1, pageCount));
}

// ───────────────────────── the Campaigns list ─────────────────────────

export const CAMPAIGNS_PAGE_SIZE = 25;

/** Campaigns per tab (every status). */
export async function countCampaignsByTab(): Promise<CampaignTabCounts> {
  const groups = await db.campaign.groupBy({ by: ["status"], _count: { _all: true } });
  const out = emptyTabCounts();
  for (const g of groups) out[tabForStatus(g.status)] += g._count._all;
  return out;
}

export type CampaignListItem = CampaignListInput & {
  createdByName: string;
  /** People left out (unticked, or excluded at launch). */
  excluded: number;
  /** Emails sent so far (every step). */
  sent: number;
  createdAt: Date;
};

export type CampaignListPage = {
  items: CampaignListItem[];
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
};

const TAB_ORDER: Record<CampaignTab, Prisma.CampaignOrderByWithRelationInput[]> = {
  drafts: [{ updatedAt: "desc" }, { id: "desc" }],
  scheduled: [{ startAt: "asc" }, { id: "asc" }],
  running: [{ launchedAt: "desc" }, { id: "desc" }],
  paused: [{ pausedAt: "desc" }, { id: "desc" }],
  finished: [{ finishedAt: "desc" }, { id: "desc" }],
  cancelled: [{ finishedAt: "desc" }, { id: "desc" }],
};

type CampaignStats = {
  audience: number;
  excluded: number;
  open: number;
  enabledSteps: number;
  firstSent: number;
  sent: number;
  progress: Progress;
};

/** Audience, sent emails and overall progress for a handful of campaigns (4 grouped queries). */
async function campaignStats(ids: number[]): Promise<Map<number, CampaignStats>> {
  const out = new Map<number, CampaignStats>();
  if (ids.length === 0) return out;
  const [recipients, emails, closed, steps] = await Promise.all([
    db.campaignRecipient.groupBy({
      by: ["campaignId", "state", "included"],
      where: { campaignId: { in: ids } },
      _count: { _all: true },
    }),
    db.outboundEmail.groupBy({
      by: ["campaignId", "step", "status"],
      where: { campaignId: { in: ids } },
      _count: { _all: true },
    }),
    db.outboundEmail.groupBy({
      by: ["campaignId", "status"],
      where: { campaignId: { in: ids }, recipient: { state: { in: CLOSED_STATES } } },
      _count: { _all: true },
    }),
    db.campaignStep.groupBy({
      by: ["campaignId"],
      where: { campaignId: { in: ids }, enabled: true },
      _count: { _all: true },
    }),
  ]);
  const closedSent = new Map<number, number>();
  const closedResolved = new Map<number, number>();
  for (const id of ids) {
    out.set(id, { audience: 0, excluded: 0, open: 0, enabledSteps: 0, firstSent: 0, sent: 0, progress: { done: 0, total: 0 } });
  }
  for (const g of recipients) {
    const s = out.get(g.campaignId);
    if (!s) continue;
    const count = g._count._all;
    if (!g.included || g.state === "EXCLUDED") {
      s.excluded += count;
      continue;
    }
    s.audience += count;
    if (OPEN_STATES.includes(g.state)) s.open += count;
  }
  for (const g of emails) {
    const s = out.get(g.campaignId);
    if (!s || g.status !== "SENT") continue;
    s.sent += g._count._all;
    if (g.step === 0) s.firstSent += g._count._all;
  }
  for (const g of closed) {
    if (g.status === "SENT") closedSent.set(g.campaignId, (closedSent.get(g.campaignId) ?? 0) + g._count._all);
    if (RESOLVED.has(g.status)) closedResolved.set(g.campaignId, (closedResolved.get(g.campaignId) ?? 0) + g._count._all);
  }
  for (const g of steps) {
    const s = out.get(g.campaignId);
    if (s) s.enabledSteps = g._count._all;
  }
  for (const [id, s] of out) {
    s.progress = campaignProgress({
      openRecipients: s.open,
      enabledSteps: s.enabledSteps,
      sentAll: s.sent,
      sentClosed: closedSent.get(id) ?? 0,
      resolvedClosed: closedResolved.get(id) ?? 0,
    });
  }
  return out;
}

/** One page of one tab of the Campaigns screen, with each campaign's audience and progress. */
export async function listCampaigns(
  tab: CampaignTab,
  opts: { page?: number | null; pageSize?: number } = {},
): Promise<CampaignListPage> {
  const status = CAMPAIGN_TAB_STATUS[tab] as CampaignStatus;
  const pageSize = opts.pageSize ?? CAMPAIGNS_PAGE_SIZE;
  const total = await db.campaign.count({ where: { status } });
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = clampPage(opts.page, pageCount);
  if (total === 0) return { items: [], total, page: 1, pageCount: 1, pageSize };

  const campaigns = await db.campaign.findMany({
    where: { status },
    orderBy: TAB_ORDER[tab],
    skip: (page - 1) * pageSize,
    take: pageSize,
    select: {
      id: true,
      name: true,
      status: true,
      mode: true,
      wizardStep: true,
      startAt: true,
      launchedAt: true,
      finishedAt: true,
      pausedAt: true,
      pauseReason: true,
      createdAt: true,
      updatedAt: true,
      sender: { select: { name: true } },
      createdBy: { select: { name: true } },
    },
  });
  const stats = await campaignStats(campaigns.map((c) => c.id));
  const items = campaigns.map((c): CampaignListItem => {
    const s = stats.get(c.id)!;
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      mode: c.mode,
      wizardStep: c.wizardStep,
      senderName: c.sender?.name ?? null,
      createdByName: c.createdBy.name,
      audience: s.audience,
      excluded: s.excluded,
      sent: s.sent,
      firstEmail: { sent: s.firstSent, planned: s.audience },
      enabledSteps: s.enabledSteps,
      progress: s.progress,
      startAt: c.startAt,
      launchedAt: c.launchedAt,
      finishedAt: c.finishedAt,
      pausedAt: c.pausedAt,
      pauseReason: c.pauseReason,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  });
  return { items, total, page, pageCount, pageSize };
}

// ───────────────────────── one campaign ─────────────────────────

/** A campaign's name (for the browser tab), or null. */
export async function getCampaignName(campaignId: number): Promise<string | null> {
  if (!Number.isInteger(campaignId) || campaignId <= 0) return null;
  const c = await db.campaign.findUnique({ where: { id: campaignId }, select: { name: true } });
  return c?.name ?? null;
}

export type CampaignStepOverview = Omit<StepProgress, "nextDueAt" | "held"> & {
  enabled: boolean;
  /** Emails of this step waiting while their person is on hold (M4-DESIGN §2.11); not counted in `waiting`. */
  held: number;
  /** The earliest due time of this step's emails waiting to send (people on hold left out). */
  nextDueAt: Date | null;
};

export type CampaignOverview = {
  id: number;
  name: string;
  status: CampaignStatus;
  mode: SendMode | null;
  wizardStep: number;
  daysAsMinutes: boolean;
  ignoreWindow: boolean;
  sender: { id: number; name: string; active: boolean } | null;
  /** Sender snapshot fixed at launch: display name and bare address. */
  fromName: string | null;
  fromAddress: string | null;
  /**
   * The snapshot's Reply-To: the sender's own address in shared-From mode (the From address is then the shared one),
   * null in per-person mode (SHARED-FROM-DESIGN §2.3).
   */
  replyTo: string | null;
  createdBy: { id: number; name: string };
  sourceTemplateName: string | null;
  startAt: Date | null;
  launchedAt: Date | null;
  finishedAt: Date | null;
  pausedAt: Date | null;
  pauseReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Its sends count as real contact (live, or a dry run in the practice copy). */
  countsAsReal: boolean;
  /** Steps switched on, plus any step that already has emails; in order. */
  steps: CampaignStepOverview[];
  /** People being emailed (ticked and not left out). */
  audience: number;
  excluded: number;
  recipientCounts: RecipientCounts;
  results: CampaignResults;
  /** Emails waiting to send right now (any step; people on hold left out). */
  emailsWaiting: number;
  progress: Progress;
  hasFollowUps: boolean;
  /** Who is on hold in this campaign, and why (the page's notices, M4-DESIGN §9.3). */
  holds: CampaignHolds;
};

/**
 * Who is on hold in one campaign (M4-DESIGN §2.8, §9.3): the companies held for a possible reply, the people held
 * because the PC was off (emailed already, or first emails to colleagues) and the window of that outage hold.
 */
export async function campaignHolds(campaignId: number): Promise<CampaignHolds> {
  const [held, outage] = await Promise.all([
    db.campaignRecipient.findMany({
      where: { campaignId, included: true, state: "HELD" },
      select: { companyId: true, state: true, holdReason: true, currentStep: true },
    }),
    readTyped(STATE_KEYS.outage, parseOutageState),
  ]);
  const possible = new Set<number>();
  const counts = { followUps: 0, firstEmails: 0 };
  for (const r of held) {
    const reasons = heldReasonsOf(r);
    if (reasons.includes("possible-reply")) possible.add(r.companyId);
    if (reasons.includes("outage")) {
      if (r.currentStep >= 1) counts.followUps += 1;
      else counts.firstEmails += 1;
    }
  }
  const o = outage.value;
  return {
    possibleReplyCompanies: possible.size,
    outage: counts,
    outageFrom: o.heldFor ?? o.from,
    outageTo: o.heldFor ? o.heldTo : o.to,
  };
}

/** Everything the campaign page shows above the recipient list. Null when the id doesn't exist. */
export async function getCampaignOverview(campaignId: number): Promise<CampaignOverview | null> {
  if (!Number.isInteger(campaignId) || campaignId <= 0) return null;
  const c = await db.campaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      name: true,
      status: true,
      mode: true,
      wizardStep: true,
      daysAsMinutes: true,
      ignoreWindow: true,
      fromName: true,
      fromAddress: true,
      replyTo: true,
      sourceTemplateId: true,
      startAt: true,
      launchedAt: true,
      finishedAt: true,
      pausedAt: true,
      pauseReason: true,
      createdAt: true,
      updatedAt: true,
      sender: { select: { id: true, name: true, active: true } },
      createdBy: { select: { id: true, name: true } },
      steps: { select: { step: true, enabled: true, delayDays: true }, orderBy: { step: "asc" } },
    },
  });
  if (!c) return null;

  const [template, recipientGroups, edited, problems, emailGroups, queuedFree, closedGroups, marks, repliedPeople, practiceCopy, holds] = await Promise.all([
    c.sourceTemplateId ? db.template.findUnique({ where: { id: c.sourceTemplateId }, select: { name: true } }) : Promise.resolve(null),
    db.campaignRecipient.groupBy({ by: ["state", "included"], where: { campaignId }, _count: { _all: true } }),
    db.campaignRecipient.count({ where: { campaignId, hasEdits: true } }),
    db.campaignRecipient.count({ where: { campaignId, outbound: { some: { status: { in: PROBLEM_STATUSES } } } } }),
    db.outboundEmail.groupBy({
      by: ["step", "status"],
      where: { campaignId },
      _count: { _all: true },
      _min: { dueAt: true },
    }),
    // Emails waiting to send whose person isn't on hold: the "waiting" counts and next due times (§2.11).
    db.outboundEmail.groupBy({
      by: ["step"],
      where: { campaignId, status: "QUEUED", recipient: { state: { not: "HELD" } } },
      _count: { _all: true },
      _min: { dueAt: true },
    }),
    db.outboundEmail.groupBy({
      by: ["status"],
      where: { campaignId, recipient: { state: { in: CLOSED_STATES } } },
      _count: { _all: true },
    }),
    db.outboundEmail.aggregate({
      where: { campaignId },
      _count: { deliveredAt: true, bouncedAt: true, complainedAt: true, unsubscribedAt: true },
    }),
    db.inboundMessage.findMany({
      where: { campaignId, kind: "REPLY", personId: { not: null } },
      distinct: ["personId"],
      select: { personId: true },
    }),
    getSetting("practice.copy"),
    campaignHolds(campaignId),
  ]);

  const counts = emptyRecipientCounts();
  let open = 0;
  for (const g of recipientGroups) {
    const count = g._count._all;
    counts.all += count;
    if (!g.included || g.state === "EXCLUDED") {
      counts.excluded += count;
      continue;
    }
    if (OPEN_STATES.includes(g.state)) {
      counts.active += count;
      open += count;
    } else if (g.state === "FINISHED") counts.finished += count;
    else if (g.state === "STOPPED") counts.stopped += count;
  }
  counts.edited = edited;
  counts.problems = problems;
  const audience = counts.all - counts.excluded;

  const stepNumbers = new Set<number>([...c.steps.filter((s) => s.enabled).map((s) => s.step), ...emailGroups.map((g) => g.step)]);
  const stepInfo = new Map(c.steps.map((s) => [s.step, s]));
  const free = new Map(queuedFree.map((g) => [g.step, { count: g._count._all, nextDueAt: g._min.dueAt }]));
  const steps: CampaignStepOverview[] = [...stepNumbers]
    .sort((a, b) => a - b)
    .map((step) => {
      const info = stepInfo.get(step);
      const p: CampaignStepOverview = {
        step,
        enabled: info?.enabled ?? false,
        delayDays: info?.delayDays ?? 0,
        planned: step === 0 ? audience : 0,
        sent: 0,
        waiting: 0,
        sending: 0,
        skipped: 0,
        failed: 0,
        cancelled: 0,
        unsure: 0,
        held: 0,
        nextDueAt: null,
      };
      for (const g of emailGroups) {
        if (g.step !== step) continue;
        const count = g._count._all;
        switch (g.status) {
          case "SENT":
            p.sent += count;
            break;
          case "QUEUED": {
            // People on hold are counted apart ("· 5 on hold"), never as waiting.
            const notHeld = free.get(step);
            p.waiting += notHeld?.count ?? 0;
            p.held += Math.max(0, count - (notHeld?.count ?? 0));
            p.nextDueAt = notHeld?.nextDueAt ?? null;
            break;
          }
          case "SENDING":
            p.sending += count;
            break;
          case "SKIPPED":
            p.skipped += count;
            break;
          case "FAILED":
            p.failed += count;
            break;
          case "CANCELLED":
            p.cancelled += count;
            break;
          case "UNKNOWN":
          case "UNCONFIRMED":
            p.unsure += count;
            break;
        }
      }
      return p;
    });

  let sentAll = 0;
  for (const g of emailGroups) if (g.status === "SENT") sentAll += g._count._all;
  const emailsWaiting = queuedFree.reduce((sum, g) => sum + g._count._all, 0);
  let sentClosed = 0;
  let resolvedClosed = 0;
  for (const g of closedGroups) {
    if (g.status === "SENT") sentClosed += g._count._all;
    if (RESOLVED.has(g.status)) resolvedClosed += g._count._all;
  }
  const enabledSteps = c.steps.filter((s) => s.enabled).length;

  return {
    id: c.id,
    name: c.name,
    status: c.status,
    mode: c.mode,
    wizardStep: c.wizardStep,
    daysAsMinutes: c.daysAsMinutes,
    ignoreWindow: c.ignoreWindow,
    sender: c.sender,
    fromName: c.fromName,
    fromAddress: c.fromAddress,
    replyTo: c.replyTo,
    createdBy: c.createdBy,
    sourceTemplateName: template?.name ?? null,
    startAt: c.startAt,
    launchedAt: c.launchedAt,
    finishedAt: c.finishedAt,
    pausedAt: c.pausedAt,
    pauseReason: c.pauseReason,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    countsAsReal: countsAsReal(c.mode, practiceCopy === true),
    steps,
    audience,
    excluded: counts.excluded,
    recipientCounts: counts,
    results: {
      sent: sentAll,
      delivered: marks._count.deliveredAt,
      bounced: marks._count.bouncedAt,
      replied: repliedPeople.length,
      unsubscribed: marks._count.unsubscribedAt,
      complained: marks._count.complainedAt,
    },
    emailsWaiting,
    progress: campaignProgress({ openRecipients: open, enabledSteps, sentAll, sentClosed, resolvedClosed }),
    hasFollowUps: steps.some((s) => s.step > 0 && s.enabled),
    holds,
  };
}

// ───────────────────────── the recipient list ─────────────────────────

export const RECIPIENTS_PAGE_SIZE = 50;

/** Which recipients a filter (and search words) selects. Search looks at the address and the company (name, website, people). */
export function recipientWhere(campaignId: number, filter: RecipientFilter, q?: string | null): Prisma.CampaignRecipientWhereInput {
  const and: Prisma.CampaignRecipientWhereInput[] = [{ campaignId }];
  switch (filter) {
    case "active":
      and.push({ included: true, state: { in: OPEN_STATES } });
      break;
    case "finished":
      and.push({ included: true, state: "FINISHED" });
      break;
    case "stopped":
      and.push({ included: true, state: "STOPPED" });
      break;
    case "problems":
      and.push({ outbound: { some: { status: { in: PROBLEM_STATUSES } } } });
      break;
    case "excluded":
      and.push({ OR: [{ included: false }, { state: "EXCLUDED" }] });
      break;
    case "edited":
      and.push({ hasEdits: true });
      break;
    default:
      break;
  }
  for (const word of normalizeText(q ?? "").split(" ").filter(Boolean).slice(0, 8)) {
    and.push({ OR: [{ emailNorm: { contains: word } }, { company: { searchText: { contains: word } } }] });
  }
  return { AND: and };
}

export type RecipientEmailSummary = {
  id: number;
  step: number;
  status: SendStatus;
  dueAt: Date;
  sentAt: Date | null;
  lastError: string | null;
};

export type RecipientListRow = {
  id: number;
  personId: number;
  companyId: number;
  /** "Anna Berg", "General inbox" or the address. */
  name: string;
  email: string;
  isGeneric: boolean;
  personDeleted: boolean;
  companyName: string;
  companyDeleted: boolean;
  state: RecipientState;
  included: boolean;
  currentStep: number;
  nextDueAt: Date | null;
  stopReason: string | null;
  /** While HELD: why (M4-DESIGN §2.8). */
  holdReason: string | null;
  /** While RECHECK: when the second address check is due (M5-DESIGN §2.7). */
  recheckAt: Date | null;
  exclusionReason: string | null;
  hasEdits: boolean;
  emails: RecipientEmailSummary[];
};

export type RecipientListPage = {
  rows: RecipientListRow[];
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
};

/** One page of a campaign's people (company A–Z), with their emails' states. */
export async function listCampaignRecipients(
  campaignId: number,
  opts: { filter?: RecipientFilter; q?: string | null; page?: number | null; pageSize?: number } = {},
): Promise<RecipientListPage> {
  const where = recipientWhere(campaignId, opts.filter ?? "all", opts.q);
  const pageSize = opts.pageSize ?? RECIPIENTS_PAGE_SIZE;
  const total = await db.campaignRecipient.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = clampPage(opts.page, pageCount);
  if (total === 0) return { rows: [], total, page: 1, pageCount: 1, pageSize };
  const rows = await db.campaignRecipient.findMany({
    where,
    orderBy: [{ company: { nameNorm: "asc" } }, { id: "asc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
    select: {
      id: true,
      personId: true,
      companyId: true,
      emailNorm: true,
      state: true,
      included: true,
      currentStep: true,
      nextDueAt: true,
      stopReason: true,
      holdReason: true,
      recheckAt: true,
      exclusionReason: true,
      hasEdits: true,
      person: { select: { name: true, email: true, isGeneric: true, deletedAt: true } },
      company: { select: { name: true, deletedAt: true } },
      outbound: {
        select: { id: true, step: true, status: true, dueAt: true, sentAt: true, lastError: true },
        orderBy: { step: "asc" },
      },
    },
  });
  return {
    rows: rows.map((r) => ({
      id: r.id,
      personId: r.personId,
      companyId: r.companyId,
      name: recipientName(r.person, r.emailNorm),
      email: r.person.email ?? r.emailNorm,
      isGeneric: r.person.isGeneric,
      personDeleted: Boolean(r.person.deletedAt),
      companyName: r.company.name,
      companyDeleted: Boolean(r.company.deletedAt),
      state: r.state,
      included: r.included,
      currentStep: r.currentStep,
      nextDueAt: r.nextDueAt,
      stopReason: r.stopReason,
      holdReason: r.holdReason,
      recheckAt: r.recheckAt,
      exclusionReason: r.exclusionReason,
      hasEdits: r.hasEdits,
      emails: r.outbound,
    })),
    total,
    page,
    pageCount,
    pageSize,
  };
}

// ───────────────────────── one recipient (the side panel) ─────────────────────────

export type RecipientDetailEmail = RecipientEmailSummary & {
  subject: string;
  text: string;
  toEmail: string;
  fromAddress: string;
  mode: SendMode;
  messageId: string;
  attempts: number;
  /** Mailgun's id: set once Mailgun has the email (it is never sent again, so never retried). */
  providerId: string | null;
  /** Mailgun's own words when it refused this email (from the "email.failed" activity), for "Details". */
  failureDetail: string | null;
};

export type RecipientDetailStep = {
  step: number;
  enabled: boolean;
  delayDays: number;
  /** The campaign's text for this step (subject: first email only). */
  subject: string | null;
  body: string;
  /** This person's own version, when someone edited it. */
  edit: { subject: string | null; body: string; editedByName: string | null; editedAt: Date } | null;
};

export type RecipientDetail = {
  id: number;
  campaignId: number;
  state: RecipientState;
  included: boolean;
  currentStep: number;
  nextDueAt: Date | null;
  stopReason: string | null;
  /** While HELD: why (M4-DESIGN §2.8). */
  holdReason: string | null;
  /** While RECHECK: when the second address check is due (M5-DESIGN §2.7). */
  recheckAt: Date | null;
  exclusionReason: string | null;
  hasEdits: boolean;
  person: { id: number; name: string; displayName: string; email: string; isGeneric: boolean; deleted: boolean };
  company: { id: number; name: string; deleted: boolean };
  emails: RecipientDetailEmail[];
  steps: RecipientDetailStep[];
  activity: TimelineActivity[];
};

/** One person in one campaign: their emails (sent and to come), the texts, and their timeline. */
export async function getRecipientDetail(campaignId: number, recipientId: number): Promise<RecipientDetail | null> {
  if (!Number.isInteger(recipientId) || recipientId <= 0) return null;
  const r = await db.campaignRecipient.findFirst({
    where: { id: recipientId, campaignId },
    select: {
      id: true,
      campaignId: true,
      personId: true,
      companyId: true,
      emailNorm: true,
      state: true,
      included: true,
      currentStep: true,
      nextDueAt: true,
      stopReason: true,
      holdReason: true,
      recheckAt: true,
      exclusionReason: true,
      hasEdits: true,
      person: { select: { id: true, name: true, email: true, isGeneric: true, deletedAt: true } },
      company: { select: { id: true, name: true, deletedAt: true } },
      edits: { select: { step: true, subject: true, body: true, editedById: true, editedAt: true } },
      outbound: {
        orderBy: { step: "asc" },
        select: {
          id: true,
          step: true,
          status: true,
          dueAt: true,
          sentAt: true,
          lastError: true,
          subject: true,
          text: true,
          toEmail: true,
          fromAddress: true,
          mode: true,
          messageId: true,
          attempts: true,
          providerId: true,
        },
      },
    },
  });
  if (!r) return null;
  const editorIds = [...new Set(r.edits.map((e) => e.editedById).filter((id): id is number => id !== null))];
  const [steps, editors, activity, failures] = await Promise.all([
    db.campaignStep.findMany({
      where: { campaignId },
      orderBy: { step: "asc" },
      select: { step: true, enabled: true, delayDays: true, subject: true, body: true },
    }),
    editorIds.length
      ? db.user.findMany({ where: { id: { in: editorIds } }, select: { id: true, name: true } })
      : Promise.resolve([] as Array<{ id: number; name: string }>),
    db.activityLog.findMany({
      where: { campaignId, personId: r.personId },
      orderBy: [{ at: "desc" }, { id: "desc" }],
      take: 50,
      select: { id: true, at: true, summary: true, mode: true, actor: { select: { name: true } } },
    }),
    r.outbound.some((e) => e.status === "FAILED")
      ? db.activityLog.findMany({
          where: { campaignId, personId: r.personId, type: "email.failed" },
          orderBy: [{ at: "desc" }, { id: "desc" }],
          take: 20,
          select: { data: true },
        })
      : Promise.resolve([] as Array<{ data: Prisma.JsonValue }>),
  ]);
  const editorName = new Map(editors.map((u) => [u.id, u.name]));
  const edits = new Map(r.edits.map((e) => [e.step, e]));
  // Mailgun's text for each refused email, newest first (the first one per email wins).
  const failureDetail = new Map<number, string>();
  for (const f of failures) {
    const data = f.data && typeof f.data === "object" && !Array.isArray(f.data) ? (f.data as Record<string, unknown>) : {};
    const emailId = typeof data.emailId === "number" ? data.emailId : null;
    const text = typeof data.mailgunMessage === "string" ? data.mailgunMessage.trim() : "";
    if (emailId !== null && text && !failureDetail.has(emailId)) failureDetail.set(emailId, text);
  }
  return {
    id: r.id,
    campaignId: r.campaignId,
    state: r.state,
    included: r.included,
    currentStep: r.currentStep,
    nextDueAt: r.nextDueAt,
    stopReason: r.stopReason,
    holdReason: r.holdReason,
    recheckAt: r.recheckAt,
    exclusionReason: r.exclusionReason,
    hasEdits: r.hasEdits,
    person: {
      id: r.person.id,
      name: r.person.name,
      displayName: recipientName(r.person, r.emailNorm),
      email: r.person.email ?? r.emailNorm,
      isGeneric: r.person.isGeneric,
      deleted: Boolean(r.person.deletedAt),
    },
    company: { id: r.company.id, name: r.company.name, deleted: Boolean(r.company.deletedAt) },
    emails: r.outbound.map((e) => ({ ...e, failureDetail: failureDetail.get(e.id) ?? null })),
    steps: steps.map((s) => {
      const e = edits.get(s.step);
      return {
        step: s.step,
        enabled: s.enabled,
        delayDays: s.delayDays,
        subject: s.subject,
        body: s.body,
        edit: e
          ? { subject: e.subject, body: e.body, editedByName: e.editedById ? (editorName.get(e.editedById) ?? null) : null, editedAt: e.editedAt }
          : null,
      };
    }),
    activity: activity.map((a) => ({ id: a.id, at: a.at, summary: a.summary, actorName: a.actor?.name ?? null, mode: a.mode })),
  };
}

// ───────────────────────── the dry-run outbox ─────────────────────────

export const OUTBOX_PAGE_SIZE = 50;

function outboxWhere(campaignId?: number | null): Prisma.OutboundEmailWhereInput {
  return { mode: "DRY_RUN", status: "SENT", ...(campaignId ? { campaignId } : {}) };
}

export type OutboxRow = {
  id: number;
  campaignId: number;
  campaignName: string;
  step: number;
  toEmail: string;
  companyName: string;
  subject: string;
  /** The full From line, e.g. "Ali from Polygon Paradise <ali@your-sending-domain>". */
  fromAddress: string;
  /** The Reply-To it was "sent" with (shared-From mode), else null or absent (SHARED-FROM-DESIGN §3.7). */
  replyTo?: string | null;
  senderName: string | null;
  sentAt: Date;
};

export type OutboxPage = {
  rows: OutboxRow[];
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
};

const OUTBOX_ROW_SELECT = {
  id: true,
  campaignId: true,
  step: true,
  toEmail: true,
  companyName: true,
  subject: true,
  fromAddress: true,
  replyTo: true,
  sentAt: true,
  campaign: { select: { name: true } },
  sender: { select: { name: true } },
} satisfies Prisma.OutboundEmailSelect;

type OutboxRowRecord = Prisma.OutboundEmailGetPayload<{ select: typeof OUTBOX_ROW_SELECT }>;

function toOutboxRow(e: OutboxRowRecord): OutboxRow {
  return {
    id: e.id,
    campaignId: e.campaignId,
    campaignName: e.campaign.name,
    step: e.step,
    toEmail: e.toEmail,
    companyName: e.companyName,
    subject: e.subject,
    fromAddress: e.fromAddress,
    replyTo: e.replyTo,
    senderName: e.sender?.name ?? null,
    sentAt: e.sentAt ?? new Date(0),
  };
}

/** Every email a dry-run campaign "sent", newest first (optionally one campaign's only). */
export async function listOutbox(opts: { campaignId?: number | null; page?: number | null; pageSize?: number } = {}): Promise<OutboxPage> {
  const where = outboxWhere(opts.campaignId);
  const pageSize = opts.pageSize ?? OUTBOX_PAGE_SIZE;
  const total = await db.outboundEmail.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = clampPage(opts.page, pageCount);
  if (total === 0) return { rows: [], total, page: 1, pageCount: 1, pageSize };
  const rows = await db.outboundEmail.findMany({
    where,
    orderBy: [{ sentAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
    select: OUTBOX_ROW_SELECT,
  });
  return { rows: rows.map(toOutboxRow), total, page, pageCount, pageSize };
}

/** Campaigns that have emails in the outbox, for the filter (A–Z, with how many). */
export async function listOutboxCampaigns(): Promise<Array<{ id: number; name: string; count: number }>> {
  const groups = await db.outboundEmail.groupBy({ by: ["campaignId"], where: outboxWhere(), _count: { _all: true } });
  if (groups.length === 0) return [];
  const campaigns = await db.campaign.findMany({
    where: { id: { in: groups.map((g) => g.campaignId) } },
    select: { id: true, name: true },
  });
  const names = new Map(campaigns.map((c) => [c.id, c.name]));
  return groups
    .map((g) => ({ id: g.campaignId, name: names.get(g.campaignId) ?? `Campaign ${g.campaignId}`, count: g._count._all }))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.id - b.id);
}

export type OutboxEmail = OutboxRow & {
  text: string;
  html: string;
  messageId: string;
  inReplyTo: string | null;
  references: string | null;
  recipientId: number;
  companyId: number | null;
  personId: number | null;
};

/** One email of the outbox (dry run, sent), or null. */
export async function getOutboxEmail(emailId: number): Promise<OutboxEmail | null> {
  if (!Number.isInteger(emailId) || emailId <= 0) return null;
  const e = await db.outboundEmail.findFirst({
    where: { id: emailId, ...outboxWhere() },
    select: {
      ...OUTBOX_ROW_SELECT,
      text: true,
      html: true,
      messageId: true,
      inReplyTo: true,
      references: true,
      recipientId: true,
      companyId: true,
      personId: true,
    },
  });
  if (!e) return null;
  return {
    ...toOutboxRow(e),
    text: e.text,
    html: e.html,
    messageId: e.messageId,
    inReplyTo: e.inReplyTo,
    references: e.references,
    recipientId: e.recipientId,
    companyId: e.companyId,
    personId: e.personId,
  };
}

// ───────────────────────── the Contacts "Sequence" column ─────────────────────────

const SEQUENCE_STATES: RecipientState[] = ["SCHEDULED", "WAITING", "HELD", "RECHECK", "FINISHED", "STOPPED"];

/**
 * The sequence rows of the companies on one Contacts page (one query): per company, every
 * recipient still in progress plus its most recent finished or stopped one, from launched
 * campaigns only (drafts say nothing about emailing), with the hold reason and whether the
 * campaign's sends count as "emailed" (countsAsEmailed by the campaign's own launch flag, M6-DESIGN
 * §2.2, for the " (test list)" suffix of M4-DESIGN §2.12). Pick and word them with
 * companySequenceLabel() from @/components/campaigns/format.
 */
export async function companySequences(
  companyIds: readonly number[],
  opts: { practiceCopy?: boolean } = {},
): Promise<Map<number, CompanySequence[]>> {
  const out = new Map<number, CompanySequence[]>();
  const ids = [...new Set(companyIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) return out;
  const [rows, practiceCopy] = await Promise.all([
    db.campaignRecipient.findMany({
      where: {
        companyId: { in: ids },
        included: true,
        state: { in: SEQUENCE_STATES },
        campaign: { status: { not: "DRAFT" } },
      },
      orderBy: { id: "desc" },
      select: {
        id: true,
        companyId: true,
        campaignId: true,
        personId: true,
        state: true,
        currentStep: true,
        nextDueAt: true,
        stopReason: true,
        holdReason: true,
        recheckAt: true,
        updatedAt: true,
        campaign: { select: { name: true, status: true, mode: true, launchedGoLive: true } },
      },
    }),
    opts.practiceCopy !== undefined
      ? Promise.resolve(opts.practiceCopy)
      : getSettings(["practice.copy"] as const).then((s) => s["practice.copy"] === true),
  ]);
  const closedSeen = new Set<number>();
  for (const r of rows) {
    const active = OPEN_STATES.includes(r.state);
    if (!active) {
      if (closedSeen.has(r.companyId)) continue;
      closedSeen.add(r.companyId);
    }
    const list = out.get(r.companyId) ?? [];
    list.push({
      id: r.id,
      companyId: r.companyId,
      campaignId: r.campaignId,
      campaignName: r.campaign.name,
      campaignStatus: r.campaign.status,
      campaignMode: r.campaign.mode,
      countsAsEmailed: countsAsEmailed(r.campaign.mode, { practiceCopy, launchedGoLive: r.campaign.launchedGoLive }),
      personId: r.personId,
      state: r.state,
      currentStep: r.currentStep,
      nextDueAt: r.nextDueAt,
      stopReason: r.stopReason,
      holdReason: r.holdReason,
      recheckAt: r.recheckAt,
      updatedAt: r.updatedAt,
    });
    out.set(r.companyId, list);
  }
  return out;
}
