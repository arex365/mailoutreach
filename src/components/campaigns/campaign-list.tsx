import Link from "next/link";
import { ArrowRight, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CampaignStatusBadge, ModeBadge } from "./badges";
import type { CampaignListView } from "./format";
import { ProgressBar } from "./progress-bar";

/**
 * The campaigns of one tab, as cards (they read the same on a laptop and a phone): name, status,
 * mode, sender, audience, progress and dates. Drafts continue in the wizard.
 */
export function CampaignList({ items }: { items: CampaignListView[] }) {
  return (
    // grid-cols-1 (minmax(0, 1fr)) and min-w-0 down to the name, not implicit auto columns: a long campaign name ends in
    // "…" on a phone instead of widening the page (drafts are named after their list, up to 120 characters).
    <ul className="grid grid-cols-1 gap-3" aria-label="Campaigns">
      {items.map((c) => (
        <li key={c.id} className="grid min-w-0 grid-cols-1 gap-3 rounded-lg border border-border bg-card p-4">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
            <div className="grid min-w-0 grid-cols-1 gap-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Link href={c.href} title={c.name} className="max-w-full truncate text-base font-medium underline-offset-4 hover:underline">
                  {c.name}
                </Link>
                <CampaignStatusBadge status={c.status} />
                {c.mode ? <ModeBadge mode={c.mode} /> : null}
              </div>
              <p className="flex flex-wrap gap-x-2 gap-y-0.5 text-sm text-muted-foreground">
                <span>{c.sender}</span>
                <span aria-hidden>·</span>
                <span className="tabular">{c.audience}</span>
                {c.dates.map((d) => (
                  <span key={d} className="contents">
                    <span aria-hidden>·</span>
                    <span>{d}</span>
                  </span>
                ))}
              </p>
            </div>
            <Button asChild variant="outline" size="sm" className="shrink-0">
              <Link href={c.href}>
                {c.isDraft ? (
                  <>
                    <Pencil aria-hidden /> Continue setting up
                  </>
                ) : (
                  <>
                    Open <ArrowRight aria-hidden />
                  </>
                )}
              </Link>
            </Button>
          </div>
          {c.percent !== null ? (
            <div className="grid gap-1.5" title={c.progressTitle ?? undefined}>
              <div className="flex items-center gap-3">
                <ProgressBar percent={c.percent} label={`${c.name}: ${c.percent}% done`} className="max-w-md" />
                <span className="shrink-0 text-xs text-muted-foreground tabular">{c.percent}%</span>
              </div>
              {c.progressText ? <p className="text-sm tabular">{c.progressText}</p> : null}
            </div>
          ) : c.progressText ? (
            <p className="text-sm text-muted-foreground">{c.progressText}</p>
          ) : null}
          {c.pauseReason ? <p className="text-sm text-warning">{c.pauseReason}</p> : null}
        </li>
      ))}
    </ul>
  );
}
