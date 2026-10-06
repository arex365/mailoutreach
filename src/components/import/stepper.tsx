import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

const STEPS = ["Upload", "Match columns", "Options", "Check", "Import"] as const;

export type ImportStepNumber = 1 | 2 | 3 | 4 | 5;

/** The five import steps. The current step has the orange "selected" marker (PLAN.md A6). */
export function ImportStepper({ current }: { current: ImportStepNumber }) {
  return (
    <ol aria-label="Import steps" className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const state = n < current ? "done" : n === current ? "current" : "todo";
        return (
          <li key={label} aria-current={state === "current" ? "step" : undefined} className="flex items-center gap-2">
            <span
              className={cn(
                "tabular flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium",
                state === "current" && "border-primary bg-primary text-primary-foreground",
                state === "done" && "border-border bg-secondary text-foreground",
                state === "todo" && "border-border text-muted-foreground",
              )}
            >
              {state === "done" ? <Check className="size-3.5" aria-hidden /> : n}
            </span>
            <span className={cn(state === "current" ? "font-medium text-foreground" : "text-muted-foreground")}>
              {label}
              {state === "done" ? <span className="sr-only"> (done)</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
