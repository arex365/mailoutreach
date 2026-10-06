"use client";

import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field, FormError } from "@/components/forms/field";

export type PromptResult = { ok: true } | { ok: false; error: string; fieldError?: string };

type PromptDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  label: string;
  placeholder?: string;
  initialValue?: string;
  submitLabel: string;
  pendingLabel: string;
  /** Offered as you type (e.g. existing tag names). */
  suggestions?: string[];
  maxLength?: number;
  onSubmit: (value: string) => Promise<PromptResult>;
};

/** A small dialog asking for one piece of text (new list name, rename, tag…). */
export function PromptDialog(props: PromptDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* Remounts on every open, so the field starts fresh. */}
        {props.open ? <PromptForm {...props} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PromptForm({
  onOpenChange,
  title,
  description,
  label,
  placeholder,
  initialValue,
  submitLabel,
  pendingLabel,
  suggestions,
  maxLength,
  onSubmit,
}: PromptDialogProps) {
  const id = useId();
  const listId = `${id}-suggestions`;
  const [value, setValue] = useState(initialValue ?? "");
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim()) {
      setFieldError(`Type ${label.toLowerCase().startsWith("a ") ? label.toLowerCase() : `a ${label.toLowerCase()}`} first.`);
      return;
    }
    startTransition(async () => {
      const res = await onSubmit(value);
      if (res.ok) {
        onOpenChange(false);
      } else {
        setError(res.fieldError ? null : res.error);
        setFieldError(res.fieldError ?? null);
      }
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
      </DialogHeader>
      <FormError message={error} />
      <Field label={label} htmlFor={`${id}-input`} error={fieldError ?? undefined}>
        <Input
          id={`${id}-input`}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setFieldError(null);
          }}
          placeholder={placeholder}
          maxLength={maxLength}
          autoFocus
          autoComplete="off"
          list={suggestions?.length ? listId : undefined}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? `${id}-input-error` : undefined}
        />
      </Field>
      {suggestions?.length ? (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? pendingLabel : submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
