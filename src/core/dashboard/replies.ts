/**
 * The dashboard's "Replies waiting for an answer" line (M6-DESIGN §4.2 item 5, §4.3 "Waiting replies rule"; PLAN A6
 * "You 3 · Ali 1"). The counts come from `waitingReplyCountsByUser()` (one definition with the bell, D9); this file
 * only words them. Pure and browser-safe.
 */

/** One active user's waiting replies (processed, not answered, not a dry-run reply). */
export type WaitingByUser = { userId: number; name: string; count: number };

/** At most this many people are named; the rest become "· 2 more people". */
export const WAITING_LINE_MAX_NAMES = 4;

const n = (v: number) => v.toLocaleString("en-US");

/**
 * "Replies waiting for an answer: You 3 · Ali 1": the viewer first as "You", then everyone else by count (most first)
 * and name; at most 4 people named, then "· 1 more person" / "· 2 more people". People with nothing waiting are left
 * out; null when nobody has anything waiting. Rows of the same user are added up.
 */
export function waitingRepliesLine(rows: readonly WaitingByUser[], viewerId: number): string | null {
  const byUser = new Map<number, { name: string; count: number }>();
  for (const r of rows) {
    const count = Number.isFinite(r.count) ? Math.max(0, Math.floor(r.count)) : 0;
    if (count === 0) continue;
    const cur = byUser.get(r.userId);
    if (cur) cur.count += count;
    else byUser.set(r.userId, { name: r.name.trim() || "Someone", count });
  }
  if (byUser.size === 0) return null;

  const viewer = byUser.get(viewerId);
  const others = [...byUser.entries()]
    .filter(([id]) => id !== viewerId)
    .map(([, v]) => v)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  const people = [...(viewer ? [{ name: "You", count: viewer.count }] : []), ...others];
  const shown = people.slice(0, WAITING_LINE_MAX_NAMES).map((p) => `${p.name} ${n(p.count)}`);
  const more = people.length - shown.length;
  if (more > 0) shown.push(`${n(more)} more ${more === 1 ? "person" : "people"}`);
  return `Replies waiting for an answer: ${shown.join(" · ")}`;
}
