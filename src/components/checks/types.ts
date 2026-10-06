import type { CheckPauseState } from "@/core/system-state";
import type { CheckEstimate } from "@/core/verification/estimate";

/**
 * Shapes the check screens pass between the Server Actions and the browser (M5-DESIGN §6.3, §6.5). Types only.
 */

/** What a Contacts or list "Check emails" covers: ticked companies, or a whole list. */
export type ChecksInput = { companyIds: number[] } | { listId: number };

/** This office month's check limit against one estimate. */
export type ChecksMonthly = { limitUsd: number; spentUsd: number; wouldPass: boolean };

/**
 * The "Check email addresses" dialog (estimateChecksAction): the counts of the check services' ContactsCheckView
 * without the person ids, plus what the dialog needs to word them.
 */
export type ChecksDialogView = {
  /** Companies counted (deleted ones aren't). */
  companies: number;
  /** Their people's addresses: need + recent + wait + cannot. */
  addresses: number;
  need: number;
  recent: number;
  wait: number;
  cannot: number;
  /** For the `need` addresses. */
  estimate: CheckEstimate;
  /** With "Check these again too" (need + recent + wait). */
  allEstimate: CheckEstimate;
  /** The monthly limit against `estimate` and `allEstimate`. */
  monthly: ChecksMonthly;
  allMonthly: ChecksMonthly;
  /** No key, an unreadable key, or a key that doesn't fit the server. */
  notReady: string | null;
  pause: CheckPauseState;
  /** The list's name for a list start, else null. */
  listName: string | null;
  /** Setting "verification.maxAgeDays" ("checked in the last 90 days"). */
  maxAgeDays: number;
  /** The practice copy: the free test checker is used. */
  practiceCopy: boolean;
  /** The viewer is the Owner (the monthly-limit sentence differs for Members). */
  isOwner: boolean;
  /** The viewer's time zone ("tried again at 14:05"). */
  timeZone: string;
};

/** What the company panel's "Check" button says about the checker (M5-DESIGN §6.5). */
export type PersonChecker = {
  /** The practice copy: the free test checker is used. */
  practiceCopy: boolean;
  /** Setting "verification.pricePerCheck" in dollars. */
  pricePerCheck: number;
};
