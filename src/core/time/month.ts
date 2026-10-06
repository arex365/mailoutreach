/** Milestone 5 contract: the office month (Setting "sending.capDayTimeZone") for the AI limit and spend lines. */
import { Temporal } from "temporal-polyfill";
import { FALLBACK_CAP_ZONE, safeZone } from "@/core/sending/capday";

export type MonthBounds = { start: Date; end: Date; label: string; resetLabel: string };

function monthName(d: Temporal.PlainDate): string {
  return new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(d.year, d.month - 1, 1)));
}

/** The month containing `now` in `timeZone`: [start, end), "September", "1 October". DST-safe (Temporal). */
export function monthBounds(now: Date, timeZone: string): MonthBounds {
  const zone = safeZone(timeZone, FALLBACK_CAP_ZONE);
  const first = Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(zone).toPlainDate().with({ day: 1 });
  const next = first.add({ months: 1 });
  return {
    start: new Date(first.toZonedDateTime({ timeZone: zone }).epochMilliseconds),
    end: new Date(next.toZonedDateTime({ timeZone: zone }).epochMilliseconds),
    label: monthName(first),
    resetLabel: `1 ${monthName(next)}`,
  };
}
