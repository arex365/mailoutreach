"use client";

import { useEffect, useId, useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Ellipsis, ExternalLink, Link2, Mail, MailCheck, Pencil, RotateCcw, Trash2, TriangleAlert } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { SETTINGS_DIALOG_CLASS } from "@/components/settings/dialog-classes";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/badges";
import { copyText } from "@/components/copy-text";
import {
  COMPANY_STATUSES,
  PRIORITIES,
  PRIORITY_LABELS,
  type CompanyStatusValue,
  type PriorityValue,
} from "@/core/labels";
import { THEY_REPLIED_TEXTS } from "@/core/sending/own-mailbox";
import { formatTime } from "@/core/time/format";
import {
  deleteCompanyAction,
  emailNowAction,
  markRepliedAction,
  renameCompanyAction,
  restoreCompanyAction,
  setCompanyPriorityAction,
  setCompanyStatusAction,
} from "./actions";
import { ConfirmDialog, InlineError, usePanelAction } from "./panel-ui";

import { theyRepliedConfirm, type HeaderView, type PanelResult } from "./types";

const OFFLINE = "Couldn't reach the app. Check your connection and try again.";

async function safe<T>(p: Promise<PanelResult<T>>): Promise<PanelResult<T>> {
  try {
    return await p;
  } catch {
    return { ok: false, error: OFFLINE };
  }
}

/** The company's local time, ticking every 30 seconds. */
export function LocalTime({ zone, initial }: { zone: string; initial: string }) {
  const [time, setTime] = useState(initial);
  useEffect(() => {
    const t = setInterval(() => {
      try {
        setTime(formatTime(new Date(), zone));
      } catch {
        /* invalid zone: keep the server's text */
      }
    }, 30_000);
    return () => clearInterval(t);
  }, [zone]);
  return <time className="tabular-nums">{time}</time>;
}

function CompanyName({ companyId, name, readOnly }: { companyId: number; name: string; readOnly: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const { pending, error, setError, run } = usePanelAction();

  if (!editing) {
    return (
      <h2 id="company-panel-title" className="min-w-0 text-xl font-semibold tracking-tight break-words">
        {readOnly ? (
          name
        ) : (
          <button
            type="button"
            className="group inline-flex max-w-full items-start gap-2 rounded-md text-left hover:text-foreground/90"
            onClick={() => {
              setDraft(name);
              setError(null);
              setEditing(true);
            }}
            aria-label={`${name}. Click to rename`}
          >
            <span className="min-w-0 break-words">{name}</span>
            <Pencil
              className="mt-1.5 size-3.5 shrink-0 text-muted-foreground opacity-40 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
              aria-hidden
            />
          </button>
        )}
      </h2>
    );
  }

  return (
    <form
      className="grid gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.trim() === name) {
          setEditing(false);
          return;
        }
        run(() => renameCompanyAction({ companyId, name: draft }), { onSuccess: () => setEditing(false) });
      }}
    >
      <h2 id="company-panel-title" className="sr-only">
        {name}
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Company name"
          value={draft}
          autoFocus
          maxLength={200}
          className="h-9 min-w-48 flex-1 text-base font-semibold"
          aria-invalid={error ? true : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
        />
        <Button type="submit" size="sm" variant="secondary" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
      <InlineError error={error} />
    </form>
  );
}

function StatusPicker({ companyId, status, disabled }: { companyId: number; status: CompanyStatusValue; disabled: boolean }) {
  const [optimistic, setOptimistic] = useOptimistic(status);
  const [, startTransition] = useTransition();
  const [confirmDnc, setConfirmDnc] = useState(false);

  function apply(next: CompanyStatusValue) {
    startTransition(async () => {
      setOptimistic(next);
      const res = await safe(setCompanyStatusAction({ companyId, status: next }));
      if (res.ok) {
        if (res.message) toast.success(res.message);
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <>
      <Select
        value={optimistic}
        disabled={disabled}
        onValueChange={(v) => {
          const next = v as CompanyStatusValue;
          if (next === optimistic) return;
          if (next === "DO_NOT_CONTACT") setConfirmDnc(true);
          else apply(next);
        }}
      >
        <SelectTrigger aria-label="Status" className="h-8 pl-1">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          {COMPANY_STATUSES.map((s) => (
            <SelectItem key={s} value={s}>
              <StatusBadge status={s} />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ConfirmDialog
        open={confirmDnc}
        onOpenChange={setConfirmDnc}
        title="Mark as Do not contact?"
        description="Nobody will be able to email this company."
        confirmLabel="Mark Do not contact"
        destructive
        onConfirm={() => apply("DO_NOT_CONTACT")}
      />
    </>
  );
}

function PriorityPicker({ companyId, priority, disabled }: { companyId: number; priority: PriorityValue; disabled: boolean }) {
  const [optimistic, setOptimistic] = useOptimistic(priority);
  const [, startTransition] = useTransition();
  return (
    <Select
      value={optimistic}
      disabled={disabled}
      onValueChange={(v) => {
        const next = v as PriorityValue;
        if (next === optimistic) return;
        startTransition(async () => {
          setOptimistic(next);
          const res = await safe(setCompanyPriorityAction({ companyId, priority: next }));
          if (res.ok) {
            if (res.message) toast.success(res.message);
          } else {
            toast.error(res.error);
          }
        });
      }}
    >
      <SelectTrigger aria-label="Priority" className="h-8">
        <span className="text-muted-foreground">Priority</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        {PRIORITIES.map((p) => (
          <SelectItem key={p} value={p}>
            {PRIORITY_LABELS[p]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * "They replied" (MAIN-DOMAIN-DESIGN O17, §3.8): one click, after a confirmation that says whether the status changes,
 * stops every follow-up to the company in every campaign. `MailCheck`, never the simulate link's `MessageSquareReply`.
 * The confirmation opens full screen on a phone (`SETTINGS_DIALOG_CLASS`). Its accessible name is its visible label
 * (WCAG 2.5.3 "Label in Name", review SCREENS-09: a voice command "click They replied" must match); what it does
 * (`THEY_REPLIED_TEXTS.ariaLabel`) is its description, from a visually hidden line next to it.
 */
export function TheyRepliedButton({
  companyId,
  companyName,
  status,
  countsAsReply,
}: {
  companyId: number;
  companyName: string;
  status: CompanyStatusValue;
  countsAsReply: boolean;
}) {
  const [confirm, setConfirm] = useState(false);
  const { pending, run } = usePanelAction();
  const descriptionId = useId();
  const t = theyRepliedConfirm({ company: companyName, countsAsReply, status });
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8"
        aria-describedby={descriptionId}
        disabled={pending}
        onClick={() => setConfirm(true)}
      >
        <MailCheck aria-hidden />
        {THEY_REPLIED_TEXTS.button}
      </Button>
      <span id={descriptionId} className="sr-only">
        {THEY_REPLIED_TEXTS.ariaLabel}
      </span>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent className={SETTINGS_DIALOG_CLASS}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.title}</AlertDialogTitle>
            <AlertDialogDescription>{t.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{THEY_REPLIED_TEXTS.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={() => run(() => markRepliedAction({ companyId }), { toastError: true })}>
              {THEY_REPLIED_TEXTS.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * "Email now": one click starts a one-company campaign from the master template and launches it. Every launch rule
 * still applies (sending hours, daily limit, 30-day rule, test list), so "now" means first in the queue. When the
 * wizard has to fix something first, the toast says what and the wizard opens at that step.
 */
export function EmailNowButton({ companyId, companyName }: { companyId: number; companyName: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function send() {
    startTransition(async () => {
      try {
        const res = await emailNowAction({ companyId });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        if (res.data.launched) {
          toast.success(res.data.message);
        } else {
          toast.message(`${companyName} isn't ready to email yet. ${res.data.message}`, { duration: 10_000 });
        }
        router.push(res.data.href);
      } catch {
        toast.error("Couldn't reach the app, so nothing was sent. Check your connection and try again.");
      }
    });
  }

  return (
    <Button type="button" variant="outline" size="sm" className="h-8" disabled={pending} onClick={send}>
      <Mail aria-hidden />
      {pending ? "Starting…" : "Email now"}
    </Button>
  );
}

function useRestore(companyId: number) {
  const { pending, run } = usePanelAction();
  return {
    pending,
    restore: () => run(() => restoreCompanyAction({ companyId }), { toastError: true }),
  };
}

function MoreMenu({ view }: { view: HeaderView }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { run } = usePanelAction();
  const { restore } = useRestore(view.companyId);

  async function copyLink() {
    const url = `${window.location.origin}/contacts?company=${view.companyId}`;
    const ok = await copyText(url);
    if (ok) toast.success("Link copied.");
    else toast.message("Your browser blocked copying. Here's the link to copy by hand:", { description: url, duration: 15_000 });
  }

  function doDelete() {
    run(() => deleteCompanyAction({ companyId: view.companyId }), {
      quiet: true,
      toastError: true,
      onSuccess: () =>
        toast.success(`${view.name} deleted. Its email history is kept.`, {
          action: { label: "Undo", onClick: () => restore() },
        }),
    });
  }

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="More actions for this company">
            <Ellipsis aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onSelect={() => void copyLink()}>
            <Link2 aria-hidden />
            Copy link to this company
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {view.deleted ? (
            <DropdownMenuItem onSelect={() => restore()}>
              <RotateCcw aria-hidden />
              Restore company
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
              <Trash2 aria-hidden />
              Delete company
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${view.name}?`}
        description="It disappears from Contacts, lists and search. Its email history stays, so the 30-day rule and unsubscribes still apply. You can restore it later."
        confirmLabel="Delete company"
        destructive
        onConfirm={doDelete}
      />
    </>
  );
}

/** "This company was deleted on … by …" with a Restore button. */
export function DeletedBanner({ companyId, text }: { companyId: number; text: string }) {
  const { pending, restore } = useRestore(companyId);
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
    >
      <span className="inline-flex items-center gap-2">
        <Trash2 className="size-4 shrink-0 text-destructive" aria-hidden />
        {text}
      </span>
      <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => restore()}>
        <RotateCcw aria-hidden />
        {pending ? "Restoring…" : "Restore company"}
      </Button>
    </div>
  );
}

export function CompanyHeader({ view }: { view: HeaderView }) {
  const readOnly = view.deleted;
  return (
    <header className="grid gap-3">
      <div className="flex items-start justify-between gap-2 pr-10">
        <div className="grid min-w-0 gap-1">
          <span className="text-xs tabular-nums text-muted-foreground">{view.code}</span>
          <CompanyName companyId={view.companyId} name={view.name} readOnly={readOnly} />
        </div>
        <MoreMenu view={view} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        {view.website ? (
          <a
            href={view.website.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-w-0 items-center gap-1 text-foreground underline-offset-2 hover:underline"
          >
            <span className="truncate">{view.website.host}</span>
            <ExternalLink className="size-3.5 shrink-0" aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        ) : (
          <span>No website</span>
        )}
        <span aria-hidden>·</span>
        <span>{view.countryName ?? "No country"}</span>
        {view.localTime ? (
          <>
            <span aria-hidden>·</span>
            <span>
              Their local time: <LocalTime key={view.localTime.zone} zone={view.localTime.zone} initial={view.localTime.time} />
            </span>
          </>
        ) : null}
      </div>
      {view.localTime?.usesDefault ? (
        <p className="inline-flex items-center gap-1.5 text-xs text-warning">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
          No time zone set, so the default ({view.localTime.zone}) is used for sending hours.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <StatusPicker companyId={view.companyId} status={view.status} disabled={readOnly} />
        {view.markReplied && !readOnly ? (
          <TheyRepliedButton
            companyId={view.companyId}
            companyName={view.name}
            status={view.status}
            countsAsReply={view.markReplied.countsAsReply}
          />
        ) : null}
        <PriorityPicker companyId={view.companyId} priority={view.priority} disabled={readOnly} />
        {!readOnly ? <EmailNowButton companyId={view.companyId} companyName={view.name} /> : null}
      </div>
    </header>
  );
}
