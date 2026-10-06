"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import { TriangleAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { lintTemplate } from "@/core/templates/render";
import { MAX_SUBJECT_CHARS } from "@/core/templates/steps";
import type { TemplateVariable } from "@/core/templates/variables";
import { cn } from "@/lib/utils";
import { TemplateWarningList } from "./warnings";

/**
 * The editor for ONE email of a sequence (the first email or a follow-up): subject (first email
 * only), one-click variable buttons that insert at the cursor, the email text, a short cheat-sheet
 * and live warnings from the template checker. Reused by the template editor and the campaign
 * wizard's message step.
 *
 *   <StepEditor id="step-0" value={{ subject, body }} onChange={setValue} variables={vars} showSubject />
 *
 * Slots: `warnings` (undefined → live syntax/unknown-variable warnings; null → none; a node → shown
 * instead), `preview` (shown beside the editor on wide screens, below it on phones) and `controls`
 * (e.g. a follow-up's timing, shown above the email text).
 */

export type StepEditorValue = { subject?: string | null; body: string };

export type StepEditorProps = {
  /** Base for the field ids (unique on the page). */
  id: string;
  value: StepEditorValue;
  onChange: (next: StepEditorValue) => void;
  variables: readonly TemplateVariable[];
  /** Only the first email has a subject; follow-ups reply in the same thread. */
  showSubject: boolean;
  subjectError?: string | null;
  /**
   * A live note under the subject (M4-DESIGN §2.13, from `firstSubjectProblem`): the "Re:"/"Fwd:" error or the Outlook
   * warning, shown while typing. A `subjectError` from saving wins. Leave it out to show nothing extra.
   */
  subjectProblem?: { level: "error" | "warning"; text: string } | null;
  bodyError?: string | null;
  warnings?: React.ReactNode;
  preview?: React.ReactNode;
  controls?: React.ReactNode;
  bodyLabel?: string;
  /** The "How variables, fallbacks and variations work" box (default: shown). */
  showCheatSheet?: boolean;
  disabled?: boolean;
  className?: string;
};

type FieldName = "subject" | "body";

export function StepEditor({
  id,
  value,
  onChange,
  variables,
  showSubject,
  subjectError,
  subjectProblem,
  bodyError,
  warnings,
  preview,
  controls,
  bodyLabel = "Email text",
  showCheatSheet = true,
  disabled,
  className,
}: StepEditorProps) {
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastField = useRef<FieldName>("body");
  const selection = useRef<Record<FieldName, [number, number] | null>>({ subject: null, body: null });
  const pendingCaret = useRef<{ field: FieldName; pos: number } | null>(null);

  const subject = value.subject ?? "";
  const names = useMemo(() => variables.map((v) => v.name), [variables]);
  const live = useMemo(
    () => [...(showSubject ? lintTemplate(subject, names, "subject") : []), ...lintTemplate(value.body, names, "body")],
    [showSubject, subject, value.body, names],
  );
  const standard = variables.filter((v) => !v.custom);
  const custom = variables.filter((v) => v.custom);

  // After a variable was inserted, put the cursor right after it.
  useLayoutEffect(() => {
    const pending = pendingCaret.current;
    if (!pending) return;
    pendingCaret.current = null;
    const el = pending.field === "subject" ? subjectRef.current : bodyRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(pending.pos, pending.pos);
    selection.current[pending.field] = [pending.pos, pending.pos];
  });

  function remember(field: FieldName, el: HTMLInputElement | HTMLTextAreaElement) {
    lastField.current = field;
    const end = el.value.length;
    selection.current[field] = [el.selectionStart ?? end, el.selectionEnd ?? end];
  }

  function insertVariable(name: string) {
    const field: FieldName = showSubject && lastField.current === "subject" ? "subject" : "body";
    const current = field === "subject" ? subject : value.body;
    const el = field === "subject" ? subjectRef.current : bodyRef.current;
    let [start, end] = selection.current[field] ?? [current.length, current.length];
    if (el && document.activeElement === el) {
      start = el.selectionStart ?? start;
      end = el.selectionEnd ?? end;
    }
    start = Math.max(0, Math.min(start, current.length));
    end = Math.max(start, Math.min(end, current.length));
    const token = `{{${name}}}`;
    const next = current.slice(0, start) + token + current.slice(end);
    pendingCaret.current = { field, pos: start + token.length };
    onChange(field === "subject" ? { ...value, subject: next } : { ...value, body: next });
  }

  const subjectId = `${id}-subject`;
  const bodyId = `${id}-body`;
  const shownWarnings = warnings === undefined ? <TemplateWarningList warnings={live} /> : warnings;

  return (
    <div className={cn(preview ? "grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]" : "grid", className)}>
      <div className="grid min-w-0 content-start gap-4">
        {showSubject ? (
          <div className="grid gap-1.5">
            <Label htmlFor={subjectId}>Subject</Label>
            <Input
              ref={subjectRef}
              id={subjectId}
              value={subject}
              disabled={disabled}
              maxLength={MAX_SUBJECT_CHARS * 2}
              placeholder="For example {Print-ready 3D models|3D models} for {{company}}"
              aria-invalid={subjectError || subjectProblem?.level === "error" ? true : undefined}
              aria-describedby={subjectError ? `${subjectId}-error` : subjectProblem ? `${subjectId}-problem` : undefined}
              autoComplete="off"
              onChange={(e) => {
                onChange({ ...value, subject: e.target.value });
                remember("subject", e.currentTarget);
              }}
              onFocus={(e) => remember("subject", e.currentTarget)}
              onSelect={(e) => remember("subject", e.currentTarget)}
              onBlur={(e) => remember("subject", e.currentTarget)}
            />
            {subjectError ? (
              <p id={`${subjectId}-error`} role="alert" className="text-sm text-destructive">
                {subjectError}
              </p>
            ) : subjectProblem ? (
              <p
                id={`${subjectId}-problem`}
                className={cn(
                  "flex items-start gap-2 text-sm",
                  subjectProblem.level === "error" ? "text-destructive" : "text-warning",
                )}
              >
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>{subjectProblem.text}</span>
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">Follow-ups use &ldquo;Re: &rdquo; and this subject, in the same thread.</p>
            )}
          </div>
        ) : null}

        {controls}

        <div className="grid gap-2">
          <Label htmlFor={bodyId}>{bodyLabel}</Label>
          <div role="group" aria-label="Insert a variable at the cursor" className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-muted-foreground">Insert:</span>
            {standard.map((v) => (
              <VariableButton key={v.name} variable={v} disabled={disabled} onInsert={insertVariable} />
            ))}
            {custom.length ? <span className="mx-1 text-xs text-muted-foreground">From your imports:</span> : null}
            {custom.map((v) => (
              <VariableButton key={v.name} variable={v} disabled={disabled} onInsert={insertVariable} />
            ))}
          </div>
          <Textarea
            ref={bodyRef}
            id={bodyId}
            value={value.body}
            disabled={disabled}
            rows={14}
            spellCheck
            className="min-h-72 leading-relaxed"
            aria-invalid={bodyError ? true : undefined}
            aria-describedby={bodyError ? `${bodyId}-error` : undefined}
            onChange={(e) => {
              onChange({ ...value, body: e.target.value });
              remember("body", e.currentTarget);
            }}
            onFocus={(e) => remember("body", e.currentTarget)}
            onSelect={(e) => remember("body", e.currentTarget)}
            onBlur={(e) => remember("body", e.currentTarget)}
          />
          {bodyError ? (
            <p id={`${bodyId}-error`} role="alert" className="text-sm text-destructive">
              {bodyError}
            </p>
          ) : null}
        </div>

        {shownWarnings}
        {showCheatSheet ? <CheatSheet /> : null}
      </div>
      {preview ? <div className="min-w-0">{preview}</div> : null}
    </div>
  );
}

function VariableButton({
  variable,
  disabled,
  onInsert,
}: {
  variable: TemplateVariable;
  disabled?: boolean;
  onInsert: (name: string) => void;
}) {
  const token = `{{${variable.name}}}`;
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      disabled={disabled}
      title={`${token}: ${variable.description}`}
      aria-label={`Insert ${variable.label} (${token})`}
      // Keep the cursor where it is in the subject or text while clicking.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onInsert(variable.name)}
    >
      {variable.label}
    </Button>
  );
}

/** The short cheat-sheet for fallbacks and variations. */
export function CheatSheet({ className }: { className?: string }) {
  const rows: Array<[string, string]> = [
    ["{{first_name}}", "This person's details. The buttons above add them where the cursor is."],
    ["{{first_name|there}}", "A fallback: uses “there” when the first name is empty, for example for a General inbox."],
    ["{{personal_line|}}", "Fine if empty. A line with only this on it disappears, so there's no gap."],
    ["{Hi|Hello|Hey}", "Picks one for each person. The pick stays the same in the preview, in Review and in the sent email."],
    ["\\{  \\}  \\|", "A real brace or bar in the text."],
  ];
  return (
    <details className={cn("group rounded-md border border-border px-3 py-2 text-sm", className)}>
      <summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground">
        How variables, fallbacks and variations work
      </summary>
      <dl className="mt-2 grid gap-x-4 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)]">
        {rows.map(([code, text]) => (
          <div key={code} className="contents">
            <dt>
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs whitespace-nowrap">{code}</code>
            </dt>
            <dd className="text-muted-foreground">{text}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">
        An empty detail without a fallback shows a warning. Warnings never stop you saving; the preview shows exactly
        what will be sent.
      </p>
    </details>
  );
}
