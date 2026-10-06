"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseInput, runAction, UserError, type ActionResult } from "@/lib/action";
import { requireUserAction } from "@/lib/auth/dal";
import { checkStartToast } from "@/core/verification/words";
import { CheckRunError } from "@/server/services/verification/runs";
import { campaignCheckView, type CampaignCheckView } from "@/server/services/verification/select";
import { startCheckRun, stopCheckRun } from "@/server/services/verification/start";

/**
 * Server Actions of the wizard's step 4 "Verify" (M5-DESIGN §6.1, §6.11): the step's counts and cost, starting the
 * campaign's checks with the count the person saw (the server counts again and refuses a changed count), and Stop,
 * which acts on address check runs only. Members may do all of it (SPEC §1).
 */

const campaignId = z
  .number({ error: "This campaign doesn't exist any more. Refresh the page." })
  .int()
  .positive({ error: "This campaign doesn't exist any more. Refresh the page." });
const REFRESH = "Something on this page is out of date. Refresh it and try again.";
const jobId = z.number({ error: REFRESH }).int({ error: REFRESH }).positive({ error: REFRESH });

/** The check services' plain refusals become the action's error text. */
async function checks<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CheckRunError) throw new UserError(err.message);
    throw err;
  }
}

/** Every wizard page shows fresh data after a start or a stop. */
function refreshWizard() {
  revalidatePath("/campaigns/[id]/setup", "layout");
}

/** The Verify step's data: what needs a check, the cost, the monthly limit, the run and who is left out. */
export async function campaignCheckViewAction(input: { campaignId: number }): Promise<ActionResult<CampaignCheckView>> {
  return runAction(async () => {
    await requireUserAction();
    const data = parseInput(z.object({ campaignId }), input);
    return checks(() => campaignCheckView(data.campaignId));
  });
}

/**
 * "Check 40 addresses" (or a dry run's "Check them anyway"): one run of the campaign's addresses that need a check,
 * the first 5,000 by person id. Refused while checks are paused, without a key, over this month's check limit, or
 * when the count changed since the page was loaded.
 */
export async function startCampaignChecksAction(input: {
  campaignId: number;
  confirmedCount: number;
}): Promise<ActionResult<{ jobId: number; count: number }>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireUserAction();
    const data = parseInput(
      z.object({
        campaignId,
        confirmedCount: z.number({ error: REFRESH }).int({ error: REFRESH }).min(1, { error: "There's nothing to check here." }),
      }),
      input,
    );
    const started = await checks(() =>
      startCheckRun({ id: user.id, name: user.name, role: user.role }, { source: "wizard", campaignId: data.campaignId, confirmedCount: data.confirmedCount }),
    );
    refreshWizard();
    message = checkStartToast(started.count);
    return started;
  });
  return res.ok ? { ...res, message } : res;
}

/** "Stop checking": only an address check run can be stopped here (never a backup or a Mailgun task). */
export async function stopChecksAction(input: { jobId: number }): Promise<ActionResult<null>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireUserAction();
    const data = parseInput(z.object({ jobId }), input);
    const stopped = await checks(() => stopCheckRun({ id: user.id, name: user.name }, data.jobId));
    refreshWizard();
    message = stopped.message;
    return null;
  });
  return res.ok ? { ...res, message } : res;
}
