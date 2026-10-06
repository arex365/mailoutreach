import { syncRoutesHandler } from "@/server/services/mailgun/routes";
import type { JobDefinition } from "./types";

const WHAT_TO_DO = "Open Settings › Domain checklist and click Apply recommended settings.";

/**
 * Job "mailgun.syncRoutes" (M3-DESIGN §4.5.4, dedupe "mailgun:routes"): brings every reply route in Mailgun in line with
 * the sending addresses and reply inboxes. Registered in worker/jobs/index.ts by the integration step (P6).
 */
export const syncRoutesJob: JobDefinition = {
  handler: syncRoutesHandler,
  label: "Updating the reply routes",
  whatToDo: WHAT_TO_DO,
  link: "/settings/domain",
  failureNotice: (_payload, error) => ({
    type: "system.replyRoute",
    title: "The reply routes couldn't be updated",
    body: `Updating the reply routes in Mailgun didn't finish: ${error.replace(/\.+$/, "")}. ${WHAT_TO_DO}`,
    link: "/settings/domain",
  }),
};
