import { notifyOwner as notifyOwnerShared } from "@/server/notifications";

export type OwnerNotice = {
  /** Notification type, e.g. "task.failed". */
  type: string;
  title: string;
  /** Plain words: what happened and what to do. */
  body: string;
  link?: string | null;
};

/**
 * Sends a notification to the Owner (there is always exactly one). Returns false when there's no Owner yet.
 * Goes through @/server/notifications, so the link is checked (same-app paths only) and the texts are cut to size
 * like every other notification.
 */
export async function notifyOwner(notice: OwnerNotice): Promise<boolean> {
  const created = await notifyOwnerShared({ type: notice.type, title: notice.title, body: notice.body, link: notice.link ?? null });
  return created !== null;
}
