import type { CatchUpSummary } from "@/core/system-state";
import type { JobHandler } from "@/server/jobs";
import type { MailgunContextResult } from "@/server/mailgun/context";
import { describeCatchUp, describeOldDomainProblems, runCatchUp, type CatchUpReason } from "@/server/services/mailgun/catch-up";
import { log } from "../log";
import { recordTaskSuccess } from "../periodic";
import type { JobDefinition } from "./types";

/**
 * Job "mailgun.catchUp" (M3-DESIGN §4.4.5): payload `{reason: "startup" | "hourly" | "manual"}`. Enqueued at start-up
 * and hourly by the worker (dedupe "mailgun:catchup", priority 50) and by "Check with Mailgun now". After a complete
 * run it records the periodic task "mailgun.catchUp.hourly" and calls `onSuccess` (worker/jobs/index.ts wires the
 * outage hold (M4-DESIGN §2.8.3), then the warm-up evaluation, then a health check there, so closed days are judged
 * only after the catch-up: B1 "catch up, then evaluate"); a failure of `onSuccess` is logged and never fails the
 * catch-up. An older domain the run couldn't check is named in the summary (it never fails the job: only the active
 * domain sends).
 */

export const CATCH_UP_TASK = "mailgun.catchUp.hourly";

/** The payload's reason; anything else counts as "manual". */
export function catchUpReasonFrom(payload: unknown): CatchUpReason {
  const reason = payload && typeof payload === "object" ? (payload as { reason?: unknown }).reason : undefined;
  return reason === "startup" || reason === "hourly" ? reason : "manual";
}

export function createCatchUpJob(
  deps: {
    onSuccess?: (summary: CatchUpSummary) => Promise<void>;
    mailgun?: () => Promise<MailgunContextResult>;
    /** Tests: the clock of the catch-up (its Logs window, cursors and `lastSuccessAt`). */
    now?: () => Date;
  } = {},
): JobDefinition {
  const handler: JobHandler = async (payload, ctx) => {
    const now = deps.now ? deps.now() : new Date();
    const summary = await runCatchUp({
      reason: catchUpReasonFrom(payload),
      now,
      signal: ctx.signal,
      progress: ctx.progress,
      mailgun: deps.mailgun,
    });
    await recordTaskSuccess(CATCH_UP_TASK, now);
    if (summary.domains.length > 0 && deps.onSuccess) {
      try {
        await deps.onSuccess(summary);
      } catch (err) {
        log.error("The steps after the Mailgun check (outage hold, warm-up, health) hit a problem", err);
      }
    }
    const oldDomains = describeOldDomainProblems(summary.oldDomainProblems);
    const text =
      summary.domains.length > 0
        ? `Checked with Mailgun (${summary.domains.join(", ")}): ${describeCatchUp(summary)}.${oldDomains ? ` ${oldDomains}` : ""}`
        : "Mailgun isn't connected, so there was nothing to check.";
    return {
      summary: text,
      domains: summary.domains,
      eventsApplied: summary.eventsApplied,
      suppressionsAdded: summary.suppressionsAdded,
      suppressionsPushed: summary.suppressionsPushed,
      inboundStored: summary.inboundStored,
      duplicatesFound: summary.duplicatesFound,
    };
  };
  return {
    handler,
    label: "The Mailgun check",
    whatToDo: "Open Settings › Sending & Mailgun and click Check with Mailgun now.",
    link: "/settings/sending",
  };
}
