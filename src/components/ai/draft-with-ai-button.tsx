"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useJobPoll } from "@/components/settings/domain/use-job-poll";
import { DraftLinesDialog } from "./draft-lines-dialog";
import type { DraftLinesTarget } from "./draft-lines-text";

/**
 * The company panel's "Draft with AI" (docs/dev/M5-DESIGN.md §6.5): opens the start dialog for this one company. The
 * panel always drafts a new line, also when the company already has one (the new line only replaces it once approved).
 * After a start it follows the run (GET /api/jobs/:id) and refreshes the panel when it has finished, so "Drafting a
 * line…" turns into "A drafted line is waiting for review." without a reload.
 */
export function DraftWithAiButton({ companyId }: { companyId: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [jobId, setJobId] = useState<number | null>(null);
  const target = useMemo<DraftLinesTarget>(() => ({ companyId }), [companyId]);
  useJobPoll(jobId, {
    onDone: () => {
      setJobId(null);
      router.refresh();
    },
  });
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Sparkles aria-hidden />
        Draft with AI
      </Button>
      <DraftLinesDialog target={target} open={open} onOpenChange={setOpen} onStarted={(run) => setJobId(run.jobId)} />
    </>
  );
}
