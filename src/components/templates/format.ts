import { plural } from "@/core/text";
import { formatDateTime, timeAgo } from "@/core/time/format";

/**
 * Pure display helpers for the Templates screens (no React, no I/O), unit-tested.
 */

/** "First email only", "First email + 2 follow-ups", "First email + 3 follow-ups (1 switched off)". */
export function sequenceSummary(t: { followUps: number; followUpsOn: number }): string {
  if (t.followUps <= 0) return "First email only";
  const off = t.followUps - t.followUpsOn;
  const base = `First email + ${plural(t.followUps, "follow-up", "follow-ups")}`;
  return off > 0 ? `${base} (${off} switched off)` : base;
}

/** "Changed 3 days ago by Ali" / "… by you". */
export function changedLabel(
  t: { updatedAt: Date; updatedBy: { id: number; name: string } | null },
  viewer: { id: number },
  now: Date = new Date(),
): string {
  const who = t.updatedBy ? (t.updatedBy.id === viewer.id ? "you" : t.updatedBy.name) : null;
  return `Changed ${timeAgo(t.updatedAt, now)}${who ? ` by ${who}` : ""}`;
}

export function changedTitle(t: { updatedAt: Date }, timeZone: string): string {
  return formatDateTime(t.updatedAt, timeZone);
}

/** Serializable row for the list (server → client). */
export type TemplateListItem = {
  id: number;
  name: string;
  isMaster: boolean;
  summary: string;
  /** The first email's subject template, or null when it hasn't been written yet. */
  subject: string | null;
  changed: string;
  changedTitle: string;
};
