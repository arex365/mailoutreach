/**
 * Milestone 4 contract (docs/dev/M4-DESIGN.md §5): notification types, pop-up groups, list filters and the per-user
 * preferences. Browser-safe, no I/O. The server, the summary route, the bell, the Notifications page and Settings ›
 * Notifications all use these, so a type is grouped the same way everywhere.
 */
export const REPLY_NOTIFICATION = {
  received: "reply.received",
  possible: "reply.possible",
  unlinked: "reply.unlinked",
  attention: "reply.attention",
  bounce: "reply.bounce",
  summary: "reply.summary",
  /**
   * Own-mailbox mode (MAIN-DOMAIN-DESIGN O33, §7.6): live follow-ups wait for today's inbox check; to the Owner, at most
   * once per 24 hours (notice key "inbox-check"), in the Replies pop-up group.
   */
  inboxCheck: "reply.inboxCheck",
} as const;
export const OUTAGE_HOLD_NOTIFICATION = "outage.hold";
/**
 * Milestone 5 (M5-DESIGN §2.11, §3.10): address check and AI notifications. notificationFilterOf files them under
 * "Sending and system"; they have no pop-up group.
 */
export const VERIFY_NOTIFICATION = { finished: "verify.finished", paused: "verify.paused" } as const;
export const AI_NOTIFICATION = { ready: "ai.draftsReady", paused: "ai.paused", stopped: "ai.runStopped" } as const;

export const POPUP_GROUPS = ["reply", "outage", "campaign", "sending"] as const;
export type PopupGroup = (typeof POPUP_GROUPS)[number];
export const DEFAULT_POPUP_GROUPS: readonly PopupGroup[] = ["reply"];
export const OWNER_ONLY_POPUP_GROUPS: readonly PopupGroup[] = ["sending"];
export const POPUP_GROUP_TYPES: Readonly<Record<PopupGroup, readonly string[]>> = {
  reply: ["reply.received", "reply.possible", "reply.unlinked", "reply.attention", "reply.summary", "reply.inboxCheck"],
  outage: ["outage.hold"],
  campaign: ["campaign.finished"],
  sending: ["sending.paused", "sending.warning", "email.complained"],
};
export function popupGroupOf(type: string): PopupGroup | null {
  for (const g of POPUP_GROUPS) if (POPUP_GROUP_TYPES[g].includes(type)) return g;
  return null;
}
/** The notification types a person's pop-up groups cover (Owner-only groups dropped for Members). */
export function popupTypesFor(groups: readonly PopupGroup[], role: "OWNER" | "MEMBER"): string[] {
  return groups
    .filter((g) => role === "OWNER" || !OWNER_ONLY_POPUP_GROUPS.includes(g))
    .flatMap((g) => [...POPUP_GROUP_TYPES[g]]);
}

export type NotifyPrefs = {
  popupGroups: PopupGroup[];
  /** Milestones 1–3's "Desktop pop-ups for new replies" switch: only the per-browser default now. */
  desktopReplies: boolean;
};
export function readNotifyPrefs(value: unknown): NotifyPrefs {
  const obj = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const raw = Array.isArray(obj.popupGroups) ? obj.popupGroups : null;
  const groups = raw
    ? POPUP_GROUPS.filter((g) => raw.includes(g))
    : [...DEFAULT_POPUP_GROUPS];
  return { popupGroups: groups, desktopReplies: obj.desktopReplies === true };
}

export const NOTIFICATION_FILTERS = ["all", "unread", "replies", "campaigns", "system"] as const;
export type NotificationFilter = (typeof NOTIFICATION_FILTERS)[number];
export const NOTIFICATION_FILTER_LABELS: Readonly<Record<NotificationFilter, string>> = {
  all: "All",
  unread: "Unread",
  replies: "Replies",
  campaigns: "Campaigns",
  system: "Sending and system",
};
/** Which list filter (besides All and Unread) a type belongs to. */
export function notificationFilterOf(type: string): "replies" | "campaigns" | "system" {
  if (type.startsWith("reply.")) return "replies";
  if (type.startsWith("campaign.") || type === OUTAGE_HOLD_NOTIFICATION || type === "email.unconfirmed") return "campaigns";
  return "system";
}
export function parseNotificationFilter(v: unknown): NotificationFilter {
  return typeof v === "string" && (NOTIFICATION_FILTERS as readonly string[]).includes(v) ? (v as NotificationFilter) : "all";
}
