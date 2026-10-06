"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PromptDialog, type PromptResult } from "@/components/contacts/prompt-dialog";
import { deleteDraftAction, renameDraftAction } from "@/app/(app)/campaigns/[id]/setup/actions";

const OFFLINE = "Couldn't reach the app. Check your connection and try again.";

/** The draft's name with Rename and Delete draft (with a confirmation). */
export function DraftTitle({ campaignId, name }: { campaignId: number; name: string }) {
  const router = useRouter();
  const [shown, setShown] = useState(name);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, startDeleting] = useTransition();

  async function rename(value: string): Promise<PromptResult> {
    try {
      const res = await renameDraftAction({ campaignId, name: value });
      if (!res.ok) return { ok: false, error: res.error, fieldError: res.error };
      setShown(res.data.name);
      if (res.message) toast.success(res.message);
      return { ok: true };
    } catch {
      return { ok: false, error: OFFLINE };
    }
  }

  function remove() {
    startDeleting(async () => {
      try {
        const res = await deleteDraftAction({ campaignId });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(res.message ?? "Draft deleted.");
        setDeleteOpen(false);
        router.push("/campaigns");
      } catch {
        toast.error(OFFLINE);
      }
    });
  }

  return (
    <div className="mt-1 flex min-w-0 items-center gap-1">
      <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">{shown}</h1>
      <Button variant="ghost" size="icon-sm" aria-label="Rename this campaign" onClick={() => setRenameOpen(true)}>
        <Pencil aria-hidden />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="More for this draft">
            <MoreHorizontal aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
            <Pencil aria-hidden /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
            <Trash2 aria-hidden /> Delete draft
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <PromptDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title="Rename this campaign"
        description="Only your team sees the name. Recipients never do."
        label="Campaign name"
        initialValue={shown}
        submitLabel="Rename"
        pendingLabel="Renaming…"
        maxLength={120}
        onSubmit={rename}
      />
      <AlertDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!deleting) setDeleteOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this draft?</AlertDialogTitle>
            <AlertDialogDescription>
              {shown} and everything chosen in it (the people, the emails and any edits) are deleted. Nothing was sent, and your
              contacts and templates stay as they are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                remove();
              }}
            >
              {deleting ? "Deleting…" : "Delete draft"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
