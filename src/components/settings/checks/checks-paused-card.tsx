"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { resumeChecksAction } from "@/app/(app)/settings/deliverability/check-actions";

const OFFLINE = "Couldn't reach the app, so nothing changed. Check your connection and try again.";

/**
 * The amber "Address checks paused" card above the address-check cards (M5-DESIGN §6.6, §2.12): the pause text,
 * Mailgun's own words behind "Details", and "Resume checks", the page's primary action while checks are paused (the
 * page then passes `primary={false}` to the Thresholds form, so "Resume checks" is its only orange button).
 */
export function ChecksPausedCard({ text, detail }: { text: string; detail: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function resume() {
    startTransition(async () => {
      try {
        const res = await resumeChecksAction();
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(res.message ?? "Address checks resumed.");
        router.refresh();
      } catch {
        toast.error(OFFLINE);
      }
    });
  }

  return (
    <section aria-labelledby="checks-paused" className="grid gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
      <h3 id="checks-paused" className="flex items-start gap-2 font-medium text-warning">
        <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>{text}</span>
      </h3>
      {detail ? (
        <details className="text-muted-foreground">
          <summary className="cursor-pointer">Details</summary>
          <p className="mt-1 font-mono text-xs break-words">{detail}</p>
        </details>
      ) : null}
      <div>
        <Button onClick={resume} disabled={pending}>
          {pending ? "Resuming…" : "Resume checks"}
        </Button>
      </div>
    </section>
  );
}
