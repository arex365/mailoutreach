import { parseNotices } from "@/core/system-state-parse";
import { STATE_KEYS, type NoticesState, type StateKey } from "@/core/system-state";
import { casState, getState } from "./state";

/**
 * Typed helpers over SystemState (M3-DESIGN §4.2.7). Every read goes through one of the lenient parsers in
 * @/core/system-state-parse, so a missing or damaged row reads as its default and never throws.
 * Writes are compare-and-set: a change computed from a stale value is never written.
 */

export type Parsed<T> = { value: T; version: number | null };

/** The parsed value and the row version (null = no row yet, which casState treats as "must not exist"). */
export async function readTyped<T>(key: StateKey, parse: (v: unknown) => T): Promise<Parsed<T>> {
  const row = await getState<unknown>(key);
  return { value: parse(row ? row.value : null), version: row ? row.version : null };
}

/** Thrown when a SystemState row kept changing under us for every try (heavy contention; retry later). */
export class StateConflictError extends Error {
  constructor(readonly key: StateKey, tries: number) {
    super(`SystemState "${key}" kept changing; gave up after ${tries} tries.`);
    this.name = "StateConflictError";
  }
}

/**
 * Read → change → compare-and-set, re-reading and retrying when another writer got there first.
 * `change` gets the current parsed value and returns the new value, or null for "nothing to write". It may run
 * more than once (once per try), so it must not have side effects: do those after this returns.
 * Returns whether it wrote and the value now stored (the current one when nothing was written).
 * Throws StateConflictError after `tries` lost races.
 */
export async function updateTyped<T>(
  key: StateKey,
  parse: (v: unknown) => T,
  change: (current: T) => T | null,
  tries = 5,
): Promise<{ written: boolean; value: T }> {
  for (let i = 0; i < tries; i++) {
    const cur = await readTyped(key, parse);
    const next = change(cur.value);
    if (next === null) return { written: false, value: cur.value };
    if (await casState(key, cur.version, next)) return { written: true, value: next };
  }
  throw new StateConflictError(key, tries);
}

/** How often each throttled Owner notice may be sent (M3-DESIGN §2.3: "at most one per key per 24 h"). */
export const NOTICE_EVERY_MS = 24 * 3_600_000;
/** Notice timestamps older than this are dropped when the map is written, so it stays small. */
const NOTICE_FORGET_MS = 30 * 24 * 3_600_000;
/** A stored time this far in the future means the PC clock went back: don't let it block notices. */
const CLOCK_SKEW_MS = 60_000;

/**
 * True (and the time recorded, by compare-and-set on "notices") when the notice `noticeKey` wasn't sent in the last
 * `everyMs`; false when it was, so the caller skips the notification. Safe with both processes calling it at once:
 * only one of them gets true.
 */
export async function shouldSendNotice(noticeKey: string, now: Date, everyMs = NOTICE_EVERY_MS): Promise<boolean> {
  const t = now.getTime();
  const res = await updateTyped<NoticesState>(STATE_KEYS.notices, parseNotices, (cur) => {
    const last = cur[noticeKey] ? Date.parse(cur[noticeKey]!) : NaN;
    if (!Number.isNaN(last) && t - last < everyMs && last - t <= CLOCK_SKEW_MS) return null;
    const next: NoticesState = {};
    for (const [k, at] of Object.entries(cur)) {
      if (t - Date.parse(at) < NOTICE_FORGET_MS) next[k] = at;
    }
    next[noticeKey] = now.toISOString();
    return next;
  });
  return res.written;
}
