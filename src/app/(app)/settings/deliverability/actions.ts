"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseInput, runAction, UserError, type ActionResult } from "@/lib/action";
import { requireOwnerAction } from "@/lib/auth/dal";
import { ServiceError } from "@/server/services/companies/mutations";
import { saveHealthThresholds, thresholdsSchema, thresholdWarnings } from "@/server/services/mail-events/deliverability";
import { addManualSuppression, removeOwnSuppression } from "@/server/services/mailgun/suppressions";

/**
 * Settings › Deliverability actions (Owner only, M3-DESIGN §5.5): the health thresholds, adding an address to the
 * do-not-email list, and taking a test-list address or a teammate's reply inbox off it.
 */

const PAGE = "/settings/deliverability";

function asUserError(err: unknown): never {
  if (err instanceof ServiceError) throw new UserError(err.message, err.fieldErrors);
  throw err;
}

/**
 * Saves the six thresholds; returns the amber warnings for limits above Mailgun's own. The dashboard's Domain health
 * tile shows "your limit" too, so every page is refreshed (M6-DESIGN §5.1 R5).
 */
export async function saveHealthThresholdsAction(input: {
  bounceWindow: number | string;
  bouncePercent: number | string;
  complaintWindow: number | string;
  complaintPercent: number | string;
  healthyBouncePercent: number | string;
  healthyComplaintPercent: number | string;
}): Promise<ActionResult<{ changed: number; warnings: { bounce: string | null; complaint: string | null } }>> {
  return runAction(async () => {
    const user = await requireOwnerAction();
    const values = parseInput(thresholdsSchema, input);
    const { changed } = await saveHealthThresholds({ id: user.id, name: user.name }, values);
    revalidatePath("/", "layout");
    return { changed: changed.length, warnings: thresholdWarnings(values) };
  }, "Thresholds saved.");
}

const addSchema = z.object({
  email: z.string({ error: "Enter an email address." }).trim().min(1, { error: "Enter an email address." }).max(320, { error: "That address is too long." }),
  reason: z.enum(["UNSUBSCRIBED", "MANUAL"], { error: "Choose Unsubscribed or Do not email." }),
});

/** "Add an address": on the do-not-email list for every sender; every email waiting for it stops. */
export async function addSuppressionAction(input: {
  email: string;
  reason: "UNSUBSCRIBED" | "MANUAL";
}): Promise<ActionResult<{ created: boolean; stopped: number }>> {
  return runAction(async () => {
    const user = await requireOwnerAction();
    const data = parseInput(addSchema, input);
    const res = await addManualSuppression({ id: user.id, name: user.name }, data).catch(asUserError);
    revalidatePath(PAGE);
    return res;
  }, "Added to the do-not-email list.");
}

const removeSchema = z.object({
  email: z.string({ error: "Pick an address." }).trim().min(1, { error: "Pick an address." }).max(320),
});

/** "Remove": only test-list addresses and active users' reply inboxes (anyone else stays on the list for good). */
export async function removeOwnSuppressionAction(input: { email: string }): Promise<ActionResult<{ removed: boolean; note: string | null }>> {
  return runAction(async () => {
    const user = await requireOwnerAction();
    const { email } = parseInput(removeSchema, input);
    const res = await removeOwnSuppression({ id: user.id, name: user.name }, email).catch(asUserError);
    if (!res.removed) throw new UserError(`${email} isn't on the do-not-email list any more. Refresh the page.`);
    revalidatePath(PAGE);
    return { removed: true, note: res.mailgunProblem };
  }, "Taken off the do-not-email list.");
}
