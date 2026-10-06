"use client";

import { useRef, useState } from "react";
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
import { useNavigationGuard, type LeaveRequest } from "@/components/navigation/nav-guard";
import { isNotDraftError, type SaveResult } from "./save-queue";

export const NOT_SAVED = "Your latest changes couldn't be saved yet, so you're still here. Check your connection and try again.";

type Problem = { error: string; request: LeaveRequest };

/**
 * For pages that save by themselves (the Message step). While changes are waiting to be saved,
 * leaving (an in-app link, the stepper, Back, the search menu, the bell) first saves them and then
 * goes on.
 * - The app can't be reached: the person stays (with a note), and saving is tried again.
 * - The save is refused for good (the campaign was launched or deleted meanwhile, the session
 *   ended, the text is too long): the real reason is shown, with "Leave anyway" (and the campaign
 *   page when it was launched).
 * While saving fails, the browser's Back button asks too; closing or reloading the tab asks the
 * browser's own "Leave site?" question. Render the returned `dialog` on the page.
 */
export function useSaveBeforeLeaving({
  campaignId,
  dirty,
  failed,
  flush,
}: {
  campaignId: number;
  /** Changes are waiting to be saved (or couldn't be). */
  dirty: boolean;
  /** The last save failed. */
  failed: boolean;
  flush: () => Promise<SaveResult>;
}): { dialog: React.ReactNode } {
  const [problem, setProblem] = useState<Problem | null>(null);
  const problemRef = useRef<Problem | null>(null);
  const saving = useRef(false);

  function show(next: Problem | null) {
    problemRef.current = next;
    setProblem(next);
  }

  const { leaveTo } = useNavigationGuard({
    active: dirty,
    protectBack: failed,
    onLeave: (request) => {
      if (saving.current) {
        request.cancel(); // already saving for an earlier click
        return;
      }
      saving.current = true;
      void flush()
        .catch((): SaveResult => ({ ok: false, retryable: true, error: NOT_SAVED }))
        .then((res) => {
          saving.current = false;
          if (res.ok) {
            request.proceed();
          } else if (res.retryable) {
            request.cancel();
            toast.error(NOT_SAVED);
          } else {
            problemRef.current?.request.cancel();
            show({ error: res.error, request });
          }
        });
    },
  });

  function stay() {
    const current = problemRef.current;
    show(null);
    current?.request.cancel();
  }

  function leaveAnyway() {
    const current = problemRef.current;
    show(null);
    current?.request.proceed();
  }

  function openCampaign() {
    show(null);
    leaveTo(`/campaigns/${campaignId}`);
  }

  const notDraft = problem ? isNotDraftError(problem.error) : false;

  const dialog = (
    <AlertDialog
      open={problem !== null}
      onOpenChange={(open) => {
        if (!open) stay();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Your latest changes can&apos;t be saved</AlertDialogTitle>
          <AlertDialogDescription>
            {problem?.error} If you leave now, what you changed since the last save is lost.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Stay here</AlertDialogCancel>
          {notDraft ? (
            <Button type="button" variant="outline" onClick={openCampaign}>
              Open the campaign page
            </Button>
          ) : null}
          <AlertDialogAction variant="destructive" onClick={leaveAnyway}>
            Leave anyway
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { dialog };
}
