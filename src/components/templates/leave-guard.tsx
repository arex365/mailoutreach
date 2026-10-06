"use client";

import { useRef, useState } from "react";
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
import { useNavigationGuard, type LeaveRequest } from "@/components/navigation/nav-guard";

/**
 * Asks "Leave without saving?" while `dirty` is true: before an in-app link, the search menu
 * (Ctrl+K), the notification bell or the browser's Back button takes the person away, and —
 * through the browser's own question — before the tab is closed or reloaded.
 * Render the returned `dialog` somewhere on the page.
 */
export function useLeaveGuard(dirty: boolean, what = "this template") {
  const [request, setRequest] = useState<LeaveRequest | null>(null);
  const requestRef = useRef<LeaveRequest | null>(null);

  function settle(next: LeaveRequest | null) {
    requestRef.current = next;
    setRequest(next);
  }

  useNavigationGuard({
    active: dirty,
    protectBack: true,
    onLeave: (next) => {
      // A newer attempt (e.g. Back, then a click in the search menu) replaces the one being asked about.
      requestRef.current?.cancel();
      settle(next);
    },
  });

  function stay() {
    const current = requestRef.current;
    settle(null);
    current?.cancel();
  }

  function leave() {
    const current = requestRef.current;
    settle(null);
    current?.proceed();
  }

  const dialog = (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) stay();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
          <AlertDialogDescription>
            You changed {what} but didn&apos;t save. If you leave now, your changes are lost.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={leave}>
            Leave without saving
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { dialog };
}
