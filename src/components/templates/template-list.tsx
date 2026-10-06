"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, FileText, MoreHorizontal, Pencil, Plus, Star, Trash2 } from "lucide-react";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState, PageHeader } from "@/components/page-header";
import { PromptDialog, type PromptResult } from "@/components/contacts/prompt-dialog";
import { TEMPLATE_NAME_MAX } from "@/core/templates/steps";
import { cn } from "@/lib/utils";
import {
  createTemplateAction,
  deleteTemplateAction,
  duplicateTemplateAction,
  renameTemplateAction,
  starTemplateAction,
} from "@/app/(app)/templates/actions";
import type { TemplateListItem } from "./format";

const OFFLINE = "Couldn't reach the app. Check your connection and try again.";

/**
 * The Templates screen: every sequence, the master starred. New template (the one primary action),
 * then per template: star as master, Edit, Duplicate, Rename, Delete (with a confirmation; the last
 * template can't be deleted).
 */
export function TemplateList({ templates }: { templates: TemplateListItem[] }) {
  const router = useRouter();
  const [newOpen, setNewOpen] = useState(false);
  const [renaming, setRenaming] = useState<TemplateListItem | null>(null);
  const [deleting, setDeleting] = useState<TemplateListItem | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();
  const onlyOne = templates.length <= 1;

  async function create(name: string): Promise<PromptResult> {
    try {
      const res = await createTemplateAction({ name });
      if (!res.ok) return { ok: false, error: res.error, fieldError: res.fieldErrors?.name?.[0] };
      toast.success(res.message ?? "Template created.");
      router.push(`/templates/${res.data.id}`);
      return { ok: true };
    } catch {
      return { ok: false, error: OFFLINE };
    }
  }

  async function rename(name: string): Promise<PromptResult> {
    if (!renaming) return { ok: true };
    try {
      const res = await renameTemplateAction({ id: renaming.id, name });
      if (!res.ok) return { ok: false, error: res.error, fieldError: res.fieldErrors?.name?.[0] };
      toast.success(res.message ?? "Template renamed.");
      router.refresh();
      return { ok: true };
    } catch {
      return { ok: false, error: OFFLINE };
    }
  }

  function runRowAction(id: number, call: () => Promise<{ ok: true; message?: string } | { ok: false; error: string }>, after?: () => void) {
    setBusyId(id);
    startTransition(async () => {
      try {
        const res = await call();
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        if (res.message) toast.success(res.message);
        after?.();
        router.refresh();
      } catch {
        toast.error(OFFLINE);
      } finally {
        setBusyId(null);
      }
    });
  }

  function star(t: TemplateListItem) {
    if (t.isMaster) {
      toast.info(`"${t.name}" is already the master template. New campaigns start from it.`);
      return;
    }
    runRowAction(t.id, () => starTemplateAction({ id: t.id }));
  }

  function duplicate(t: TemplateListItem) {
    runRowAction(t.id, () => duplicateTemplateAction({ id: t.id }));
  }

  function confirmDelete() {
    const t = deleting;
    if (!t) return;
    runRowAction(t.id, () => deleteTemplateAction({ id: t.id }), () => setDeleting(null));
  }

  return (
    <div>
      <PageHeader
        title="Templates"
        description="Each template is a sequence: the first email and its follow-ups. The starred template is the master: new campaigns start from it."
        actions={
          <Button onClick={() => setNewOpen(true)}>
            <Plus className="size-4" aria-hidden />
            New template
          </Button>
        }
      />
      <div className="px-4 pb-10 md:px-6">
        {templates.length === 0 ? (
          <EmptyState
            icon={<FileText className="size-6" aria-hidden />}
            title="No templates yet."
            description="A template is a first email plus its follow-ups. Create one to get started."
            actions={
              <Button variant="outline" onClick={() => setNewOpen(true)}>
                New template
              </Button>
            }
          />
        ) : (
          // grid-cols-1 (minmax(0, 1fr)) and min-w-0, not the implicit auto column: a long subject or name would otherwise
          // widen the whole page on a phone instead of ending in "…" (the raw "{A|B}" variations make the master's long).
          <ul className="grid grid-cols-1 gap-3" aria-label="Templates">
            {templates.map((t) => (
              <li
                key={t.id}
                className={cn(
                  "flex min-w-0 flex-wrap items-start gap-3 rounded-lg border border-border bg-card p-4 sm:flex-nowrap",
                  busyId === t.id && pending && "opacity-70",
                )}
              >
                <StarButton template={t} disabled={pending} onClick={() => star(t)} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Link
                      href={`/templates/${t.id}`}
                      className="max-w-full truncate text-base font-medium underline-offset-4 hover:underline"
                    >
                      {t.name}
                    </Link>
                    {t.isMaster ? (
                      <span className="inline-flex h-5 items-center rounded-full border border-border px-1.5 text-[11px] font-medium text-muted-foreground">
                        Master
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{t.summary}</p>
                  <p className="mt-1 truncate text-sm" title={t.subject ?? undefined}>
                    {t.subject ? (
                      <>
                        <span className="text-muted-foreground">Subject: </span>
                        {t.subject}
                      </>
                    ) : (
                      <span className="text-warning">No subject yet. Open the template to write one.</span>
                    )}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground" title={t.changedTitle}>
                    {t.changed}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/templates/${t.id}`}>
                      <Pencil className="size-3.5" aria-hidden />
                      Edit
                    </Link>
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`More options for ${t.name}`} disabled={pending && busyId === t.id}>
                        <MoreHorizontal className="size-4" aria-hidden />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-60">
                      <DropdownMenuLabel className="truncate">{t.name}</DropdownMenuLabel>
                      {!t.isMaster ? (
                        <DropdownMenuItem onSelect={() => star(t)}>
                          <Star className="size-4" aria-hidden /> Make master template
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem onSelect={() => duplicate(t)}>
                        <Copy className="size-4" aria-hidden /> Duplicate
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setRenaming(t)}>
                        <Pencil className="size-4" aria-hidden /> Rename
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      {onlyOne ? (
                        <DropdownMenuItem disabled className="flex-col items-start gap-0">
                          <span className="flex items-center gap-1.5">
                            <Trash2 className="size-4" aria-hidden /> Delete
                          </span>
                          <span className="pl-5.5 text-xs text-muted-foreground">Keep at least one template.</span>
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(t)}>
                          <Trash2 className="size-4" aria-hidden /> Delete
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <PromptDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        title="New template"
        description="It starts with a first email. You can add up to three follow-ups."
        label="Template name"
        placeholder="For example Norway printers"
        submitLabel="Create template"
        pendingLabel="Creating…"
        maxLength={TEMPLATE_NAME_MAX}
        onSubmit={create}
      />
      <PromptDialog
        open={renaming !== null}
        onOpenChange={(o) => {
          if (!o) setRenaming(null);
        }}
        title="Rename template"
        label="Template name"
        initialValue={renaming?.name}
        submitLabel="Save name"
        pendingLabel="Saving…"
        maxLength={TEMPLATE_NAME_MAX}
        onSubmit={rename}
      />
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o && !pending) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the template &ldquo;{deleting?.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.isMaster
                ? "It's the master template, so another template becomes the master. Campaigns that already use its text keep their own copy."
                : "Campaigns that already use its text keep their own copy. This can't be undone."}
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
              {pending ? "Deleting…" : "Delete template"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The master's star is filled (orange = "selected"); the others make their template the master. */
function StarButton({ template, disabled, onClick }: { template: TemplateListItem; disabled: boolean; onClick: () => void }) {
  const label = template.isMaster
    ? `${template.name} is the master template: new campaigns start from it`
    : `Make ${template.name} the master template`;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="mt-0.5 shrink-0"
      aria-pressed={template.isMaster}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Star className={cn("size-4", template.isMaster ? "fill-brand text-brand" : "text-muted-foreground")} aria-hidden />
    </Button>
  );
}
