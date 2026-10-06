"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { continueAction } from "@/app/(app)/campaigns/[id]/setup/actions";
import { previousStepKey, stepLabelFor, wizardHref, type WizardStepKey } from "./steps";

const OFFLINE = "Couldn't reach the app, so you're still on this step. Check your connection and try again.";

export type ContinueProblem = { error: string; fieldErrors?: Record<string, string[] | undefined> };

type BeforeContinue = () => Promise<{ ok: true } | { ok: false; error: string }>;

/** Runs the step's own check before Continue (e.g. saving): the text to show next to Continue, or null to go on. */
export async function problemBeforeContinue(beforeContinue?: BeforeContinue): Promise<string | null> {
  if (!beforeContinue) return null;
  const ready = await beforeContinue();
  return ready.ok ? null : ready.error;
}

/**
 * The bar at the bottom of every wizard step: Back, and the step's one primary button (Continue,
 * or Launch campaign on the last step). Continue asks the server whether the step is complete
 * (people who'll get the email, a sender, a message that follows the rules), remembers the
 * progress and opens the next step. It stays above the phone's bottom bar.
 */
export function StepFooter({
  campaignId,
  current,
  beforeContinue,
  onProblem,
  primary,
  note,
}: {
  campaignId: number;
  current: WizardStepKey;
  /** E.g. save the Message step first. When it isn't ok, the step stays and its error shows next to Continue. */
  beforeContinue?: BeforeContinue;
  /** Called with the server's answer when the step isn't complete. */
  onProblem?: (problem: ContinueProblem) => void;
  /** Replaces Continue (the Schedule step's Launch campaign). */
  primary?: React.ReactNode;
  /** A short line beside the buttons. */
  note?: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const previous = previousStepKey(current);

  function onContinue() {
    setError(null);
    startTransition(async () => {
      try {
        const blocked = await problemBeforeContinue(beforeContinue);
        if (blocked) {
          setError(blocked);
          return;
        }
        const res = await continueAction({ campaignId, from: current });
        if (!res.ok) {
          setError(res.error);
          onProblem?.({ error: res.error, fieldErrors: res.fieldErrors });
          return;
        }
        router.push(res.data.href);
      } catch {
        setError(OFFLINE);
        toast.error(OFFLINE);
      }
    });
  }

  return (
    <div className="sticky bottom-16 z-20 -mx-4 mt-8 border-t border-border bg-background/95 px-4 py-3 backdrop-blur md:bottom-0 md:-mx-6 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {previous ? (
          <Button variant="outline" asChild>
            <Link href={wizardHref(campaignId, previous)}>
              <ArrowLeft aria-hidden />
              <span>
                Back<span className="sr-only"> to {stepLabelFor(previous)}</span>
              </span>
            </Link>
          </Button>
        ) : (
          <span />
        )}
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-3">
          {error ? (
            <p role="alert" className="min-w-0 text-sm text-destructive">
              {error}
            </p>
          ) : note ? (
            <div className="min-w-0 text-sm text-muted-foreground">{note}</div>
          ) : null}
          {primary ?? (
            <Button onClick={onContinue} disabled={pending}>
              {pending ? "Checking…" : "Continue"}
              <ArrowRight aria-hidden />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
