import { runVerifyAddresses, type VerifyRunDeps } from "@/server/services/verification/run";
import { log } from "../log";
import type { JobDefinition } from "./types";

export { enqueueDueRechecks, VERIFY_RECHECK_TASK } from "@/server/services/verification/recheck-sweep";

/**
 * "verify.addresses" (docs/dev/M5-DESIGN.md §2.5, P6): the address checks of one run (the wizard's Verify step,
 * Contacts or a list's "Check emails", the company panel's "Check", Settings' "Test address checks", or the re-check
 * sweep). It runs in the worker's `checks` lane; the work itself is `runVerifyAddresses`
 * (@/server/services/verification/run). P11 registers it in `createJobRegistry` and the periodic task
 * `VERIFY_RECHECK_TASK` (every 15 minutes) that calls `enqueueDueRechecks`.
 *
 * A run that fails for good (e.g. the key was removed after the start) gets the runner's generic notice: "The address
 * checks didn't finish: <why>. Open the campaign's Verify step or Contacts and start the checks again."
 */
export function createVerifyAddressesJob(deps: VerifyRunDeps = {}): JobDefinition {
  return {
    handler: (payload, ctx) => runVerifyAddresses(payload, ctx, { logger: log, ...deps }),
    label: "The address checks",
    whatToDo: "Open the campaign's Verify step or Contacts and start the checks again.",
    link: null,
  };
}

/** The job definition the worker registers (P11: `"verify.addresses": verifyAddressesJob`). */
export const verifyAddressesJob: JobDefinition = createVerifyAddressesJob();
