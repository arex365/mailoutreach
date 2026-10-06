import Link from "next/link";
import { StatusBadge } from "@/components/badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/campaigns/progress-bar";
import { HealthCard } from "@/components/settings/deliverability/health-card";
import { replyRate30Text, replyRateText } from "@/core/dashboard/pipeline";
import { COMPANY_STATUSES } from "@/core/labels";
import { timeAgo } from "@/core/time/format";
import type { TeamActivityRow } from "@/server/services/dashboard/activity";
import type { PipelineView } from "@/server/services/dashboard/pipeline";
import { cn } from "@/lib/utils";
import { activityGroupText, campaignMetaLine, statusHref } from "./format";
import { DASHBOARD_TEXTS } from "./texts";
import type { DashboardCampaign, DashboardDryRun, HealthTileView, TodayView } from "./types";

/**
 * The dashboard's tiles (M6-DESIGN §4.3): Companies, Today, Active campaigns, Domain health, Recent team activity and
 * Dry runs and test mode. Each is a `<section>` with an `h2`, a short body and at most one "more" link in its footer
 * (ghost, never orange). Numbers use tabular figures; bars stay neutral; no charts. A tile whose data is `null`
 * couldn't be loaded and says so. Owner-only links are left out for Members. Server components.
 */

type Viewer = { role: "OWNER" | "MEMBER" };

/** A full-width row on a phone (44 px), a small ghost button from 640 px. */
const LINK_BUTTON = "h-11 w-full justify-start sm:h-7 sm:w-auto";

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Button asChild variant="ghost" size="sm" className={LINK_BUTTON}>
      <Link href={href}>{children}</Link>
    </Button>
  );
}

function Tile({
  id,
  title,
  description,
  footer,
  className,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  footer?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={`${id}-heading`}
      data-tile={id}
      className={cn("flex min-w-0 flex-col gap-3 rounded-xl bg-card p-4 text-sm ring-1 ring-foreground/10", className)}
    >
      <div className="grid gap-1">
        <h2 id={`${id}-heading`} className="text-base font-semibold">
          {title}
        </h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      <div className="grid gap-3">{children}</div>
      {footer ? <div className="mt-auto">{footer}</div> : null}
    </section>
  );
}

function Unavailable() {
  return <p className="text-muted-foreground">{DASHBOARD_TEXTS.unavailable}</p>;
}

/** Companies (§4.3): the total, the six status counts linking to Contacts, and the reply rate. */
export function CompaniesTile({ pipeline, className }: { pipeline: PipelineView | null; className?: string }) {
  const t = DASHBOARD_TEXTS.companies;
  if (!pipeline) {
    return (
      <Tile id="companies" title={t.heading} className={className}>
        <Unavailable />
      </Tile>
    );
  }
  if (pipeline.counts.all === 0) {
    return (
      <Tile id="companies" title={t.heading} className={className}>
        <p className="text-muted-foreground">{t.empty}</p>
        <div>
          <Button asChild variant="outline" className="h-11 w-full sm:h-8 sm:w-auto">
            <Link href="/import">{t.importLink}</Link>
          </Button>
        </div>
      </Tile>
    );
  }
  const last30 = replyRate30Text(pipeline.replyRate);
  return (
    <Tile id="companies" title={t.heading} className={className} footer={<FooterLink href="/contacts">{t.footer}</FooterLink>}>
      <p className="text-2xl font-semibold tabular-nums">{t.total(pipeline.counts.all)}</p>
      <ul className="grid grid-cols-2 gap-1 sm:grid-cols-3">
        {COMPANY_STATUSES.map((status) => (
          <li key={status}>
            <Link
              href={statusHref(status)}
              className="flex min-h-11 items-center justify-between gap-2 rounded-md px-2 hover:bg-accent sm:min-h-9"
            >
              <StatusBadge status={status} />
              <span className="tabular-nums">{pipeline.counts.byStatus[status].toLocaleString("en-US")}</span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="grid gap-0.5">
        <p>{replyRateText(pipeline.replyRate)}</p>
        {last30 ? <p className="text-muted-foreground">{last30}</p> : null}
      </div>
    </Tile>
  );
}

/** Today (§4.3): sent today against today's limit, its notes and the warm-up line. */
export function TodayTile({ today, viewer, className }: { today: TodayView | null; viewer: Viewer; className?: string }) {
  const t = DASHBOARD_TEXTS.today;
  const owner = viewer.role === "OWNER";
  const footer = owner ? <FooterLink href="/settings/limits">{t.footer}</FooterLink> : undefined;
  if (!today) {
    return (
      <Tile id="today" title={t.heading} className={className} footer={footer}>
        <Unavailable />
      </Tile>
    );
  }
  return (
    <Tile id="today" title={t.heading} className={className} footer={footer}>
      <p className="flex items-baseline gap-2">
        <span className="text-3xl font-semibold tabular-nums">{today.used.toLocaleString("en-US")}</span>
        <span className="text-muted-foreground tabular-nums">{t.ofCap(today.cap)}</span>
      </p>
      <ProgressBar percent={today.percent} label={t.barLabel} />
      {today.lines.length > 0 ? (
        <ul className="grid gap-1">
          {today.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {today.notConfigured ? (
        <div className="grid gap-2">
          <p>{today.notConfigured}</p>
          {owner ? (
            <div>
              <Button asChild variant="outline" className="h-11 w-full sm:h-8 sm:w-auto">
                <Link href="/settings/sending">{t.connectLink}</Link>
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Tile>
  );
}

/** Domain health (§4.3): bounces and complaints since go-live, next to your limit and Mailgun's (P5's compact card). */
export function HealthTile({ health, viewer, className }: { health: HealthTileView | null; viewer: Viewer; className?: string }) {
  const t = DASHBOARD_TEXTS.health;
  const footer = viewer.role === "OWNER" ? <FooterLink href="/settings/deliverability">{t.footer}</FooterLink> : undefined;
  return (
    <Tile id="health" title={t.heading} className={className} footer={footer}>
      {!health ? (
        <Unavailable />
      ) : health.empty ? (
        <p className="text-muted-foreground">{health.empty}</p>
      ) : (
        <HealthCard compact bounce={health.bounce} complaint={health.complaint} sinceNote={health.sinceNote} />
      )}
    </Tile>
  );
}

/** Active campaigns (§4.3): running, then scheduled, at most 5, each with its sender, mode and progress. */
export function CampaignsTile({
  campaigns,
  className,
}: {
  campaigns: { items: readonly DashboardCampaign[]; more: number; moreHref: string } | null;
  className?: string;
}) {
  const t = DASHBOARD_TEXTS.campaigns;
  if (!campaigns) {
    return (
      <Tile id="campaigns" title={t.heading} className={className}>
        <Unavailable />
      </Tile>
    );
  }
  if (campaigns.items.length === 0) {
    return (
      <Tile id="campaigns" title={t.heading} className={className}>
        <p className="text-muted-foreground">{t.empty}</p>
        <div>
          <Button asChild variant="outline" className="h-11 w-full sm:h-8 sm:w-auto">
            <Link href="/campaigns">{t.emptyLink}</Link>
          </Button>
        </div>
      </Tile>
    );
  }
  return (
    <Tile id="campaigns" title={t.heading} className={className} footer={<FooterLink href="/campaigns">{t.footer}</FooterLink>}>
      <ul className="grid gap-3">
        {campaigns.items.map((c) => (
          <li key={c.id} className="grid gap-1.5 rounded-lg border border-border p-3">
            <Link
              href={`/campaigns/${c.id}`}
              className="flex min-h-11 w-full min-w-0 items-center font-medium break-words underline-offset-4 hover:underline sm:min-h-0"
            >
              {c.name}
            </Link>
            <p className="text-xs text-muted-foreground">{campaignMetaLine(c)}</p>
            {c.percent !== null ? <ProgressBar percent={c.percent} label={t.barLabel(c.name)} /> : null}
            {c.progressText ? (
              <p className="text-xs text-muted-foreground tabular-nums" title={c.progressTitle ?? undefined}>
                {c.progressText}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {campaigns.more > 0 ? (
        <div>
          <Link
            href={campaigns.moreHref}
            className="flex min-h-11 w-full items-center text-muted-foreground underline-offset-4 hover:text-foreground hover:underline sm:inline-flex sm:min-h-0 sm:w-auto"
          >
            {t.more(campaigns.more)}
          </Link>
        </div>
      ) : null}
    </Tile>
  );
}

/**
 * Recent team activity (§4.3): the 8 newest changes of the last 30 days, without per-email rows, a bulk change as one
 * row with its count (review DASHBOARD-4), and the company each row is about, linked like the Activity page (plain
 * "Name (deleted)" once deleted; review DASHBOARD-3).
 */
export function ActivityTile({ activity, now, className }: { activity: readonly TeamActivityRow[] | null; now: Date; className?: string }) {
  const t = DASHBOARD_TEXTS.activity;
  if (!activity) {
    return (
      <Tile id="activity" title={t.heading} className={className}>
        <Unavailable />
      </Tile>
    );
  }
  if (activity.length === 0) {
    return (
      <Tile id="activity" title={t.heading} className={className}>
        <p className="text-muted-foreground">{t.empty}</p>
      </Tile>
    );
  }
  return (
    <Tile id="activity" title={t.heading} className={className} footer={<FooterLink href="/activity">{t.footer}</FooterLink>}>
      <ul className="grid gap-2">
        {activity.map((row) => (
          <li key={row.id} className="flex items-start gap-2">
            <p className="line-clamp-2 min-w-0 flex-1 break-words">
              {row.summary}
              {row.company ? (
                <>
                  {" · "}
                  {row.company.deleted ? (
                    t.deletedCompany(row.company.name)
                  ) : (
                    <Link href={`/contacts?company=${row.company.id}`} className="font-medium underline-offset-4 hover:underline">
                      {row.company.name}
                    </Link>
                  )}
                </>
              ) : null}
              {row.group ? ` · ${activityGroupText(row.group)}` : null} · <time dateTime={row.at}>{timeAgo(row.at, now)}</time>
            </p>
            {row.mode === "DRY_RUN" ? <Badge variant="secondary">{t.dryRunBadge}</Badge> : null}
          </li>
        ))}
      </ul>
    </Tile>
  );
}

/** Dry runs and test mode (§4.3, B6.5 "shown separately"): hidden (not rendered) when there's nothing to show. */
export function DryRunTile({ dryRun, className }: { dryRun: DashboardDryRun; className?: string }) {
  const t = DASHBOARD_TEXTS.dryRun;
  return (
    <Tile
      id="dry-run"
      title={t.heading}
      description={t.description}
      className={className}
      footer={<FooterLink href="/campaigns/outbox">{t.footer}</FooterLink>}
    >
      <ul className="grid gap-1 tabular-nums">
        {dryRun.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </Tile>
  );
}
