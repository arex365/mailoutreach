"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseInput, runAction, UserError, type ActionResult } from "@/lib/action";
import { requireUserAction } from "@/lib/auth/dal";
import { ServiceError } from "@/server/services/companies/mutations";
import { simulateEmailEvent, simulateReply, type SimulateKind, type SimulateReplyKind } from "@/server/services/mail-events/simulate";

/**
 * The dry-run outbox's "Simulate" buttons (everyone signed in, M3-DESIGN §4.4.8, §5.9; M4-DESIGN §7.1): pretend Mailgun
 * reported a delivery, a bounce, a spam complaint or an unsubscribe for one dry-run email, or that the person answered
 * it with a reply, an out-of-office or an unclear reply. Real emails are refused.
 */

const schema = z.object({
  emailId: z.coerce.number({ error: "Pick an email." }).int().positive({ error: "Pick an email." }),
  kind: z.enum(["delivered", "bounce", "complaint", "unsubscribe"], { error: "Pick delivered, bounce, complaint or unsubscribe." }),
});

export async function simulateEmailAction(input: { emailId: number; kind: SimulateKind }): Promise<ActionResult<{ message: string }>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const { emailId, kind } = parseInput(schema, input);
    try {
      const res = await simulateEmailEvent({ id: user.id, name: user.name }, emailId, kind);
      revalidatePath("/campaigns/outbox");
      return res;
    } catch (err) {
      if (err instanceof ServiceError) throw new UserError(err.message);
      throw err;
    }
  });
}

const replySchema = z.object({
  emailId: z.coerce.number({ error: "Pick an email." }).int().positive({ error: "Pick an email." }),
  kind: z.enum(["reply", "out-of-office", "unclear"], { error: "Pick reply, out-of-office or unclear reply." }),
});

/**
 * "Reply", "Out-of-office" and "Unclear reply" (M4-DESIGN §7.1): the person answers one dry-run email; the message is
 * processed at once like a real reply. The toast says what it changed (only this campaign on real data; the company and
 * every campaign in the practice copy).
 */
export async function simulateReplyAction(input: { emailId: number; kind: SimulateReplyKind }): Promise<ActionResult<{ message: string }>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const { emailId, kind } = parseInput(replySchema, input);
    try {
      const res = await simulateReply({ id: user.id, name: user.name }, emailId, kind);
      revalidatePath("/campaigns/outbox");
      revalidatePath("/notifications");
      return res;
    } catch (err) {
      if (err instanceof ServiceError) throw new UserError(err.message);
      throw err;
    }
  });
}
