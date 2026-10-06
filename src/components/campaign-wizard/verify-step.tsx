"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CircleAlert, MailCheck } from "lucide-react";
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
import { useJobPoll, type PolledJob } from "@/components/settings/domain/use-job-poll";
import { CHECK_SETTINGS_HREF, MEMBER_PAUSE_NOTE } from "@/components/checks/run-text";
import {
  continueWithoutText,
  verifyStepModel,
  VERIFY_INTRO,
  type VerifyLastRun,
  type VerifyModel,
  type VerifyRunInfo,
} from "@/components/checks/verify-model";
import { continueAction } from "@/app/(app)/campaigns/[id]/setup/actions";
import { startCampaignChecksAction, stopChecksAction } from "@/app/(app)/campaigns/[id]/setup/verify-actions";
import type { CampaignCheckView } from "@/server/services/verification/select";
import { StepFooter } from "./step-footer";
import { StepIntro } from "./wizard-frame";

const OFFLINE = "Couldn't reach the app, so nothing changed. Check your connection and try again.";

/** The poll's newer data for the page's run (same job only). */
function mergeRun(run: CampaignCheckView["run"], live: PolledJob | null): VerifyRunInfo | null {
  if (!run) return null;
  if (!live || live.id !== run.jobId) return run;
  return {
    ...run,
    status: live.status,
    done: live.progressDone,
    total: live.progressTotal,
    summary: live.summary,
    waitingUntil: live.waitingUntil ?? null,
  };
}

/**
 * Step 4, Verify (M5-DESIGN §6.1): how many addresses need a check and what it costs, starting and following the
 * campaign's check run (every 2 s through GET /api/jobs/:id), Stop, the finished run's results and who is left out,
 * "Continue without checking" (those people are left out at launch), and the dry-run and before-go-live notes. The
 * page refreshes itself when the run changes state, so the server's view stays the source of truth.
 */
export function VerifyStep({
  campaignId,
  view,
  lastRun,
  isOwner,
  maxAgeDays,
  timeZone,
  nowIso,
}: {
  campaignId: number;
  view: CampaignCheckView;
  lastRun: VerifyLastRun | null;
  isOwner: boolean;
  /** Setting "verification.maxAgeDays". */
  maxAgeDays: number;
  /** The viewer's time zone. */
  timeZone: string;
  /** When the page was made. */
  nowIso: string;
}) {
  const router = useRouter();
  const [live, setLive] = useState<PolledJob | null>(null);
  const [stopOpen, setStopOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [footerError, setFooterError] = useState<string | null>(null);

  const run = mergeRun(view.run, live);
  const model: VerifyModel = verifyStepModel({ view, run, lastRun, isOwner, maxAgeDays, timeZone, now: new Date(nowIso) });
  const activeJobId = model.active?.jobId ?? null;

  useJobPoll(activeJobId, {
    onProgress: (job) => {
      const before = live?.id === job.id ? live.status : view.run?.status;
      setLive(job);
      // Queued → running, running → waiting or paused: the server's view says what that means now.
      if (before && before !== job.status) router.refresh();
    },
    onDone: () => router.refresh(),
  });

  function startChecks(count: number) {
    setFooterError(null);
    startTransition(async () => {
      try {
        const res = await startCampaignChecksAction({ campaignId, confirmedCount: count });
        if (!res.ok) {
          toast.error(res.error);
          router.refresh();
          return;
        }
        router.refresh();
      } catch {
        toast.error(OFFLINE);
      }
    });
  }

  function stop(jobId: number) {
    startTransition(async () => {
      try {
        const res = await stopChecksAction({ jobId });
        setStopOpen(false);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(res.message ?? "Address checks stopped.");
        router.refresh();
      } catch {
        toast.error(OFFLINE);
      }
    });
  }

  function continueOn() {
    setFooterError(null);
    startTransition(async () => {
      try {
        const res = await continueAction({ campaignId, from: "verify" });
        if (!res.ok) {
          setLeaveOpen(false);
          setFooterError(res.error);
          return;
        }
        router.push(res.data.href);
      } catch {
        setLeaveOpen(false);
        setFooterError(OFFLINE);
      }
    });
  }

  const main = model.main;
  const checkButton =
    main?.check && main.check.primary ? (
      <Button onClick={() => startChecks(main.check!.count)} disabled={main.check.disabled || pending}>
        <MailCheck aria-hidden />
        {main.check.label}
      </Button>
    ) : null;

  return (
    <div className="flex flex-1 flex-col">
      <StepIntro title={VERIFY_INTRO.title}>{VERIFY_INTRO.description}</StepIntro>

      <div className="grid max-w-3xl gap-4">
        {model.active ? (
          <ActiveRunCard model={model} isOwner={isOwner} onStop={() => setStopOpen(true)} pending={pending} />
        ) : null}

        {model.pause ? <PauseNotice text={model.pause.text} isOwner={isOwner} /> : null}

        {model.done ? (
          <section aria-labelledby="verify-done" className="grid gap-2 rounded-lg border border-border bg-card p-4">
            <h3 id="verify-done" className="font-medium">
              {model.done.heading}
            </h3>
            {model.done.error ? (
              <p role="alert" className="text-sm text-destructive">
                {model.done.error}
              </p>
            ) : null}
            {model.done.lines.length > 0 ? (
              <ul className="grid gap-1 text-sm">
                {model.done.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {main ? (
          <section aria-labelledby={main.heading ? "verify-main" : undefined} className="grid gap-2 rounded-lg border border-border bg-card p-4">
            <div className="flex items-start gap-3">
              <MailCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
              <div className="grid min-w-0 gap-1.5">
                {main.heading ? (
                  <h3 id="verify-main" className="font-medium">
                    {main.heading}
                  </h3>
                ) : null}
                {main.kind === "needs" && main.lines.length > 0 ? (
                  <ul className="grid list-disc gap-0.5 pl-5 text-sm">
                    {main.lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ) : (
                  main.lines.map((line) => (
                    <p key={line} className={main.kind === "not-ready" ? "text-sm text-warning" : "text-sm"}>
                      {line}
                    </p>
                  ))
                )}
                {main.costLine ? <p className="text-sm">{main.costLine}</p> : null}
                {main.blocker ? (
                  <p role="alert" className="flex items-start gap-2 text-sm text-warning">
                    <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                    {main.blocker}
                  </p>
                ) : null}
                {main.notes.map((note) => (
                  <p key={note} className="text-sm text-muted-foreground">
                    {note}
                  </p>
                ))}
                {main.check && !main.check.primary ? (
                  <div className="pt-1">
                    <Button variant="outline" onClick={() => startChecks(main.check!.count)} disabled={main.check.disabled || pending}>
                      <MailCheck aria-hidden />
                      {main.check.label}
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}

        {model.leftOut.length > 0 ? (
          <details className="rounded-lg border border-border bg-card px-4 py-3 text-sm">
            <summary className="cursor-pointer font-medium">Who is left out ({model.leftOut.length.toLocaleString("en-US")})</summary>
            <ul className="mt-2 grid gap-1">
              {model.leftOut.map((p) => (
                <li key={p.personId} className="break-words">
                  {p.name} · {p.email} · {p.companyName} — {p.reason}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>

      {model.footer === "check" ? (
        <StepFooter
          campaignId={campaignId}
          current="verify"
          note={
            footerError ? (
              <span role="alert" className="text-destructive">
                {footerError}
              </span>
            ) : null
          }
          primary={
            <>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => (model.continueWithout && model.continueWithout.leaveOut > 0 ? setLeaveOpen(true) : continueOn())}
              >
                Continue without checking
              </Button>
              {checkButton}
            </>
          }
        />
      ) : (
        <StepFooter campaignId={campaignId} current="verify" />
      )}

      <AlertDialog open={stopOpen} onOpenChange={(o) => !pending && setStopOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop checking?</AlertDialogTitle>
            <AlertDialogDescription>{model.active?.stopText}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep checking</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                if (model.active) stop(model.active.jobId);
              }}
            >
              {pending ? "Stopping…" : "Stop checking"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={leaveOpen} onOpenChange={(o) => !pending && setLeaveOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Continue without checking?</AlertDialogTitle>
            <AlertDialogDescription>{continueWithoutText(model.continueWithout?.leaveOut ?? 0)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                continueOn();
              }}
            >
              {pending ? "Continuing…" : "Leave them out and continue"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The amber "checks are paused" card: the pause text, then the Owner's link or the Member's note. */
function PauseNotice({ text, isOwner, children }: { text: string; isOwner: boolean; children?: React.ReactNode }) {
  return (
    <section role="status" className="grid gap-2 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
      <p className="flex items-start gap-2 text-warning">
        <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>{text}</span>
      </p>
      {isOwner ? (
        <p>
          <Link href={CHECK_SETTINGS_HREF} className="underline underline-offset-3 hover:no-underline">
            Open Settings › Deliverability
          </Link>
        </p>
      ) : (
        <p className="text-muted-foreground">{MEMBER_PAUSE_NOTE}</p>
      )}
      {children}
    </section>
  );
}

/** The campaign's queued, waiting, paused or running check run, with Stop checking. */
function ActiveRunCard({
  model,
  isOwner,
  onStop,
  pending,
}: {
  model: VerifyModel;
  isOwner: boolean;
  onStop: () => void;
  pending: boolean;
}) {
  const active = model.active!;
  const stopButton = (
    <div>
      <Button variant="outline" onClick={onStop} disabled={pending}>
        Stop checking
      </Button>
    </div>
  );
  if (active.state === "paused") {
    return (
      <PauseNotice text={active.text} isOwner={isOwner}>
        {stopButton}
      </PauseNotice>
    );
  }
  const percent = active.progress && active.progress.total > 0 ? (active.progress.done / active.progress.total) * 100 : 0;
  return (
    <section aria-labelledby={active.heading ? "verify-run" : undefined} className="grid gap-3 rounded-lg border border-border bg-card p-4">
      {active.heading ? (
        <h3 id="verify-run" className="font-medium">
          {active.heading}
        </h3>
      ) : null}
      {active.state === "running" ? <ProgressBar percent={percent} label="Address checks" /> : null}
      <p className="text-sm" role="status" aria-live="polite">
        {active.text}
      </p>
      {active.note ? <p className="text-sm text-muted-foreground">{active.note}</p> : null}
      {stopButton}
    </section>
  );
}
