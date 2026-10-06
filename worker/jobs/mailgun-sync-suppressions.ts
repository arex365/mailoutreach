import type { JobHandler } from "@/server/jobs";
import { pushLocalSuppressions } from "@/server/services/mailgun/suppressions";
import type { JobDefinition } from "./types";

/**
 * Job "mailgun.syncSuppressions" (M3-DESIGN §4.4.6): pushes every local do-not-email entry Mailgun doesn't have yet to
 * the active domain's unsubscribes list. Enqueued (dedupe "mailgun:push", priority 10) after the Owner adds an address
 * or marks someone unsubscribed, and after a (new) domain is connected; the hourly catch-up also pushes (and pulls).
 */
export const runSyncSuppressions: JobHandler = async () => {
  const { pushed } = await pushLocalSuppressions();
  return {
    summary:
      pushed > 0
        ? `Sent ${pushed} ${pushed === 1 ? "address" : "addresses"} to Mailgun's do-not-email list.`
        : "Mailgun already has every address on the do-not-email list.",
    pushed,
  };
};

export const syncSuppressionsJob: JobDefinition = {
  handler: runSyncSuppressions,
  label: "Sending the do-not-email list to Mailgun",
  whatToDo: "It runs again with the next check with Mailgun. If it keeps failing, open Settings › Sending & Mailgun and check the connection.",
  link: "/settings/sending",
};
