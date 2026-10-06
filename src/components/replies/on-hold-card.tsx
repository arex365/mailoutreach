"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PauseCircle } from "lucide-react";
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
import { plural } from "@/core/text";
import { continueMyFollowUpsAction } from "@/app/(app)/notifications/reply-actions";
import { tellBell } from "./tell-bell";

const OFFLINE = "Couldn't reach the app. Check your connection and try again.";

/** The On hold card's texts (M4-DESIGN §9.1), from the viewer's counts and the window in their own time zone. */
export function onHoldTexts(i: { held: number; firstEmailsWaiting: number; from: string | null; to: string | null }): {
  title: string;
  text: string;
  confirm: string | null;
} {
  const window = i.from && i.to ? `from ${i.from} to ${i.to}` : null;
  if (i.held === 0) {
    return {
      title: "Some of your first emails are on hold",
      text:
        `First emails to ${plural(i.firstEmailsWaiting, "person", "people")} wait until the senders who already emailed their companies ` +
        `have checked their inbox for replies${window ? ` ${window}` : " from the days the PC was off"}. There's nothing for you to do.`,
      confirm: null,
    };
  }
  const colleagues =
    i.firstEmailsWaiting > 0 ? ` First emails to ${plural(i.firstEmailsWaiting, "other person", "other people")} at those companies wait too.` : "";
  return {
    title: "Your follow-ups are on hold",
    text:
      // The window is the part the app couldn't check (the replies that may have been missed), not the PC's off-time.
      `The PC was off too long, so the app may have missed replies that arrived ${window ?? "then"}. ` +
      `Look through your inbox for replies to your campaigns from those days. Follow-ups of ${plural(i.held, "person", "people")} wait until you confirm.${colleagues}`,
    confirm:
      `Did you check your inbox for replies${window ? ` ${window}` : " from those days"}? Follow-ups to ${plural(i.held, "person", "people")} will continue. ` +
      "If someone replied, set their company to Replied first, so their follow-ups stop.",
  };
}

/**
 * "Your follow-ups are on hold" (M4-DESIGN §2.8.3, §9.1): after a long outage the viewer's follow-ups (and first emails
 * to colleagues at the same companies) wait until they have checked their inbox. "I've checked my inbox" (the page's
 * primary action) asks first, then continues them. When only first emails wait for other senders, there's nothing to do.
 */
export function OnHoldCard({ held, firstEmailsWaiting, from, to }: { held: number; firstEmailsWaiting: number; from: string | null; to: string | null }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [pending, startTransition] = useTransition();
  const t = onHoldTexts({ held, firstEmailsWaiting, from, to });

  function release() {
    startTransition(async () => {
      try {
        const res = await continueMyFollowUpsAction();
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(res.data.message);
        setConfirm(false);
        tellBell();
        router.refresh();
      } catch {
        toast.error(OFFLINE);
      }
    });
  }

  return (
    <section id="on-hold" aria-labelledby="on-hold-title" className="grid scroll-mt-4 gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <div className="flex items-start gap-3">
        <PauseCircle className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="grid min-w-0 gap-1">
          <h2 id="on-hold-title" className="text-base font-semibold">
            {t.title}
          </h2>
          <p className="text-sm text-muted-foreground">{t.text}</p>
        </div>
      </div>
      {t.confirm ? (
        <div>
          <Button onClick={() => setConfirm(true)} disabled={pending}>
            I&apos;ve checked my inbox
          </Button>
        </div>
      ) : null}
      {t.confirm ? (
        <AlertDialog open={confirm} onOpenChange={(open) => !pending && setConfirm(open)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Continue your follow-ups?</AlertDialogTitle>
              <AlertDialogDescription>{t.confirm}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={pending}
                onClick={(e) => {
                  e.preventDefault();
                  release();
                }}
              >
                {pending ? "Continuing…" : "I've checked my inbox"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </section>
  );
}
