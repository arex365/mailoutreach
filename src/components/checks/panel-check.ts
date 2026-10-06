import { aboutUsd } from "@/core/money";
import type { CheckSingleOutcome } from "@/core/verification/types";
import { checkedTodayText, checkOutcomeToast, reasonWords } from "@/core/verification/words";
import type { PersonChecker } from "./types";

/**
 * The company panel's address check on one person (M5-DESIGN §6.5): the button's tooltip, the confirmation, the toast
 * once the run is done, the reason line under a result and the "Did you mean" texts. Pure and browser-safe.
 */

/** "about $0.01", or "free" for a price of $0. */
function priceWords(price: number): string {
  return price > 0 ? aboutUsd(price) : "free";
}

/** The Check button's tooltip: "Check this address with Mailgun (about $0.01)". */
export function checkButtonTip(c: PersonChecker): string {
  return c.practiceCopy ? "Check this address with the test checker (free)" : `Check this address with Mailgun (${priceWords(c.pricePerCheck)})`;
}

/** The disabled button's tooltip within 24 hours of a real check: "anna@firma.de was checked today already." */
export function checkedTodayTip(email: string): string {
  return checkedTodayText(email);
}

/** The popover: "Check anna@firma.de? About $0.01." (practice copy: "… Free with the test checker."). */
export function checkConfirmText(email: string, c: PersonChecker): string {
  if (c.practiceCopy) return `Check ${email}? Free with the test checker.`;
  const price = priceWords(c.pricePerCheck);
  return `Check ${email}? ${price.charAt(0).toUpperCase()}${price.slice(1)}.`;
}

/** A finished panel run as its screen reads it (the check services' CheckRunView, reduced). */
export type PanelRunResult = {
  status: string;
  single: CheckSingleOutcome | null;
  /** The plain sentence of a failed run. */
  error: string | null;
};

export type PanelCheckToast = {
  tone: "success" | "info" | "error";
  text: string;
  /** Mailgun's scrubbed refusal text, for a "Details" disclosure. */
  detail: string | null;
};

/** The toast once a panel run has finished (M5-DESIGN §6.5; the sentences are the check services' words). */
export function panelCheckToast(email: string, run: PanelRunResult, opts: { practiceCopy?: boolean } = {}): PanelCheckToast {
  if (run.status === "FAILED") {
    return { tone: "error", text: run.error || "The check couldn't finish. Try again in a few minutes.", detail: null };
  }
  if (run.status === "CANCELLED") return { tone: "info", text: `The check of ${email} was stopped before it finished.`, detail: null };
  const single = run.single;
  if (!single) return { tone: "info", text: "The check has finished. Refresh the page to see the result.", detail: null };
  const text = checkOutcomeToast(email, single, { practiceCopy: opts.practiceCopy });
  if (single.outcome === "refused") return { tone: "error", text, detail: single.detail };
  if (single.outcome === "not-reached") return { tone: "error", text, detail: null };
  if (single.outcome === "checked" && single.decision === "send") return { tone: "success", text, detail: null };
  return { tone: "info", text, detail: null };
}

/**
 * The muted line under a result that isn't "Valid": the reason words of the latest check ("This mailbox doesn't
 * exist."), each sentence once; a code the app has no words for is shown as received. Null for a valid or unchecked
 * address, or when the check gave no reason.
 */
export function checkReasonLine(status: string | null | undefined, reasons: readonly string[] | null | undefined): string | null {
  if (!status || status === "VALID" || !reasons || reasons.length === 0) return null;
  const words = [...new Set(reasons.map((r) => reasonWords(r).trim()).filter(Boolean))];
  return words.length > 0 ? words.join(" ") : null;
}

/** "Did you mean anna@yahoo.com?" */
export function didYouMeanText(suggestion: string): string {
  return `Did you mean ${suggestion}?`;
}

/** The confirmation of "Use this address": title and body. */
export function didYouMeanConfirm(suggestion: string): { title: string; description: string } {
  return { title: `Change the address to ${suggestion}?`, description: "It needs a new check afterwards." };
}
