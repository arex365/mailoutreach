"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { DatabaseBackup, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/forms/field";
import { summaryHasCopyFailure } from "@/core/backups/copy-note";
import type { PublicJob } from "@/server/jobs";
import { backUpNowAction } from "./actions";
import { startsFollowing } from "./follow-job";

const WORKER_DOWN =
  "The background sender isn't running, so the backup is waiting. Double-click start.bat on the office PC.";
const POLL_MS = 2_000;

/** True when /api/health says the background sender checked in during the last minute. */
async function workerIsRunning(): Promise<boolean | null> {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    const h = (await res.json()) as { workerLastSeen?: string | null; time?: string };
    if (!h.workerLastSeen || !h.time) return false;
    return new Date(h.time).getTime() - new Date(h.workerLastSeen).getTime() < 60_000;
  } catch {
    return null; // can't tell
  }
}

/**
 * "Back up now": queues a backup, then polls /api/jobs/<id> until it's done (PLAN.md B6.14:
 * progress screens poll every 2–3 s, no live connection). A backup queued elsewhere and shown after a refresh (Save
 * folder's first copy, another person's click) is followed the same way (review SCREENS-03); a finished one going away
 * never clears what the button says about it.
 */
export function BackupNowButton({
  initialJobId,
  initialStatus,
  workerRunning,
}: {
  initialJobId: number | null;
  initialStatus: string | null;
  workerRunning: boolean;
}) {
  const router = useRouter();
  const [jobId, setJobId] = useState<number | null>(initialJobId);
  const [status, setStatus] = useState<string | null>(initialJobId ? initialStatus : null);
  const [workerDown, setWorkerDown] = useState(!workerRunning);
  const [error, setError] = useState<string | null>(null);
  /** Technical text behind a failed backup, shown only under "Details". */
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [starting, startTransition] = useTransition();

  // A newly waiting backup from the server (after router.refresh()): follow it. Adjusted while rendering, React's
  // pattern for state that follows a prop.
  const [seenJobId, setSeenJobId] = useState<number | null>(initialJobId);
  if (initialJobId !== seenJobId) {
    setSeenJobId(initialJobId);
    if (startsFollowing(initialJobId, jobId)) {
      setJobId(initialJobId);
      setStatus(initialStatus);
      setError(null);
      setErrorDetail(null);
    }
  }

  useEffect(() => {
    if (jobId === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;

    const finish = () => {
      setJobId(null);
      setStatus(null);
      router.refresh();
    };

    const poll = async () => {
      polls += 1;
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 401) {
          setError("Your session has ended. Sign in again to see how the backup went.");
          setJobId(null);
          setStatus(null);
          return;
        }
        if (res.status === 404) return finish();
        if (res.ok) {
          const job = (await res.json()) as PublicJob;
          if (cancelled) return;
          if (job.status === "DONE") {
            // Saved, but the copy to the second folder failed: say so as a warning (the summary says why and what to do).
            if (summaryHasCopyFailure(job.summary)) toast.warning(job.summary);
            else toast.success(job.summary ?? "Backup saved.");
            return finish();
          }
          if (job.status === "FAILED") {
            setError(`The backup didn't finish: ${job.error ?? "Something unexpected went wrong."}`);
            setErrorDetail(job.errorDetail ?? null);
            return finish();
          }
          if (job.status === "CANCELLED") return finish();
          setStatus(job.status);
          if (job.status === "RUNNING") setWorkerDown(false);
          else if (polls % 3 === 1) {
            const running = await workerIsRunning();
            if (!cancelled && running !== null) setWorkerDown(!running);
          }
        }
      } catch {
        /* network hiccup (e.g. the PC is busy): just try again */
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    };

    timer = setTimeout(poll, 1_000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [jobId, router]);

  function start() {
    setError(null);
    setErrorDetail(null);
    startTransition(async () => {
      const res = await backUpNowAction();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setWorkerDown(!res.data.workerRunning);
      setStatus("QUEUED");
      setJobId(res.data.jobId);
    });
  }

  const busy = starting || jobId !== null;
  const label = starting
    ? "Starting…"
    : status === "RUNNING"
      ? "Backing up…"
      : jobId !== null
        ? "Waiting to start…"
        : "Back up now";
  const note =
    jobId === null
      ? null
      : status === "RUNNING"
        ? "Copying the database. This usually takes a few seconds."
        : workerDown
          ? WORKER_DOWN
          : "The backup starts in a moment.";

  return (
    <div className="grid gap-2">
      <div>
        <Button type="button" onClick={start} disabled={busy}>
          {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : <DatabaseBackup aria-hidden />}
          {label}
        </Button>
      </div>
      <p role="status" aria-live="polite" className={note === WORKER_DOWN ? "text-sm text-warning" : "text-sm text-muted-foreground"}>
        {note}
      </p>
      <FormError message={error} />
      {error && errorDetail ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Details</summary>
          <p className="mt-1 font-mono break-all text-muted-foreground">{errorDetail}</p>
        </details>
      ) : null}
    </div>
  );
}
