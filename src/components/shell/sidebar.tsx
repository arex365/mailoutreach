"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo, PalmMark } from "@/components/brand/logo";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  AI_WAITING_EVENT,
  MAIN_NAV,
  MOBILE_NAV,
  SETTINGS_NAV,
  isActive,
  navBadgeText,
  type NavCounts,
  type NavItem,
} from "./nav-items";

function NavLink({
  item,
  pathname,
  compact,
  count,
}: {
  item: NavItem;
  pathname: string;
  compact: boolean;
  /** The item's count (a neutral badge, hidden at 0). */
  count?: number;
}) {
  const active = isActive(pathname, item.href);
  const Icon = item.icon;
  const badge = navBadgeText(count);
  const link = (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex h-9 items-center gap-3 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        active && "bg-accent font-medium text-foreground",
        compact && "justify-center px-0",
      )}
    >
      {/* Orange means "selected": a bar on the left of the active item. */}
      {active ? <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-brand" /> : null}
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className={cn(compact && "sr-only")}>{item.label}</span>
      {badge ? (
        <>
          <span className="sr-only">, {badge} waiting for review</span>
          {/* Neutral, never orange: orange only means "primary" or "selected". */}
          <span
            aria-hidden
            data-nav-badge
            className={cn(
              "flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[10px] leading-none font-semibold text-foreground tabular",
              compact ? "absolute top-0.5 right-0.5" : "ml-auto",
            )}
          >
            {badge}
          </span>
        </>
      ) : null}
    </Link>
  );
  if (!compact) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{badge ? `${item.label} (${badge})` : item.label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The sidebar's counts: the first value comes from the `(app)` layout, later ones from AI_WAITING_EVENT (the bell's
 * summary poll, the AI lines page), so the badge follows without a page load. The search dialog's "Go to" list uses
 * it too (without a first value: the bell polls as soon as the page loads).
 */
export function useNavCounts(initial: Partial<NavCounts> | undefined): NavCounts {
  const [live, setLive] = useState<number | null>(null);
  useEffect(() => {
    const onCount = (e: Event) => {
      const n = (e as CustomEvent<unknown>).detail;
      if (typeof n === "number" && Number.isFinite(n)) setLive(Math.max(0, Math.floor(n)));
    };
    window.addEventListener(AI_WAITING_EVENT, onCount);
    return () => window.removeEventListener(AI_WAITING_EVENT, onCount);
  }, []);
  return { aiWaiting: live ?? initial?.aiWaiting ?? 0 };
}

/**
 * Desktop sidebar: full width on large screens, icons only on smaller laptop screens. "AI lines" shows how many lines
 * wait for review as a neutral badge (hidden at 0).
 */
export function Sidebar({ footer, counts }: { footer?: React.ReactNode; counts?: Partial<NavCounts> }) {
  const pathname = usePathname();
  const live = useNavCounts(counts);
  const countOf = (item: NavItem) => (item.count ? live[item.count] : undefined);
  return (
    <>
      <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar 2xl:flex">
        <div className="flex h-14 items-center px-4">
          <Link href="/dashboard" className="rounded-md">
            <Logo subtitle="Outreach" />
          </Link>
        </div>
        <nav aria-label="Main" className="flex flex-1 flex-col gap-0.5 px-2 py-2">
          {MAIN_NAV.map((item) => (
            <NavLink key={item.href} item={item} pathname={pathname} compact={false} count={countOf(item)} />
          ))}
        </nav>
        <div className="flex flex-col gap-0.5 border-t border-sidebar-border px-2 py-2">
          <NavLink item={SETTINGS_NAV} pathname={pathname} compact={false} />
          {footer}
        </div>
      </aside>
      <aside className="sticky top-0 hidden h-dvh w-14 shrink-0 flex-col items-stretch border-r border-sidebar-border bg-sidebar md:flex 2xl:hidden">
        <div className="flex h-14 items-center justify-center">
          <Link href="/dashboard" aria-label="Polygon Paradise Outreach" className="rounded-md p-1">
            <PalmMark />
          </Link>
        </div>
        <nav aria-label="Main" className="flex flex-1 flex-col gap-0.5 px-2 py-2">
          {MAIN_NAV.map((item) => (
            <NavLink key={item.href} item={item} pathname={pathname} compact count={countOf(item)} />
          ))}
        </nav>
        <div className="flex flex-col gap-0.5 border-t border-sidebar-border px-2 py-2">
          <NavLink item={SETTINGS_NAV} pathname={pathname} compact />
        </div>
      </aside>
    </>
  );
}

/**
 * Phone bottom bar: Dashboard, Contacts, Campaigns, Notifications. Settings is in the account menu; AI lines,
 * Templates, Import and Activity are in the top bar's search ("Go to", QUICK_LINKS).
 */
export function MobileNav() {
  const pathname = usePathname();
  const items = MOBILE_NAV;
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 flex h-14 border-t border-border bg-sidebar md:hidden"
    >
      {items.map((item) => {
        const active = isActive(pathname, item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] text-muted-foreground",
              active && "text-foreground",
            )}
          >
            {active ? <span aria-hidden className="absolute inset-x-5 top-0 h-[3px] rounded-full bg-brand" /> : null}
            <Icon className="size-5" aria-hidden />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
