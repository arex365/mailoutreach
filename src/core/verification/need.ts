import {
  checkNeedFromReasons,
  personReasons,
  type EligibilityContext,
  type PersonFacts,
  type VerificationPolicy,
} from "@/core/rules/eligibility";
import { LIVE_CHECK_CONTEXT, type CheckNeed } from "./types";

/**
 * Who needs an address check (M5-DESIGN §2.8 rule 8). Pure and browser-safe.
 *
 * The Verify step counts with the campaign's own context. Contacts, list and panel checks and the check job's skip
 * rule use `liveCheckContext`: what a live campaign after go-live would need, whatever the sending mode, so they count
 * and check the right people also in dry-run mode and before go-live (D38).
 */

/**
 * "check" (never checked, only by the test checker, older than the maximum age, or two "no answer"s 30 days ago),
 * "second-check" (one "no answer" whose 24 hours are over), "wait" (inside them) or "none" (also in a dry run and for
 * test-list addresses before go-live).
 */
export function checkNeedOf(person: PersonFacts, ctx: EligibilityContext): CheckNeed {
  return checkNeedFromReasons(personReasons(person, ctx).reasons, person, ctx);
}

/** True for the needs that the Verify step and the Contacts dialog count as "needs a check". */
export function needsCheck(need: CheckNeed): boolean {
  return need === "check" || need === "second-check";
}

/**
 * The live check context: the contract `LIVE_CHECK_CONTEXT` (mode LIVE, phase launch, go-live on, the test-list
 * exception off) with an empty test list, plus `now` and the check settings.
 */
export function liveCheckContext(
  s: { maxCheckAgeDays: number; policy: VerificationPolicy; realProviders: ReadonlySet<string> },
  now: Date,
): EligibilityContext {
  return {
    ...LIVE_CHECK_CONTEXT,
    now,
    maxCheckAgeDays: s.maxCheckAgeDays,
    policy: s.policy,
    realProviders: s.realProviders,
    testList: new Set<string>(),
  };
}
