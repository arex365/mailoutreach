import { plural } from "@/core/text";
import type { CheckEstimate } from "@/core/verification/estimate";
import { MAX_CHECKS_PER_RUN } from "@/core/verification/types";
import { checkCostLine, monthlyLimitRefusal, tooManyChecksText } from "@/core/verification/words";
import { PAUSED_FALLBACK_TEXT } from "./run-text";
import type { ChecksDialogView } from "./types";

/**
 * The words of the Contacts and list "Check email addresses" dialog (M5-DESIGN §6.3), from the counts the check
 * services made under the live check context. Pure and browser-safe, so every state is unit-tested.
 */

export const CHECKS_DIALOG_TITLE = "Check email addresses";

/** The toast when the dialog is closed while its run goes on (M5-DESIGN §6.3). */
export const DIALOG_CLOSED_NOTE = "You can close this window. The checks keep running, and you get a notification when they're done.";

const num = (v: number): string => Math.max(0, Math.floor(v)).toLocaleString("en-US");

export type ChecksDialogLine = { kind: "need" | "recent" | "wait" | "cannot"; text: string };

export type ChecksDialogModel = {
  /** "37 companies · 52 addresses" (list: "Germany Q4 · 45 companies · 61 addresses"). */
  countsLine: string;
  /** Non-zero lines only, in the design's order. */
  lines: ChecksDialogLine[];
  /** "Check these again too (10)": shown when some addresses were checked recently or wait for their 24 hours. */
  recheck: { label: string; count: number } | null;
  /** The addresses "Check N addresses" checks (with or without the recent ones). */
  count: number;
  estimate: CheckEstimate;
  /** The cost line of §2.10, or null when nothing would be checked. */
  costLine: string | null;
  /** "Every address here was checked in the last 90 days." and the like, when nothing would be checked. */
  nothing: string | null;
  /** Why the check can't start: paused, not ready, too many, over the monthly limit. */
  blocker: string | null;
  canStart: boolean;
  /** "Check 40 addresses" ("Check addresses" while there is nothing to check). */
  startLabel: string;
};

/** The dialog's counts line, lines, cost and whether "Check N addresses" can start (`recheck`: the box is ticked). */
export function checksDialogModel(view: ChecksDialogView, recheck: boolean): ChecksDialogModel {
  const countsLine = `${view.listName ? `${view.listName} · ` : ""}${plural(view.companies, "company", "companies")} · ${plural(
    view.addresses,
    "address",
    "addresses",
  )}`;

  const lines: ChecksDialogLine[] = [];
  if (view.need > 0) lines.push({ kind: "need", text: view.need === 1 ? "1 needs a check" : `${num(view.need)} need a check` });
  if (view.recent > 0) {
    lines.push({
      kind: "recent",
      text: `${view.recent === 1 ? "1 was" : `${num(view.recent)} were`} checked in the last ${num(view.maxAgeDays)} days`,
    });
  }
  if (view.wait > 0) {
    lines.push({
      kind: "wait",
      text:
        view.wait === 1
          ? "1 got no answer less than 24 hours ago; it can be checked again after that."
          : `${num(view.wait)} got no answer less than 24 hours ago; they can be checked again after that.`,
    });
  }
  if (view.cannot > 0) {
    lines.push({
      kind: "cannot",
      text: `${num(view.cannot)} can't be checked: no email address, on the do-not-email list, or never emailed (company status).`,
    });
  }

  const again = view.recent + view.wait;
  const useAll = recheck && again > 0;
  const estimate = useAll ? view.allEstimate : view.estimate;
  const monthly = useAll ? view.allMonthly : view.monthly;
  const count = estimate.count;

  let nothing: string | null = null;
  if (count === 0) {
    if (again > 0) nothing = `Every address here was checked in the last ${num(view.maxAgeDays)} days.`;
    else if (view.addresses === 0) nothing = "These companies have no email addresses to check.";
    else nothing = "None of these addresses can be checked.";
  }

  let blocker: string | null = null;
  if (view.pause.paused) blocker = view.pause.text || PAUSED_FALLBACK_TEXT;
  else if (view.notReady) blocker = view.notReady;
  else if (count > MAX_CHECKS_PER_RUN) blocker = tooManyChecksText(count);
  else if (count > 0 && monthly.wouldPass) {
    blocker = monthlyLimitRefusal({ limitUsd: monthly.limitUsd, spentUsd: monthly.spentUsd, isOwner: view.isOwner });
  }

  return {
    countsLine,
    lines,
    recheck: again > 0 ? { label: `Check these again too (${num(again)})`, count: again } : null,
    count,
    estimate,
    costLine: count > 0 ? checkCostLine(estimate) : null,
    nothing,
    blocker,
    canStart: count > 0 && blocker === null,
    startLabel: count > 0 ? `Check ${plural(count, "address", "addresses")}` : "Check addresses",
  };
}
