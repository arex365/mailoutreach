"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/campaigns/progress-bar";
import { OFFLINE_TEXT } from "@/components/ai/phone-dialog";
import { stopDraftRunAction } from "@/app/(app)/ai-lines/actions";

/** A drafting run as its card needs it (the words come from the server, in the viewer's zone). */
export type RunCardView = {
  jobId: number;
  status: "QUEUED" | "RUNNING";
  total: number;
  done: number;
  /** "Drafting lines for 30 companies: 12 done, $0.07 so far. Started by Ali." / "Waiting to start: …" / "Waiting: …". */
  text: string;
  /** The Stop dialog's sentence: "The 18 companies not drafted yet are taken off the list. Lines already drafted stay." */
  stopText: string;
};

/**
 * One drafting run on the AI lines page (docs/dev/M5-DESIGN.md §6.7): what it is doing, a neutral progress bar while it
 * has progress, and [Stop] (outline) with "Stop drafting?". Stop acts on this AI drafting run only; a queued run stops
 * at once ("Drafting stopped before it started."), a running one after the companies in flight.
 */
export function RunCard({ run }: { run: RunCardView }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const percent = run.total > 0 ? (run.done / run.total) * 100 : 0;
  const showProgress = run.status === "RUNNING" || run.done > 0;

  function stop() {
    startTransition(async () => {
      try {
        const res = await stopDraftRunAction({ jobId: run.jobId });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(res.message ?? "Drafting stopped.");
        setOpen(false);
        router.refresh();
      } catch {
        toast.error(OFFLINE_TEXT);
      }
    });
  }

  return (
    <section aria-label="Drafting run" className="grid gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="min-w-0 flex-1 text-sm" role="status">
          {run.text}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} disabled={pending}>
          Stop
        </Button>
      </div>
      {showProgress ? <ProgressBar percent={percent} label="Drafting progress" /> : null}
      <AlertDialog open={open} onOpenChange={(o) => (!pending ? setOpen(o) : undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop drafting?</AlertDialogTitle>
            <AlertDialogDescription>{run.stopText}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep drafting</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                stop();
              }}
            >
              {pending ? "Stopping…" : "Stop drafting"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
