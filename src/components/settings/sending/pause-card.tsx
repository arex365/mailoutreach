"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { FormError } from "@/components/forms/field";
import { pausedWithReason } from "@/core/sending/label";
import { resumeSendingAction } from "@/app/(app)/settings/sending/actions";
import type { PauseView } from "../types";

const OFFLINE = "Couldn't reach the app, so nothing changed. Check your connection and try again.";

/**
 * The red "Sending is paused" card (M3-DESIGN §5.2): why, what to do, since when and by whom, the details, and the
 * page's primary action "Resume sending" with the dialog that fits the cause (a fresh health count, a restore check
 * still running or failed with its required tick box, a copied database). A restore check that fails or can't reach
 * Mailgun after the Owner resumed brings the card back with the tick box (restore.ts pauseUntilAcknowledged).
 */
export function PauseCard({ view }: { view: PauseView }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function resume() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await resumeSendingAction({ confirmRestoreRisk: view.confirmLabel ? confirmed : undefined });
        if (!res.ok) {
          setError(res.error);
          // The pause may have changed while the dialog was open (e.g. the restore check failed meanwhile and now
          // needs the tick box): show the card as it is now, with the dialog still open.
          router.refresh();
          return;
        }
        toast.success(res.message ?? "Sending is resumed.");
        setOpen(false);
        router.refresh();
      } catch {
        setError(OFFLINE);
      }
    });
  }

  return (
    <section aria-labelledby="pause-title" className="grid gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4">
      <h3 id="pause-title" className="flex items-start gap-2 text-base font-semibold text-destructive">
        <CircleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
        {pausedWithReason("Sending is paused", view.reason)}.
      </h3>
      {view.fixText ? <p className="text-sm">{view.fixText}</p> : null}
      {view.restoreText ? <p className="text-sm">{view.restoreText}</p> : null}
      <p className="text-sm text-muted-foreground">{view.sinceText}</p>
      {view.details.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Details</summary>
          <ul className="mt-1 grid gap-1 pl-4">
            {view.details.map((d, i) => (
              <li key={i} className="list-disc break-words">
                {d}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setOpen(true)}>Resume sending</Button>
        {view.healthLink ? (
          <Button asChild variant="outline">
            <Link href={view.healthLink.href}>{view.healthLink.label}</Link>
          </Button>
        ) : null}
      </div>

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setError(null);
            setConfirmed(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Resume sending?</DialogTitle>
            <DialogDescription asChild>
              <div className="grid gap-2">
                {view.dialog.map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            </DialogDescription>
          </DialogHeader>
          {view.confirmLabel ? (
            <div className="flex items-start gap-2">
              <Checkbox id="confirm-restore-risk" checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} className="mt-0.5" />
              <Label htmlFor="confirm-restore-risk" className="font-normal leading-snug">
                {view.confirmLabel}
              </Label>
            </div>
          ) : null}
          <FormError message={error} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Stay paused
            </Button>
            <Button onClick={resume} disabled={pending || (view.confirmLabel !== null && !confirmed)}>
              {pending ? "Resuming…" : "Resume sending"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
