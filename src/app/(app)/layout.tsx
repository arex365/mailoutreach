import { requireUser } from "@/lib/auth/dal";
import { getSendingState } from "@/server/sending-state";
import { aiQueueCounts } from "@/server/services/ai/queue";
import { MobileNav, Sidebar } from "@/components/shell/sidebar";
import { SendingPill } from "@/components/shell/sending-pill";
import { UserMenu } from "@/components/shell/user-menu";
import { CommandMenu } from "@/components/shell/command-menu";
import { NotificationBell } from "@/components/shell/notification-bell";
import { NavigationGuardRoot } from "@/components/navigation/nav-guard";

/** The sidebar's first "AI lines" count (the bell's poll keeps it current); 0 when it can't be read. */
async function firstAiWaiting(): Promise<number> {
  try {
    return (await aiQueueCounts()).waiting;
  } catch (err) {
    console.error("[layout] couldn't count the AI lines waiting for review", err);
    return 0;
  }
}

/**
 * The signed-in app frame. NOTE: layouts don't re-render on navigation, so every
 * page still calls requireUser()/requireOwner() itself (PLAN.md B7).
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [sending, aiWaiting] = await Promise.all([getSendingState(), firstAiWaiting()]);
  return (
    <div className="flex min-h-dvh">
      {/* The one "leave without saving?" guard for the tab (links, Ctrl+K, the bell, browser Back). */}
      <NavigationGuardRoot />
      <Sidebar counts={{ aiWaiting }} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur">
          <div className="min-w-0 flex-1">
            <CommandMenu />
          </div>
          <SendingPill state={sending} isOwner={user.role === "OWNER"} />
          <NotificationBell />
          <UserMenu name={user.name} email={user.email} role={user.role} />
        </header>
        <main id="main" className="min-w-0 flex-1 pb-16 md:pb-0">
          {children}
        </main>
      </div>
      <MobileNav />
    </div>
  );
}
