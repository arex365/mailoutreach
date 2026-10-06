import type { JobHandler } from "@/server/jobs";
import type { MailgunContextResult } from "@/server/mailgun/context";
import { markRestoreScanFailed, runRestoreScan } from "@/server/services/sending/restore";
import type { JobDefinition } from "./types";

/**
 * Job "mailgun.restoreScan" `{pass: 1 | 2}` (M3-DESIGN §4.3.7): the check with Mailgun after a
 * restore, queued by handleRestoreMarker at worker start-up (pass 1) and by pass 1 for 35 minutes
 * after the restore (pass 2). When it fails for good (also when the worker kept stopping while it ran:
 * resetOrphanedJobs runs this failureNotice too), the restore is marked "failed" and sending pauses
 * again (kind "restore"): emails through Mailgun stay held until the Owner resumes with the "may go
 * out a second time" confirmation. The worker's start-up (settleRestoreCheck) repeats that if the
 * marking itself failed.
 */

/** Payload `{pass: 1 | 2}`; anything else is pass 1. */
export function restorePassFromPayload(payload: unknown): 1 | 2 {
  const pass = payload && typeof payload === "object" ? (payload as { pass?: unknown }).pass : undefined;
  return pass === 2 ? 2 : 1;
}

/**
 * The registry's clock and Mailgun context (`createJobRegistry` deps, as the catch-up takes them): tests run the check
 * on their fixed clock, so its log window never depends on the PC's real date. The worker passes neither (real time,
 * the saved keys).
 */
export type RestoreScanJobDeps = {
  now?: () => Date;
  mailgun?: () => Promise<MailgunContextResult>;
};

export function createRestoreScanJobHandler(deps: RestoreScanJobDeps = {}): JobHandler {
  return async (payload, ctx) => {
    const pass = restorePassFromPayload(payload);
    const report = await runRestoreScan({ pass, signal: ctx.signal, progress: ctx.progress, now: deps.now?.(), mailgun: deps.mailgun });
    return restoreScanResult(pass, report);
  };
}

export const runRestoreScanJob: JobHandler = createRestoreScanJobHandler();

function restoreScanResult(pass: 1 | 2, report: Awaited<ReturnType<typeof runRestoreScan>>) {
  const summary = !report.mailgunChecked
    ? "Mailgun couldn't be checked for emails sent after the backup."
    : `Checked Mailgun for emails sent after the backup (pass ${pass} of 2): ${report.matchedByMessageId + report.matchedBySendId + report.matchedByRecipient} confirmed as sent, ${report.externalSends} the backup didn't know about, ${report.madeUnconfirmed} marked "Not sure it was sent".`;
  return {
    summary,
    pass,
    mailgunChecked: report.mailgunChecked,
    acceptedEvents: report.acceptedEvents,
    rowsCreated: report.rowsCreated,
    externalSends: report.externalSends,
    madeUnconfirmed: report.madeUnconfirmed,
  };
}

const WHAT_TO_DO =
  "Open Settings › Sending & Mailgun. Emails through Mailgun stay held until you resume and confirm that emails sent after the backup may go out a second time.";

/** The job definition with the registry's deps (`createJobRegistry`); `restoreScanJob` is the worker's own (no deps). */
export function createRestoreScanJob(deps: RestoreScanJobDeps = {}): JobDefinition {
  return {
    handler: deps.now || deps.mailgun ? createRestoreScanJobHandler(deps) : runRestoreScanJob,
    label: "The restore check with Mailgun",
    whatToDo: WHAT_TO_DO,
    link: "/settings/sending",
    failureNotice: (_payload, error) => {
      void markRestoreScanFailed(error).catch((err: unknown) => console.error("[restore] couldn't mark the check as failed", err));
      return {
        type: "restore.checked",
        title: "The restore check with Mailgun failed",
        body: `The app couldn't check Mailgun for emails sent after the backup: ${error.replace(/\.+$/, "")}. ${WHAT_TO_DO}`,
        link: "/settings/sending",
      };
    },
  };
}

export const restoreScanJob: JobDefinition = createRestoreScanJob();
