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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { saveAccessChoiceAction } from "@/app/(app)/settings/system/actions";
import { SETTINGS_DIALOG_CLASS } from "./dialog-classes";

/** The switch's words (M6-DESIGN §2.8, G7). */
export const ACCESS_OFF_TEXT = {
  label: "We don't use Cloudflare Access",
  hint: "Recommended: keep Access on. Without it, anyone who finds the address sees the app's sign-in page; the app's own sign-in still protects your data.",
  confirmTitle: "Turn off the Access check?",
  confirmButton: "Turn it off",
  cancel: "Cancel",
  saving: "Saving…",
  offline: "Couldn't reach the app, so nothing changed. Check your connection and try again.",
} as const;

/**
 * Settings › System › Remote access: "We don't use Cloudflare Access" (Owner). Turning it on asks first (the sign-in
 * page becomes public); turning it off saves at once. The switch stays neutral: it is a choice, not the page's
 * primary action.
 */
export function AccessOffSwitch({ accessOff }: { accessOff: boolean }) {
  const router = useRouter();
  const [checked, setChecked] = useState(accessOff);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function save(value: boolean) {
    startTransition(async () => {
      try {
        const res = await saveAccessChoiceAction({ accessOff: value });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        setChecked(value);
        setConfirmOpen(false);
        toast.success(res.message ?? "Saved.");
        router.refresh();
      } catch {
        toast.error(ACCESS_OFF_TEXT.offline);
      }
    });
  }

  function onCheckedChange(value: boolean) {
    if (value) setConfirmOpen(true);
    else save(false);
  }

  return (
    <div className="grid gap-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="access-off">{ACCESS_OFF_TEXT.label}</Label>
        <Switch
          id="access-off"
          checked={checked}
          disabled={pending}
          onCheckedChange={onCheckedChange}
          aria-describedby="access-off-hint"
          // Switches stay neutral (orange only means "primary" or "selected").
          className="data-checked:bg-foreground"
        />
      </div>
      <p id="access-off-hint" className="text-sm text-muted-foreground">
        {ACCESS_OFF_TEXT.hint}
      </p>

      <AlertDialog open={confirmOpen} onOpenChange={(open) => !pending && setConfirmOpen(open)}>
        <AlertDialogContent className={SETTINGS_DIALOG_CLASS}>
          <AlertDialogHeader>
            <AlertDialogTitle>{ACCESS_OFF_TEXT.confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>{ACCESS_OFF_TEXT.hint}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>{ACCESS_OFF_TEXT.cancel}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={(e) => {
                e.preventDefault(); // keep the dialog open until the choice is saved
                save(true);
              }}
            >
              {pending ? ACCESS_OFF_TEXT.saving : ACCESS_OFF_TEXT.confirmButton}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
