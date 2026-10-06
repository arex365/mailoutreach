"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Building2, ChevronDown, Download, Mail, MailX, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
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
import { plural } from "@/core/text";
import { cn } from "@/lib/utils";
import { createListAction, deleteListAction, renameListAction } from "@/app/(app)/contacts/actions";
import { DraftListMenuItem } from "@/components/ai/draft-lines-dialog";
import { useStartCampaign } from "@/components/campaign-wizard/new-campaign";
import { CheckListMenuItem } from "@/components/checks/check-emails-dialog";
import { PromptDialog, type PromptResult } from "./prompt-dialog";
import { sidebarHiddenStore, useStore } from "./storage";
import type { ListSummary } from "./types";
import { viewHref } from "./url";

type ActiveView = { view: "all" | "missing-email"; listId?: number };

type SidebarProps = {
  allCount: number;
  missingEmailCount: number;
  lists: ListSummary[];
  active: ActiveView;
};

function isActive(active: ActiveView, target: ActiveView): boolean {
  if (target.listId) return active.listId === target.listId;
  return !active.listId && active.view === target.view;
}

function exportListHref(listId: number, format: "csv" | "xlsx") {
  return `/api/export/companies?list=${listId}&format=${format}`;
}

/** The hideable list sidebar: All companies, Missing email, then every list with its size. */
export function ListSidebar({ allCount, missingEmailCount, lists, active }: SidebarProps) {
  const hidden = useStore(sidebarHiddenStore);
  const search = useSearchParams().toString();
  const { dialogs, openNew, openRename, openDelete } = useListDialogs(active);

  if (hidden) return dialogs;

  return (
    <>
      <aside
        aria-label="Lists"
        className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-60 shrink-0 flex-col border-r border-border md:flex"
      >
        <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-4">
          <SidebarLink
            href={viewHref(search, { view: "all" })}
            label="All companies"
            count={allCount}
            icon={<Building2 className="size-4" aria-hidden />}
            active={isActive(active, { view: "all" })}
          />
          <SidebarLink
            href={viewHref(search, { view: "missing-email" })}
            label="Missing email"
            count={missingEmailCount}
            icon={<MailX className="size-4" aria-hidden />}
            active={isActive(active, { view: "missing-email" })}
          />
          <div className="mt-4 flex items-center justify-between px-3 pb-1">
            <h2 className="text-xs font-medium text-muted-foreground">Lists</h2>
          </div>
          {lists.length === 0 ? (
            <p className="px-3 py-1 text-xs text-muted-foreground">
              No lists yet. Lists group companies, like the tabs in your old tool.
            </p>
          ) : null}
          {lists.map((list) => (
            <div key={list.id} className="group/list relative">
              <SidebarLink
                href={viewHref(search, { view: "all", listId: list.id })}
                label={list.name}
                count={list.count}
                active={isActive(active, { view: "all", listId: list.id })}
                className="pr-9"
              />
              <ListMenu
                list={list}
                onRename={() => openRename(list)}
                onDelete={() => openDelete(list)}
                className="absolute top-1/2 right-1 -translate-y-1/2"
              />
            </div>
          ))}
          <Button variant="ghost" size="sm" className="mt-1 justify-start gap-2 px-3 text-muted-foreground" onClick={openNew}>
            <Plus className="size-4" aria-hidden />
            New list
          </Button>
        </nav>
      </aside>
      {dialogs}
    </>
  );
}

function SidebarLink({
  href,
  label,
  count,
  icon,
  active,
  className,
}: {
  href: string;
  label: string;
  count: number;
  icon?: React.ReactNode;
  active: boolean;
  className?: string;
}) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex h-8 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        active && "bg-accent font-medium text-foreground",
        className,
      )}
    >
      {/* Orange means "selected". */}
      {active ? <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-brand" /> : null}
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="tabular text-xs text-muted-foreground">{count.toLocaleString("en-US")}</span>
    </Link>
  );
}

function ListMenu({
  list,
  onRename,
  onDelete,
  className,
}: {
  list: ListSummary;
  onRename: () => void;
  onDelete: () => void;
  className?: string;
}) {
  const { start: startCampaign } = useStartCampaign();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Options for the list ${list.name}`}
          className={cn(
            "opacity-100 md:opacity-0 md:group-hover/list:opacity-100 md:focus-visible:opacity-100 md:aria-expanded:opacity-100",
            className,
          )}
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right" className="w-60">
        <DropdownMenuLabel className="truncate">{list.name}</DropdownMenuLabel>
        {/* Starts a draft with a click (a Server Action), never through a link. */}
        <DropdownMenuItem onSelect={() => startCampaign({ listId: list.id, loading: `Starting a campaign for ${list.name}…` })}>
          <Mail className="size-4" aria-hidden /> Email this list
        </DropdownMenuItem>
        {/*
          M5-DESIGN §6.4: each item owns its dialog, so choosing it keeps this menu open (and the dialog mounted) under
          the dialog; closing the dialog comes back to the menu.
        */}
        <DraftListMenuItem listId={list.id} listName={list.name} />
        <CheckListMenuItem listId={list.id} listName={list.name} />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Download className="size-4" aria-hidden /> Export
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem asChild>
              <a href={exportListHref(list.id, "csv")}>CSV file</a>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={exportListHref(list.id, "xlsx")}>Excel file (.xlsx)</a>
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onSelect={onRename}>
          <Pencil className="size-4" aria-hidden /> Rename
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 className="size-4" aria-hidden /> Delete list
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** New list / rename / delete dialogs, shared by the sidebar and the phone list picker. */
function useListDialogs(active: ActiveView) {
  const router = useRouter();
  const search = useSearchParams().toString();
  const [newOpen, setNewOpen] = useState(false);
  const [renaming, setRenaming] = useState<ListSummary | null>(null);
  const [deleting, setDeleting] = useState<ListSummary | null>(null);
  const [deletePending, startDelete] = useTransition();

  async function createList(name: string): Promise<PromptResult> {
    const res = await createListAction({ name });
    if (!res.ok) return { ok: false, error: res.error, fieldError: res.fieldErrors?.name?.[0] };
    toast.success(res.message ?? "List created.");
    router.push(viewHref(search, { view: "all", listId: res.data.id }), { scroll: false });
    return { ok: true };
  }

  async function renameList(name: string): Promise<PromptResult> {
    if (!renaming) return { ok: true };
    const res = await renameListAction({ id: renaming.id, name });
    if (!res.ok) return { ok: false, error: res.error, fieldError: res.fieldErrors?.name?.[0] };
    toast.success(res.message ?? "List renamed.");
    router.refresh();
    return { ok: true };
  }

  function confirmDelete() {
    const list = deleting;
    if (!list) return;
    startDelete(async () => {
      const res = await deleteListAction({ id: list.id });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message ?? "List deleted.");
      setDeleting(null);
      if (active.listId === list.id) router.push(viewHref(search, { view: "all" }), { scroll: false });
      else router.refresh();
    });
  }

  const dialogs = (
    <>
      <PromptDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        title="New list"
        description="Lists group companies, like the tabs in your old tool. A company can be in several lists."
        label="List name"
        placeholder="For example Germany Q4"
        submitLabel="Create list"
        pendingLabel="Creating…"
        maxLength={80}
        onSubmit={createList}
      />
      <PromptDialog
        open={renaming !== null}
        onOpenChange={(o) => {
          if (!o) setRenaming(null);
        }}
        title="Rename list"
        label="List name"
        initialValue={renaming?.name}
        submitLabel="Save name"
        pendingLabel="Saving…"
        maxLength={80}
        onSubmit={renameList}
      />
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o && !deletePending) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the list &ldquo;{deleting?.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting && deleting.count > 0
                ? `The ${plural(deleting.count, "company", "companies")} in it stay in your contacts. Only the list goes.`
                : "The list is empty, so nothing else changes."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deletePending}
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
            >
              {deletePending ? "Deleting…" : "Delete list"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );

  return {
    dialogs,
    openNew: () => setNewOpen(true),
    openRename: (l: ListSummary) => setRenaming(l),
    openDelete: (l: ListSummary) => setDeleting(l),
  };
}

/** On phones (and when the sidebar is hidden) the lists sit in a menu above the table. */
export function ListPicker({
  allCount,
  missingEmailCount,
  lists,
  active,
  className,
}: SidebarProps & { className?: string }) {
  const search = useSearchParams().toString();
  const { dialogs, openNew } = useListDialogs(active);
  const current = active.listId
    ? (lists.find((l) => l.id === active.listId)?.name ?? "List")
    : active.view === "missing-email"
      ? "Missing email"
      : "All companies";
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className={cn("max-w-56 gap-1.5", className)}>
            <span className="truncate">{current}</span>
            <ChevronDown className="size-3.5" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuItem asChild>
            <Link href={viewHref(search, { view: "all" })} scroll={false}>
              <Building2 className="size-4" aria-hidden />
              <span className="flex-1">All companies</span>
              <span className="tabular text-xs text-muted-foreground">{allCount.toLocaleString("en-US")}</span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={viewHref(search, { view: "missing-email" })} scroll={false}>
              <MailX className="size-4" aria-hidden />
              <span className="flex-1">Missing email</span>
              <span className="tabular text-xs text-muted-foreground">{missingEmailCount.toLocaleString("en-US")}</span>
            </Link>
          </DropdownMenuItem>
          {lists.length ? <DropdownMenuSeparator /> : null}
          {lists.map((l) => (
            <DropdownMenuItem key={l.id} asChild>
              <Link href={viewHref(search, { view: "all", listId: l.id })} scroll={false}>
                <span className="min-w-0 flex-1 truncate">{l.name}</span>
                <span className="tabular text-xs text-muted-foreground">{l.count.toLocaleString("en-US")}</span>
              </Link>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={openNew}>
            <Plus className="size-4" aria-hidden /> New list
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialogs}
    </>
  );
}
