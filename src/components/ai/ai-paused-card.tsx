"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { resumeAiAction } from "@/app/(app)/ai-lines/actions";
import { OFFLINE_TEXT } from "./phone-dialog";

/** What the Member sees instead of Resume (§6.7). */
export const AI_PAUSED_MEMBER_TEXT = "The Owner can fix this in Settings › AI.";
/** When a stored pause has no sentence of its own. */
export const AI_PAUSED_FALLBACK_TEXT = "AI drafting is paused.";

/**
 * The amber "AI drafting paused" card (docs/dev/M5-DESIGN.md §6.7, §6.9): the pause's own sentence, and for the Owner
 * [Resume drafting] (the page's primary action while paused) → "AI drafting resumed."; a Member reads who can fix it.
 */
export function AiPausedCard({ text, isOwner }: { text: string; isOwner: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function resume() {
    startTransition(async () => {
      try {
        const res = await resumeAiAction();
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(res.message ?? "AI drafting resumed.");
        router.refresh();
      } catch {
        toast.error(OFFLINE_TEXT);
      }
    });
  }

  return (
    <section aria-label="AI drafting paused" role="status" className="grid gap-3 rounded-lg border border-warning/40 bg-warning/5 p-4">
      <p className="flex items-start gap-2 text-sm font-medium">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
        <span className="min-w-0 break-words">{text.trim() || AI_PAUSED_FALLBACK_TEXT}</span>
      </p>
      {isOwner ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={resume} disabled={pending}>
            {pending ? "Resuming…" : "Resume drafting"}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{AI_PAUSED_MEMBER_TEXT}</p>
      )}
    </section>
  );
}
