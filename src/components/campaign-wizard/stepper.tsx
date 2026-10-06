import Link from "next/link";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { WIZARD_STEPS, canOpenStep, stepNumber, wizardHref, type WizardStepKey } from "./steps";

/**
 * Audience · Sender · Message · Verify · Review · Schedule. The current step has the orange
 * "selected" marker (PLAN.md A6); steps already reached are links (you can always go back);
 * steps not reached yet are plain text. On a phone only the current step's name shows.
 */
export function WizardStepper({
  campaignId,
  current,
  furthest,
  className,
}: {
  campaignId: number;
  current: WizardStepKey;
  /** Campaign.wizardStep: the furthest step reached (1 … 6). */
  furthest: number;
  className?: string;
}) {
  const currentN = stepNumber(current);
  const reach = Math.max(furthest, currentN);
  return (
    <nav aria-label="Campaign steps" className={className}>
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-2 text-sm">
        {WIZARD_STEPS.map((s, i) => {
          const isCurrent = s.key === current;
          const done = s.n < currentN;
          const reachable = !isCurrent && canOpenStep(s.key, reach);
          const marker = (
            <span
              aria-hidden
              className={cn(
                "tabular flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium",
                isCurrent && "border-primary bg-primary text-primary-foreground",
                !isCurrent && reachable && "border-border bg-secondary text-foreground",
                !isCurrent && !reachable && "border-border text-muted-foreground",
              )}
            >
              {done ? <Check className="size-3.5" /> : s.n}
            </span>
          );
          const srState = isCurrent ? " (this step)" : done ? " (done)" : reachable ? "" : " (not reached yet)";
          const label = (
            <span
              className={cn(
                // On a phone only the current step's name is visible; screen readers always get every name.
                isCurrent ? "font-medium text-foreground" : "sr-only text-muted-foreground sm:not-sr-only",
                reachable && "group-hover:text-foreground",
              )}
            >
              <span className="sr-only">Step {s.n}: </span>
              {s.label}
              <span className="sr-only">{srState}</span>
            </span>
          );
          return (
            <li key={s.key} className="flex items-center gap-1" aria-current={isCurrent ? "step" : undefined}>
              {reachable ? (
                <Link href={wizardHref(campaignId, s.key)} className="group inline-flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted">
                  {marker}
                  {label}
                </Link>
              ) : (
                <span className="inline-flex items-center gap-2 px-1.5 py-1">
                  {marker}
                  {label}
                </span>
              )}
              {i < WIZARD_STEPS.length - 1 ? (
                <span aria-hidden className="mx-0.5 hidden h-px w-4 bg-border sm:inline-block lg:w-6" />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
