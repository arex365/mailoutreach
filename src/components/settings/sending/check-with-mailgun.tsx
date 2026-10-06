"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Info, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
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
import { cn } from "@/lib/utils";
import { checkWithMailgunAction, continueFollowUpsAction } from "@/app/(app)/settings/sending/actions";
import type { OutageSenderRow, OutageView } from "@/app/(app)/settings/sending/load";

const OFFLINE = "Couldn't reach the app, so nothing changed. Check your connection and try again.";

/**
 * "Check with Mailgun" (M3-DESIGN §5.2, M4-DESIGN §9.9): when the app last caught up with Mailgun (or since when it
 * can't), older sending domains whose logs couldn't be checked (M6-DESIGN L10, amber), what a long time the PC was off
 * means for follow-ups (found and being put on hold; held, with one row per sender and "Continue Ali's follow-ups"
 * behind a confirmation; nothing held any more; replies recovered without their text), and "Check with Mailgun now".
 */
export function CheckWithMailgun({
  line,
  failing,
  detail,
  oldDomains = [],
  outage,
}: {
  line: string;
  failing: boolean;
  detail: string | null;
  /** "Mailgun's logs for the old domain mail.example.com haven't been checked since 25 Sep. …" per older domain. */
  oldDomains?: string[];
  outage: OutageView | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function check() {
    startTransition(async () => {
      try {
        const res = await checkWithMailgunAction();
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(res.message ?? "Checking with Mailgun.");
        router.refresh();
      } catch {
        toast.error(OFFLINE);
      }
    });
  }

  return (
    <div className="grid gap-3">
      <p className={failing ? "text-sm text-warning" : "text-sm"}>{line}</p>
      {detail ? (
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer">Details</summary>
          <p className="mt-1 break-words font-mono text-xs">{detail}</p>
        </details>
      ) : null}
      {oldDomains.map((text) => (
        <p key={text} className="flex items-start gap-2 text-sm text-warning">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{text}</span>
        </p>
      ))}
      {outage ? <OutageLines view={outage} /> : null}
      <div>
        <Button variant="outline" onClick={check} disabled={pending}>
          <RefreshCw aria-hidden className={pending ? "animate-spin" : undefined} />
          {pending ? "Asking Mailgun…" : "Check with Mailgun now"}
        </Button>
      </div>
    </div>
  );
}

/** The outage line (amber while follow-ups wait, neutral afterwards), the held senders and the colleagues' line. */
export function OutageLines({ view }: { view: OutageView }) {
  const warning = view.tone === "warning";
  const Icon = warning ? TriangleAlert : Info;
  return (
    <div
      role="status"
      className={cn(
        "grid gap-2 rounded-md border px-3 py-2 text-sm",
        warning ? "border-warning/40 bg-warning/5" : "border-border bg-card",
      )}
    >
      <p className="flex items-start gap-2">
        <Icon className={cn("mt-0.5 size-4 shrink-0", warning ? "text-warning" : "text-muted-foreground")} aria-hidden />
        <span>{view.line}</span>
      </p>
      {view.senders.length > 0 ? (
        <ul className="grid gap-2 pl-6">
          {view.senders.map((s) => (
            <li key={s.senderId ?? "none"} className="flex flex-wrap items-center justify-between gap-2">
              <span className="break-words">{s.label}</span>
              <ContinueButton row={s} />
            </li>
          ))}
        </ul>
      ) : null}
      {view.colleagues ? <p className="pl-6 text-muted-foreground">{view.colleagues}</p> : null}
    </div>
  );
}

/** "Continue Ali's follow-ups" with its confirmation: only after Ali has checked their inbox. */
function ContinueButton({ row }: { row: OutageSenderRow }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function go() {
    startTransition(async () => {
      try {
        const res = await continueFollowUpsAction({ senderId: row.senderId });
        setOpen(false);
        if (!res.ok) {
          toast.error(res.error);
          router.refresh();
          return;
        }
        toast.success(res.message ?? "Follow-ups continue.");
        router.refresh();
      } catch {
        toast.error(OFFLINE);
      }
    });
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={pending}>
        {row.buttonLabel}
      </Button>
      <AlertDialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{row.dialogTitle}</AlertDialogTitle>
            <AlertDialogDescription>{row.dialogText}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                go();
              }}
            >
              {pending ? "Continuing…" : "Continue follow-ups"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
