"use client";

import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { PERSONAL_LINE_GOOD_WORDS, PERSONAL_LINE_MAX_CHARS, wordCount } from "./emailed-text";
import { InlineError, usePanelAction } from "./panel-ui";
import type { PanelResult } from "./types";
import { useUnsavedChange } from "./unsaved-changes";

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Editor for a personal line: one sentence, at most 300 characters, with a gentle
 * warning past 25 words. Ctrl+Enter saves, Esc cancels.
 */
export function LineEditor({
  id,
  label,
  value,
  hint,
  onSave,
  onDone,
}: {
  id: string;
  label: string;
  value: string | null;
  hint?: string;
  onSave: (value: string) => Promise<PanelResult<unknown>>;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const { pending, error, run } = usePanelAction();
  const chars = oneLine(draft).length;
  const words = wordCount(draft);
  const tooLong = chars > PERSONAL_LINE_MAX_CHARS;
  const wordy = words > PERSONAL_LINE_GOOD_WORDS;
  const helpId = `${id}-help`;
  useUnsavedChange(id, oneLine(draft) !== oneLine(value ?? ""));

  function save() {
    if (tooLong) return;
    if (oneLine(draft) === oneLine(value ?? "")) {
      onDone();
      return;
    }
    run(() => onSave(draft), { onSuccess: onDone });
  }

  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Textarea
        id={id}
        aria-label={label}
        aria-describedby={helpId}
        aria-invalid={tooLong || error ? true : undefined}
        value={draft}
        rows={3}
        autoFocus
        placeholder="One specific sentence about their work, e.g. “Your hand-painted dragon busts caught my eye.”"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onDone();
          } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            save();
          }
        }}
      />
      <div id={helpId} className="flex flex-wrap items-start justify-between gap-2 text-xs">
        {wordy ? (
          <span className="inline-flex items-center gap-1 text-warning">
            <TriangleAlert className="size-3.5" aria-hidden />
            Personal lines work best under {PERSONAL_LINE_GOOD_WORDS} words
          </span>
        ) : (
          <span className="text-muted-foreground">{hint ?? "Keep it to one sentence."}</span>
        )}
        <span className={cn("tabular-nums", tooLong ? "text-destructive" : "text-muted-foreground")}>
          {chars} / {PERSONAL_LINE_MAX_CHARS}
        </span>
      </div>
      {tooLong ? (
        <p className="text-sm text-destructive" role="alert">
          Keep the personal line under {PERSONAL_LINE_MAX_CHARS} characters.
        </p>
      ) : null}
      <InlineError error={error} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="secondary" disabled={pending || tooLong}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Notes that are always editable: a textarea with a Save button that lights up once
 * something changed. Remount it with key={value} to pick up a newly saved value.
 */
export function NotesEditor({
  id,
  label,
  value,
  readOnly,
  placeholder,
  onSave,
}: {
  id: string;
  label: string;
  value: string;
  readOnly?: boolean;
  placeholder?: string;
  onSave: (value: string) => Promise<PanelResult<unknown>>;
}) {
  const [draft, setDraft] = useState(value);
  const { pending, error, run } = usePanelAction();
  const dirty = draft.trim() !== value.trim();
  // Closing the panel with unsaved notes asks first (see CompanySheet).
  useUnsavedChange(id, dirty && !readOnly);

  function save() {
    if (!dirty) return;
    run(() => onSave(draft));
  }

  if (readOnly) {
    return value ? (
      <p className="whitespace-pre-wrap break-words text-sm">{value}</p>
    ) : (
      <p className="text-sm text-muted-foreground">No notes.</p>
    );
  }

  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Textarea
        id={id}
        aria-label={label}
        value={draft}
        rows={4}
        placeholder={placeholder}
        className="max-h-80"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            save();
          }
        }}
      />
      <InlineError error={error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" variant="secondary" disabled={!dirty || pending}>
          {pending ? "Saving…" : "Save notes"}
        </Button>
        {dirty && !pending ? (
          <>
            <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(value)}>
              Undo changes
            </Button>
            <span className="text-xs text-muted-foreground">Not saved yet</span>
          </>
        ) : null}
      </div>
    </form>
  );
}

/** Notes shown as text, with an Edit button that opens a textarea (used on person cards). */
export function ToggleNotes({
  id,
  label,
  value,
  readOnly,
  addLabel,
  onSave,
}: {
  id: string;
  label: string;
  value: string;
  readOnly?: boolean;
  addLabel: string;
  onSave: (value: string) => Promise<PanelResult<unknown>>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const { pending, error, run } = usePanelAction();
  useUnsavedChange(id, editing && !readOnly && draft.trim() !== value.trim());

  if (!editing) {
    if (!value) {
      return readOnly ? null : (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="justify-self-start text-muted-foreground"
          onClick={() => {
            setDraft("");
            setEditing(true);
          }}
        >
          {addLabel}
        </Button>
      );
    }
    return (
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 whitespace-pre-wrap break-words text-sm">{value}</p>
        {!readOnly ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              setDraft(value);
              setEditing(true);
            }}
            aria-label={`Edit ${label.toLowerCase()}`}
          >
            Edit
          </Button>
        ) : null}
      </div>
    );
  }

  function save() {
    if (draft.trim() === value.trim()) {
      setEditing(false);
      return;
    }
    run(() => onSave(draft), { onSuccess: () => setEditing(false) });
  }

  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Textarea
        id={id}
        aria-label={label}
        value={draft}
        rows={3}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            save();
          }
        }}
      />
      <InlineError error={error} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="secondary" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
