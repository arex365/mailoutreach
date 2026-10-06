import type { ChecklistRow, ChecklistRowKey } from "@/core/system-state";

/** The Domain checklist rows that "Apply recommended settings" sets up (M6-DESIGN §5.1 R1). */
export const APPLY_FIXES_ROWS: readonly ChecklistRowKey[] = [
  "tracking-off",
  "unsubscribe",
  "spam-filter",
  "retention",
  "signing-key",
  "webhooks",
  "reply-routes",
  "https-links",
];

/**
 * Whether "Apply recommended settings" is the page's orange button (R1): only while a row it fixes still needs it (not
 * done, needs a look, or couldn't be checked), and before the domain was ever checked; otherwise it is outline. A row
 * that is only "for your information" or switched off on purpose (Setup B's unsubscribe row) doesn't count.
 */
export function applyIsPrimary(rows: ReadonlyArray<Pick<ChecklistRow, "key" | "status">>): boolean {
  if (rows.length === 0) return true;
  return rows.some((r) => APPLY_FIXES_ROWS.includes(r.key) && r.status !== "ok" && r.status !== "info" && r.status !== "off");
}
