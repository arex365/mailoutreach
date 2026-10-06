"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { CircleAlert, MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { FormError } from "@/components/forms/field";
import type { CheckRunCounts } from "@/core/verification/types";
import { checkRunDoneLines, checkStartToast } from "@/core/verification/words";
import { useJobPoll, type PolledJob } from "@/components/settings/domain/use-job-poll";
import {
  checkRunViewAction,
  estimateChecksAction,
  startChecksAction,
  stopChecksAction,
} from "@/app/(app)/contacts/check-actions";
import { checksDialogModel, CHECKS_DIALOG_TITLE, DIALOG_CLOSED_NOTE, type ChecksDialogModel } from "./dialog-model";
import { deferredRunText, dialogRunningText } from "./run-text";
import type { ChecksDialogView, ChecksInput } from "./types";

const OFFLINE = "Couldn't reach the app, so nothing changed. Check your connection and try again.";
const LOST_TRACK = "Couldn't follow the checks from here. You get a notification when they're done.";
/** Dialogs open full screen on a phone (M5-DESIGN §6). */
const DIALOG_CLASS =
  "max-h-dvh overflow-y-auto sm:max-w-lg max-sm:inset-0 max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none";

/** Under the start button while the start is on its way (the dialog can't be closed until the answer is back). */
export const STARTING_NOTE = "Starting the checks. You can close this window once they've started.";

export type ChecksDialogPhase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; view: ChecksDialogView }
  | { kind: "running"; jobId: number; count: number; timeZone: string; job: PolledJob | null }
  | { kind: "done"; heading: string; lines: string[]; error: string | null };

type Phase = ChecksDialogPhase;

/** The finished run's heading: "Checks finished", or "Checks stopped" after Stop. */
function doneHeading(status: string): string {
  return status === "CANCELLED" ? "Checks stopped" : status === "FAILED" ? "Checks didn't finish" : "Checks finished";
}

/**
 * What a request to close the dialog does (Esc, the X, a click outside, Cancel, Close). While a start is on its way it
 * is ignored: closing then would hide whether a paid run started, and people would start it again. A running run goes
 * on without the dialog, which the toast says.
 */
export function checksDialogClose(phase: Phase, starting: boolean): { close: boolean; toast: string | null } {
  if (starting) return { close: false, toast: null };
  return { close: true, toast: phase.kind === "running" ? checkStartToast(phase.count) : null };
}

/**
 * What the dialog shows when a start comes back: the running run while the dialog is still open; otherwise (it was
 * unmounted, e.g. with its list menu) the start toast, so a run never starts without a word.
 */
export function checksStartedOutcome(stillOpen: boolean, count: number): { show: "running" } | { show: "toast"; toast: string } {
  return stillOpen ? { show: "running" } : { show: "toast", toast: checkStartToast(count) };
}

/**
 * The finished run's lines. A Contacts or list run belongs to no campaign, so they never promise an automatic re-check,
 * an email or a launch ("emailed if it passes", "left out at launch"; M5 review SCREENS-04).
 */
export function checksDialogDoneLines(counts: CheckRunCounts | null | undefined): string[] {
  return counts ? checkRunDoneLines(counts, { inCampaign: false }) : [];
}

/**
 * The "Check email addresses" dialog for ticked companies or a list (M5-DESIGN §6.3): how many addresses need a check
 * (judged as for a live campaign), "Check these again too", the cost, the paused / not ready / too many / monthly limit
 * refusals, then the run's progress (every 2 s), Stop, and the finished run's lines. Closing it while the run goes on
 * leaves the run going and says so in a toast; while the start is on its way ("Starting…") it can't be closed, so a
 * paid run never starts unseen. `trigger` is the element that opens it; `loadingTitle` (a list's name) shows under the
 * title while the addresses are counted.
 */
export function CheckEmailsDialog({
  input,
  trigger,
  loadingTitle,
}: {
  input: ChecksInput;
  trigger: React.ReactNode;
  loadingTitle?: string;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [recheck, setRecheck] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, startStarting] = useTransition();
  const [stopping, startStopping] = useTransition();
  // Open and mounted: a start that answers after the dialog went away (unmounted with its menu) says so in a toast.
  const openRef = useRef(false);
  useEffect(() => {
    openRef.current = open;
    return () => {
      openRef.current = false;
    };
  }, [open]);

  const runningJobId = phase.kind === "running" ? phase.jobId : null;
  useJobPoll(runningJobId, {
    onProgress: (job) => setPhase((p) => (p.kind === "running" && p.jobId === job.id ? { ...p, job } : p)),
    onDone: (job) => {
      if (runningJobId !== null) void finish(runningJobId, job);
    },
  });

  async function load() {
    setPhase({ kind: "loading" });
    setRecheck(false);
    setStartError(null);
    try {
      const res = await estimateChecksAction(input);
      setPhase(res.ok ? { kind: "ready", view: res.data } : { kind: "error", message: res.error });
    } catch {
      setPhase({ kind: "error", message: OFFLINE });
    }
  }

  async function finish(jobId: number, job: PolledJob | null) {
    if (!job) {
      setPhase({ kind: "done", heading: "Checks started", lines: [], error: LOST_TRACK });
      return;
    }
    try {
      const res = await checkRunViewAction({ jobId });
      if (!res.ok) {
        setPhase({ kind: "done", heading: doneHeading(job.status), lines: [], error: res.error });
        return;
      }
      const v = res.data;
      setPhase({
        kind: "done",
        heading: doneHeading(v.status),
        lines: checksDialogDoneLines(v.counts),
        error: v.status === "FAILED" ? v.error || "The address checks stopped because of a problem. Start them again." : null,
      });
    } catch {
      setPhase({ kind: "done", heading: doneHeading(job.status), lines: [], error: OFFLINE });
    }
  }

  function onOpenChange(next: boolean) {
    if (next) {
      setOpen(true);
      void load();
      return;
    }
    // Not while the start is on its way. A running run goes on without the dialog; the requester gets a notification.
    const closing = checksDialogClose(phase, starting);
    if (!closing.close) return;
    if (closing.toast) toast(closing.toast);
    setOpen(false);
    setPhase({ kind: "idle" });
  }

  function start(model: ChecksDialogModel, timeZone: string) {
    setStartError(null);
    startStarting(async () => {
      try {
        const res = await startChecksAction({ ...input, recheckRecent: recheck, confirmedCount: model.count });
        if (!res.ok) {
          setStartError(res.error);
          return;
        }
        const outcome = checksStartedOutcome(openRef.current, res.data.count);
        if (outcome.show === "toast") {
          toast(outcome.toast);
          return;
        }
        setPhase({ kind: "running", jobId: res.data.jobId, count: res.data.count, timeZone, job: null });
      } catch {
        setStartError(OFFLINE);
      }
    });
  }

  function stop(jobId: number) {
    startStopping(async () => {
      try {
        const res = await stopChecksAction({ jobId });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(res.message ?? "Address checks stopped.");
      } catch {
        toast.error(OFFLINE);
      }
    });
  }

  const close = () => onOpenChange(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      {/* No X while the start is on its way (Esc and a click outside are ignored then too, in onOpenChange). */}
      <DialogContent className={DIALOG_CLASS} showCloseButton={!starting}>
        <DialogHeader>
          <DialogTitle>{CHECKS_DIALOG_TITLE}</DialogTitle>
          {phase.kind === "ready" ? (
            <DialogDescription>{checksDialogModel(phase.view, recheck).countsLine}</DialogDescription>
          ) : loadingTitle ? (
            <DialogDescription>{loadingTitle}</DialogDescription>
          ) : (
            <DialogDescription className="sr-only">How many addresses need a check, and what it costs.</DialogDescription>
          )}
        </DialogHeader>

        {phase.kind === "loading" || phase.kind === "idle" ? (
          <p className="text-sm text-muted-foreground" role="status">
            Counting the addresses…
          </p>
        ) : null}

        {phase.kind === "error" ? (
          <>
            <FormError message={phase.message} />
            <DialogFooter>
              <Button variant="outline" onClick={close}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {phase.kind === "ready" ? (
          <ChecksDialogReady
            view={phase.view}
            recheck={recheck}
            onRecheck={setRecheck}
            error={startError}
            pending={starting}
            onCancel={close}
            onStart={(model) => start(model, phase.view.timeZone)}
          />
        ) : null}

        {phase.kind === "running" ? (
          <>
            <div className="grid gap-2 text-sm">
              <p role="status" aria-live="polite">
                {phase.job?.status === "QUEUED" && phase.job.waitingUntil
                  ? deferredRunText({ waitingUntil: phase.job.waitingUntil, summary: phase.job.summary }, phase.timeZone)
                  : dialogRunningText(phase.count, phase.job?.progressDone ?? 0)}
              </p>
              <p className="text-muted-foreground">{DIALOG_CLOSED_NOTE}</p>
            </div>
            <DialogFooter>
              <Button variant="secondary" onClick={close}>
                Close
              </Button>
              <Button variant="outline" onClick={() => stop(phase.jobId)} disabled={stopping}>
                {stopping ? "Stopping…" : "Stop checking"}
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {phase.kind === "done" ? (
          <>
            <div className="grid gap-2 text-sm">
              <p className="font-medium">{phase.heading}</p>
              <FormError message={phase.error} />
              {phase.lines.length > 0 ? (
                <ul className="grid gap-1">
                  {phase.lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
            </div>
            <DialogFooter>
              <Button variant="secondary" onClick={close}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The dialog before a start: the counts, "Check these again too", the cost line, what stops a start, and
 * [Cancel] [Check N addresses]. Exported for the screen tests.
 */
export function ChecksDialogReady({
  view,
  recheck,
  onRecheck,
  error,
  pending,
  onCancel,
  onStart,
}: {
  view: ChecksDialogView;
  recheck: boolean;
  onRecheck: (on: boolean) => void;
  error: string | null;
  pending: boolean;
  onCancel: () => void;
  onStart: (model: ChecksDialogModel) => void;
}) {
  const id = useId();
  const model = checksDialogModel(view, recheck);
  return (
    <>
      <div className="grid gap-3 text-sm">
        {model.lines.length > 0 ? (
          <ul className="grid gap-1">
            {model.lines.map((l) => (
              <li key={l.kind}>{l.text}</li>
            ))}
          </ul>
        ) : null}
        {model.recheck ? (
          <div className="flex items-start gap-2">
            <Checkbox id={`${id}-again`} checked={recheck} onCheckedChange={(v) => onRecheck(v === true)} className="mt-0.5" />
            <Label htmlFor={`${id}-again`} className="font-normal leading-snug">
              {model.recheck.label}
            </Label>
          </div>
        ) : null}
        {model.nothing ? <p className="text-muted-foreground">{model.nothing}</p> : null}
        {model.costLine ? <p>{model.costLine}</p> : null}
        {model.blocker ? (
          <p role="alert" className="flex items-start gap-2 text-warning">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {model.blocker}
          </p>
        ) : null}
        <FormError message={error} />
        {pending ? (
          <p role="status" className="text-muted-foreground">
            {STARTING_NOTE}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button onClick={() => onStart(model)} disabled={!model.canStart || pending}>
          <MailCheck aria-hidden />
          {pending ? "Starting…" : model.startLabel}
        </Button>
      </DialogFooter>
    </>
  );
}

/** The Contacts bulk bar's "Check emails" (outline) for the ticked companies (P11 wires it in). */
export function CheckEmailsButton({ companyIds, disabled }: { companyIds: number[]; disabled?: boolean }) {
  return (
    <CheckEmailsDialog
      input={{ companyIds }}
      trigger={
        <Button variant="outline" size="sm" disabled={disabled || companyIds.length === 0}>
          <MailCheck className="size-3.5" aria-hidden /> Check emails
        </Button>
      }
    />
  );
}

/**
 * The list menu's "Check emails" item (P11 puts it in ListMenu's content). Selecting it keeps the menu open (so the
 * item, and with it the dialog, stays mounted) and opens the dialog above it; closing the dialog returns to the menu.
 * The dialog names the list ("Germany Q4 · 45 companies · 61 addresses"); `listName` is its title while it counts.
 */
export function CheckListMenuItem({ listId, listName }: { listId: number; listName: string }) {
  return (
    <CheckEmailsDialog
      input={{ listId }}
      loadingTitle={listName}
      trigger={
        <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
          <MailCheck className="size-4" aria-hidden /> Check emails
        </DropdownMenuItem>
      }
    />
  );
}
