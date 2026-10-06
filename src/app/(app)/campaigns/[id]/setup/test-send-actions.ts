"use server";

import { z } from "zod";
import type { RenderedEmail } from "@/core/templates/types";
import type { ActionResult } from "@/lib/action";
import type { TestSendInfo } from "@/server/services/test-send";

/**
 * "Send me a test" on the campaign wizard's Review step (M3-DESIGN §4.5.5, §5.8). Any signed-in user may send a test of
 * any campaign to their own reply inbox; the limits (20 a day, today's limit, one at a time) are checked by the service.
 *
 * The server-only modules are loaded inside each action, so the Review step's client component (which imports this
 * file) stays importable in unit tests that render it outside Next.
 */

async function deps() {
  const [action, dal, service] = await Promise.all([
    import("@/lib/action"),
    import("@/lib/auth/dal"),
    import("@/server/services/test-send"),
  ]);
  return { ...action, ...dal, service };
}

const infoSchema = z.object({ campaignId: z.number().int().positive() });

/** What the dialog shows when it opens: the mode, where the test goes, how many are left today, what blocks it. */
export async function testSendInfoAction(input: z.infer<typeof infoSchema>): Promise<ActionResult<TestSendInfo>> {
  const { runAction, parseInput, requireUserAction, service } = await deps();
  return runAction(async () => {
    const user = await requireUserAction();
    parseInput(infoSchema, input);
    return service.testSendInfo({ id: user.id });
  });
}

const sendSchema = z.object({
  campaignId: z.number().int().positive(),
  recipientId: z.number().int().positive(),
  step: z.number().int().min(0).max(3),
});

/** Sends this person's email to your reply inbox, or (dry run) returns it as a preview. */
export async function sendMeATestAction(
  input: z.infer<typeof sendSchema>,
): Promise<ActionResult<{ status: "sent" | "preview"; preview: RenderedEmail | null }>> {
  const { runAction, parseInput, requireUserAction, UserError, service } = await deps();
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireUserAction();
    const data = parseInput(sendSchema, input);
    try {
      const out = await service.sendMeATest({ id: user.id, name: user.name }, data);
      message = out.message;
      return { status: out.status, preview: out.preview ?? null };
    } catch (err) {
      if (err instanceof service.TestSendError) throw new UserError(err.message);
      throw err;
    }
  });
  return res.ok ? { ...res, message } : res;
}
