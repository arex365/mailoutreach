"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/forms/field";
import { roundTripResultLines } from "@/core/import/round-trip";
import { importSummarySentence, type ImportResultSummary } from "@/core/import/types";
import type { PublicJob } from "@/server/jobs";
import { importJobAction, startImportAction, workerRunningAction } from "@/app/(app)/import/actions";

const POLL_MS = 2_000;
const WAITING_WARNING_MS = 15_000;

function readJob(data: unknown): PublicJob | null {
  if (!data || typeof data !== "object") return null;
  const obj = ("job" in data ? (data as { job: unknown }).job : data) as Partial<PublicJob> | null;
  if (!obj || typeof obj !== "object" || typeof obj.status !== "string" || typeof obj.id !== "number") return null;
  return obj as PublicJob;
}

/** Progress bar in neutral colours (orange is only for primary actions and "selected"). */
function Bar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label="Import progress"
      className="h-2 w-full overflow-hidden rounded-full bg-muted"
    >
      <div className="h-full rounded-full bg-foreground/70 transition-[width] duration-500" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Step 5 while the background sender imports: polls the task every 2 s. */
export function ImportProgress({
  sessionId,
  jobId: initialJobId,
  fileLabel,
}: {
  sessionId: number;
  jobId: number | null;
  fileLabel: string;
}) {
  const router = useRouter();
  const [jobId, setJobId] = useState<number | null>(initialJobId);
  const [job, setJob] = useState<PublicJob | null>(null);
  const [workerDown, setWorkerDown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const startedAt = useRef(0);
  const lastWorkerCheck = useRef(0);
  const refreshed = useRef(false);

  const fetchJob = useCallback(async (): Promise<PublicJob | null> => {
    if (jobId) {
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
        if (res.ok) {
          const parsed = readJob(await res.json());
          if (parsed) return parsed;
        }
      } catch {
        /* fall back below */
      }
    }
    const res = await importJobAction({ sessionId });
    return res.ok ? res.data : null;
  }, [jobId, sessionId]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!startedAt.current) startedAt.current = Date.now();
    const tick = async () => {
      const current = await fetchJob().catch(() => null);
      if (stopped) return;
      if (current) {
        setJob(current);
        if (current.id !== jobId) setJobId(current.id);
        if (current.status === "DONE") {
          if (!refreshed.current) {
            refreshed.current = true;
            router.refresh();
          }
          return;
        }
        if (current.status === "FAILED" || current.status === "CANCELLED") return;
        const waitingSince = Date.parse(current.createdAt) || startedAt.current;
        if (current.status === "QUEUED" && Date.now() - Math.max(waitingSince, startedAt.current) > WAITING_WARNING_MS) {
          if (Date.now() - lastWorkerCheck.current > 10_000) {
            lastWorkerCheck.current = Date.now();
            const w = await workerRunningAction();
            if (!stopped && w.ok) setWorkerDown(!w.data.running);
          }
        } else if (current.status === "RUNNING") {
          setWorkerDown(false);
        }
      }
      timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchJob, jobId, router]);

  async function retry() {
    setError(null);
    setRetrying(true);
    const res = await startImportAction({ sessionId });
    setRetrying(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    startedAt.current = Date.now();
    refreshed.current = false;
    setJob(null);
    setWorkerDown(false);
    setJobId(res.data.jobId);
  }

  const failed = job?.status === "FAILED" || job?.status === "CANCELLED";
  const done = job?.progressDone ?? 0;
  const total = job?.progressTotal ?? 0;

  if (failed) {
    return (
      <div className="grid max-w-2xl gap-4">
        <h2 className="text-lg font-medium">The import stopped</h2>
        <FormError
          message={
            job?.status === "CANCELLED"
              ? "The import was cancelled before it finished. Rows that were already imported stay; click Try again to import the rest."
              : `${job?.error ?? "Something went wrong."} Rows that were already imported stay; click Try again to carry on from where it stopped.`
          }
        />
        {job?.status === "FAILED" && job.errorDetail ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Details</summary>
            <p className="mt-1 font-mono break-all text-muted-foreground">{job.errorDetail}</p>
          </details>
        ) : null}
        <FormError message={error} />
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={retry} disabled={retrying}>
            {retrying ? "Starting…" : "Try again"}
          </Button>
          <Button asChild variant="ghost">
            <Link href="/import">Back to Import</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid max-w-2xl gap-4" aria-live="polite">
      <h2 className="text-lg font-medium">
        {job?.status === "DONE" ? "Finishing…" : job?.status === "RUNNING" ? `Importing ${fileLabel}…` : "Waiting to start…"}
      </h2>
      <Bar done={done} total={total} />
      <p className="tabular text-sm text-muted-foreground">
        {total > 0
          ? `${done.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} rows done`
          : "The background sender picks up the import in a moment."}
      </p>
      {workerDown ? (
        <div role="alert" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          The background sender isn&apos;t running, so the import is waiting. Double-click start.bat on the office PC.
        </div>
      ) : null}
      <p className="text-sm text-muted-foreground">
        You can leave this page; the import carries on and its result shows on the Import page.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="tabular text-2xl font-semibold">{value.toLocaleString("en-US")}</div>
    </div>
  );
}

/** "Download problem rows (3)": the rows that weren't imported cleanly or carry a note (problems.ts). */
function ProblemRowsLink({ sessionId, count }: { sessionId: number; count: number }) {
  return (
    <Button asChild variant="outline">
      {/* No `download` attribute: the file comes as an attachment, and if something goes wrong
          (signed out, import gone) the browser shows the plain page with a way back instead of
          saving that page as a file. */}
      <a href={`/api/imports/${sessionId}/problems`}>
        <Download aria-hidden />
        Download problem rows ({count.toLocaleString("en-US")})
      </a>
    </Button>
  );
}

/**
 * Step 5 of the missing-emails round trip (M5-DESIGN §6.10): "Added 37 people to 30 companies." +
 * "5 rows had no email." + the problem-rows download. The Missing email view is where the round trip began.
 */
function RoundTripResult({ sessionId, summary }: { sessionId: number; summary: ImportResultSummary }) {
  const problemRows = summary.problems + summary.invalidEmails + summary.notes;
  const [first, ...rest] = roundTripResultLines(summary);
  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="grid gap-1">
        <h2 className="text-lg font-medium">Import finished</h2>
        <p className="text-sm">{first}</p>
        {rest.map((line, i) => (
          <p key={i} className="text-sm text-muted-foreground">
            {line}
          </p>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <Link href="/contacts?view=missing-email">Open Missing email</Link>
        </Button>
        {problemRows > 0 ? <ProblemRowsLink sessionId={sessionId} count={problemRows} /> : null}
        <Button asChild variant="ghost">
          <Link href="/import">Import another file</Link>
        </Button>
      </div>
    </div>
  );
}

/** Step 5 when finished: the numbers in the owner's words, and where to go next. */
export function ImportResult({
  sessionId,
  fileLabel,
  summary,
}: {
  sessionId: number;
  fileLabel: string;
  summary: ImportResultSummary;
}) {
  if (summary.roundTrip) return <RoundTripResult sessionId={sessionId} summary={summary} />;
  const problemRows = summary.problems + summary.invalidEmails + summary.notes;
  return (
    <div className="grid grid-cols-1 gap-6">
      <div>
        <h2 className="text-lg font-medium">Import finished</h2>
        <p className="text-sm text-muted-foreground">{importSummarySentence(fileLabel, summary)}</p>
        {summary.listName || summary.tagName ? (
          <p className="text-sm text-muted-foreground">
            {summary.listName ? `Added to the list "${summary.listName}".` : ""}
            {summary.listName && summary.tagName ? " " : ""}
            {summary.tagName ? `Tagged "${summary.tagName}".` : ""}
          </p>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Stat label="Created" value={summary.created} />
        <Stat label="Updated" value={summary.updated} />
        {summary.unchanged ? <Stat label="Already up to date" value={summary.unchanged} /> : null}
        <Stat label="Skipped duplicates" value={summary.skipped} />
        <Stat label="People added" value={summary.peopleAdded} />
        {summary.restored ? <Stat label="Restored" value={summary.restored} /> : null}
        <Stat label="Invalid emails" value={summary.invalidEmails} />
        <Stat label="Empty rows" value={summary.emptyRows} />
        <Stat label="Problems" value={summary.problems} />
      </div>
      <div className="flex flex-wrap gap-2">
        {summary.listId ? (
          <Button asChild>
            <Link href={`/contacts?list=${summary.listId}`}>Open the list</Link>
          </Button>
        ) : null}
        <Button asChild variant={summary.listId ? "outline" : "default"}>
          <Link href="/contacts">Go to Contacts</Link>
        </Button>
        {problemRows > 0 ? <ProblemRowsLink sessionId={sessionId} count={problemRows} /> : null}
        <Button asChild variant="ghost">
          <Link href="/import">Import another file</Link>
        </Button>
      </div>
    </div>
  );
}
