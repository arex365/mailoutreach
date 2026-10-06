import { cn } from "@/lib/utils";

/**
 * A neutral progress bar (grey on grey, never orange: PLAN.md A6 "progress bars stay neutral").
 * Server-safe; the percentage is also given to screen readers.
 */
export function ProgressBar({ percent, label, className }: { percent: number; label: string; className?: string }) {
  const p = Math.min(100, Math.max(0, Math.round(Number(percent) || 0)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={p}
      aria-valuetext={`${p}%`}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <div className="h-full rounded-full bg-foreground/60 transition-[width]" style={{ width: `${p}%` }} />
    </div>
  );
}
