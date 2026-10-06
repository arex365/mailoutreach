import { getUserOrNull } from "@/lib/auth/dal";
import { popupTypesFor } from "@/core/notification-types";
import { latestNotificationId, popupsAfter, unreadSummary, waitingReplyCount } from "@/server/notifications";
import { aiQueueCounts } from "@/server/services/ai/queue";
import { getNotifyPrefs } from "@/server/services/users";
import type { SummaryResponse } from "@/app/(app)/settings/notifications/desktop-popups";

/**
 * GET /api/notifications/summary?after=<id> — the bell polls this (M4-DESIGN §5.2; every 20 s while the tab is
 * visible, every 60 s while it is hidden with pop-ups on in that browser). Read-only: nothing changes on GET.
 *
 * Returns the unread count and the latest 5 (the bell's menu), the user's highest notification id, how many replies
 * wait for their answer (dry-run ones not counted), the M1–M3 pop-up switch (`legacyDesktopReplies`, only the default
 * of each browser's own switch) and the desktop pop-ups: notifications with an id above `after`, of the types the
 * person's pop-up groups cover (Owner-only groups dropped for Members), from the last 10 minutes, at most 5, oldest
 * first, with how many match in total and the highest matching id. Without `after` (the first poll after a page load
 * only records `latestId`) the pop-ups are empty, so opening the app never pops old items. `aiWaiting` is how many AI
 * lines wait for review (M5-DESIGN §6.7): the bell hands it to the sidebar's "AI lines" badge.
 */

const NO_POPUPS: SummaryResponse["popups"] = { items: [], count: 0, latestId: null };

/**
 * `after` as a non-negative integer id, or null when it is missing or isn't one (treated as a first poll). Not
 * exported: a route file exports only its HTTP methods.
 */
function parseAfter(value: string | null): number | null {
  if (value === null || !/^\d{1,15}$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) ? n : null;
}

/** The Waiting count, or 0 when it can't be read (the bell's poll never fails because of the badge). */
async function aiWaitingCount(): Promise<number> {
  try {
    return (await aiQueueCounts()).waiting;
  } catch (err) {
    console.error("[summary] couldn't count the AI lines waiting for review", err);
    return 0;
  }
}

export async function GET(request: Request) {
  const user = await getUserOrNull();
  if (!user) return Response.json({ error: "Sign in again." }, { status: 401 });
  const after = parseAfter(new URL(request.url).searchParams.get("after"));
  const now = new Date();
  const prefs = await getNotifyPrefs(user.id);
  const [summary, latestId, waitingReplies, popups, aiWaiting] = await Promise.all([
    unreadSummary(user.id, 5),
    latestNotificationId(user.id),
    waitingReplyCount(user.id),
    after === null ? NO_POPUPS : popupsAfter(user.id, { after, types: popupTypesFor(prefs.popupGroups, user.role), now }),
    aiWaitingCount(),
  ]);
  const body: SummaryResponse = {
    userId: user.id,
    unread: summary.unread,
    latest: summary.latest,
    latestId,
    waitingReplies,
    legacyDesktopReplies: prefs.desktopReplies,
    popups,
    aiWaiting,
  };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
