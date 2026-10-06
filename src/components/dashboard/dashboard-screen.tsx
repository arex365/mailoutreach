import { PageHeader } from "@/components/page-header";
import { LiveRefresh } from "@/components/campaigns/live-refresh";
import { AttentionList } from "./attention-list";
import { GetStarted } from "./get-started";
import { RepliesList } from "./replies-list";
import { ActivityTile, CampaignsTile, CompaniesTile, DryRunTile, HealthTile, TodayTile } from "./tiles";
import { DASHBOARD_TEXTS } from "./texts";
import type { DashboardView } from "./types";

/** How often the dashboard re-reads itself while the tab is visible (M6-DESIGN §4.6, D12). */
export const DASHBOARD_REFRESH_MS = 60_000;

/**
 * The dashboard (M6-DESIGN §4): everyone's home. In this order on every width: "Get started" (when shown), "Needs your
 * attention", the viewer's "Replies waiting for an answer", then the tiles — on a laptop a 12-column grid (Companies ·
 * Today, Active campaigns · Domain health, Recent team activity · Dry runs and test mode), two columns from 640 px, one
 * on a phone. The only orange button is "Get started"'s next step. A pure view of `loadDashboard`'s result, used by the
 * page and the render tests; it refreshes itself every minute while the tab is visible. In own-mailbox mode
 * (`view.ownFrom`, MAIN-DOMAIN-DESIGN §3.9) the replies list's empty state says replies go straight to that mailbox.
 */
export function DashboardScreen({
  view,
  viewer,
  now,
}: {
  view: DashboardView;
  viewer: { id: number; role: "OWNER" | "MEMBER"; timeZone: string };
  now: Date;
}) {
  const dry = view.dryRun;
  return (
    <div>
      <PageHeader title={DASHBOARD_TEXTS.title} description={DASHBOARD_TEXTS.description} />
      <div className="grid min-w-0 gap-8 px-4 pb-12 md:px-6">
        {view.getStarted ? <GetStarted view={view.getStarted} /> : null}
        <AttentionList items={view.attention} more={view.attentionMore} />
        <RepliesList replies={view.replies} ownFrom={view.ownFrom ?? null} />
        <div className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-12">
          <CompaniesTile pipeline={view.pipeline} className="lg:col-span-7" />
          <TodayTile today={view.today} viewer={viewer} className="lg:col-span-5" />
          <CampaignsTile campaigns={view.campaigns} className="lg:col-span-7" />
          <HealthTile health={view.health} viewer={viewer} className="lg:col-span-5" />
          <ActivityTile activity={view.activity} now={now} className={dry ? "lg:col-span-7" : "sm:col-span-2 lg:col-span-12"} />
          {dry ? <DryRunTile dryRun={dry} className="lg:col-span-5" /> : null}
        </div>
      </div>
      <LiveRefresh active intervalMs={DASHBOARD_REFRESH_MS} />
    </div>
  );
}
