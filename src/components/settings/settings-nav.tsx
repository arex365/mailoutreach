"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  DatabaseBackup,
  Gauge,
  ListChecks,
  PanelBottom,
  Send,
  Server,
  ShieldCheck,
  Sparkles,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

type SettingsItem = { href: string; label: string; icon: LucideIcon };

const EVERYONE: SettingsItem[] = [
  { href: "/settings/profile", label: "My profile", icon: UserRound },
  { href: "/settings/notifications", label: "Notifications", icon: Bell },
  { href: "/settings/backups", label: "Backups", icon: DatabaseBackup },
];

/** Owner pages, in this order (M3-DESIGN §5.1, M5-DESIGN §6.9): the sending pages, AI, then Team and System. */
export const OWNER_SETTINGS: SettingsItem[] = [
  { href: "/settings/sending", label: "Sending & Mailgun", icon: Send },
  { href: "/settings/domain", label: "Domain checklist", icon: ListChecks },
  { href: "/settings/limits", label: "Limits & warm-up", icon: Gauge },
  { href: "/settings/deliverability", label: "Deliverability", icon: ShieldCheck },
  { href: "/settings/footer", label: "Email footer", icon: PanelBottom },
  { href: "/settings/ai", label: "AI", icon: Sparkles },
  { href: "/settings/team", label: "Team", icon: Users },
  { href: "/settings/system", label: "System", icon: Server },
];
const OWNER = OWNER_SETTINGS;

function isCurrent(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

function SideLink({ item, active }: { item: SettingsItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex h-9 items-center gap-2.5 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        active && "bg-accent font-medium text-foreground",
      )}
    >
      {/* Orange means "selected": a bar on the left of the current page. */}
      {active ? <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-brand" /> : null}
      <Icon className="size-4 shrink-0" aria-hidden />
      {item.label}
    </Link>
  );
}

function TopTab({ item, active }: { item: SettingsItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex h-10 shrink-0 items-center px-3 text-sm whitespace-nowrap text-muted-foreground hover:text-foreground",
        active && "font-medium text-foreground",
      )}
    >
      {item.label}
      {active ? <span aria-hidden className="absolute inset-x-2 bottom-0 h-[3px] rounded-full bg-brand" /> : null}
    </Link>
  );
}

/**
 * Settings sub-navigation: a left list on laptops, scrollable top tabs on phones.
 * Members don't see the Owner group (the Owner pages also refuse them).
 */
export function SettingsNav({ isOwner }: { isOwner: boolean }) {
  const pathname = usePathname();
  const all = isOwner ? [...EVERYONE, ...OWNER] : EVERYONE;
  return (
    <>
      <nav aria-label="Settings" className="-mx-4 border-b border-border px-2 md:hidden">
        <div className="flex overflow-x-auto">
          {all.map((item) => (
            <TopTab key={item.href} item={item} active={isCurrent(pathname, item.href)} />
          ))}
        </div>
      </nav>
      <nav aria-label="Settings" className="hidden w-52 shrink-0 md:block">
        <div className="flex flex-col gap-0.5">
          {EVERYONE.map((item) => (
            <SideLink key={item.href} item={item} active={isCurrent(pathname, item.href)} />
          ))}
        </div>
        {isOwner ? (
          <div className="mt-5">
            <p className="px-3 pb-1.5 text-xs font-medium text-muted-foreground">Owner</p>
            <div className="flex flex-col gap-0.5">
              {OWNER.map((item) => (
                <SideLink key={item.href} item={item} active={isCurrent(pathname, item.href)} />
              ))}
            </div>
          </div>
        ) : null}
      </nav>
    </>
  );
}
