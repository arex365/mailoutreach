"use client";

import { useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ChevronsUpDown, Pencil, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
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
import { normalizeText } from "@/core/text";
import { cn } from "@/lib/utils";
import type { ErrorLink, NamedItem, PanelResult } from "./types";
import { useUnsavedChange } from "./unsaved-changes";

// ───────────────────────── running actions ─────────────────────────

export type PanelErrorState = {
  message: string;
  link?: ErrorLink;
  fieldErrors?: Record<string, string[] | undefined>;
};

const OFFLINE = "Couldn't reach the app. Check your connection and try again.";

/**
 * Runs a Server Action in a transition: toasts the success message, keeps the error
 * (with its optional link) for inline display.
 */
export function usePanelAction() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<PanelErrorState | null>(null);

  function run<T>(
    call: () => Promise<PanelResult<T>>,
    opts: { onSuccess?: (data: T) => void; onError?: (err: PanelErrorState) => void; toastError?: boolean; quiet?: boolean } = {},
  ) {
    setError(null);
    startTransition(async () => {
      let res: PanelResult<T>;
      try {
        res = await call();
      } catch {
        res = { ok: false, error: OFFLINE };
      }
      if (res.ok) {
        if (res.message && !opts.quiet) toast.success(res.message);
        opts.onSuccess?.(res.data);
        return;
      }
      const err: PanelErrorState = { message: res.error, link: res.link, fieldErrors: res.fieldErrors };
      setError(err);
      if (opts.toastError) toast.error(res.error);
      opts.onError?.(err);
    });
  }

  return { pending, error, setError, run };
}

/** Plain error text, plus "Open C-1042 Acme GmbH" when the problem points at another company. */
export function InlineError({ error, id, className }: { error: PanelErrorState | null; id?: string; className?: string }) {
  if (!error) return null;
  return (
    <p id={id} role="alert" className={cn("text-sm text-destructive", className)}>
      {error.message}
      {error.link ? (
        <>
          {" "}
          <Link href={error.link.href} className="font-medium text-foreground underline underline-offset-2 hover:no-underline">
            Open {error.link.label}
          </Link>
        </>
      ) : null}
    </p>
  );
}

// ───────────────────────── section frame ─────────────────────────

export function PanelSection({
  title,
  id,
  actions,
  children,
  className,
}: {
  title: string;
  id: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={id} className={cn("grid gap-3", className)}>
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
        <h3 id={id} className="text-sm font-semibold">
          {title}
        </h3>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

// ───────────────────────── inline text field ─────────────────────────

/**
 * Shows a value with a small Edit button; editing shows an input with Save and Cancel.
 * Enter saves, Esc cancels. Each field saves on its own.
 */
export function InlineTextField({
  id,
  label,
  value,
  display,
  emptyText = "Not set",
  placeholder,
  maxLength,
  listId,
  readOnly,
  hint,
  startEditing = false,
  onSave,
  onDone,
}: {
  id: string;
  label: string;
  value: string;
  display?: ReactNode;
  emptyText?: string;
  placeholder?: string;
  maxLength?: number;
  listId?: string;
  readOnly?: boolean;
  hint?: ReactNode;
  startEditing?: boolean;
  onSave: (value: string) => Promise<PanelResult<unknown>>;
  /** Called after a save or cancel (e.g. to drop a temporary "new field" row). */
  onDone?: () => void;
}) {
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState(value);
  const { pending, error, setError, run } = usePanelAction();
  useUnsavedChange(id, editing && draft.trim() !== value.trim());

  function begin() {
    setDraft(value);
    setError(null);
    setEditing(true);
  }
  function cancel() {
    setEditing(false);
    setError(null);
    onDone?.();
  }
  function save() {
    if (draft.trim() === value.trim()) {
      cancel();
      return;
    }
    run(() => onSave(draft), {
      onSuccess: () => {
        setEditing(false);
        onDone?.();
      },
    });
  }

  if (!editing) {
    return (
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0 break-words">
          {value ? (display ?? value) : <span className="text-muted-foreground">{emptyText}</span>}
        </div>
        {!readOnly ? (
          <Button type="button" variant="ghost" size="icon-xs" aria-label={`Edit ${label.toLowerCase()}`} onClick={begin}>
            <Pencil aria-hidden />
          </Button>
        ) : null}
      </div>
    );
  }

  const errorId = `${id}-error`;
  return (
    <form
      className="grid gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={id}
          aria-label={label}
          value={draft}
          placeholder={placeholder}
          maxLength={maxLength}
          list={listId}
          autoFocus
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="min-w-40 flex-1"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
        />
        <div className="flex gap-1">
          <Button type="submit" size="sm" variant="secondary" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={cancel} disabled={pending}>
            Cancel
          </Button>
        </div>
      </div>
      <InlineError error={error} id={errorId} />
      {hint && !error ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </form>
  );
}

// ───────────────────────── searchable picker ─────────────────────────

export type PickerOption = { value: string; label: string; hint?: string };

/** A button that opens a searchable list (countries, time zones, lists, tags). */
export function SearchSelect({
  label,
  options,
  value,
  onSelect,
  trigger,
  placeholder = "Search…",
  emptyText = "Nothing matches.",
  onCreate,
  createLabel = (q) => `Create “${q}”`,
  disabled,
  triggerClassName,
  align = "start",
}: {
  label: string;
  options: PickerOption[];
  value?: string | null;
  onSelect: (value: string) => void;
  trigger: ReactNode;
  placeholder?: string;
  emptyText?: string;
  onCreate?: (query: string) => void;
  createLabel?: (query: string) => string;
  disabled?: boolean;
  triggerClassName?: string;
  align?: "start" | "center" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim();
  const exact = q ? options.some((o) => normalizeText(o.label) === normalizeText(q)) : true;
  const showCreate = Boolean(onCreate && q && !exact);

  function close() {
    setOpen(false);
    setQuery("");
  }

  return (
    <Popover
      modal
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          disabled={disabled}
          className={cn("max-w-full justify-between", triggerClassName)}
        >
          <span className="flex min-w-0 items-center gap-1.5 truncate">{trigger}</span>
          <ChevronsUpDown className="opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 max-w-[calc(100vw-2rem)] p-0" align={align}>
        <Command>
          <CommandInput placeholder={placeholder} value={query} onValueChange={setQuery} aria-label={label} />
          <CommandList>
            {!showCreate ? <CommandEmpty>{emptyText}</CommandEmpty> : null}
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={`${o.label} ${o.value}`}
                  keywords={o.hint ? [o.hint] : undefined}
                  data-checked={o.value === value ? "true" : undefined}
                  onSelect={() => {
                    close();
                    onSelect(o.value);
                  }}
                >
                  <span className="min-w-0 truncate">{o.label}</span>
                  {o.hint ? <span className="ml-auto text-xs text-muted-foreground">{o.hint}</span> : null}
                </CommandItem>
              ))}
            </CommandGroup>
            {showCreate ? (
              <CommandGroup forceMount>
                <CommandItem
                  forceMount
                  value={`__create__ ${q}`}
                  onSelect={() => {
                    close();
                    onCreate?.(q);
                  }}
                >
                  <Plus aria-hidden />
                  <span className="min-w-0 truncate">{createLabel(q)}</span>
                </CommandItem>
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ───────────────────────── chips (tags, lists) ─────────────────────────

export function ChipsField({
  noun,
  items,
  options,
  readOnly,
  emptyText,
  onAdd,
  onRemove,
}: {
  noun: "tag" | "list";
  items: NamedItem[];
  options: NamedItem[];
  readOnly?: boolean;
  emptyText: string;
  onAdd: (target: { id: number } | { name: string }) => Promise<PanelResult<unknown>>;
  onRemove: (id: number) => Promise<PanelResult<unknown>>;
}) {
  const { pending, error, run } = usePanelAction();
  const have = new Set(items.map((i) => i.id));
  const choices: PickerOption[] = options.filter((o) => !have.has(o.id)).map((o) => ({ value: String(o.id), label: o.name }));
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {items.length === 0 ? <span className="text-muted-foreground">{emptyText}</span> : null}
        {items.map((item) => (
          <span
            key={item.id}
            className="inline-flex h-6 max-w-full items-center gap-1 rounded-full border border-border bg-secondary pr-1 pl-2 text-xs"
          >
            <span className="min-w-0 truncate">{item.name}</span>
            {!readOnly ? (
              <button
                type="button"
                className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                aria-label={`Remove ${noun} ${item.name}`}
                disabled={pending}
                onClick={() => run(() => onRemove(item.id))}
              >
                <X className="size-3" aria-hidden />
              </button>
            ) : null}
          </span>
        ))}
        {!readOnly ? (
          <SearchSelect
            label={noun === "tag" ? "Add a tag" : "Add to a list"}
            options={choices}
            disabled={pending}
            placeholder={noun === "tag" ? "Find or create a tag…" : "Find or create a list…"}
            emptyText={noun === "tag" ? "No other tags yet. Type a name to create one." : "No other lists yet. Type a name to create one."}
            triggerClassName="h-6 px-2 text-xs"
            trigger={
              <>
                <Plus className="size-3" aria-hidden />
                {noun === "tag" ? "Add tag" : "Add to list"}
              </>
            }
            onSelect={(v) => run(() => onAdd({ id: Number(v) }))}
            onCreate={(name) => run(() => onAdd({ name }))}
            createLabel={(q) => (noun === "tag" ? `Create tag “${q}”` : `Create list “${q}”`)}
          />
        ) : null}
      </div>
      <InlineError error={error} />
    </div>
  );
}

// ───────────────────────── confirmation ─────────────────────────

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={destructive ? "destructive" : "default"} onClick={onConfirm}>
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
