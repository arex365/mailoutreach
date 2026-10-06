import { cn } from "@/lib/utils";
import { RESULT_LABELS, type CampaignResults } from "./format";
import { ProgressBar } from "./progress-bar";

/**
 * The campaign page's progress: the overall bar and one line per email of the sequence
 * ("First email 120 of 150 sent", "Follow-up 1: 40 waiting, next on 14 Oct"), then the counts
 * (sent, delivered, bounced, replied, unsubscribed, complained). Server-safe: every text comes
 * ready from @/components/campaigns/format.
 */

export type StepLineView = { step: number; title: string; text: string; timing: string | null };

export function CampaignProgressCard({
  percent,
  doneText,
  steps,
  className,
}: {
  percent: number;
  doneText: string;
  steps: StepLineView[];
  className?: string;
}) {
  return (
    <section aria-labelledby="campaign-progress" className={cn("grid gap-4 rounded-lg border border-border bg-card p-4", className)}>
      <div className="grid gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="campaign-progress" className="text-sm font-semibold">
            Progress
          </h2>
          <span className="text-sm text-muted-foreground tabular">{doneText}</span>
        </div>
        <ProgressBar percent={percent} label={`Campaign progress: ${percent}% done`} />
      </div>
      <ol className="grid gap-2">
        {steps.map((s) => (
          <li key={s.step} className="grid gap-0.5 border-t border-border pt-2 first:border-t-0 first:pt-0">
            <span className="text-sm tabular">{s.text}</span>
            {s.timing ? <span className="text-xs text-muted-foreground">{s.timing}</span> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function CampaignResultsGrid({ results, note }: { results: CampaignResults; note: string | null }) {
  return (
    <section aria-labelledby="campaign-results" className="grid gap-2">
      <h2 id="campaign-results" className="sr-only">
        Results
      </h2>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {RESULT_LABELS.map(({ key, label }) => (
          <div key={key} className="grid gap-0.5 rounded-lg border border-border bg-card px-3 py-2.5">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-xl font-semibold tabular">{results[key].toLocaleString("en-US")}</dd>
          </div>
        ))}
      </dl>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </section>
  );
}
