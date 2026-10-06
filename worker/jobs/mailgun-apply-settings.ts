import { applySettingsHandler, parseApplyPayload } from "@/server/services/mailgun/apply-settings";
import type { JobDefinition } from "./types";

const WHAT_TO_DO = "Open Settings › Domain checklist and click Apply recommended settings again.";

/**
 * Job "mailgun.applySettings" (M3-DESIGN §4.5.2): "Apply recommended settings" (payload `{step: "all"}`, dedupe
 * "mailgun:apply") and each certificate poll (`{step: "certificate-poll", attempt}`, dedupe "mailgun:cert-poll").
 * Registered in worker/jobs/index.ts by the integration step (P6).
 */
export const applySettingsJob: JobDefinition = {
  handler: applySettingsHandler,
  label: "Apply recommended settings",
  whatToDo: WHAT_TO_DO,
  link: "/settings/domain",
  failureNotice: (payload, error) => {
    const poll = parseApplyPayload(payload).step === "certificate-poll";
    const what = poll ? "Checking the certificate for secure unsubscribe links" : "Apply recommended settings";
    return {
      type: "system.mailgun",
      title: poll ? "The certificate check didn't finish" : "Apply recommended settings didn't finish",
      body: `${what} didn't finish: ${error.replace(/\.+$/, "")}. ${WHAT_TO_DO}`,
      link: "/settings/domain",
    };
  },
};
