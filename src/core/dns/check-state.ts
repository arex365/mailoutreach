import { repliesOf, type RepliesMode } from "@/core/sending/own-mailbox";
import type { DomainCheckState } from "@/core/system-state";

/**
 * Stored checklist rows belong to one way of sending (MAIN-DOMAIN-DESIGN O36, §5): `DomainCheckState.replies` records
 * the mode the rows were built for (missing = "app", every check stored before this field). Every reader that already
 * ignores another domain's rows also ignores rows of the other mode, so after a same-domain mode switch the old mode's
 * rows never pass a gate until the check the switch queued has run. Pure.
 */
export function checkMatchesMode(state: Pick<DomainCheckState, "replies">, replies: RepliesMode): boolean {
  return repliesOf(state.replies) === replies;
}
