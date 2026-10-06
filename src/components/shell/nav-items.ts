import {
  BarChart3,
  Bell,
  Building2,
  FileText,
  History,
  Inbox,
  Mail,
  MailPlus,
  MailX,
  Settings,
  Sparkles,
  Upload,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown in the phone bottom bar. */
  mobile?: boolean;
  /** A count shown as a neutral badge next to the label (hidden at 0), e.g. the AI lines waiting for review. */
  count?: "aiWaiting";
};

export const MAIN_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: BarChart3, mobile: true },
  { href: "/contacts", label: "Contacts", icon: Building2, mobile: true },
  { href: "/campaigns", label: "Campaigns", icon: Mail, mobile: true },
  { href: "/templates", label: "Templates", icon: FileText },
  { href: "/ai-lines", label: "AI lines", icon: Sparkles, count: "aiWaiting" },
  { href: "/import", label: "Import", icon: Upload },
  { href: "/activity", label: "Activity", icon: History },
];

export const SETTINGS_NAV: NavItem = { href: "/settings", label: "Settings", icon: Settings };

export const NOTIFICATIONS_NAV: NavItem = { href: "/notifications", label: "Notifications", icon: Bell };

/**
 * The phone bottom bar (PLAN.md A6): Dashboard, Contacts, Campaigns, Notifications.
 * Settings stays reachable from the account menu in the top bar.
 */
export const MOBILE_NAV: NavItem[] = [...MAIN_NAV.filter((i) => i.mobile), NOTIFICATIONS_NAV];

/** One entry of the search dialog's "Go to" list (the top bar's "Search companies…", Ctrl+K). */
export type QuickLink = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Starts a draft with a click (a Server Action) instead of opening `href`: a link never creates one. */
  startsCampaign?: true;
  /** A count shown next to the label (hidden at 0), as in the sidebar. */
  count?: NavItem["count"];
};

/** Entries that follow a main screen in the "Go to" list. */
const QUICK_LINK_EXTRAS: Readonly<Record<string, readonly QuickLink[]>> = {
  "/contacts": [{ href: "/contacts?view=missing-email", label: "Missing email view", icon: MailX }],
  "/campaigns": [
    { href: "/campaigns/new", label: "New campaign", icon: MailPlus, startsCampaign: true },
    { href: "/campaigns/outbox", label: "Dry-run outbox", icon: Inbox },
  ],
};

function quickLinkOf(item: NavItem): QuickLink {
  return { href: item.href, label: item.label, icon: item.icon, ...(item.count ? { count: item.count } : {}) };
}

/**
 * The search dialog's "Go to" list: every screen of the sidebar in its order (built from MAIN_NAV, so a new screen is
 * never left out), a few extra entries after their screen, then Settings. On a phone the sidebar is hidden and the
 * bottom bar has four items, so this list is how a phone reaches the other screens (AI lines, Templates, Import…).
 */
export const QUICK_LINKS: readonly QuickLink[] = [
  ...MAIN_NAV.flatMap((item) => [quickLinkOf(item), ...(QUICK_LINK_EXTRAS[item.href] ?? [])]),
  quickLinkOf(SETTINGS_NAV),
];

export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

/** The counts the sidebar shows next to its items (M5-DESIGN §6.7: "AI lines" with the Waiting count). */
export type NavCounts = { aiWaiting: number };

/**
 * Fired on `window` with the new "AI lines" Waiting count (`detail`: a number): by the bell after each summary poll and
 * by the AI lines page after it rendered, so the sidebar badge follows without a page load.
 */
export const AI_WAITING_EVENT = "pp:ai-waiting";

/** A count as the badge shows it: "27", "99+"; null (no badge) at 0 or for anything that isn't a count. */
export function navBadgeText(count: number | null | undefined): string | null {
  const n = typeof count === "number" && Number.isFinite(count) ? Math.floor(count) : 0;
  if (n <= 0) return null;
  return n > 99 ? "99+" : n.toLocaleString("en-US");
}

/** The count next to a "Go to" entry as its badge shows it ("27", "99+"), or null (no count, or 0). */
export function quickLinkBadge(link: QuickLink, counts: NavCounts): string | null {
  return link.count ? navBadgeText(counts[link.count]) : null;
}

/** Tells the sidebar the Waiting count (browser only; does nothing on the server). */
export function publishAiWaiting(count: number): void {
  if (typeof window === "undefined" || !Number.isFinite(count)) return;
  try {
    window.dispatchEvent(new CustomEvent<number>(AI_WAITING_EVENT, { detail: Math.max(0, Math.floor(count)) }));
  } catch {
    // No window events (tests): the badge updates at the next page load.
  }
}
