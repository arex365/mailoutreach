"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
import { removeOwnSuppressionAction } from "@/app/(app)/settings/deliverability/actions";
import { SETTINGS_DIALOG_CLASS } from "../dialog-classes";

const OFFLINE = "Couldn't reach the app. Check your connection and try again.";

/**
 * "Remove" on the do-not-email list (§5.5): shown only for test-list addresses and active users' reply inboxes, with
 * a confirmation that says why it may come off.
 */
export function RemoveSuppressionButton({
  email,
  kind,
  userName,
}: {
  email: string;
  kind: "test-list" | "reply-inbox";
  userName?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const why =
    kind === "test-list"
      ? "It's on your test list, so test emails can reach it again."
      : `It's ${userName ?? "a teammate"}'s reply inbox, so Mailgun can forward replies to it again.`;

  function remove() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await removeOwnSuppressionAction({ email });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        toast.success(res.data.note ? `${res.message ?? "Removed."} ${res.data.note}` : (res.message ?? "Removed."));
        setOpen(false);
        router.refresh();
      } catch {
        setError(OFFLINE);
      }
    });
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} disabled={pending}>
        Remove
      </Button>
      <AlertDialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <AlertDialogContent className={SETTINGS_DIALOG_CLASS}>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {email} from the do-not-email list?</AlertDialogTitle>
            <AlertDialogDescription>{why}</AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep it on the list</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                remove();
              }}
            >
              {pending ? "Removing…" : "Remove from the list"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
