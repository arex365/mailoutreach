import { createHash } from "node:crypto";
import type { CampaignStatus, SendMode } from "@/generated/prisma/client";
import { db, dbTx, dbWrite } from "@/server/db";
import { logActivity } from "@/server/activity";
import { SETTING_DEFAULTS, getSetting } from "@/server/settings";
import { GENERAL_INBOX_NAME } from "@/core/email-address";
import { stepTitle } from "@/core/rules/wording";
import { lintTemplate } from "@/core/templates/render";
import { MAX_BODY_CHARS, MAX_FOLLOW_UPS, MAX_SUBJECT_CHARS, validateSequence, type SequenceStep } from "@/core/templates/steps";
import type { RenderedEmail, TemplateWarning } from "@/core/templates/types";
import { normalizeText, plural } from "@/core/text";
import { RenderError, renderCampaignEmails, renderDraftPreview } from "@/server/services/render";
import { senderSnapshot } from "@/server/services/sending/addresses";
import { loadTeamFrom, type TeamFromState } from "@/server/services/mailgun/team-from";
import { TEMPLATE_GONE, getMasterTemplate, getTemplate, saveSteps, templateVariables, type TemplateStepData } from "@/server/services/templates";
import {
  AUDIENCE_MAX_COMPANIES,
  NOT_TICKED,
  addCompaniesToAudience,
  draftSendingMode,
  loadAudienceCompany,
  loadAudienceSnapshot,
  loadDraftForChange,
  readAudienceJson,
  syncExclusionReasons,
  type Actor,
  type AddCompaniesResult,
  type AudienceSnapshot,
} from "./audience";
import type { MailgunContextResult } from "@/server/mailgun/context";
import { getTodayCap } from "@/server/services/sending/usage";
import { parseWindow, windowSentence } from "@/core/sending/window";
import { FIRST_SUBJECT_REPLY_ERROR, firstSubjectProblem } from "@/core/templates/subject-rules";
import { discardUnsentEdit, editUnsentEmail } from "./control";
import { CAMPAIGN_GONE, CampaignError } from "./errors";
import { RE_SUBJECT_LAUNCH_TEXT, firstSubjectErrors, launchCampaign, launchModeProblems, type LaunchResult } from "./launch";

/**
 * Campaign drafts and the wizard's other steps (PLAN.md A6 Campaigns, B6.4; SPEC §7):
 * creating a draft (blank, from a list, or from companies ticked on Contacts), renaming and
 * deleting it, the sender, the message and its follow-ups (copied from a template; "Save back to
 * template"), the live preview, Review (every recipient's emails exactly as rendered), the schedule
 * and the launch hand-over to launchCampaign (the engine).
 *
 * Every change refuses a campaign that is no longer a draft, runs in short transactions, and throws
 * CampaignError (plain words) for anything the person can fix. Drafts save on every change, so only
 * meaningful changes are logged (created, renamed, deleted, audience, sender, template).
 * The audience itself lives in ./audience.
 */

export const DRAFT_NAME_MAX = 120;
/** Autosave limits: generous, so nothing typed is lost; the Message step's checks use the real ones. */
export const DRAFT_TEXT_LIMITS = { subject: MAX_SUBJECT_CHARS * 5, body: MAX_BODY_CHARS * 2 } as const;
export const REVIEW_PAGE_SIZE = 50;

export type { Actor } from "./audience";

// ───────────────────────── reading ─────────────────────────

export type DraftInfo = {
  id: number;
  name: string;
  status: CampaignStatus;
  /** Furthest wizard step reached, 1 (Audience) … 6 (Schedule). */
  wizardStep: number;
  senderId: number | null;
  senderName: string | null;
  senderActive: boolean;
  createdById: number;
  createdByName: string;
  sourceTemplateId: number | null;
  startAt: Date | null;
  daysAsMinutes: boolean;
  ignoreWindow: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export async function getDraftInfo(campaignId: number): Promise<DraftInfo | null> {
  if (!Number.isInteger(campaignId) || campaignId <= 0) return null;
  const c = await db.campaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      name: true,
      status: true,
      wizardStep: true,
      senderId: true,
      sender: { select: { name: true, active: true } },
      createdById: true,
      createdBy: { select: { name: true } },
      sourceTemplateId: true,
      startAt: true,
      daysAsMinutes: true,
      ignoreWindow: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    wizardStep: c.wizardStep,
    senderId: c.senderId,
    senderName: c.sender?.name ?? null,
    senderActive: c.sender?.active ?? false,
    createdById: c.createdById,
    createdByName: c.createdBy.name,
    sourceTemplateId: c.sourceTemplateId,
    startAt: c.startAt,
    daysAsMinutes: c.daysAsMinutes,
    ignoreWindow: c.ignoreWindow,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

// ───────────────────────── creating ─────────────────────────

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Campaign · 23 Sep" (the date in the creator's own time zone). */
export function defaultDraftName(now: Date, timeZone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "numeric" }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "numeric" }).formatToParts(now);
  }
  const day = parts.find((p) => p.type === "day")?.value ?? String(now.getUTCDate());
  const month = Number(parts.find((p) => p.type === "month")?.value ?? now.getUTCMonth() + 1);
  return `Campaign · ${day} ${SHORT_MONTHS[month - 1] ?? ""}`.trim();
}

export function cleanDraftName(name: string | null | undefined): string {
  return (name ?? "").replace(/\s+/g, " ").trim();
}

export function draftNameProblem(name: string): string | null {
  const clean = cleanDraftName(name);
  if (!clean) return "Give the campaign a name.";
  if (clean.length > DRAFT_NAME_MAX) return `Keep the name under ${DRAFT_NAME_MAX} characters.`;
  return null;
}

function stepRows(steps: readonly TemplateStepData[]) {
  return steps.map((s) => ({
    step: s.step,
    enabled: s.step === 0 ? true : s.enabled,
    subject: s.step === 0 ? (s.subject ?? "") : null,
    body: s.body,
    delayDays: s.step === 0 ? 0 : s.delayDays,
  }));
}

function originFor(input: { listId?: number | null; companyIds?: readonly number[] | null }): string {
  if (input.listId) return `list:${input.listId}`;
  if (input.companyIds && input.companyIds.length > 0) {
    const ids = [...new Set(input.companyIds)].sort((a, b) => a - b);
    return `selection:${ids.length}:${createHash("sha1").update(ids.join(",")).digest("hex").slice(0, 16)}`;
  }
  return "blank";
}

export type CreateDraftInput = {
  /** Start from every company in this list (named after it). */
  listId?: number | null;
  /** Start from these companies (e.g. ticked on Contacts), in this order. */
  companyIds?: readonly number[] | null;
  name?: string | null;
  /** The creator's time zone, for the default name. */
  timeZone?: string;
  /**
   * When set, a draft this person started the same way within this many ms is reused instead of
   * making a second one (a double click, or a page opened twice).
   */
  reuseWithinMs?: number;
  now?: Date;
};

export type CreateDraftResult = {
  id: number;
  name: string;
  /** An identical draft started moments ago was reused. */
  reused: boolean;
  /** The list asked for doesn't exist (any more): the draft starts empty. */
  listMissing: boolean;
  added: AddCompaniesResult | null;
};

/**
 * Creates a draft: sender = the creator, the master template's steps copied in (every step, with
 * its on/off switch), and the audience from a list or from ticked companies (or empty).
 */
export async function createDraft(actor: Actor, input: CreateDraftInput = {}): Promise<CreateDraftResult> {
  const now = input.now ?? new Date();
  const list = input.listId
    ? await db.list.findUnique({ where: { id: input.listId }, select: { id: true, name: true } })
    : null;
  const listMissing = Boolean(input.listId) && !list;
  const companyIds = !list && input.companyIds ? input.companyIds : null;
  const origin = originFor({ listId: list?.id ?? null, companyIds });

  if (input.reuseWithinMs && input.reuseWithinMs > 0) {
    const recent = await db.campaign.findMany({
      where: { createdById: actor.id, status: "DRAFT", createdAt: { gte: new Date(now.getTime() - input.reuseWithinMs) } },
      select: { id: true, name: true, audience: true },
      orderBy: { id: "desc" },
      take: 5,
    });
    const twin = recent.find((c) => readAudienceJson(c.audience).origin === origin);
    if (twin) return { id: twin.id, name: twin.name, reused: true, listMissing, added: null };
  }

  const name = (cleanDraftName(input.name) || list?.name || defaultDraftName(now, input.timeZone ?? "UTC")).slice(0, DRAFT_NAME_MAX);
  const master = await getMasterTemplate();
  const campaign = await dbTx(async (tx) => {
    const created = await tx.campaign.create({
      data: {
        name,
        status: "DRAFT",
        wizardStep: 1,
        senderId: actor.id,
        createdById: actor.id,
        sourceTemplateId: master.id,
        audience: { v: 1, companyIds: [], sources: [], origin },
        createdAt: now,
      },
      select: { id: true, name: true },
    });
    await tx.campaignStep.createMany({ data: stepRows(master.steps).map((s) => ({ ...s, campaignId: created.id })) });
    await logActivity(
      {
        actorId: actor.id,
        type: "campaign.created",
        summary: `${actor.name} started the campaign ${created.name}`,
        campaignId: created.id,
        data: { from: list ? "list" : companyIds ? "selection" : "blank", templateId: master.id },
      },
      tx,
    );
    return created;
  });

  let ids: number[] | null = null;
  let source: { kind: "list" | "selection"; label: string } | null = null;
  if (list) {
    const rows = await db.companyList.findMany({
      where: { listId: list.id, company: { deletedAt: null } },
      select: { companyId: true },
      orderBy: [{ company: { nameNorm: "asc" } }, { companyId: "asc" }],
      take: AUDIENCE_MAX_COMPANIES + 1,
    });
    ids = rows.map((r) => r.companyId);
    source = { kind: "list", label: `List: ${list.name}` };
  } else if (companyIds && companyIds.length > 0) {
    ids = [...companyIds];
    source = { kind: "selection", label: `${plural(new Set(companyIds).size, "company", "companies")} ticked on Contacts` };
  }
  const added = ids && source && ids.length > 0 ? await addCompaniesToAudience(actor, campaign.id, ids, source, { now, log: false }) : null;
  return { id: campaign.id, name: campaign.name, reused: false, listMissing, added };
}

// ───────────────────────── name, delete, progress ─────────────────────────

export async function renameDraft(actor: Actor, campaignId: number, name: string): Promise<{ name: string; changed: boolean }> {
  const problem = draftNameProblem(name);
  if (problem) throw new CampaignError(problem, "bad-name");
  const clean = cleanDraftName(name);
  return dbTx(async (tx) => {
    const d = await loadDraftForChange(tx, campaignId);
    if (d.name === clean) return { name: clean, changed: false };
    await tx.campaign.update({ where: { id: campaignId }, data: { name: clean } });
    await logActivity(
      {
        actorId: actor.id,
        type: "campaign.renamed",
        summary: `${actor.name} renamed the campaign ${d.name} to ${clean}`,
        campaignId,
        data: { from: d.name, to: clean },
      },
      tx,
    );
    return { name: clean, changed: true };
  });
}

/** Deletes a draft for good (it never sent anything). Launched campaigns are cancelled instead. */
export async function deleteDraft(actor: Actor, campaignId: number): Promise<{ name: string }> {
  const draft = await loadDraftForChange(db, campaignId);
  // Big drafts: recipients go in chunks first (each chunk checks it's still a draft).
  for (;;) {
    const batch = await db.campaignRecipient.findMany({ where: { campaignId }, select: { id: true }, take: 500 });
    if (batch.length === 0) break;
    await dbTx(async (tx) => {
      await loadDraftForChange(tx, campaignId);
      const ids = batch.map((r) => r.id);
      const sentish = await tx.outboundEmail.count({
        where: { recipientId: { in: ids }, status: { in: ["SENDING", "SENT", "UNKNOWN", "UNCONFIRMED"] } },
      });
      if (sentish > 0) throw new CampaignError("Some of this campaign's emails may already have gone out, so it can't be deleted.", "sent");
      await tx.outboundEmail.deleteMany({ where: { recipientId: { in: ids } } });
      await tx.campaignRecipient.deleteMany({ where: { id: { in: ids } } });
    });
  }
  await dbTx(async (tx) => {
    await loadDraftForChange(tx, campaignId);
    await tx.outboundEmail.deleteMany({ where: { campaignId } });
    await tx.campaign.delete({ where: { id: campaignId } }); // steps and reservations go with it
    await logActivity(
      { actorId: actor.id, type: "campaign.deleted", summary: `${actor.name} deleted the draft campaign ${draft.name}`, campaignId, data: { name: draft.name } },
      tx,
    );
  });
  return { name: draft.name };
}

/** Remembers the furthest wizard step reached (never goes backwards). */
export async function setWizardStep(campaignId: number, step: number): Promise<void> {
  const n = Math.min(Math.max(Math.floor(step), 1), 6);
  await dbWrite((c) => c.campaign.updateMany({ where: { id: campaignId, status: "DRAFT", wizardStep: { lt: n } }, data: { wizardStep: n } }));
}

// ───────────────────────── sender ─────────────────────────

export type SenderChoice = {
  id: number;
  name: string;
  email: string;
  /** The sender display name ("Ali from Polygon Paradise"; their name when they haven't set one). */
  fromName: string;
  /**
   * The From line, e.g. "Ali from Polygon Paradise <ali@send.example.com>" (a dry-run placeholder without an address);
   * in shared-From mode the shared address with their display name, "Ali from Polygon Paradise <contact@example.com>".
   */
  fromLine: string;
  /** True while there is no sending address (a dry run then uses the placeholder "…@your-sending-domain"). */
  placeholderAddress: boolean;
  /** The sender's own address on the connected domain (the Reply-To in shared-From mode), or null. */
  address: string | null;
  /** The shared From address (SHARED-FROM-DESIGN §3.7), or null in per-person mode. */
  teamFrom: string | null;
  /**
   * MAIN-DOMAIN-DESIGN §2.3, §3.7: own-mailbox mode's own From (every email comes from it with this person's display
   * name), or null (app mode, or own-mailbox mode while no From fits). In own-mailbox mode `address` and `routeOk` are
   * always null (nobody needs an address of their own or a reply route). Optional so older callers' literals still fit;
   * `listSenderChoices` always sets it.
   */
  ownFrom?: string | null;
  /** Its reply route works (null when there is no address). */
  routeOk: boolean | null;
  /** User.dailyCap: their own daily limit, or null for "No limit of their own". */
  dailyCap: number | null;
  signature: string;
};

/**
 * Active teammates who can send, by name (anyone can pick any of them, A5.15). Their From lines use the shared From
 * address when one is saved and fits (`opts.teamFrom`, else read with loadTeamFrom; SHARED-FROM-DESIGN §3.7).
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §2.3; `opts.team`, else read with loadTeamFrom when `teamFrom` isn't given):
 * every active user, From line = their display name with the own From (the placeholder while none fits), no address,
 * no route, `placeholderAddress` = no fitting own From, `ownFrom` set (null in app mode). `opts.teamFrom` alone keeps
 * today's app-mode reading.
 */
export async function listSenderChoices(
  opts: { teamFrom?: string | null; team?: Pick<TeamFromState, "address" | "replies" | "ownFrom"> } = {},
): Promise<SenderChoice[]> {
  const team = opts.team ?? (opts.teamFrom !== undefined ? null : await loadTeamFrom());
  const ownMailbox = team?.replies === "own-mailbox";
  const ownFrom = ownMailbox ? (team?.ownFrom ?? null) : null;
  const teamFrom = ownMailbox ? null : opts.team ? opts.team.address : opts.teamFrom !== undefined ? opts.teamFrom : (team?.address ?? null);
  const users = await db.user.findMany({
    where: { active: true },
    select: {
      id: true,
      name: true,
      email: true,
      senderDisplayName: true,
      signature: true,
      dailyCap: true,
      senderAddresses: {
        where: { retiredAt: null, domain: { active: true } },
        orderBy: { id: "desc" },
        take: 1,
        select: { address: true, domainId: true, routeStatus: true, domain: { select: { name: true } } },
      },
    },
  });
  return users
    .map((u) => {
      if (ownMailbox) {
        // The dry-run snapshot's From line: the display name with the own From, or the placeholder while none fits. Only
        // the From line is used here, so no domain row is needed.
        const snap = senderSnapshot(u, "DRY_RUN", null, ownFrom ? { ownMailbox: { from: ownFrom, domainId: 0, domainName: "" } } : {});
        return {
          id: u.id,
          name: u.name,
          email: u.email,
          fromName: snap.fromName,
          fromLine: snap.fromHeader,
          placeholderAddress: ownFrom === null,
          address: null,
          teamFrom: null,
          ownFrom,
          routeOk: null,
          dailyCap: u.dailyCap,
          signature: u.signature,
        };
      }
      const address = u.senderAddresses[0];
      const snap = senderSnapshot(
        u,
        "DRY_RUN",
        address ? { address: address.address, domainId: address.domainId, domainName: address.domain.name } : null,
        { teamFrom },
      );
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        fromName: snap.fromName,
        fromLine: snap.fromHeader,
        placeholderAddress: !address,
        address: address?.address ?? null,
        teamFrom: teamFrom ?? null,
        ownFrom: null,
        routeOk: address ? address.routeStatus === "ok" : null,
        dailyCap: u.dailyCap,
        signature: u.signature,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.id - b.id);
}

/**
 * Picks the sender. Anyone can pick any active teammate; when the one who launches isn't the
 * sender, the engine tells the sender at launch (notification "campaign.sender").
 */
export async function setDraftSender(actor: Actor, campaignId: number, senderId: number): Promise<{ senderName: string; changed: boolean }> {
  const sender = await db.user.findUnique({ where: { id: senderId }, select: { id: true, name: true, active: true } });
  if (!sender || !sender.active) {
    throw new CampaignError("That teammate's account is switched off or gone. Pick someone else.", "sender-off");
  }
  return dbTx(async (tx) => {
    const d = await loadDraftForChange(tx, campaignId);
    if (d.senderId === senderId) return { senderName: sender.name, changed: false };
    await tx.campaign.update({ where: { id: campaignId }, data: { senderId } });
    await logActivity(
      {
        actorId: actor.id,
        type: "campaign.sender",
        summary:
          senderId === actor.id ? `${actor.name} will send ${d.name}` : `${actor.name} chose ${sender.name} to send ${d.name}`,
        campaignId,
        data: { senderId },
      },
      tx,
    );
    return { senderName: sender.name, changed: true };
  });
}

// ───────────────────────── message ─────────────────────────

export type DraftStep = { step: number; enabled: boolean; subject: string | null; body: string; delayDays: number };

export async function getDraftSteps(campaignId: number): Promise<DraftStep[]> {
  const steps = await db.campaignStep.findMany({
    where: { campaignId },
    orderBy: { step: "asc" },
    select: { step: true, enabled: true, subject: true, body: true, delayDays: true },
  });
  return steps.map((s) => ({ ...s, subject: s.step === 0 ? (s.subject ?? "") : null }));
}

function tidyStepsForDraft(steps: readonly SequenceStep[]): DraftStep[] {
  const sorted = [...steps].sort((a, b) => a.step - b.step);
  if (sorted.length === 0 || sorted.length > MAX_FOLLOW_UPS + 1 || sorted.some((s, i) => s.step !== i)) {
    throw new CampaignError("The emails are out of order. Reload the page and try again.", "bad-steps");
  }
  return sorted.map((s) => {
    const subject = s.step === 0 ? (s.subject ?? "").replace(/[\r\n]+/g, " ") : null;
    const body = (s.body ?? "").replace(/\r\n?/g, "\n");
    if ((subject?.length ?? 0) > DRAFT_TEXT_LIMITS.subject) {
      throw new CampaignError("The subject is too long to save. Shorten it and try again.", "too-long");
    }
    if (body.length > DRAFT_TEXT_LIMITS.body) {
      throw new CampaignError(`${stepTitle(s.step)} is too long to save. Shorten it and try again.`, "too-long");
    }
    const days = Number(s.delayDays);
    return {
      step: s.step,
      enabled: s.step === 0 ? true : Boolean(s.enabled),
      subject,
      body,
      delayDays: s.step === 0 ? 0 : Number.isInteger(days) && days >= 0 && days <= 999 ? days : 0,
    };
  });
}

/**
 * The Message step's autosave: stores the steps as typed (the real checks run on Continue and at
 * launch). `renumber` says how follow-ups moved when some were removed ({ oldStep: newStep | null }),
 * so emails already edited for single people in Review move with their follow-up, or go when their
 * follow-up was removed.
 *
 * A person whose own version of an email still has the campaign's old body (for example only
 * their subject was changed in Review) follows the new body, so a fix typed here reaches them too.
 * Bodies they really rewrote are left alone.
 */
export async function saveDraftSteps(
  actor: Actor,
  campaignId: number,
  steps: readonly SequenceStep[],
  renumber: ReadonlyMap<number, number | null> = new Map(),
): Promise<{ steps: DraftStep[]; movedEdits: number; removedEdits: number; followedEdits: number }> {
  const tidy = tidyStepsForDraft(steps);
  return dbTx(async (tx) => {
    await loadDraftForChange(tx, campaignId);
    const oldBodies = new Map(
      (await tx.campaignStep.findMany({ where: { campaignId }, select: { step: true, body: true } })).map((s) => [s.step, s.body]),
    );
    await tx.campaignStep.deleteMany({ where: { campaignId, step: { gte: tidy.length } } });
    for (const s of tidy) {
      await tx.campaignStep.upsert({
        where: { campaignId_step: { campaignId, step: s.step } },
        create: { campaignId, ...s },
        update: { enabled: s.enabled, subject: s.subject, body: s.body, delayDays: s.delayDays },
      });
    }
    let movedEdits = 0;
    let removedEdits = 0;
    if (renumber.size > 0) {
      const edits = await tx.recipientEdit.findMany({
        where: { recipient: { campaignId }, step: { in: [...renumber.keys()] } },
        select: { id: true, step: true },
      });
      const removeIds = edits.filter((e) => renumber.get(e.step) === null).map((e) => e.id);
      if (removeIds.length > 0) removedEdits += (await tx.recipientEdit.deleteMany({ where: { id: { in: removeIds } } })).count;
      const moving = edits.filter((e) => typeof renumber.get(e.step) === "number");
      // Two passes, so an edit never lands on a step another one is just leaving.
      for (const e of moving) await tx.recipientEdit.update({ where: { id: e.id }, data: { step: 100 + (renumber.get(e.step) as number) } });
      for (const e of moving) await tx.recipientEdit.update({ where: { id: e.id }, data: { step: renumber.get(e.step) as number } });
      movedEdits = moving.length;
    }
    // Edits for steps that no longer exist.
    removedEdits += (await tx.recipientEdit.deleteMany({ where: { recipient: { campaignId }, step: { gte: tidy.length } } })).count;
    if (removedEdits > 0) {
      await tx.campaignRecipient.updateMany({ where: { campaignId, hasEdits: true, edits: { none: {} } }, data: { hasEdits: false } });
    }

    // Per-person versions that kept the campaign's old body follow the new one.
    let followedEdits = 0;
    for (const s of tidy) {
      const from = originalStep(s.step, renumber);
      const oldBody = from === null ? undefined : oldBodies.get(from);
      if (oldBody === undefined || sameBody(oldBody, s.body)) continue;
      const edits = await tx.recipientEdit.findMany({ where: { recipient: { campaignId }, step: s.step }, select: { id: true, body: true } });
      const following = edits.filter((e) => sameBody(e.body, oldBody)).map((e) => e.id);
      if (following.length === 0) continue;
      followedEdits += (await tx.recipientEdit.updateMany({ where: { id: { in: following } }, data: { body: s.body } })).count;
    }
    return { steps: tidy, movedEdits, removedEdits, followedEdits };
  });
}

/**
 * The step number a step had before this save: the follow-up that moved onto it, else itself
 * (null when its old follow-up moved away or was removed and nothing took its place).
 */
function originalStep(step: number, renumber: ReadonlyMap<number, number | null>): number | null {
  for (const [from, to] of renumber) if (to === step) return from;
  return renumber.has(step) ? null : step;
}

/**
 * The Message step's check before Continue and at launch: the templates' rules, plus the first-subject rule (M4-DESIGN
 * §2.13: a first subject may not start with "Re:" or "Fwd:"; the error sits on the subject field, `step0.subject`).
 * Autosave never refuses (nothing typed is lost); this check does.
 */
export async function checkDraftMessage(campaignId: number): Promise<ReturnType<typeof validateSequence>> {
  const steps = await getDraftSteps(campaignId);
  const checked = validateSequence(steps);
  const first = steps.find((s) => s.step === 0);
  const problem = firstSubjectProblem(first?.subject ?? "");
  // A structural problem (steps out of order) has no field errors and its own words: it comes first.
  if (problem?.level !== "error" || (!checked.ok && Object.keys(checked.fieldErrors).length === 0)) return checked;
  const fieldErrors = checked.ok ? {} : { ...checked.fieldErrors };
  fieldErrors["step0.subject"] = [...(fieldErrors["step0.subject"] ?? []), problem.text];
  const onlyFirst = Object.keys(fieldErrors).every((k) => k.startsWith("step0."));
  return {
    ok: false,
    error: `Some details need fixing${onlyFirst ? " in the first email" : ""}. Check the highlighted fields.`,
    fieldErrors,
  };
}

/**
 * Replaces the draft's emails with a template's steps (every step, with its on/off switch) and
 * remembers the template for "Save back to template". Emails edited for single people are reset.
 */
export async function applyTemplateToDraft(
  actor: Actor,
  campaignId: number,
  templateId: number,
): Promise<{ steps: DraftStep[]; templateName: string; clearedEdits: number }> {
  const template = await getTemplate(templateId);
  if (!template) throw new CampaignError(TEMPLATE_GONE, "template-gone");
  const rows = stepRows(template.steps);
  const clearedEdits = await dbTx(async (tx) => {
    const d = await loadDraftForChange(tx, campaignId);
    await tx.campaignStep.deleteMany({ where: { campaignId } });
    await tx.campaignStep.createMany({ data: rows.map((s) => ({ ...s, campaignId })) });
    await tx.campaign.update({ where: { id: campaignId }, data: { sourceTemplateId: template.id } });
    const cleared = await tx.recipientEdit.deleteMany({ where: { recipient: { campaignId } } });
    await tx.campaignRecipient.updateMany({ where: { campaignId, hasEdits: true }, data: { hasEdits: false } });
    await logActivity(
      {
        actorId: actor.id,
        type: "campaign.template",
        summary: `${actor.name} used the template "${template.name}" for ${d.name}`,
        campaignId,
        data: { templateId: template.id, clearedEdits: cleared.count },
      },
      tx,
    );
    return cleared.count;
  });
  return { steps: await getDraftSteps(campaignId), templateName: template.name, clearedEdits };
}

export type SaveBackResult =
  | { ok: true; templateId: number; templateName: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

/** "Save back to template": the draft's steps replace the source template's steps (checked by the templates service). */
export async function saveDraftStepsToTemplate(actor: Actor, campaignId: number): Promise<SaveBackResult> {
  await loadDraftForChange(db, campaignId);
  const c = await db.campaign.findUnique({ where: { id: campaignId }, select: { sourceTemplateId: true } });
  if (!c?.sourceTemplateId) {
    return { ok: false, error: "This campaign didn't start from a template. Choose a template above first." };
  }
  const steps = await getDraftSteps(campaignId);
  const res = await saveSteps(actor, c.sourceTemplateId, steps);
  if (!res.ok) {
    if (res.error === TEMPLATE_GONE) {
      return { ok: false, error: "The template this campaign started from was deleted, so there's nothing to save to." };
    }
    return { ok: false, error: res.error, fieldErrors: res.fieldErrors };
  }
  return { ok: true, templateId: res.template.id, templateName: res.template.name };
}

/** The Message step's preview of one email for one person. */
export type DraftPreview = RenderedEmail & {
  /**
   * "email": this person has their own version of this email (edited in Review), so the campaign
   * text previewed here doesn't reach them. "subject": only their first email's subject is their
   * own; a follow-up's "Re:" line repeats it (and the preview uses it). null: they get the campaign's text.
   */
  ownVersion: "email" | "subject" | null;
};

/**
 * The Message step's preview: unsaved text for one person, as the campaign's sender. The body is
 * always the campaign's (unsaved) text, since that's what is being edited; `ownVersion` says when
 * this person won't get it because of their own edit in Review.
 */
export async function previewDraftEmail(
  campaignId: number,
  input: { personId: number; step: number; subject: string | null; body: string },
): Promise<DraftPreview> {
  const c = await db.campaign.findUnique({ where: { id: campaignId }, select: { senderId: true, createdById: true } });
  if (!c) throw new CampaignError(CAMPAIGN_GONE, "not-found");
  const recipient = await db.campaignRecipient.findUnique({
    where: { campaignId_personId: { campaignId, personId: input.personId } },
    select: { edits: { where: { step: { in: [0, input.step] } }, select: { step: true, subject: true } } },
  });
  const ownEdit = recipient?.edits.find((e) => e.step === input.step) ?? null;
  const firstEdit = recipient?.edits.find((e) => e.step === 0) ?? null;
  // A follow-up's "Re:" repeats the first subject this person gets: their own when they have one.
  const ownFirstSubject = input.step > 0 && firstEdit?.subject != null ? firstEdit.subject : null;
  const email = await renderDraftPreview({
    subject: ownFirstSubject ?? input.subject,
    body: input.body,
    step: input.step,
    personId: input.personId,
    senderId: c.senderId ?? c.createdById,
  });
  return { ...email, ownVersion: ownEdit ? "email" : ownFirstSubject !== null ? "subject" : null };
}

// ───────────────────────── recipients (preview picker) ─────────────────────────

export type RecipientOption = {
  personId: number;
  recipientId: number;
  name: string;
  email: string;
  companyName: string;
  /** Ticked (may still be blocked; the audience says). */
  ticked: boolean;
};

type OptionRow = {
  id: number;
  personId: number;
  included: boolean;
  emailNorm: string;
  person: { name: string; email: string | null; isGeneric: boolean };
  company: { name: string };
};

function toOption(r: OptionRow): RecipientOption {
  return {
    personId: r.personId,
    recipientId: r.id,
    name: r.person.isGeneric ? GENERAL_INBOX_NAME : r.person.name.trim() || r.person.email || r.emailNorm,
    email: r.person.email ?? r.emailNorm,
    companyName: r.company.name,
    ticked: r.included,
  };
}

const OPTION_SELECT = {
  id: true,
  personId: true,
  included: true,
  emailNorm: true,
  person: { select: { name: true, email: true, isGeneric: true } },
  company: { select: { name: true } },
} as const;

/** The campaign's people for the preview picker: ticked people first; searches company, name and address. */
export async function searchDraftRecipients(campaignId: number, q: string, limit = 12): Promise<RecipientOption[]> {
  const words = normalizeText(q).split(" ").filter(Boolean).slice(0, 6);
  const rows: OptionRow[] = await db.campaignRecipient.findMany({
    where: {
      campaignId,
      person: { deletedAt: null },
      ...(words.length ? { company: { AND: words.map((w) => ({ searchText: { contains: w } })) } } : {}),
    },
    orderBy: [{ included: "desc" }, { id: "asc" }],
    take: words.length ? 200 : limit,
    select: OPTION_SELECT,
  });
  if (!words.length) return rows.map(toOption);
  const own = (r: OptionRow) => {
    const text = normalizeText(`${r.person.name} ${r.emailNorm}`);
    return words.every((w) => text.includes(w));
  };
  return [...rows.filter(own), ...rows.filter((r) => !own(r))].slice(0, limit).map(toOption);
}

/** Who the preview shows first: the first ticked person, else anyone in the campaign. */
export async function defaultDraftRecipient(campaignId: number): Promise<RecipientOption | null> {
  const row =
    (await db.campaignRecipient.findFirst({
      where: { campaignId, included: true, person: { deletedAt: null } },
      orderBy: { id: "asc" },
      select: OPTION_SELECT,
    })) ??
    (await db.campaignRecipient.findFirst({ where: { campaignId, person: { deletedAt: null } }, orderBy: { id: "asc" }, select: OPTION_SELECT }));
  return row ? toOption(row) : null;
}

// ───────────────────────── review ─────────────────────────

export type ReviewFilter = "all" | "missing" | "text" | "edited" | "excluded";
export const REVIEW_FILTERS: readonly ReviewFilter[] = ["all", "missing", "text", "edited", "excluded"];

export type ReviewItem = {
  personId: number;
  recipientId: number | null;
  companyId: number;
  companyName: string;
  name: string;
  email: string | null;
  willGet: boolean;
  edited: boolean;
  /** Emails (steps) with missing details for this person. */
  missing: number;
  /**
   * This person's own emails (edited in Review) whose text has problems the campaign's text
   * doesn't have: a variable we don't know, or braces that don't match.
   */
  textProblems: number;
  /** Why this person won't get the email ("Unsubscribed", "Not ticked"…). */
  reason: string | null;
  /** Can be put in (they can be emailed; they're just not ticked). */
  canInclude: boolean;
};

export type ReviewPage = {
  filter: ReviewFilter;
  q: string;
  page: number;
  pageCount: number;
  /** Items in this filter matching the search. */
  total: number;
  items: ReviewItem[];
  counts: Record<ReviewFilter, number>;
  /** The switched-on steps (0 = first email). */
  steps: number[];
  /** Emails with missing details, across everyone who'll get the email. */
  missingEmails: number;
  /** Problems in the campaign's own text, per switched-on step (the same for everyone who gets it). */
  textProblems: StepTextProblem[];
  /** Emails edited for single people whose own text has problems. */
  editedTextProblems: number;
  /** When emails couldn't be prepared at all (e.g. the sender is gone). */
  renderError: string | null;
  totals: AudienceSnapshot["totals"];
};

/**
 * What's wrong with one step's text, for everyone who gets it (PLAN.md B6.3: shown and counted,
 * never blocking). Missing details are counted separately, per person.
 */
export type StepTextProblem = {
  step: number;
  /** Variable names we don't know, e.g. "frist_name" (first use first). */
  unknown: string[];
  /** Braces that don't match: an unclosed {{ or {, a stray }, an empty choice… */
  syntax: boolean;
};

type TextProblemCounts = {
  steps: StepTextProblem[];
  /** Per recipient: emails edited for them whose own text has problems. */
  editedByRecipient: Map<number, number>;
  editedTotal: number;
};

/** Unknown variables and broken braces in a subject (first email only) and a body. */
function textWarnings(step: number, subject: string | null, body: string, known: readonly string[]): TemplateWarning[] {
  const warnings = step === 0 && subject !== null ? lintTemplate(subject, known, "subject") : [];
  return [...warnings, ...lintTemplate(body, known, "body")].filter((w) => w.kind === "unknown" || w.kind === "syntax");
}

/** The same problem in two texts: the same unknown name, or the same broken piece. */
function problemKey(w: TemplateWarning): string {
  return w.kind === "unknown" ? `unknown\u0000${w.variable ?? w.message}` : `${w.kind}\u0000${w.where}\u0000${w.message}`;
}

function summariseStep(step: number, warnings: readonly TemplateWarning[]): StepTextProblem | null {
  const unknown: string[] = [];
  let syntax = false;
  for (const w of warnings) {
    if (w.kind === "unknown" && w.variable && !unknown.includes(w.variable)) unknown.push(w.variable);
    if (w.kind === "syntax") syntax = true;
  }
  return unknown.length > 0 || syntax ? { step, unknown, syntax } : null;
}

/**
 * Text problems (unknown variables, broken braces) over the switched-on steps: once for the
 * campaign's text of each step, and for every email edited for one of `recipientIds` whose own
 * text has a problem the campaign's text doesn't (a problem already in the campaign's text is
 * reported there, once).
 */
async function textProblems(campaignId: number, recipientIds: readonly number[], steps: readonly number[]): Promise<TextProblemCounts> {
  const out: TextProblemCounts = { steps: [], editedByRecipient: new Map(), editedTotal: 0 };
  if (steps.length === 0) return out;
  const known = (await templateVariables()).map((v) => v.name);
  const rows = await db.campaignStep.findMany({
    where: { campaignId, step: { in: [...steps] } },
    orderBy: { step: "asc" },
    select: { step: true, subject: true, body: true },
  });
  const campaignProblems = new Map<number, Set<string>>();
  for (const r of rows) {
    const warnings = textWarnings(r.step, r.subject, r.body, known);
    campaignProblems.set(r.step, new Set(warnings.map(problemKey)));
    const summary = summariseStep(r.step, warnings);
    if (summary) out.steps.push(summary);
  }
  if (recipientIds.length === 0) return out;
  const wanted = new Set(recipientIds);
  const edits = await db.recipientEdit.findMany({
    where: { recipient: { campaignId }, step: { in: [...steps] } },
    select: { recipientId: true, step: true, subject: true, body: true },
  });
  for (const e of edits) {
    if (!wanted.has(e.recipientId)) continue;
    const campaign = campaignProblems.get(e.step) ?? new Set<string>();
    // A null subject follows the campaign's subject, whose problems are the campaign's.
    const own = textWarnings(e.step, e.subject, e.body, known).filter((w) => !campaign.has(problemKey(w)));
    if (own.length === 0) continue;
    out.editedByRecipient.set(e.recipientId, (out.editedByRecipient.get(e.recipientId) ?? 0) + 1);
    out.editedTotal += 1;
  }
  return out;
}

type MissingCounts = { byRecipient: Map<number, number>; total: number; error: string | null };

/** Missing-detail warnings per recipient over the switched-on steps (rendered exactly as they'd be sent). */
async function missingDetails(campaignId: number, recipientIds: readonly number[], steps: readonly number[]): Promise<MissingCounts> {
  const out: MissingCounts = { byRecipient: new Map(), total: 0, error: null };
  if (recipientIds.length === 0 || steps.length === 0) return out;
  try {
    const rendered = await renderCampaignEmails({ campaignId, recipientIds, steps, purpose: "preview" });
    for (const r of rendered) {
      if (!r.email.warnings.some((w) => w.kind === "missing")) continue;
      out.byRecipient.set(r.recipientId, (out.byRecipient.get(r.recipientId) ?? 0) + 1);
      out.total += 1;
    }
  } catch (err) {
    if (err instanceof RenderError) out.error = err.message;
    else throw err;
  }
  return out;
}

async function enabledSteps(campaignId: number): Promise<number[]> {
  const rows = await db.campaignStep.findMany({ where: { campaignId, enabled: true }, orderBy: { step: "asc" }, select: { step: true } });
  return rows.map((r) => r.step);
}

/** Review's list: everyone who'll get the email (with missing-detail and edited flags), and everyone left out. */
export async function loadReviewPage(
  campaignId: number,
  opts: { filter?: ReviewFilter; q?: string; page?: number; now?: Date } = {},
): Promise<ReviewPage> {
  const snap = await loadAudienceSnapshot(campaignId, { now: opts.now });
  const steps = await enabledSteps(campaignId);
  const included: ReviewItem[] = [];
  const excluded: ReviewItem[] = [];
  for (const c of snap.companies) {
    for (const p of c.people) {
      if (!p.email) continue;
      const base = {
        personId: p.personId,
        recipientId: p.recipientId,
        companyId: c.companyId,
        companyName: c.name,
        name: p.name,
        email: p.email,
        edited: p.edited,
        missing: 0,
        textProblems: 0,
      };
      if (p.willGet) {
        included.push({ ...base, willGet: true, reason: null, canInclude: false });
      } else {
        const reason = p.eligible ? NOT_TICKED : (p.reason ?? c.blockedReason ?? c.emptyReason ?? "Can't be emailed");
        excluded.push({ ...base, willGet: false, reason, canInclude: p.canTick });
      }
    }
  }
  const recipientIds = included.map((i) => i.recipientId!).filter(Boolean);
  const missing = await missingDetails(campaignId, recipientIds, steps);
  const text = await textProblems(campaignId, recipientIds, steps);
  for (const i of included) {
    i.missing = i.recipientId ? (missing.byRecipient.get(i.recipientId) ?? 0) : 0;
    i.textProblems = i.recipientId ? (text.editedByRecipient.get(i.recipientId) ?? 0) : 0;
  }

  const counts: Record<ReviewFilter, number> = {
    all: included.length,
    missing: included.filter((i) => i.missing > 0).length,
    text: included.filter((i) => i.textProblems > 0).length,
    edited: included.filter((i) => i.edited).length,
    excluded: excluded.length,
  };
  const filter: ReviewFilter = REVIEW_FILTERS.includes(opts.filter as ReviewFilter) ? (opts.filter as ReviewFilter) : "all";
  const pool =
    filter === "excluded"
      ? excluded
      : filter === "missing"
        ? included.filter((i) => i.missing > 0)
        : filter === "text"
          ? included.filter((i) => i.textProblems > 0)
          : filter === "edited"
            ? included.filter((i) => i.edited)
            : included;
  const q = (opts.q ?? "").trim().slice(0, 200);
  const words = normalizeText(q).split(" ").filter(Boolean).slice(0, 8);
  const shown = words.length
    ? pool.filter((i) => {
        const text = normalizeText(`${i.name} ${i.email ?? ""} ${i.companyName}`);
        return words.every((w) => text.includes(w));
      })
    : pool;
  const pageCount = Math.max(1, Math.ceil(shown.length / REVIEW_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1) || 1), pageCount);
  return {
    filter,
    q,
    page,
    pageCount,
    total: shown.length,
    items: shown.slice((page - 1) * REVIEW_PAGE_SIZE, page * REVIEW_PAGE_SIZE),
    counts,
    steps,
    missingEmails: missing.total,
    textProblems: text.steps,
    editedTextProblems: text.editedTotal,
    renderError: missing.error,
    totals: snap.totals,
  };
}

export type ReviewEmail = {
  step: number;
  /** "First email", "Follow-up 1". */
  title: string;
  /** Follow-ups: days after the previous step. */
  delayDays: number;
  /** Exactly as it will be sent (the unsubscribe link shows as "[unsubscribe link]"). */
  email: RenderedEmail;
  /** This person has their own version of this email. */
  edited: boolean;
  editedBy: string | null;
  editedAt: string | null;
  /** The text to edit: this person's own version, else the campaign's (variables included). */
  source: { subject: string | null; body: string };
  /** The campaign's text for this step (for "Reset to campaign text"). */
  campaignSource: { subject: string | null; body: string };
};

export type ReviewDetail = {
  personId: number;
  recipientId: number | null;
  companyId: number;
  companyCode: string;
  companyName: string;
  name: string;
  email: string | null;
  willGet: boolean;
  ticked: boolean;
  canInclude: boolean;
  /** Why they won't get the email. */
  reason: string | null;
  /**
   * The company replied and that is the only thing keeping this person out: putting the company
   * back in (Audience step) would let them get it.
   */
  companyCanPutBack: boolean;
  /** The company's approved personal line. */
  personalLine: string | null;
  /** This person's own line (used instead of the company's). */
  personalLineOverride: string | null;
  emails: ReviewEmail[];
  renderError: string | null;
};

/** One person in Review: every switched-on step rendered exactly as it will be sent, with warnings and edits. */
export async function loadReviewDetail(campaignId: number, personId: number): Promise<ReviewDetail> {
  const person = await db.person.findUnique({
    where: { id: personId },
    select: { id: true, companyId: true, personalLineOverride: true, company: { select: { name: true, personalLine: true } } },
  });
  if (!person) throw new CampaignError("This person doesn't exist any more. Refresh the page to see the latest.", "person-gone");
  const row = await db.campaignRecipient.findUnique({ where: { campaignId_personId: { campaignId, personId } }, select: { id: true } });
  const campaign = await db.campaign.findUnique({ where: { id: campaignId }, select: { audience: true } });
  if (!campaign) throw new CampaignError(CAMPAIGN_GONE, "not-found");
  if (!row && !readAudienceJson(campaign.audience).companyIds.includes(person.companyId)) {
    throw new CampaignError("This person isn't in the campaign any more. Refresh the page to see the latest.", "not-in-audience");
  }
  const company = await loadAudienceCompany(campaignId, person.companyId);
  const pv = company.people.find((p) => p.personId === personId);
  if (!pv) throw new CampaignError("This person isn't at this company any more. Refresh the page to see the latest.", "person-gone");

  const emails: ReviewEmail[] = [];
  let renderError: string | null = null;
  if (row) {
    const steps = await db.campaignStep.findMany({ where: { campaignId, enabled: true }, orderBy: { step: "asc" } });
    const edits = await db.recipientEdit.findMany({ where: { recipientId: row.id } });
    const editors = await db.user.findMany({
      where: { id: { in: edits.map((e) => e.editedById).filter((v): v is number => v !== null) } },
      select: { id: true, name: true },
    });
    const editorName = new Map(editors.map((u) => [u.id, u.name]));
    try {
      const rendered = await renderCampaignEmails({ campaignId, recipientIds: [row.id], steps: steps.map((s) => s.step), purpose: "preview" });
      const first = steps.find((s) => s.step === 0);
      for (const s of steps) {
        const r = rendered.find((x) => x.step === s.step);
        if (!r) continue;
        const edit = edits.find((e) => e.step === s.step);
        const campaignSubject = s.step === 0 ? (first?.subject ?? "") : null;
        emails.push({
          step: s.step,
          title: stepTitle(s.step),
          delayDays: s.delayDays,
          email: r.email,
          edited: Boolean(edit),
          editedBy: edit?.editedById ? (editorName.get(edit.editedById) ?? null) : null,
          editedAt: edit ? edit.editedAt.toISOString() : null,
          source: { subject: s.step === 0 ? (edit?.subject ?? campaignSubject) : null, body: edit?.body ?? s.body },
          campaignSource: { subject: campaignSubject, body: s.body },
        });
      }
    } catch (err) {
      if (err instanceof RenderError) renderError = err.message;
      else throw err;
    }
  }
  return {
    personId,
    recipientId: row?.id ?? null,
    companyId: person.companyId,
    companyCode: company.code,
    companyName: person.company.name,
    name: pv.name,
    email: pv.email,
    willGet: pv.willGet,
    ticked: pv.ticked,
    canInclude: pv.canTick,
    reason: pv.willGet ? null : pv.eligible ? NOT_TICKED : (pv.reason ?? company.blockedReason ?? company.emptyReason ?? null),
    companyCanPutBack: company.canPutBack && !pv.eligible && pv.reason === null && Boolean(pv.email),
    personalLine: person.company.personalLine,
    personalLineOverride: person.personalLineOverride,
    emails,
    renderError,
  };
}

/** Normalises a subject the way the engine stores it (for "same as the campaign's?"). */
function sameSubject(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim();
  return n(a) === n(b);
}

function sameBody(a: string, b: string): boolean {
  const n = (v: string) => v.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
  return n(a) === n(b);
}

/**
 * Review's "Edit this person's email": saved as this person's own version (RecipientEdit, through
 * the engine's editUnsentEmail). The first email's subject is only stored when it differs from the
 * campaign's, and text identical to the campaign's simply goes back to the campaign's text.
 */
export async function editDraftRecipientEmail(
  actor: Actor,
  campaignId: number,
  recipientId: number,
  step: number,
  input: { subject?: string | null; body: string },
): Promise<{ message: string; edited: boolean }> {
  await loadDraftForChange(db, campaignId);
  const row = await db.campaignRecipient.findUnique({ where: { id: recipientId }, select: { campaignId: true } });
  if (!row || row.campaignId !== campaignId) {
    throw new CampaignError("This person isn't in the campaign any more. Refresh the page to see the latest.", "not-in-campaign");
  }
  const cs = await db.campaignStep.findUnique({ where: { campaignId_step: { campaignId, step } }, select: { subject: true, body: true } });
  if (!cs) throw new CampaignError(`This campaign has no ${stepTitle(step).toLowerCase()}.`, "no-step");
  const subject = step === 0 && input.subject !== undefined && input.subject !== null && !sameSubject(input.subject, cs.subject) ? input.subject : null;
  if (subject === null && sameBody(input.body, cs.body)) {
    const res = await discardUnsentEdit(recipientId, step, actor.id);
    return { message: `No changes from the campaign's text, so ${res.message.charAt(0).toLowerCase()}${res.message.slice(1)}`, edited: false };
  }
  const res = await editUnsentEmail(recipientId, step, { subject, body: input.body }, actor.id);
  return { message: res.message, edited: true };
}

/** Review's "Reset to campaign text". */
export async function resetDraftRecipientEmail(actor: Actor, campaignId: number, recipientId: number, step: number): Promise<{ message: string }> {
  await loadDraftForChange(db, campaignId);
  const row = await db.campaignRecipient.findUnique({ where: { id: recipientId }, select: { campaignId: true } });
  if (!row || row.campaignId !== campaignId) {
    throw new CampaignError("This person isn't in the campaign any more. Refresh the page to see the latest.", "not-in-campaign");
  }
  const res = await discardUnsentEdit(recipientId, step, actor.id);
  return { message: res.message };
}

// ───────────────────────── schedule and launch ─────────────────────────

/** The latest start that can be chosen. */
export const MAX_SCHEDULE_DAYS = 365;

/** Saves the Schedule step: the start (null = start now) and the dry-run helper. */
export async function setDraftSchedule(
  actor: Actor,
  campaignId: number,
  input: { startAt?: Date | null; daysAsMinutes?: boolean },
  opts: { now?: Date } = {},
): Promise<{ startAt: Date | null; daysAsMinutes: boolean }> {
  const now = opts.now ?? new Date();
  if (input.startAt) {
    if (Number.isNaN(input.startAt.getTime())) throw new CampaignError("Choose a valid date and time.", "bad-start");
    if (input.startAt.getTime() <= now.getTime()) {
      throw new CampaignError("That time has already passed. Pick a time in the future, or choose Start now.", "past-start");
    }
    if (input.startAt.getTime() > now.getTime() + MAX_SCHEDULE_DAYS * 86_400_000) {
      throw new CampaignError("Pick a start within the next year.", "far-start");
    }
  }
  return dbTx(async (tx) => {
    await loadDraftForChange(tx, campaignId);
    const updated = await tx.campaign.update({
      where: { id: campaignId },
      data: {
        ...(input.startAt !== undefined ? { startAt: input.startAt } : {}),
        ...(input.daysAsMinutes !== undefined ? { daysAsMinutes: input.daysAsMinutes } : {}),
      },
      select: { startAt: true, daysAsMinutes: true },
    });
    return updated;
  });
}

/** Something that must be fixed before launching, with the wizard step to fix it in. */
export type LaunchProblem = { step: "audience" | "sender" | "message" | "review"; text: string };

export type LaunchSummary = {
  mode: SendMode;
  /**
   * What stops a launch in this mode right now, in the launch's own order and words (M3-DESIGN
   * §4.3.9): the practice copy, Mailgun not connected, the mode's readiness (incl. "Live campaigns
   * start once the reply test has passed …"), the sender's address, the sender's reply route.
   */
  modeBlockers: string[];
  /** modeBlockers is empty. */
  modeReady: boolean;
  /** Today's limit and its use (live campaigns, and dry runs in the practice copy); null otherwise. */
  today: { cap: number; used: number; left: number; capDay: string } | null;
  /** The sending window in words: "Monday to Friday, 9:00–17:00". */
  windowText: string;
  /** How many of the people fit in today's limit, and how many follow later (null when no limit applies). */
  fits: { today: number; later: number } | null;
  /** "Ignore sending hours" starts on for dry runs on real data, off in the practice copy. */
  ignoreWindowDefault: boolean;
  /** The practice copy: dry runs count as real contact there. */
  practiceCopy: boolean;
  /** People who'll get the first email. */
  people: number;
  companies: number;
  excludedCompanies: number;
  /** Switched-on follow-ups. */
  followUps: number;
  /** Emails (person × step) with missing details. */
  missingEmails: number;
  /** People with at least one of them. */
  missingPeople: number;
  /** Unknown variables and broken braces in the campaign's text, per switched-on step (they don't block). */
  textProblems: StepTextProblem[];
  /** Emails edited for single people whose own text has such problems. */
  editedTextProblems: number;
  /** Where the people who'll get the email are, most people first. */
  recipientZones: RecipientZone[];
  /** The zone used for companies with no time zone of their own (Setting "defaultTimeZone"). */
  defaultTimeZone: string;
  senderName: string | null;
  startAt: Date | null;
  daysAsMinutes: boolean;
  /** What must be fixed before launching, with the step to fix it in. */
  problems: LaunchProblem[];
  /** Setting "sending.goLive" right now (M6-DESIGN §2.7: the Schedule step's Live line changes with it). */
  goLive: boolean;
  /**
   * Go-live is on and this draft was created before `sending.goLiveAt` (G11). Whatever the mode; a LIVE launch of such
   * a draft needs `confirmMadeBeforeGoLive` (the Schedule step's tick).
   */
  madeBeforeGoLive: boolean;
};

export type RecipientZone = {
  /** IANA zone, e.g. "Europe/Berlin". */
  timeZone: string;
  /** People who'll get the email at companies in this zone. */
  people: number;
  /** Of them, people at companies with no time zone set (they count as the default zone). */
  defaulted: number;
};

const ZONE_CHUNK = 400;

/**
 * The recipients' time zones (PLAN.md B6.4 Schedule: the start "in recipients' local time"):
 * people who'll get the email, grouped by their company's time zone, most people first. Companies
 * with no time zone use the default zone (B6.2).
 */
async function recipientZones(peopleByCompany: ReadonlyMap<number, number>, defaultTimeZone: string): Promise<RecipientZone[]> {
  const ids = [...peopleByCompany.keys()];
  const zones = new Map<string, RecipientZone>();
  for (let i = 0; i < ids.length; i += ZONE_CHUNK) {
    const rows = await db.company.findMany({ where: { id: { in: ids.slice(i, i + ZONE_CHUNK) } }, select: { id: true, timeZone: true } });
    for (const r of rows) {
      const people = peopleByCompany.get(r.id) ?? 0;
      const own = r.timeZone?.trim() || null;
      const zone = own ?? defaultTimeZone;
      const entry = zones.get(zone) ?? { timeZone: zone, people: 0, defaulted: 0 };
      entry.people += people;
      if (!own) entry.defaulted += people;
      zones.set(zone, entry);
    }
  }
  return [...zones.values()].sort((a, b) => b.people - a.people || a.timeZone.localeCompare(b.timeZone));
}

/** What launching would do right now (the Schedule step and its confirmation). */
export async function loadLaunchSummary(
  campaignId: number,
  opts: { now?: Date; mailgun?: () => Promise<MailgunContextResult> } = {},
): Promise<LaunchSummary> {
  const info = await getDraftInfo(campaignId);
  if (!info) throw new CampaignError(CAMPAIGN_GONE, "not-found");
  const snap = await loadAudienceSnapshot(campaignId, { now: opts.now });
  const steps = await getDraftSteps(campaignId);
  const on = steps.filter((s) => s.enabled).map((s) => s.step);
  const recipientIds = snap.companies.flatMap((c) => c.people.filter((p) => p.willGet && p.recipientId).map((p) => p.recipientId!));
  const missing = await missingDetails(campaignId, recipientIds, on);
  const text = await textProblems(campaignId, recipientIds, on);
  const practiceCopy = (await getSetting("practice.copy")) === true;
  const mode = await draftSendingMode();
  const zoneSetting = await getSetting("defaultTimeZone");
  const defaultTimeZone = typeof zoneSetting === "string" && zoneSetting.trim() ? zoneSetting.trim() : SETTING_DEFAULTS.defaultTimeZone;
  const peopleByCompany = new Map(snap.companies.filter((c) => c.willGet > 0).map((c) => [c.companyId, c.willGet]));
  const zones = await recipientZones(peopleByCompany, defaultTimeZone);

  const problems: LaunchProblem[] = [];
  if (snap.totals.people === 0) problems.push({ step: "audience", text: "Nobody will get the email yet. Tick at least one person who can be emailed." });
  if (!info.senderId) problems.push({ step: "sender", text: "Choose who sends this campaign." });
  else if (!info.senderActive) problems.push({ step: "sender", text: `${info.senderName ?? "The sender"}'s account is switched off. Choose another sender.` });
  const checked = validateSequence(steps);
  if (!checked.ok) problems.push({ step: "message", text: checked.error });
  // First subjects that pretend to be a reply (M4-DESIGN §2.13): the campaign's is fixed in Message, people's own in Review.
  const badSubjects = await firstSubjectErrors(db, campaignId);
  if (badSubjects.campaign) problems.push({ step: "message", text: FIRST_SUBJECT_REPLY_ERROR });
  if (badSubjects.edits > 0) problems.push({ step: "review", text: RE_SUBJECT_LAUNCH_TEXT });
  if (missing.error) problems.push({ step: "message", text: missing.error });

  // Sending mode: the launch's own checks, the limit and the sending window (M3-DESIGN §4.3.9, §5.8).
  const sender = info.senderId
    ? await db.user.findUnique({
        where: { id: info.senderId },
        select: {
          name: true,
          senderAddresses: {
            where: { retiredAt: null, domain: { active: true } },
            orderBy: { id: "desc" },
            take: 1,
            select: { address: true, routeStatus: true },
          },
        },
      })
    : null;
  const modeBlockers = (
    await launchModeProblems(mode, sender ? { name: sender.name, address: sender.senderAddresses[0] ?? null } : null, {
      mailgun: opts.mailgun,
    })
  ).map((p) => p.text);
  const limited = mode === "LIVE" || (mode === "DRY_RUN" && practiceCopy);
  const cap = limited ? await getTodayCap(opts.now ?? new Date(), { practiceCopy }) : null;
  const today = cap ? { cap: cap.cap, used: cap.used, left: cap.left, capDay: cap.capDay } : null;
  const fitsToday = today ? Math.min(snap.totals.people, today.left) : null;
  // Go live (M6-DESIGN §2.7, G11): today's switch, and whether this draft is older than it.
  const goLive = (await getSetting("sending.goLive")) === true;
  const goLiveAt = goLive ? Date.parse(String((await getSetting("sending.goLiveAt")) ?? "")) : Number.NaN;
  const madeBeforeGoLive = Number.isFinite(goLiveAt) && info.createdAt.getTime() < goLiveAt;

  return {
    mode,
    modeBlockers,
    modeReady: modeBlockers.length === 0,
    today,
    windowText: windowSentence(parseWindow(await getSetting("sending.window"))),
    fits: fitsToday === null ? null : { today: fitsToday, later: Math.max(0, snap.totals.people - fitsToday) },
    ignoreWindowDefault: !practiceCopy,
    practiceCopy,
    people: snap.totals.people,
    companies: snap.totals.companies,
    excludedCompanies: snap.totals.excludedCompanies,
    followUps: on.filter((s) => s > 0).length,
    missingEmails: missing.total,
    missingPeople: missing.byRecipient.size,
    textProblems: text.steps,
    editedTextProblems: text.editedTotal,
    recipientZones: zones,
    defaultTimeZone,
    senderName: info.senderName,
    startAt: info.startAt,
    daysAsMinutes: info.daysAsMinutes,
    problems,
    goLive,
    madeBeforeGoLive,
  };
}

/**
 * Launch: the message is checked with the templates' rules, unticked people who can't be emailed
 * get their reason written down, then the engine's launchCampaign does the rest (mode and its
 * checks, sender snapshot, a fresh eligibility check, reservations, the first-email rows, the
 * sender's notification when someone else launched it). `ignoreWindow` is the Schedule step's
 * "Ignore sending hours" switch (dry runs only); omitted, it is on for real data and off in the
 * practice copy. `confirmMadeBeforeGoLive` is the Schedule step's tick for a LIVE draft made before
 * go-live (M6-DESIGN G11), passed on to the engine. Throws CampaignError in plain words.
 */
export async function launchDraft(
  actor: Actor,
  campaignId: number,
  opts: { now?: Date; ignoreWindow?: boolean; confirmMadeBeforeGoLive?: boolean; mailgun?: () => Promise<MailgunContextResult> } = {},
): Promise<LaunchResult> {
  await loadDraftForChange(db, campaignId);
  // A "Re:"/"Fwd:" first subject saved before this rule existed: the launch's own words say where to fix it.
  const badSubjects = await firstSubjectErrors(db, campaignId);
  if (badSubjects.campaign || badSubjects.edits > 0) throw new CampaignError(RE_SUBJECT_LAUNCH_TEXT, "re-subject");
  const checked = await checkDraftMessage(campaignId);
  if (!checked.ok) throw new CampaignError(`${checked.error} Open the Message step to fix it.`, "message");
  await syncExclusionReasons(campaignId, { now: opts.now });
  const ignoreWindow = opts.ignoreWindow ?? (await getSetting("practice.copy")) !== true;
  return launchCampaign(campaignId, actor.id, {
    now: opts.now,
    ignoreWindow,
    mailgun: opts.mailgun,
    ...(opts.confirmMadeBeforeGoLive ? { confirmMadeBeforeGoLive: true } : {}),
  });
}
