"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useJobPoll, type PolledJob } from "@/components/settings/domain/use-job-poll";
import { checkPersonAction, checkRunViewAction } from "@/app/(app)/contacts/check-actions";
import { checkButtonTip, checkConfirmText, checkedTodayTip, panelCheckToast, type PanelCheckToast } from "./panel-check";
import type { PersonChecker } from "./types";

const OFFLINE = "Couldn't reach the app, so nothing changed. Check your connection and try again.";
const LOST_TRACK = "Couldn't follow the check from here. Refresh the page in a minute to see the result.";

/** Shows a finished check's toast; a refusal keeps Mailgun's own words behind "Details". */
function showCheckToast(t: PanelCheckToast): void {
  if (t.tone === "success") {
    toast.success(t.text);
    return;
  }
  if (t.tone === "info") {
    toast(t.text);
    return;
  }
  toast.error(t.text, {
    duration: t.detail ? 15_000 : undefined,
    description: t.detail ? (
      <details>
        <summary className="cursor-pointer">Details</summary>
        <p className="mt-1 font-mono text-xs break-words">{t.detail}</p>
      </details>
    ) : undefined,
  });
}

/**
 * The company panel's "Check" on one person (M5-DESIGN §6.5): a ghost button with the checker and price in its
 * tooltip, a small confirmation ("Check anna@firma.de? About $0.01."), then "Checking…" until the run is done and a
 * toast with the result. Off, with the reason in its tooltip, when a real provider checked this address in the last
 * 24 hours (Mailgun would answer the same and charge again).
 */
export function PersonCheckButton({
  personId,
  email,
  checkedToday,
  checker,
}: {
  personId: number;
  email: string;
  /** A real provider checked this address in the last 24 hours. */
  checkedToday: boolean;
  checker: PersonChecker;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [jobId, setJobId] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  useJobPoll(jobId, {
    onDone: (job) => {
      if (jobId !== null) void finish(jobId, job);
    },
  });

  async function finish(id: number, job: PolledJob | null) {
    setJobId(null);
    if (!job) {
      toast.error(LOST_TRACK);
      return;
    }
    try {
      const res = await checkRunViewAction({ jobId: id });
      if (!res.ok) toast.error(res.error);
      else showCheckToast(panelCheckToast(email, res.data, { practiceCopy: checker.practiceCopy }));
    } catch {
      toast.error(OFFLINE);
    }
    // The badge, the date and the reasons come from the server.
    router.refresh();
  }

  function start() {
    setOpen(false);
    startTransition(async () => {
      try {
        const res = await checkPersonAction({ personId });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        setJobId(res.data.jobId);
      } catch {
        toast.error(OFFLINE);
      }
    });
  }

  if (checkedToday) {
    const tip = checkedTodayTip(email);
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Disabled buttons get no pointer or focus events, so the wrapper carries the tooltip. */}
          <span tabIndex={0} role="button" aria-disabled="true" className="inline-flex shrink-0 rounded-md" aria-label={`Check ${email}. ${tip}`}>
            <Button type="button" variant="ghost" size="xs" disabled tabIndex={-1} aria-hidden>
              <MailCheck aria-hidden />
              Check
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{tip}</TooltipContent>
      </Tooltip>
    );
  }

  const checking = pending || jobId !== null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="xs" disabled={checking} aria-label={checking ? `Checking ${email}` : `Check ${email}`}>
              <MailCheck aria-hidden />
              {checking ? "Checking…" : "Check"}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{checkButtonTip(checker)}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-72 max-w-[calc(100vw-2rem)]">
        <p className="text-sm break-words">{checkConfirmText(email, checker)}</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={start}>
            Check
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
