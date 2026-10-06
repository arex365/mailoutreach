import { plural } from "@/core/text";

/**
 * The Schedule step's address-check note and its launch-phase counts (M5-DESIGN §6.1 "Schedule step"). The draft
 * counts people whose addresses still need a check as getting the email (they are tickable); launch leaves them out.
 * So the Schedule counts, "fits today's limit" and the launch confirmation subtract them, while people waiting for a
 * second check stay in (they become "Waiting for re-check" at launch). Pure and browser-safe.
 */

/** The check services' campaignLaunchCheckNote: ticked people who still need a check / wait for their second check. */
export type LaunchCheckNote = { unchecked: number; secondCheck: number };

export const NO_CHECK_NOTE: LaunchCheckNote = { unchecked: 0, secondCheck: 0 };

/** "40 people with unchecked addresses will be left out when you launch." (null when nobody). */
export function uncheckedLaunchLine(unchecked: number): string | null {
  if (unchecked <= 0) return null;
  return `${plural(unchecked, "person with an unchecked address", "people with unchecked addresses")} will be left out when you launch.`;
}

/** "2 people wait for a second address check. Their first email goes out once it passes." (null when nobody). */
export function secondCheckLaunchLine(secondCheck: number): string | null {
  if (secondCheck <= 0) return null;
  return `${plural(secondCheck, "person waits", "people wait")} for a second address check. Their first email goes out once it passes.`;
}

/**
 * The launch phase's "people" and today's fit: the summary's people minus the unchecked ones, and `fits` recomputed
 * from what is left of today's limit (null when no limit applies, as in the summary).
 */
export function launchPhaseCounts(
  summary: { people: number; today: { left: number } | null; fits: { today: number; later: number } | null },
  note: LaunchCheckNote,
): { people: number; fits: { today: number; later: number } | null } {
  const people = Math.max(0, summary.people - Math.max(0, note.unchecked));
  if (!summary.today || !summary.fits) return { people, fits: null };
  const today = Math.min(people, Math.max(0, summary.today.left));
  return { people, fits: { today, later: Math.max(0, people - today) } };
}
