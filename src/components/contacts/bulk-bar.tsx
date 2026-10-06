"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, Download, ListPlus, Tag, Trash2 } from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { COMPANY_STATUSES, COMPANY_STATUS_LABELS, PRIORITIES, PRIORITY_LABELS, type CompanyStatusValue, type PriorityValue } from "@/core/labels";
import { plural } from "@/core/text";
import type { ActionResult } from "@/lib/action";
import {
  bulkAddTagAction,
  bulkAddToListAction,
  bulkDeleteAction,
  bulkRemoveFromListAction,
  bulkRemoveTagAction,
  bulkSetPriorityAction,
  bulkSetStatusAction,
} from "@/app/(app)/contacts/actions";
import { DraftLinesButton } from "@/components/ai/draft-lines-dialog";
import { EmailTheseCompaniesButton } from "@/components/campaign-wizard/email-these-companies";
import { CheckEmailsButton } from "@/components/checks/check-emails-dialog";
import { PromptDialog, type PromptResult } from "./prompt-dialog";
import { selection } from "./storage";
import type { ListSummary, NamedId } from "./types";
import { SELECTION_EXPORT_MAX, exportSelectionHref } from "./url";

type BulkBarProps = {
  selectedIds: number[];
  lists: ListSummary[];
  tags: NamedId[];
  /** The list being viewed, if any (offered first under "Remove from list"). */
  currentListId?: number;
};

/**
 * The sticky bar for ticked companies ("37 selected · Clear"). Every action works on
 * exactly the ticked ids, even across pages, and reports back in plain words.
 */
export function BulkBar({ selectedIds, lists, tags, currentListId }: BulkBarProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [newListOpen, setNewListOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const count = selectedIds.length;
  const countText = plural(count, "company", "companies");

  function runBulk<T>(call: () => Promise<ActionResult<T>>, opts: { clear?: boolean; after?: (data: T) => void } = {}) {
    startTransition(async () => {
      const res = await call();
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message ?? "Done.");
      if (opts.clear) selection.clear();
      opts.after?.(res.data);
      router.refresh();
    });
  }

  function setStatus(status: CompanyStatusValue) {
    runBulk(() => bulkSetStatusAction({ ids: selectedIds, status }));
  }
  function setPriority(priority: PriorityValue) {
    runBulk(() => bulkSetPriorityAction({ ids: selectedIds, priority }));
  }
  function addToList(listId: number) {
    runBulk(() => bulkAddToListAction({ ids: selectedIds, listId }));
  }
  function removeFromList(listId: number) {
    // Removed companies vanish from the list being viewed, so their ticks go too.
    runBulk(() => bulkRemoveFromListAction({ ids: selectedIds, listId }), { clear: listId === currentListId });
  }
  function removeTag(tagId: number) {
    runBulk(() => bulkRemoveTagAction({ ids: selectedIds, tagId }));
  }

  async function addToNewList(name: string): Promise<PromptResult> {
    const res = await bulkAddToListAction({ ids: selectedIds, newListName: name });
    if (!res.ok) return { ok: false, error: res.error, fieldError: res.fieldErrors?.newListName?.[0] };
    toast.success(res.message ?? "Done.");
    router.refresh();
    return { ok: true };
  }

  async function addTag(name: string): Promise<PromptResult> {
    const res = await bulkAddTagAction({ ids: selectedIds, tagName: name });
    if (!res.ok) return { ok: false, error: res.error, fieldError: res.fieldErrors?.tagName?.[0] };
    toast.success(res.message ?? "Done.");
    router.refresh();
    return { ok: true };
  }

  function confirmDelete() {
    startTransition(async () => {
      const res = await bulkDeleteAction({ ids: selectedIds });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message ?? "Deleted.");
      setDeleteOpen(false);
      selection.clear();
      router.refresh();
    });
  }

  const orderedLists = currentListId
    ? [...lists.filter((l) => l.id === currentListId), ...lists.filter((l) => l.id !== currentListId)]
    : lists;
  const canExport = count <= SELECTION_EXPORT_MAX;

  return (
    <>
      <div
        role="region"
        aria-label="Actions for ticked companies"
        className="pointer-events-none fixed inset-x-0 bottom-16 z-40 flex justify-center px-2 md:bottom-4 md:pl-16 2xl:pl-58"
      >
        <div
          className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-border bg-popover p-1.5 shadow-lg"
          aria-busy={pending || undefined}
        >
          <span className="tabular px-2 text-sm font-medium whitespace-nowrap" aria-live="polite">
            {count.toLocaleString("en-US")} selected
          </span>
          <span aria-hidden className="text-muted-foreground">
            ·
          </span>
          <Button variant="ghost" size="sm" onClick={() => selection.clear()} disabled={pending}>
            Clear
          </Button>
          <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={pending}>
                Set status <ChevronDown className="size-3.5" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-52">
              <DropdownMenuLabel>Set status for {countText}</DropdownMenuLabel>
              {COMPANY_STATUSES.map((s) => (
                <DropdownMenuItem key={s} onSelect={() => setStatus(s)}>
                  {COMPANY_STATUS_LABELS[s]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={pending}>
                Priority <ChevronDown className="size-3.5" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-52">
              <DropdownMenuLabel>Set priority for {countText}</DropdownMenuLabel>
              {PRIORITIES.map((p) => (
                <DropdownMenuItem key={p} onSelect={() => setPriority(p)}>
                  {PRIORITY_LABELS[p]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={pending}>
                <ListPlus className="size-3.5" aria-hidden /> Lists <ChevronDown className="size-3.5" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="max-h-80 w-60">
              <DropdownMenuLabel>Add to list</DropdownMenuLabel>
              {lists.map((l) => (
                <DropdownMenuItem key={l.id} onSelect={() => addToList(l.id)}>
                  <span className="min-w-0 flex-1 truncate">{l.name}</span>
                  <span className="tabular text-xs text-muted-foreground">{l.count.toLocaleString("en-US")}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem onSelect={() => setNewListOpen(true)}>New list…</DropdownMenuItem>
              {lists.length ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Remove from list</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
                      {orderedLists.map((l) => (
                        <DropdownMenuItem key={l.id} onSelect={() => removeFromList(l.id)}>
                          <span className="truncate">{l.name}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={pending}>
                <Tag className="size-3.5" aria-hidden /> Tag <ChevronDown className="size-3.5" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-56">
              <DropdownMenuItem onSelect={() => setTagOpen(true)}>Add a tag…</DropdownMenuItem>
              {tags.length ? (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Remove a tag</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
                    {tags.map((t) => (
                      <DropdownMenuItem key={t.id} onSelect={() => removeTag(t.id)}>
                        <span className="truncate">{t.name}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={pending}>
                <Download className="size-3.5" aria-hidden /> Export <ChevronDown className="size-3.5" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-64">
              <DropdownMenuLabel>Export the {countText} you ticked</DropdownMenuLabel>
              {canExport ? (
                <>
                  <DropdownMenuItem asChild>
                    <a href={exportSelectionHref(selectedIds, "csv")}>CSV file</a>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <a href={exportSelectionHref(selectedIds, "xlsx")}>Excel file (.xlsx)</a>
                  </DropdownMenuItem>
                </>
              ) : (
                <p className="px-1.5 py-1 text-xs text-muted-foreground">
                  Ticked exports work for up to {SELECTION_EXPORT_MAX.toLocaleString("en-US")} companies. Add them to a list and export the
                  list instead, or use Export above the table for everything in this view.
                </p>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
          <EmailTheseCompaniesButton selectedIds={selectedIds} disabled={pending} />
          {/* M5-DESIGN §6.4: both open their dialog with the ticked ids (counts and cost first, nothing starts without a click). */}
          <DraftLinesButton companyIds={selectedIds} disabled={pending} />
          <CheckEmailsButton companyIds={selectedIds} disabled={pending} />
          <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
          <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)} disabled={pending}>
            <Trash2 className="size-3.5" aria-hidden /> Delete
          </Button>
        </div>
      </div>

      <PromptDialog
        open={newListOpen}
        onOpenChange={setNewListOpen}
        title="Add to a new list"
        description={`Creates the list and adds the ${countText} you ticked.`}
        label="List name"
        placeholder="For example Germany Q4"
        submitLabel="Create and add"
        pendingLabel="Adding…"
        maxLength={80}
        onSubmit={addToNewList}
      />
      <PromptDialog
        open={tagOpen}
        onOpenChange={setTagOpen}
        title="Add a tag"
        description={`Tags the ${countText} you ticked. Pick an existing tag or type a new one.`}
        label="Tag"
        placeholder="For example trade fair"
        submitLabel="Add tag"
        pendingLabel="Adding…"
        maxLength={50}
        suggestions={tags.map((t) => t.name)}
        onSubmit={addTag}
      />
      <AlertDialog
        open={deleteOpen}
        onOpenChange={(o) => {
          if (!pending) setDeleteOpen(o);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {countText}?</AlertDialogTitle>
            <AlertDialogDescription>
              {count === 1
                ? "It'll disappear from every list and view. Its email history is kept, so the 30-day rule and unsubscribes still apply."
                : "They'll disappear from every list and view. Their email history is kept, so the 30-day rule and unsubscribes still apply."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
            >
              {pending ? "Deleting…" : `Delete ${countText}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
