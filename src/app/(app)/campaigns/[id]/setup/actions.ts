"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { COMPANY_STATUSES } from "@/core/labels";
import { MAX_FOLLOW_UPS } from "@/core/templates/steps";
import { UserError, parseInput, runAction, type ActionResult } from "@/lib/action";
import { requireUserAction } from "@/lib/auth/dal";
import type { SessionUser } from "@/lib/auth/session";
import { addedMessage } from "@/components/campaign-wizard/format";
import { cleanRenumberMap } from "@/components/campaign-wizard/message-state";
import { localDateTimeToUtc } from "@/components/campaign-wizard/schedule-time";
import { WIZARD_STEPS, nextStepKey, stepNumber, wizardHref, type WizardStepKey } from "@/components/campaign-wizard/steps";
import { CHECKS_STILL_RUNNING_TEXT } from "@/components/checks/verify-model";
import { activeCampaignCheckRun } from "@/server/services/verification/runs";
import { ServiceError, setCompanyPersonalLine } from "@/server/services/companies/mutations";
import { setPersonPersonalLine } from "@/server/services/people";
import { RenderError } from "@/server/services/render";
import { CampaignError } from "@/server/services/campaigns/errors";
import {
  addAudienceByFilter,
  audienceTotals,
  clearAudience,
  notDraftText,
  previewAudienceFilter,
  removeCompaniesFromAudience,
  setCompanyPutBack,
  setPersonTicked,
  type AddCompaniesResult,
  type AudienceCompanyView,
  type AudienceFilter,
  type FilterPreview,
} from "@/server/services/campaigns/audience";
import {
  DRAFT_TEXT_LIMITS,
  applyTemplateToDraft,
  checkDraftMessage,
  deleteDraft,
  editDraftRecipientEmail,
  getDraftInfo,
  launchDraft,
  loadReviewDetail,
  previewDraftEmail,
  renameDraft,
  resetDraftRecipientEmail,
  saveDraftSteps,
  saveDraftStepsToTemplate,
  searchDraftRecipients,
  setDraftSchedule,
  setDraftSender,
  setWizardStep,
  type DraftPreview,
  type DraftStep,
  type RecipientOption,
  type ReviewDetail,
} from "@/server/services/campaigns/draft";

/**
 * Server Actions for the campaign wizard (/campaigns/<id>/setup/<step>, PLAN.md B6.4, SPEC §7).
 * Every action checks the session first, works on drafts only (the services refuse anything
 * else), and answers in plain words. Changes are saved at once ("drafts save automatically").
 */

// ───────────────────────── helpers (not exported) ─────────────────────────

function actorOf(user: SessionUser) {
  return { id: user.id, name: user.name };
}

/** runAction, plus: campaign/render/company problems become plain messages; the body may return its own success message. */
async function run<T>(fn: () => Promise<{ data: T; message?: string }>): Promise<ActionResult<T>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    try {
      const out = await fn();
      message = out.message;
      return out.data;
    } catch (err) {
      if (err instanceof CampaignError || err instanceof RenderError) throw new UserError(err.message);
      if (err instanceof ServiceError) throw new UserError(err.message, err.fieldErrors);
      throw err;
    }
  });
  return res.ok ? { ...res, message } : res;
}

/**
 * The wizard's pages show fresh data: every page under /campaigns/<id>/setup (the route pattern,
 * as the docs ask for a whole section). Actions that answer with the changed data themselves
 * (ticks, the Message step's autosave, the preview) skip this, so a 2,000-company audience isn't
 * re-checked on every click.
 */
function refreshWizard() {
  revalidatePath("/campaigns/[id]/setup", "layout");
}

const campaignIdSchema = z
  .number({ error: "This campaign doesn't exist any more. Refresh the page." })
  .int()
  .positive({ error: "This campaign doesn't exist any more. Refresh the page." });
const idSchema = z.number({ error: "Something about this page is out of date. Refresh it and try again." }).int().positive();
const stepKeySchema = z.enum(WIZARD_STEPS.map((s) => s.key) as [WizardStepKey, ...WizardStepKey[]]);

// ───────────────────────── the draft itself ─────────────────────────

export async function renameDraftAction(input: { campaignId: number; name: string }): Promise<ActionResult<{ name: string }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(z.object({ campaignId: campaignIdSchema, name: z.string({ error: "Give the campaign a name." }).max(1000) }), input);
    const res = await renameDraft(actorOf(user), data.campaignId, data.name);
    refreshWizard();
    revalidatePath("/campaigns");
    return { data: { name: res.name }, message: res.changed ? "Campaign renamed." : undefined };
  });
}

export async function deleteDraftAction(input: { campaignId: number }): Promise<ActionResult<{ name: string }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(z.object({ campaignId: campaignIdSchema }), input);
    const res = await deleteDraft(actorOf(user), data.campaignId);
    revalidatePath("/campaigns");
    return { data: res, message: `Deleted the draft ${res.name}.` };
  });
}

/**
 * "Continue": checks what the step needs (people who'll get the email, a sender, a message that
 * follows the rules, no address checks still running), remembers the progress and says where to go next.
 */
export async function continueAction(input: { campaignId: number; from: WizardStepKey }): Promise<ActionResult<{ href: string }>> {
  return run(async () => {
    await requireUserAction();
    const data = parseInput(z.object({ campaignId: campaignIdSchema, from: stepKeySchema }), input);
    const info = await getDraftInfo(data.campaignId);
    if (!info) throw new UserError("This campaign doesn't exist any more. Refresh the page.");
    if (info.status !== "DRAFT") throw new UserError(notDraftText(info.status));
    if (data.from === "audience") {
      const totals = await audienceTotals(data.campaignId);
      if (totals.people === 0) {
        throw new UserError(
          totals.all === 0
            ? "Add some companies first: pick a list, tag, status, country or niche above."
            : "Nobody will get the email yet. Tick at least one person who can be emailed.",
        );
      }
    }
    if (data.from === "sender" && (!info.senderId || !info.senderActive)) {
      throw new UserError("Choose who sends this campaign.");
    }
    if (data.from === "message") {
      const checked = await checkDraftMessage(data.campaignId);
      if (!checked.ok) throw new UserError(checked.error, checked.fieldErrors);
    }
    // Verify (M5-DESIGN §6.1): not while the campaign's address checks are queued or running.
    if (data.from === "verify" && (await activeCampaignCheckRun(data.campaignId))) {
      throw new UserError(CHECKS_STILL_RUNNING_TEXT);
    }
    const next = nextStepKey(data.from);
    if (!next) throw new UserError("This is the last step. Launch the campaign when you're ready.");
    await setWizardStep(data.campaignId, stepNumber(next));
    return { data: { href: wizardHref(data.campaignId, next) } };
  });
}

// ───────────────────────── 1 Audience ─────────────────────────

const filterSchema = z.object({
  listId: z.number().int().positive().nullable().optional(),
  tagIds: z.array(z.number().int().positive()).max(200).optional(),
  status: z.enum(COMPANY_STATUSES).nullable().optional(),
  countries: z.array(z.string().max(10)).max(300).optional(),
  niches: z.array(z.string().max(200)).max(300).optional(),
});

export async function previewAudienceFilterAction(input: { campaignId: number; filter: AudienceFilter }): Promise<ActionResult<FilterPreview>> {
  return run(async () => {
    await requireUserAction();
    const data = parseInput(z.object({ campaignId: campaignIdSchema, filter: filterSchema }), input);
    return { data: await previewAudienceFilter(data.campaignId, data.filter) };
  });
}

export async function addAudienceFilterAction(input: {
  campaignId: number;
  filter: AudienceFilter;
}): Promise<ActionResult<AddCompaniesResult & { label: string }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(z.object({ campaignId: campaignIdSchema, filter: filterSchema }), input);
    const res = await addAudienceByFilter(actorOf(user), data.campaignId, data.filter);
    refreshWizard();
    return { data: res, message: addedMessage(res) };
  });
}

export async function removeAudienceCompanyAction(input: { campaignId: number; companyId: number }): Promise<ActionResult<{ removed: number }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(z.object({ campaignId: campaignIdSchema, companyId: idSchema }), input);
    const res = await removeCompaniesFromAudience(actorOf(user), data.campaignId, [data.companyId]);
    refreshWizard();
    return { data: res, message: res.removed ? "Removed from this campaign." : "It was already out of this campaign." };
  });
}

export async function clearAudienceAction(input: { campaignId: number }): Promise<ActionResult<{ removed: number }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(z.object({ campaignId: campaignIdSchema }), input);
    const res = await clearAudience(actorOf(user), data.campaignId);
    refreshWizard();
    return {
      data: res,
      message: res.removed === 1 ? "Removed the company. The audience is empty." : `Removed all ${res.removed.toLocaleString("en-US")} companies. The audience is empty.`,
    };
  });
}

/** Ticks or unticks one person. Returns that company's fresh view (no page reload needed). */
export async function tickPersonAction(input: {
  campaignId: number;
  personId: number;
  ticked: boolean;
}): Promise<ActionResult<{ company: AudienceCompanyView }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(z.object({ campaignId: campaignIdSchema, personId: idSchema, ticked: z.boolean() }), input);
    const res = await setPersonTicked(actorOf(user), data.campaignId, data.personId, data.ticked);
    return { data: { company: res.company }, message: res.message };
  });
}

/** Puts a Replied company back in by hand (or out again). */
export async function putBackCompanyAction(input: {
  campaignId: number;
  companyId: number;
  on: boolean;
}): Promise<ActionResult<{ company: AudienceCompanyView }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(z.object({ campaignId: campaignIdSchema, companyId: idSchema, on: z.boolean() }), input);
    const res = await setCompanyPutBack(actorOf(user), data.campaignId, data.companyId, data.on);
    refreshWizard();
    return { data: { company: res.company }, message: res.message };
  });
}

// ───────────────────────── 2 Sender ─────────────────────────

export async function setSenderAction(input: { campaignId: number; senderId: number }): Promise<ActionResult<{ senderName: string }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(z.object({ campaignId: campaignIdSchema, senderId: idSchema }), input);
    const res = await setDraftSender(actorOf(user), data.campaignId, data.senderId);
    return { data: { senderName: res.senderName } };
  });
}

// ───────────────────────── 3 Message ─────────────────────────

const stepSchema = z.object({
  step: z.number().int().min(0).max(MAX_FOLLOW_UPS),
  enabled: z.boolean(),
  subject: z.string().max(DRAFT_TEXT_LIMITS.subject, { error: "The subject is too long to save." }).nullable().optional(),
  body: z.string().max(DRAFT_TEXT_LIMITS.body, { error: "This email is too long to save." }),
  delayDays: z.number(),
});

export async function saveStepsAction(input: {
  campaignId: number;
  steps: Array<z.input<typeof stepSchema>>;
  renumber?: Record<number, number | null>;
}): Promise<ActionResult<{ savedAt: string }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(
      z.object({ campaignId: campaignIdSchema, steps: z.array(stepSchema).min(1).max(MAX_FOLLOW_UPS + 1), renumber: z.unknown().optional() }),
      input,
    );
    const renumber = cleanRenumberMap(data.renumber ?? null, MAX_FOLLOW_UPS);
    if (!renumber) throw new UserError("The follow-ups got out of step with this page. Reload it and try again.");
    await saveDraftSteps(actorOf(user), data.campaignId, data.steps, renumber);
    return { data: { savedAt: new Date().toISOString() } };
  });
}

export async function applyTemplateAction(input: {
  campaignId: number;
  templateId: number;
}): Promise<ActionResult<{ steps: DraftStep[]; templateId: number; templateName: string }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(z.object({ campaignId: campaignIdSchema, templateId: idSchema }), input);
    const res = await applyTemplateToDraft(actorOf(user), data.campaignId, data.templateId);
    const reset =
      res.clearedEdits > 0
        ? ` ${res.clearedEdits === 1 ? "1 email you edited for one person was" : `${res.clearedEdits} emails you edited for single people were`} reset.`
        : "";
    return {
      data: { steps: res.steps, templateId: data.templateId, templateName: res.templateName },
      message: `Now using the template "${res.templateName}".${reset}`,
    };
  });
}

export async function saveBackToTemplateAction(input: { campaignId: number }): Promise<ActionResult<{ templateId: number; templateName: string }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(z.object({ campaignId: campaignIdSchema }), input);
    const res = await saveDraftStepsToTemplate(actorOf(user), data.campaignId);
    if (!res.ok) throw new UserError(res.error, res.fieldErrors);
    revalidatePath("/templates");
    revalidatePath(`/templates/${res.templateId}`);
    return {
      data: { templateId: res.templateId, templateName: res.templateName },
      message: `Saved to the template "${res.templateName}". New campaigns from it use this text.`,
    };
  });
}

const previewSchema = z.object({
  campaignId: campaignIdSchema,
  personId: z.number({ error: "Pick someone to preview." }).int().positive({ error: "Pick someone to preview." }),
  step: z.number().int().min(0).max(MAX_FOLLOW_UPS),
  subject: z.string().max(DRAFT_TEXT_LIMITS.subject).nullable(),
  body: z.string().max(DRAFT_TEXT_LIMITS.body),
});

/** The Message step's live preview (unsaved text; for a follow-up, `subject` is the first email's subject). */
export async function previewStepAction(input: z.input<typeof previewSchema>): Promise<ActionResult<DraftPreview>> {
  return run(async () => {
    await requireUserAction();
    const data = parseInput(previewSchema, input);
    return { data: await previewDraftEmail(data.campaignId, data) };
  });
}

export async function searchRecipientsAction(input: { campaignId: number; q: string }): Promise<ActionResult<RecipientOption[]>> {
  return run(async () => {
    await requireUserAction();
    const data = parseInput(z.object({ campaignId: campaignIdSchema, q: z.string().max(200, { error: "Type a shorter search." }) }), input);
    return { data: await searchDraftRecipients(data.campaignId, data.q) };
  });
}

// ───────────────────────── 5 Review ─────────────────────────

export async function reviewDetailAction(input: { campaignId: number; personId: number }): Promise<ActionResult<ReviewDetail>> {
  return run(async () => {
    await requireUserAction();
    const data = parseInput(z.object({ campaignId: campaignIdSchema, personId: idSchema }), input);
    return { data: await loadReviewDetail(data.campaignId, data.personId) };
  });
}

/** Review's Include / Exclude (the same tick as the Audience step). The list refreshes. */
export async function setIncludedAction(input: { campaignId: number; personId: number; included: boolean }): Promise<ActionResult<ReviewDetail>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(z.object({ campaignId: campaignIdSchema, personId: idSchema, included: z.boolean() }), input);
    const res = await setPersonTicked(actorOf(user), data.campaignId, data.personId, data.included);
    refreshWizard();
    return { data: await loadReviewDetail(data.campaignId, data.personId), message: res.message };
  });
}

const editSchema = z.object({
  campaignId: campaignIdSchema,
  recipientId: idSchema,
  step: z.number().int().min(0).max(MAX_FOLLOW_UPS),
  subject: z.string().max(DRAFT_TEXT_LIMITS.subject).nullable().optional(),
  body: z.string().max(DRAFT_TEXT_LIMITS.body, { error: "This email is too long to save." }),
});

/** "Edit this person's email": saved for this person only (the engine's RecipientEdit). */
export async function editRecipientEmailAction(input: z.input<typeof editSchema>): Promise<ActionResult<{ edited: boolean }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(editSchema, input);
    const res = await editDraftRecipientEmail(actorOf(user), data.campaignId, data.recipientId, data.step, {
      subject: data.subject,
      body: data.body,
    });
    refreshWizard();
    return { data: { edited: res.edited }, message: res.message };
  });
}

export async function resetRecipientEmailAction(input: { campaignId: number; recipientId: number; step: number }): Promise<ActionResult<null>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(
      z.object({ campaignId: campaignIdSchema, recipientId: idSchema, step: z.number().int().min(0).max(MAX_FOLLOW_UPS) }),
      input,
    );
    const res = await resetDraftRecipientEmail(actorOf(user), data.campaignId, data.recipientId, data.step);
    refreshWizard();
    return { data: null, message: res.message };
  });
}

const lineSchema = z.string({ error: "Type the personal line." }).max(2000, { error: "Keep the personal line under 300 characters." });

/** "Edit personal line": saved on the company (and logged there), so every campaign uses it. */
export async function setCompanyLineAction(input: { campaignId: number; companyId: number; value: string }): Promise<ActionResult<{ line: string | null }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(z.object({ campaignId: campaignIdSchema, companyId: idSchema, value: lineSchema }), input);
    const res = await setCompanyPersonalLine(actorOf(user), data.companyId, data.value);
    refreshWizard();
    revalidatePath("/contacts");
    return { data: { line: res.line }, message: res.line ? "Personal line saved on the company." : "Personal line removed from the company." };
  });
}

/** The person's own line (used instead of the company's), when they have one. */
export async function setPersonLineAction(input: { campaignId: number; personId: number; value: string }): Promise<ActionResult<{ line: string | null }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(z.object({ campaignId: campaignIdSchema, personId: idSchema, value: lineSchema }), input);
    const res = await setPersonPersonalLine(actorOf(user), data.personId, data.value);
    refreshWizard();
    revalidatePath("/contacts");
    return {
      data: { line: res.line },
      message: res.line ? "Saved this person's own line." : "Removed this person's own line: they get the company's line again.",
    };
  });
}

// ───────────────────────── 6 Schedule and launch ─────────────────────────

const scheduleSchema = z.object({
  campaignId: campaignIdSchema,
  when: z.enum(["now", "later"]),
  local: z.string().max(40).optional(),
  daysAsMinutes: z.boolean().optional(),
});

/** Saves the start (typed in the viewer's own time zone) and the dry-run helper. */
export async function setScheduleAction(input: z.input<typeof scheduleSchema>): Promise<ActionResult<{ startAt: string | null; daysAsMinutes: boolean }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(scheduleSchema, input);
    let startAt: Date | null = null;
    if (data.when === "later") {
      startAt = localDateTimeToUtc(data.local ?? "", user.timeZone);
      if (!startAt) throw new UserError("Choose a date and a time to start.", { local: ["Choose a date and a time to start."] });
    }
    const res = await setDraftSchedule(actorOf(user), data.campaignId, { startAt, daysAsMinutes: data.daysAsMinutes });
    return { data: { startAt: res.startAt ? res.startAt.toISOString() : null, daysAsMinutes: res.daysAsMinutes } };
  });
}

/**
 * "Launch campaign": the engine takes over; the result says what happened in plain words.
 * `ignoreWindow` is the Schedule step's "Ignore sending hours" switch (dry runs only; omitted: on
 * for real data, off in the practice copy). `confirmMadeBeforeGoLive` is the Schedule step's tick
 * for a LIVE draft made before go-live (M6-DESIGN G11); without it such a launch is refused.
 */
export async function launchAction(input: {
  campaignId: number;
  ignoreWindow?: boolean;
  confirmMadeBeforeGoLive?: boolean;
}): Promise<ActionResult<{ campaignId: number; status: "SCHEDULED" | "RUNNING"; href: string }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(
      z.object({ campaignId: campaignIdSchema, ignoreWindow: z.boolean().optional(), confirmMadeBeforeGoLive: z.boolean().optional() }),
      input,
    );
    const res = await launchDraft(actorOf(user), data.campaignId, {
      ignoreWindow: data.ignoreWindow,
      confirmMadeBeforeGoLive: data.confirmMadeBeforeGoLive === true,
    });
    revalidatePath("/campaigns");
    revalidatePath(`/campaigns/${data.campaignId}`);
    const lost =
      res.lost.length > 0
        ? ` ${res.lost.length === 1 ? `${res.lost[0]!.companyName} was` : `${res.lost.length} companies were`} taken by another campaign at the same moment.`
        : "";
    return {
      data: { campaignId: data.campaignId, status: res.status, href: `/campaigns/${data.campaignId}` },
      message: res.message + lost,
    };
  });
}
