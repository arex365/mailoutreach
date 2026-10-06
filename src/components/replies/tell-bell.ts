import { NOTIFICATIONS_CHANGED_EVENT } from "@/components/shell/notification-bell";

/**
 * Tells the bell in the top bar to refresh now (its unread count and "replies waiting for your answer" line) instead of
 * at its next check. Browser only: call it from event handlers of client components.
 */
export function tellBell(): void {
  window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
}
