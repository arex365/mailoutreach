"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, RefreshCw, WandSparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { applyRecommendedSettingsAction, checkDomainAgainAction } from "@/app/(app)/settings/domain/actions";
import { useJobPoll } from "./use-job-poll";

const OFFLINE = "Couldn't reach the app, so nothing changed. Check your connection and try again.";

/**
 * "Apply recommended settings" (M3-DESIGN §5.3): the Domain checklist's primary action (orange) while a row it fixes
 * isn't done, otherwise outline (`primary`, M6-DESIGN §5.1 R1; see applyIsPrimary). While its job runs, the page
 * re-reads the steps every time the job moves on (GET /api/jobs/:id every 2 s).
 */
export function ApplyButton({ runningJobId, primary = true }: { runningJobId: number | null; primary?: boolean }) {
  const router = useRouter();
  const [jobId, setJobId] = useState<number | null>(runningJobId);
  const [pending, startTransition] = useTransition();

  useJobPoll(jobId, {
    onProgress: () => router.refresh(),
    onDone: (job) => {
      setJobId(null);
      router.refresh();
      if (job?.status === "DONE") toast.success(job.summary ?? "The recommended settings are applied.");
      else if (job?.status === "FAILED") toast.error(job.error ?? "Apply recommended settings didn't finish.");
    },
  });

  function apply() {
    startTransition(async () => {
      try {
        const res = await applyRecommendedSettingsAction();
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(res.message ?? "Applying the recommended settings.");
        setJobId(res.data.jobId);
        router.refresh();
      } catch {
        toast.error(OFFLINE);
      }
    });
  }

  const busy = pending || jobId !== null;
  return (
    <Button variant={primary ? "default" : "outline"} onClick={apply} disabled={busy}>
      {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : <WandSparkles aria-hidden />}
      {jobId !== null ? "Applying…" : "Apply recommended settings"}
    </Button>
  );
}

const AGAIN_AFTER_MS = 60_000;

/** "Check again" (outline): a fresh domain check; disabled for a minute after use. */
export function CheckAgainButton({ checkedRecently }: { checkedRecently: boolean }) {
  const router = useRouter();
  const [coolingDown, setCoolingDown] = useState(checkedRecently);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!coolingDown) return;
    const t = setTimeout(() => setCoolingDown(false), AGAIN_AFTER_MS);
    return () => clearTimeout(t);
  }, [coolingDown]);

  function check() {
    startTransition(async () => {
      try {
        const res = await checkDomainAgainAction();
        setCoolingDown(true);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(res.message ?? "Checking your domain.");
        router.refresh();
      } catch {
        toast.error(OFFLINE);
      }
    });
  }

  return (
    <Button
      variant="outline"
      onClick={check}
      disabled={pending || coolingDown}
      title={coolingDown ? "Checked just now. Check again in a minute." : undefined}
    >
      <RefreshCw aria-hidden className={pending ? "animate-spin" : undefined} />
      {coolingDown && !pending ? "Checked just now" : "Check again"}
    </Button>
  );
}
