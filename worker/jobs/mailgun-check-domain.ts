import type { JobHandler } from "@/server/jobs";
import { runDomainCheck } from "@/server/services/checks/domain-check";
import { recordTaskSuccess } from "../periodic";
import type { JobDefinition } from "./types";

/**
 * Job "mailgun.checkDomain" (M3-DESIGN §4.4.7): payload `{verify?: boolean}` (true also asks Mailgun to re-check the
 * DNS records, at most once a minute). Enqueued every 6 hours by the periodic task "mailgun.domainCheck.6h" (dedupe
 * "mailgun:domain-check", priority 20), after connecting, after a send's 404, and by "Check again" on the Domain
 * checklist. Writes SystemState "domain.check", which the checklist, the mode gates and the send holds read.
 */

export const DOMAIN_CHECK_TASK = "mailgun.domainCheck.6h";

export function verifyFromPayload(payload: unknown): boolean {
  return Boolean(payload && typeof payload === "object" && (payload as { verify?: unknown }).verify === true);
}

export const runCheckDomain: JobHandler = async (payload) => {
  const state = await runDomainCheck({ verify: verifyFromPayload(payload) });
  await recordTaskSuccess(DOMAIN_CHECK_TASK);
  if (!state.domain) return { summary: state.error ?? "Mailgun isn't connected yet.", rows: 0, done: 0 };
  const done = state.rows.filter((r) => r.status === "ok").length;
  const bad = state.rows.filter((r) => r.status === "bad").length;
  return {
    summary: `Domain checklist for ${state.domain}: ${done} of ${state.rows.length} rows done${bad ? `, ${bad} need fixing` : ""}.`,
    rows: state.rows.length,
    done,
    bad,
  };
};

export const checkDomainJob: JobDefinition = {
  handler: runCheckDomain,
  label: "The domain check",
  whatToDo: "Open Settings › Domain checklist and click Check again.",
  link: "/settings/domain",
};
