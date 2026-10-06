"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { UserError, parseInput, runAction, type ActionResult } from "@/lib/action";
import { requireUserAction } from "@/lib/auth/dal";
import { db } from "@/server/db";
import {
  EDIT_LIMITS,
  cancelCampaign,
  discardUnsentEdit,
  editUnsentEmail,
  pauseCampaign,
  resumeCampaign,
  retryEmail,
  skipRecipient,
} from "@/server/services/campaigns/control";
import { CAMPAIGN_GONE, CampaignError, EMAIL_GONE, RECIPIENT_GONE } from "@/server/services/campaigns/errors";

/**
 * Server Actions for the campaign page (PLAN.md A6, SPEC §7, M3-DESIGN §5.8): pause, resume, cancel,
 * skip a person, try an email again ("Retry or Skip?" for an email we're not sure was sent), and
 * edit (or un-edit) an email that hasn't been sent. Members and the Owner can all use them (SPEC
 * §1). The engine (@/server/services/campaigns/control) does the work and decides; its
 * CampaignError messages are shown as they are.
 */

/** runAction, with a success message that comes from the engine's answer. */
async function run<T>(fn: () => Promise<{ data: T; message: string }>): Promise<ActionResult<T>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    try {
      const out = await fn();
      message = out.message;
      return out.data;
    } catch (err) {
      if (err instanceof CampaignError) throw new UserError(err.message);
      throw err;
    }
  });
  return res.ok ? { ...res, message } : res;
}

function refresh(campaignId: number) {
  revalidatePath("/campaigns");
  revalidatePath(`/campaigns/${campaignId}`);
  revalidatePath("/campaigns/outbox");
  revalidatePath("/contacts");
}

const campaignIdSchema = z
  .number({ error: "That campaign doesn't exist any more. Refresh the page." })
  .int({ error: "That campaign doesn't exist any more. Refresh the page." })
  .positive({ error: "That campaign doesn't exist any more. Refresh the page." });
const recipientIdSchema = z
  .number({ error: "That person isn't in the campaign any more. Refresh the page." })
  .int({ error: "That person isn't in the campaign any more. Refresh the page." })
  .positive({ error: "That person isn't in the campaign any more. Refresh the page." });
const emailIdSchema = z
  .number({ error: "That email doesn't exist any more. Refresh the page." })
  .int({ error: "That email doesn't exist any more. Refresh the page." })
  .positive({ error: "That email doesn't exist any more. Refresh the page." });
const stepSchema = z
  .number({ error: "That email doesn't exist any more. Refresh the page." })
  .int({ error: "That email doesn't exist any more. Refresh the page." })
  .min(0, { error: "That email doesn't exist any more. Refresh the page." })
  .max(3, { error: "That email doesn't exist any more. Refresh the page." });

const campaignInput = z.object({ campaignId: campaignIdSchema });

/** The person must belong to the campaign the page shows (a stale or edited request can't reach another one). */
async function assertRecipientInCampaign(recipientId: number, campaignId: number): Promise<void> {
  const r = await db.campaignRecipient.findUnique({ where: { id: recipientId }, select: { campaignId: true } });
  if (!r || r.campaignId !== campaignId) throw new UserError(RECIPIENT_GONE);
}

async function assertEmailInCampaign(emailId: number, campaignId: number): Promise<void> {
  const e = await db.outboundEmail.findUnique({ where: { id: emailId }, select: { campaignId: true } });
  if (!e || e.campaignId !== campaignId) throw new UserError(EMAIL_GONE);
}

async function assertCampaign(campaignId: number): Promise<void> {
  const c = await db.campaign.findUnique({ where: { id: campaignId }, select: { id: true } });
  if (!c) throw new UserError(CAMPAIGN_GONE);
}

export async function pauseCampaignAction(input: { campaignId: number }): Promise<ActionResult<{ status: "PAUSED" }>> {
  return run(async () => {
    const user = await requireUserAction();
    const { campaignId } = parseInput(campaignInput, input);
    await assertCampaign(campaignId);
    const res = await pauseCampaign(campaignId, user.id);
    refresh(campaignId);
    return { data: { status: res.status }, message: res.message };
  });
}

export async function resumeCampaignAction(
  input: { campaignId: number },
): Promise<ActionResult<{ status: "RUNNING" | "SCHEDULED" | "FINISHED"; lostCompanies: number }>> {
  return run(async () => {
    const user = await requireUserAction();
    const { campaignId } = parseInput(campaignInput, input);
    await assertCampaign(campaignId);
    const res = await resumeCampaign(campaignId, user.id);
    refresh(campaignId);
    return { data: { status: res.status, lostCompanies: res.lostCompanies }, message: res.message };
  });
}

export async function cancelCampaignAction(
  input: { campaignId: number },
): Promise<ActionResult<{ cancelledEmails: number; stoppedRecipients: number }>> {
  return run(async () => {
    const user = await requireUserAction();
    const { campaignId } = parseInput(campaignInput, input);
    await assertCampaign(campaignId);
    const res = await cancelCampaign(campaignId, user.id);
    refresh(campaignId);
    return { data: { cancelledEmails: res.cancelledEmails, stoppedRecipients: res.stoppedRecipients }, message: res.message };
  });
}

export async function skipRecipientAction(
  input: { campaignId: number; recipientId: number },
): Promise<ActionResult<{ skippedEmails: number; sendingNow: boolean }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(z.object({ campaignId: campaignIdSchema, recipientId: recipientIdSchema }), input);
    await assertRecipientInCampaign(data.recipientId, data.campaignId);
    const res = await skipRecipient(data.recipientId, user.id);
    refresh(data.campaignId);
    return { data: { skippedEmails: res.skippedEmails, sendingNow: res.sendingNow }, message: res.message };
  });
}

/**
 * Tries an email again. For a live campaign's "Not sure it was sent" email the person must confirm the
 * duplicate risk first (`confirmDuplicateRisk`, from the "Retry or Skip?" dialog); an email Mailgun
 * already has is never sent again.
 */
export async function retryEmailAction(
  input: { campaignId: number; emailId: number; confirmDuplicateRisk?: boolean },
): Promise<ActionResult<{ status: "QUEUED" }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(
      z.object({ campaignId: campaignIdSchema, emailId: emailIdSchema, confirmDuplicateRisk: z.boolean().optional() }),
      input,
    );
    await assertEmailInCampaign(data.emailId, data.campaignId);
    const res = await retryEmail(data.emailId, user.id, { confirmDuplicateRisk: data.confirmDuplicateRisk === true });
    refresh(data.campaignId);
    return { data: { status: res.status }, message: res.message };
  });
}

const editSchema = z.object({
  campaignId: campaignIdSchema,
  recipientId: recipientIdSchema,
  step: stepSchema,
  subject: z
    .string({ error: "Write a subject for the first email." })
    .max(EDIT_LIMITS.subject * 4, { error: `Keep the subject under ${EDIT_LIMITS.subject} characters.` })
    .nullable()
    .optional(),
  body: z
    .string({ error: "Write the email text before saving." })
    .max(EDIT_LIMITS.body * 2, { error: `Keep the email under ${EDIT_LIMITS.body.toLocaleString("en-US")} characters.` }),
});

/**
 * Saves this person's own version of one email that hasn't been sent (first email: subject and
 * text; follow-ups: text). subject null/omitted keeps the campaign's subject. Refused politely once
 * the background sender has the email ("This email is being sent right now…").
 */
export async function editUnsentEmailAction(input: z.input<typeof editSchema>): Promise<ActionResult<{ recipientId: number; step: number }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(editSchema, input);
    await assertRecipientInCampaign(data.recipientId, data.campaignId);
    const res = await editUnsentEmail(
      data.recipientId,
      data.step,
      { subject: data.step === 0 ? (data.subject ?? null) : null, body: data.body },
      user.id,
    );
    refresh(data.campaignId);
    return { data: { recipientId: res.recipientId, step: res.step }, message: res.message };
  });
}

/** Goes back to the campaign's text for one email of one person. */
export async function discardUnsentEditAction(
  input: { campaignId: number; recipientId: number; step: number },
): Promise<ActionResult<{ recipientId: number; step: number }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(z.object({ campaignId: campaignIdSchema, recipientId: recipientIdSchema, step: stepSchema }), input);
    await assertRecipientInCampaign(data.recipientId, data.campaignId);
    const res = await discardUnsentEdit(data.recipientId, data.step, user.id);
    refresh(data.campaignId);
    return { data: { recipientId: res.recipientId, step: res.step }, message: res.message };
  });
}
