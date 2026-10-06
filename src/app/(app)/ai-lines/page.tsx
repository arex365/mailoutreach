import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/dal";
import { PageHeader } from "@/components/page-header";
import { LiveRefresh } from "@/components/campaigns/live-refresh";
import { AiPausedCard } from "@/components/ai/ai-paused-card";
import { AiLinesQueue } from "@/components/ai-lines/ai-lines-queue";
import { AiWaitingSync } from "@/components/ai-lines/ai-waiting-sync";
import {
  AI_LINES_DESCRIPTION,
  AI_LINES_TITLE,
  parseAiTab,
  runText,
  stopDialogText,
  toDraftCardDisplay,
} from "@/components/ai-lines/format";
import { RunCard, type RunCardView } from "@/components/ai-lines/run-card";
import { getAiPause } from "@/server/services/ai/pause";
import { activeRuns, listDrafts } from "@/server/services/ai/queue";

export const metadata: Metadata = { title: "AI lines" };

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * AI lines (docs/dev/M5-DESIGN.md §6.7): lines Claude drafted from each company's website, for everyone to review. The
 * pause card (Resume for the Owner), the drafting runs in progress with Stop, the tabs Waiting / Approved / Rejected /
 * No line / Failed (`?tab=`, 20 cards per page, `?page=`), and each tab's empty state. The page refreshes itself every
 * few seconds while a run is going, and keeps the sidebar's "AI lines" count in step.
 */
export default async function AiLinesPage({ searchParams }: PageProps<"/ai-lines">) {
  const user = await requireUser();
  const sp = await searchParams;
  const tab = parseAiTab(first(sp.tab));
  const pageRaw = Number(first(sp.page));
  const now = new Date();
  const [list, runs, pause] = await Promise.all([
    listDrafts({ id: user.id, timeZone: user.timeZone }, { tab, page: Number.isFinite(pageRaw) ? pageRaw : 1, now }),
    activeRuns(now),
    getAiPause(now),
  ]);
  const isOwner = user.role === "OWNER";
  const runViews: RunCardView[] = runs.map((run) => ({
    jobId: run.jobId,
    status: run.status,
    total: run.total,
    done: run.done,
    text: runText(run, {
      timeZone: user.timeZone,
      now,
      anotherRunning: runs.some((r) => r.status === "RUNNING" && r.jobId !== run.jobId),
    }),
    stopText: stopDialogText(run),
  }));

  return (
    <div>
      <PageHeader title={AI_LINES_TITLE} description={AI_LINES_DESCRIPTION} />
      {/* grid-cols-1 (minmax(0, 1fr)): the tab row scrolls inside its own box instead of widening the page on a phone. */}
      <div className="grid grid-cols-1 gap-4 px-4 pb-8 md:px-6">
        {pause.paused ? <AiPausedCard text={pause.text} isOwner={isOwner} /> : null}
        {runViews.map((run) => (
          <RunCard key={run.jobId} run={run} />
        ))}
        <AiLinesQueue
          tab={tab}
          counts={list.counts}
          cards={list.rows.map((card) => toDraftCardDisplay(card, user.timeZone, now))}
          page={list.page}
          pageCount={list.pageCount}
          emptyPrimary={!(pause.paused && isOwner)}
        />
      </div>
      <LiveRefresh active={runs.length > 0} intervalMs={5_000} />
      <AiWaitingSync count={list.counts.waiting} />
    </div>
  );
}
