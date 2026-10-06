import type { WaitingByUser } from "@/core/dashboard/replies";
import { db } from "@/server/db";
import { waitingReplyWhere } from "@/server/notifications";

/**
 * The dashboard's waiting replies per person (M6-DESIGN §4.2 item 5, §4.3 "Waiting replies rule", D9). Read-only
 * (§0.2 rule 8): one `groupBy` and one user lookup, no per-row query.
 */

/**
 * Waiting replies per assignee by the bell's rule (`waitingReplyWhere`: processed, not answered, REPLY /
 * POSSIBLE_REPLY / UNLINKED, dry-run replies not counted), active users only (a switched-off user's replies moved to
 * the Owner). Most first, then by name; users with nothing waiting are not listed. `waitingReplyCount(userId)` gives
 * the same number for one user.
 */
export async function waitingReplyCountsByUser(): Promise<WaitingByUser[]> {
  const groups = await db.inboundMessage.groupBy({
    by: ["assigneeId"],
    where: waitingReplyWhere({ assigneeId: { not: null } }),
    _count: { _all: true },
  });
  const counts = new Map<number, number>();
  for (const g of groups) {
    if (g.assigneeId !== null && g._count._all > 0) counts.set(g.assigneeId, g._count._all);
  }
  if (counts.size === 0) return [];
  const users = await db.user.findMany({
    where: { id: { in: [...counts.keys()] }, active: true },
    select: { id: true, name: true },
  });
  return users
    .map((u) => ({ userId: u.id, name: u.name, count: counts.get(u.id) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.userId - b.userId);
}
