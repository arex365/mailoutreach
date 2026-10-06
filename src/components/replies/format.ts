import type { NotificationFilter } from "@/core/notification-types";
import { INBOUND_KIND_LABELS } from "@/core/replies/copy";
import { stepName } from "@/core/rules/wording";
import type { WaitingReplyView } from "@/server/services/replies/waiting";

/**
 * Words and links of the Notifications page (M4-DESIGN §9.1): the page's query string, and how a waiting reply's card
 * names its sender and describes it. Pure and browser-safe (the reply's own text is shown as plain text only).
 */

/** Whose waiting replies the page lists. */
export type ReplyListScope = "mine" | "everyone";

/** The Notifications page's query: list filter and page, waiting-list view and page, the pinned reply. */
export type NotificationsQuery = {
  filter?: NotificationFilter;
  page?: number;
  scope?: ReplyListScope | null;
  rpage?: number;
  reply?: number | null;
};

/**
 * `/notifications?…#hash` with only the non-default parts (filter "all", page 1 and the default view are left out), so
 * links stay short and a filter change keeps the waiting list's view.
 */
export function notificationsHref(q: NotificationsQuery = {}, hash?: "replies" | "all-notifications" | "on-hold"): string {
  const params = new URLSearchParams();
  if (q.reply) params.set("reply", String(q.reply));
  if (q.scope) params.set("scope", q.scope);
  if (q.rpage && q.rpage > 1) params.set("rpage", String(q.rpage));
  if (q.filter && q.filter !== "all") params.set("filter", q.filter);
  if (q.page && q.page > 1) params.set("page", String(q.page));
  const qs = params.toString();
  return `/notifications${qs ? `?${qs}` : ""}${hash ? `#${hash}` : ""}`;
}

/** The default waiting-list view (§4.2): everyone's for the Owner, yours for Members. */
export function defaultReplyScope(role: "OWNER" | "MEMBER"): ReplyListScope {
  return role === "OWNER" ? "everyone" : "mine";
}

/** A `?scope=` value, or null when it is missing or unknown (then the default applies). */
export function parseReplyScope(v: unknown): ReplyListScope | null {
  return v === "mine" || v === "everyone" ? v : null;
}

/**
 * How the card names the sender (§9.1 first line): a contact by name ("Anna Berg", "Ben Braun"); an address that isn't
 * a contact on a linked reply as "jonas@firma.de (not in your contacts)"; otherwise the address.
 */
export function replySenderText(r: Pick<WaitingReplyView, "fromEmail" | "fromName" | "fromIsContact" | "company">): string {
  if (r.fromName) return r.fromName;
  if (!r.fromIsContact && r.company) return `${r.fromEmail} (not in your contacts)`;
  return r.fromEmail;
}

/** The kind badge: "Reply", "Real reply?" or "Reply we couldn't link to a company" (A6 wording). */
export function replyBadgeText(kind: WaitingReplyView["kind"]): string {
  return INBOUND_KIND_LABELS[kind];
}

/**
 * The card's meta line (§9.1): "Replied 2 hours ago to “Re: 3D models for your shop” · Germany Q4 · follow-up 1 ·
 * sent by Ali", plus "· waiting for Ali" on Everyone's. A message not linked to one of our emails: "Received 2 hours
 * ago: “Your 3D offer”".
 */
export function replyMetaParts(
  r: Pick<WaitingReplyView, "receivedAgo" | "subject" | "campaign" | "senderName" | "assigneeName">,
  opts: { showAssignee: boolean },
): string[] {
  const subject = r.subject.replace(/\s+/g, " ").trim() || "(no subject)";
  const parts = [r.campaign ? `Replied ${r.receivedAgo} to “${subject}”` : `Received ${r.receivedAgo}: “${subject}”`];
  if (r.campaign) {
    parts.push(r.campaign.name, stepName(r.campaign.step));
    if (r.senderName) parts.push(`sent by ${r.senderName}`);
  }
  if (opts.showAssignee && r.assigneeName) parts.push(`waiting for ${r.assigneeName}`);
  return parts;
}

/** "Add jonas@firma.de to Firma GmbH". */
export function addSenderText(r: Pick<WaitingReplyView, "fromEmail" | "company">): string {
  return `Add ${r.fromEmail} to ${r.company?.name ?? "this company"}`;
}
