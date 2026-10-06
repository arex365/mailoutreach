import { Temporal } from "temporal-polyfill";
import { parseLocalDateTime } from "./format";

/**
 * The Schedule step's start time is typed as wall-clock time in the viewer's own time zone
 * (SPEC: show times in each user's own time zone). This turns it into the UTC instant stored in
 * Campaign.startAt. Daylight-saving gaps and overlaps use Temporal's "compatible" rule (the same as
 * the sending window, PLAN.md B6.6). Used by the server action; kept out of client bundles.
 */
export function localDateTimeToUtc(value: string, timeZone: string): Date | null {
  const p = parseLocalDateTime(value);
  if (!p) return null;
  const plain = Temporal.PlainDateTime.from({ year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute });
  let zoned: Temporal.ZonedDateTime;
  try {
    zoned = plain.toZonedDateTime(timeZone, { disambiguation: "compatible" });
  } catch {
    zoned = plain.toZonedDateTime("UTC");
  }
  return new Date(zoned.epochMilliseconds);
}
