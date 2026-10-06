"use client";

import { useState } from "react";
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
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { unsavedChanges } from "@/components/company-panel/unsaved-changes";
import { useContacts } from "./contacts-provider";

/**
 * The company panel slides over the table from the right (full screen on phones).
 * It is open whenever the URL has ?company=<id>, so its address can be shared.
 * Closing it (Esc, the close button, or clicking outside) removes the parameter; while notes or
 * another field hold text that isn't saved, it asks first instead of throwing the text away.
 * `children` is the server-rendered <CompanyPanel> for the company in the URL.
 */
export function CompanySheet({ children }: { children: React.ReactNode }) {
  const { openCompanyId, renderedCompanyId, closeCompany } = useContacts();
  const [confirmClose, setConfirmClose] = useState(false);
  const open = openCompanyId !== null;
  const ready = open && openCompanyId === renderedCompanyId;

  function requestClose() {
    if (unsavedChanges.any()) {
      setConfirmClose(true);
      return;
    }
    closeCompany();
  }

  function discardAndClose() {
    unsavedChanges.clear();
    setConfirmClose(false);
    closeCompany();
  }

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!next) requestClose();
        }}
      >
        <SheetContent
          side="right"
          className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:max-w-none data-[side=right]:sm:max-w-xl data-[side=right]:lg:max-w-2xl"
          onEscapeKeyDown={(e) => {
            // Esc inside an inline editor cancels that edit (the panel handles it); it must not close the sheet.
            const t = e.target as HTMLElement | null;
            if (t?.closest("input, textarea, select, [contenteditable='true']")) e.preventDefault();
          }}
        >
          <SheetTitle className="sr-only">{openCompanyId ? `Company C-${openCompanyId}` : "Company"}</SheetTitle>
          <SheetDescription className="sr-only">Details, people, notes and timeline for this company.</SheetDescription>
          <div className="min-h-0 flex-1 overflow-y-auto">{ready ? children : <CompanyPanelSkeleton />}</div>
        </SheetContent>
      </Sheet>
      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              You typed something in this company&apos;s panel that isn&apos;t saved yet, for example notes. If you close
              the panel now, that text is lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={discardAndClose}>
              Discard and close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Placeholder while the panel loads. */
export function CompanyPanelSkeleton() {
  return (
    <div className="grid gap-5 p-5" aria-busy="true" aria-label="Loading company">
      <div className="grid gap-2 pr-10">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-8 w-24" />
      </div>
      <Skeleton className="h-14 w-full" />
      <div className="grid gap-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
      <div className="grid gap-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-4/6" />
      </div>
    </div>
  );
}
