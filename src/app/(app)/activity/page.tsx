import type { Metadata } from "next";
import Link from "next/link";
import { History as HistoryIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/dal";
import { formatDateTime } from "@/core/time/format";
import { db } from "@/server/db";
import { EmptyState, PageHeader } from "@/components/page-header";
import { FlagBadge } from "@/components/badges";
import { Pager } from "@/components/activity/pager";
import { ActivityFilterBar } from "@/components/activity/activity-filter-bar";
import {
  activityFiltersToParams,
  followUpsDatesLine,
  hasActivityFilters,
  parseActivityFilters,
} from "@/components/activity/activity-filters";
import { activityPeople, queryActivity, type ActivityRow } from "./activity-query";

export const metadata: Metadata = { title: "Activity" };

/**
 * The second line of outage-hold entries on this page (M4-DESIGN §3.11): "Replies from 3 Oct to 9 Oct may have been missed.", read
 * from each `followups.*` entry's `data.from`/`data.to` and written in the viewer's time zone. Keyed by entry id.
 */
async function followUpsLines(rows: readonly ActivityRow[], timeZone: string, now: Date): Promise<Map<number, string>> {
  const ids = rows.filter((r) => r.type.startsWith("followups.")).map((r) => r.id);
  const lines = new Map<number, string>();
  if (ids.length === 0) return lines;
  const logs = await db.activityLog.findMany({ where: { id: { in: ids } }, select: { id: true, type: true, data: true } });
  for (const l of logs) {
    const line = followUpsDatesLine(l.type, l.data, timeZone, now);
    if (line) lines.set(l.id, line);
  }
  return lines;
}

/** Who changed what, newest first (SPEC §1: every change is recorded with who made it). */
export default async function ActivityPage({ searchParams }: PageProps<"/activity">) {
  const user = await requireUser();
  const filters = parseActivityFilters(await searchParams);
  const [data, people] = await Promise.all([queryActivity(filters, user.timeZone), activityPeople()]);
  const extraLines = await followUpsLines(data.rows, user.timeZone, new Date());
  const filtered = hasActivityFilters(filters);

  return (
    <div>
      <PageHeader title="Activity" description="Every change and who made it, newest first. Times are in your time zone." />
      <div className="grid gap-4 px-4 pb-12 md:px-6">
        {data.total > 0 || filtered ? <ActivityFilterBar filters={filters} people={people} /> : null}

        {data.total === 0 ? (
          filtered ? (
            <EmptyState
              title="Nothing matches these filters."
              description="Try another person, kind or date range."
              actions={
                <Button asChild variant="outline">
                  <Link href="/activity">Clear filters</Link>
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<HistoryIcon className="size-6" aria-hidden />}
              title="Nothing yet. Changes you and your team make will show here."
              actions={
                <Button asChild variant="outline">
                  <Link href="/contacts">Go to Contacts</Link>
                </Button>
              }
            />
          )
        ) : (
          <>
            <ol className="divide-y divide-border overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
              {data.rows.map((row) => (
                <li
                  key={row.id}
                  className="grid gap-1 px-4 py-3 text-sm md:grid-cols-[11rem_9rem_minmax(0,1fr)_auto] md:items-baseline md:gap-4"
                >
                  <time dateTime={row.at.toISOString()} className="text-xs text-muted-foreground tabular md:text-sm">
                    {formatDateTime(row.at, user.timeZone)}
                  </time>
                  <span className="truncate font-medium">{row.actorName ?? "System"}</span>
                  <span className="min-w-0 break-words">
                    {row.summary}
                    {row.mode === "DRY_RUN" ? (
                      <span className="ml-2 align-middle">
                        <FlagBadge>Dry run</FlagBadge>
                      </span>
                    ) : null}
                    {extraLines.has(row.id) ? (
                      <span className="mt-0.5 block text-muted-foreground">{extraLines.get(row.id)}</span>
                    ) : null}
                  </span>
                  <span className="md:text-right">
                    {row.companyId !== null && !row.companyDeleted ? (
                      <Link
                        href={`/contacts?company=${row.companyId}`}
                        className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                      >
                        {row.companyName ? `Open ${row.companyName}` : "Open company"}
                      </Link>
                    ) : row.companyDeleted && row.companyName ? (
                      <span className="text-sm text-muted-foreground">{row.companyName} (deleted)</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
            <Pager
              page={data.page}
              pageCount={data.pageCount}
              total={data.total}
              noun={["change", "changes"]}
              hrefFor={(p) => {
                const qs = activityFiltersToParams({ ...filters, page: p }).toString();
                return qs ? `/activity?${qs}` : "/activity";
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
