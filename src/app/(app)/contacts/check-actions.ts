"use server";

import { z } from "zod";
import { parseInput, runAction, UserError, type ActionResult } from "@/lib/action";
import { requireUserAction } from "@/lib/auth/dal";
import type { SessionUser } from "@/lib/auth/session";
import { roundUsd } from "@/core/money";
import { checkStartToast } from "@/core/verification/words";
import type { ChecksDialogView, ChecksMonthly } from "@/components/checks/types";
import { getSettings } from "@/server/settings";
import { CheckRunError, checkRunView, type CheckRunView } from "@/server/services/verification/runs";
import { contactsCheckView } from "@/server/services/verification/select";
import { startCheckRun, stopCheckRun, type CheckRunActor } from "@/server/services/verification/start";

/**
 * Server Actions for address checks started outside the wizard (M5-DESIGN §6.3, §6.5, §6.11): the Contacts and list
 * "Check email addresses" dialog (count and cost, start), the company panel's "Check" on one person, a finished run's
 * counts and one-address outcome, and Stop. Members may start checks (SPEC §1); the check services refuse in plain
 * words (paused, no key, the count changed, the monthly limit, checked in the last 24 hours), and Stop acts on
 * address check runs only.
 */

const REFRESH = "Something on this page is out of date. Refresh it and try again.";
const id = z.number({ error: REFRESH }).int({ error: REFRESH }).positive({ error: REFRESH });
/** The check services refuse more than 10,000 companies in their own words; this only keeps the body sane. */
const companyIds = z.array(z.number({ error: REFRESH }).int({ error: REFRESH }), { error: REFRESH }).max(50_000, {
  error: "You can check the addresses of up to 10,000 companies at a time. Tick fewer and try again.",
});
const inputSchema = z.union([z.object({ companyIds }), z.object({ listId: id })], { error: REFRESH });

function actorOf(user: SessionUser): CheckRunActor {
  return { id: user.id, name: user.name, role: user.role };
}

/** The check services' plain refusals become the action's error text. */
async function checks<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CheckRunError) throw new UserError(err.message);
    throw err;
  }
}

/** The monthly limit against another estimate of the same view (free runs never pass it). */
function monthlyFor(limitUsd: number, spentUsd: number, aboutUsd: number): ChecksMonthly {
  return { limitUsd, spentUsd, wouldPass: aboutUsd > 0 && roundUsd(spentUsd + aboutUsd) > limitUsd };
}

/** The "Check email addresses" dialog's counts, cost and readiness for ticked companies or a list. */
export async function estimateChecksAction(input: { companyIds: number[] } | { listId: number }): Promise<ActionResult<ChecksDialogView>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const data = parseInput(inputSchema, input);
    const [v, s] = await Promise.all([
      checks(() => contactsCheckView("listId" in data ? { listId: data.listId } : { companyIds: data.companyIds })),
      getSettings(["verification.maxAgeDays"] as const),
    ]);
    const maxAge = Number(s["verification.maxAgeDays"]);
    return {
      companies: v.companies,
      addresses: v.addresses,
      need: v.need,
      recent: v.recent,
      wait: v.wait,
      cannot: v.cannot,
      estimate: v.estimate,
      allEstimate: v.allEstimate,
      monthly: v.monthly,
      allMonthly: monthlyFor(v.monthly.limitUsd, v.monthly.spentUsd, v.allEstimate.aboutUsd),
      notReady: v.notReady,
      pause: v.pause,
      listName: v.listName,
      maxAgeDays: Number.isInteger(maxAge) && maxAge > 0 ? maxAge : 90,
      practiceCopy: v.estimate.provider === "fake",
      isOwner: user.role === "OWNER",
      timeZone: user.timeZone,
    };
  });
}

const startSchema = z.object({
  companyIds: companyIds.optional(),
  listId: id.optional(),
  recheckRecent: z.boolean({ error: REFRESH }),
  confirmedCount: z.number({ error: REFRESH }).int({ error: REFRESH }).min(1, { error: "There's nothing to check here." }),
});

/**
 * "Check N addresses": the server counts again and refuses when the number changed since the dialog opened ("The
 * number of addresses changed. Open the dialog again to see the new count and cost."), then starts one run.
 */
export async function startChecksAction(input: {
  companyIds?: number[];
  listId?: number;
  recheckRecent: boolean;
  confirmedCount: number;
}): Promise<ActionResult<{ jobId: number; count: number }>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireUserAction();
    const data = parseInput(startSchema, input);
    const started = await checks(() => {
      if (data.listId !== undefined) {
        return startCheckRun(actorOf(user), {
          source: "list",
          listId: data.listId,
          recheckRecent: data.recheckRecent,
          confirmedCount: data.confirmedCount,
        });
      }
      if (!data.companyIds) throw new UserError(REFRESH);
      return startCheckRun(actorOf(user), {
        source: "contacts",
        companyIds: data.companyIds,
        recheckRecent: data.recheckRecent,
        confirmedCount: data.confirmedCount,
      });
    });
    message = checkStartToast(started.count);
    return started;
  });
  return res.ok ? { ...res, message } : res;
}

/** The company panel's "Check" on one person (refused within 24 hours of a real check of the address). */
export async function checkPersonAction(input: { personId: number }): Promise<ActionResult<{ jobId: number }>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const data = parseInput(z.object({ personId: id }), input);
    const started = await checks(() => startCheckRun(actorOf(user), { source: "panel", personId: data.personId }));
    return { jobId: started.jobId };
  });
}

/**
 * A check run for its screen once the poll says it has finished (or while it runs): status, progress, counts, the
 * one-address outcome of panel and Settings runs, and who its results leave out. Refuses any other job type.
 */
export async function checkRunViewAction(input: { jobId: number }): Promise<ActionResult<CheckRunView>> {
  return runAction(async () => {
    await requireUserAction();
    const data = parseInput(z.object({ jobId: id }), input);
    return checks(() => checkRunView(data.jobId));
  });
}

/** "Stop checking" in the dialog: only an address check run can be stopped here (never a backup or a Mailgun task). */
export async function stopChecksAction(input: { jobId: number }): Promise<ActionResult<null>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireUserAction();
    const data = parseInput(z.object({ jobId: id }), input);
    const stopped = await checks(() => stopCheckRun({ id: user.id, name: user.name }, data.jobId));
    message = stopped.message;
    return null;
  });
  return res.ok ? { ...res, message } : res;
}
