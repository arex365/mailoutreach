/**
 * The warm-up line (M6-DESIGN §2.6): one sentence about the ramp, the same on every screen (go-live card, Limits &
 * warm-up, dashboard). `today` comes from `loadWarmupToday(now)`; `null` gives the "how it goes up" form, which is
 * always true. Pure and browser-safe.
 *
 * "How it goes up" follows the Owner's own warm-up settings (review SCREENS-10), like the Limits page's explanation:
 * "at least half the limit used" only at the default 50 % ("at least 80% of the limit used" otherwise, Setting
 * "warmup.minUsePercent"), and "a weekday" only while the sending days are Monday to Friday ("a sending day"
 * otherwise, Setting "sending.window"). Without the settings (null `today` and no `rule`), the defaults' words.
 */

/**
 * M6 contract (M6-DESIGN §2.6): the warm-up line on every screen. "Step" is the ramp's step, not a day count. Pure.
 * `weekdaysOnly` (review SCREENS-10): the sending days are exactly Monday to Friday; missing counts as yes (the default
 * window).
 */
export type WarmupToday = { sendingDay: boolean; used: number; cap: number; minUsePercent: number; healthy: boolean; weekdaysOnly?: boolean };

/** How a step is earned, from the settings (review SCREENS-10); a missing field is the default (50 %, Monday to Friday). */
export type WarmupRiseRule = { minUsePercent?: number; weekdaysOnly?: boolean };

/** The sending days (1 = Monday … 7 = Sunday, Setting "sending.window") are exactly Monday to Friday. */
export function isWeekdaysOnly(days: readonly number[]): boolean {
  const set = new Set(days);
  return set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d));
}

/** Setting "warmup.minUsePercent" as the warm-up judges it: a whole percent from 1 to 100, 50 when unreadable. */
export function warmupUsePercent(minUsePercent: unknown): number {
  const typed = Math.round(Number(minUsePercent));
  return Number.isFinite(typed) && typed > 0 ? Math.min(typed, 100) : 50;
}

/**
 * The condition of a rise in the Owner's settings: "weekday with at least half the limit used", "sending day with at
 * least 80% of the limit used", "weekday with all of the limit used". The sentences put "after a" / "after each" in
 * front of it.
 */
export function warmupRiseCondition(rule: WarmupRiseRule | null | undefined): string {
  const p = warmupUsePercent(rule?.minUsePercent ?? 50);
  const use = p === 100 ? "all of the limit used" : p === 50 ? "at least half the limit used" : `at least ${p}% of the limit used`;
  return `${rule?.weekdaysOnly === false ? "sending day" : "weekday"} with ${use}`;
}

export function warmupLine(step: number, table: readonly number[], today: WarmupToday | null, rule?: WarmupRiseRule | null): string {
  const n = (v: number) => v.toLocaleString("en-US");
  if (table.length === 0) return "Warm-up finished.";
  const last = table.length - 1;
  // A step that isn't a number counts as the first step (never a screen that throws; parsed states are always whole).
  const i = Math.min(Math.max(0, Math.floor(step) || 0), last);
  if (i >= last) return `Warm-up finished: ${n(table[last]!)} a day.`;
  const head = `Warm-up step ${i + 1} of ${table.length}: ${n(table[i]!)} a day.`;
  const qualifying =
    today !== null && today.sendingDay && today.healthy && today.used * 100 >= today.cap * today.minUsePercent;
  // The rule given wins; else today's facts carry the same settings.
  const words = warmupRiseCondition({
    minUsePercent: rule?.minUsePercent ?? today?.minUsePercent,
    weekdaysOnly: rule?.weekdaysOnly ?? today?.weekdaysOnly,
  });
  return qualifying
    ? `${head} Tomorrow ${n(table[i + 1]!)}, if today's numbers stay healthy.`
    : `${head} It goes up to ${n(table[i + 1]!)} after a ${words} and healthy numbers.`;
}
