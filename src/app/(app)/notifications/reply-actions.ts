"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { plural } from "@/core/text";
import { parseInput, runAction, UserError, type ActionResult } from "@/lib/action";
import { requireUserAction } from "@/lib/auth/dal";
import type { SessionUser } from "@/lib/auth/session";
import { CampaignError } from "@/server/services/campaigns/errors";
import { ServiceError } from "@/server/services/companies/mutations";
import {
  addReplySender,
  confirmReply,
  getLinkCompany,
  linkReply,
  markReplyAnswered,
  markReplyNotNeeded,
  reopenReply,
  type LinkCompanyView,
  type ReplyActor,
} from "@/server/services/replies";
import { releaseOutageHold } from "@/server/services/sequences/holds";

/**
 * The decisions on "Replies waiting for an answer" and the On hold card (M4-DESIGN §9.1, §9.10): thin wrappers of the
 * reply services. Everyone signed in may act on any waiting reply (SPEC §1, D17); each decision is logged with who made
 * it. Every action answers with the sentence to toast (`data.message`) or the plain error.
 */

const NOTIFICATIONS_PATH = "/notifications";

function actorOf(user: SessionUser): ReplyActor {
  return { id: user.id, name: user.name, role: user.role };
}

/** The service's own sentences become the action's error; anything else stays "something went wrong". */
async function plain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ServiceError || err instanceof CampaignError) throw new UserError(err.message);
    throw err;
  }
}

const idSchema = z.object({
  id: z.coerce.number({ error: "This reply isn't on the list any more. Refresh the page." }).int().positive({
    error: "This reply isn't on the list any more. Refresh the page.",
  }),
});

/** "Answered": the reply leaves the waiting list (Undo in the toast). */
export async function markReplyAnsweredAction(input: { id: number }): Promise<ActionResult<{ message: string }>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const { id } = parseInput(idSchema, input);
    const res = await plain(() => markReplyAnswered(actorOf(user), id));
    revalidatePath(NOTIFICATIONS_PATH);
    return res;
  });
}

/** "No answer needed": the reply leaves the waiting list (Undo in the toast). */
export async function markReplyNotNeededAction(input: { id: number }): Promise<ActionResult<{ message: string }>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const { id } = parseInput(idSchema, input);
    const res = await plain(() => markReplyNotNeeded(actorOf(user), id));
    revalidatePath(NOTIFICATIONS_PATH);
    return res;
  });
}

/** The toast's Undo after Answered / No answer needed: back on the waiting list. */
export async function reopenReplyAction(input: { id: number }): Promise<ActionResult<{ message: string }>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const { id } = parseInput(idSchema, input);
    const res = await plain(() => reopenReply(actorOf(user), id));
    revalidatePath(NOTIFICATIONS_PATH);
    return res;
  });
}

const confirmSchema = idSchema.extend({ real: z.boolean({ error: "Choose Real reply or It was an auto-reply." }) });

/** "Real reply" (`real: true`) or "It was an auto-reply" (`real: false`) on a possible reply. */
export async function confirmReplyAction(input: { id: number; real: boolean }): Promise<ActionResult<{ message: string }>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const { id, real } = parseInput(confirmSchema, input);
    const res = await plain(() => confirmReply(actorOf(user), id, real));
    revalidatePath(NOTIFICATIONS_PATH);
    return res;
  });
}

const linkSchema = idSchema.extend({
  companyId: z.coerce.number({ error: "Pick a company first." }).int().positive({ error: "Pick a company first." }),
  personId: z.coerce.number().int().positive().nullable().optional(),
  addPerson: z.boolean().optional(),
  real: z.boolean().optional(),
});

/** "Link reply" in the Link dialog: links an unlinked reply to a company (and optionally adds the sender as a person). */
export async function linkReplyAction(input: {
  id: number;
  companyId: number;
  personId?: number | null;
  addPerson?: boolean;
  real?: boolean;
}): Promise<ActionResult<{ message: string }>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const data = parseInput(linkSchema, input);
    const res = await plain(() =>
      linkReply(actorOf(user), data.id, { companyId: data.companyId, personId: data.personId ?? null, addPerson: data.addPerson, real: data.real }),
    );
    revalidatePath(NOTIFICATIONS_PATH);
    revalidatePath("/contacts");
    return res;
  });
}

/** "Add jonas@firma.de to Firma GmbH": the reply's sender becomes a person at the reply's company. */
export async function addReplySenderAction(input: { id: number }): Promise<ActionResult<{ message: string }>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const { id } = parseInput(idSchema, input);
    const res = await plain(() => addReplySender(actorOf(user), id));
    revalidatePath(NOTIFICATIONS_PATH);
    revalidatePath("/contacts");
    return res;
  });
}

const companySchema = z.object({
  companyId: z.coerce.number({ error: "Pick a company first." }).int().positive({ error: "Pick a company first." }),
});

/** The Link dialog's picked company: its name and people for the "Person" select (read only). */
export async function replyLinkCompanyAction(input: { companyId: number }): Promise<ActionResult<LinkCompanyView>> {
  return runAction(async () => {
    await requireUserAction();
    const { companyId } = parseInput(companySchema, input);
    const company = await getLinkCompany(companyId);
    if (!company || company.deleted) throw new UserError("This company was deleted. Pick another one.");
    return company;
  });
}

/**
 * "I've checked my inbox" on the On hold card (M4-DESIGN §2.8.3, §9.1): the viewer's own follow-ups held after a long
 * outage continue (and colleagues' first emails at companies nobody else still has to check).
 */
export async function continueMyFollowUpsAction(): Promise<ActionResult<{ message: string; released: number }>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const res = await plain(() => releaseOutageHold(actorOf(user), { senderId: user.id }));
    revalidatePath(NOTIFICATIONS_PATH);
    const message =
      res.released > 0
        ? `Thanks. Follow-ups of ${plural(res.released, "person", "people")} continue.`
        : `Thanks. First emails to ${plural(res.firstEmails, "person", "people")} continue.`;
    return { message, released: res.released };
  });
}
