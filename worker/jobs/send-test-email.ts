import { sendTestEmailHandler } from "@/server/services/test-send";
import type { JobDefinition } from "./types";

const WHAT_TO_DO = "Open Settings › Domain checklist › Reply test and click Send test emails to my test list again.";

/**
 * Job "send.testEmail" (M3-DESIGN §4.5.5): the reply test's emails, one per test-list mailbox (payload
 * `{purpose: "REPLY_TEST", userId}`, dedupe "send:reply-test", one try). "Send me a test" doesn't use a job: it runs in
 * the web process. Registered in worker/jobs/index.ts by the integration step (P6).
 */
export const sendTestEmailJob: JobDefinition = {
  handler: sendTestEmailHandler,
  label: "The reply test emails",
  whatToDo: WHAT_TO_DO,
  link: "/settings/domain",
  failureNotice: (_payload, error) => ({
    type: "system.mailgun",
    title: "The reply test emails weren't sent",
    body: `The reply test emails weren't sent: ${error.replace(/\.+$/, "")}. ${WHAT_TO_DO}`,
    link: "/settings/domain",
  }),
};
