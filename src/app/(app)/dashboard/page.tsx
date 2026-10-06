import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/dal";
import { DashboardScreen } from "@/components/dashboard/dashboard-screen";
import { NoticeToast } from "@/components/shell/notice-toast";
import { loadDashboard } from "./load";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * The dashboard (M6-DESIGN §4): everyone's home. What needs attention first, the viewer's own replies waiting for an
 * answer, then how sending is going. Read at request time (it depends on the session) and refreshed every minute while
 * the tab is visible. Members sent here from an Owner-only page (`?notice=owner-only`) see "Only the Owner can open
 * that page."
 */
export default async function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  const user = await requireUser();
  const sp = await searchParams;
  const notice = Array.isArray(sp.notice) ? (sp.notice[0] ?? null) : (sp.notice ?? null);
  const now = new Date();
  const view = await loadDashboard(user, now);
  return (
    <>
      <DashboardScreen view={view} viewer={{ id: user.id, role: user.role, timeZone: user.timeZone }} now={now} />
      <NoticeToast notice={notice} />
    </>
  );
}
