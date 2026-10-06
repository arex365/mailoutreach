"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Plus, Star, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Field, FormError } from "@/components/forms/field";
import { MAX_DELAY_DAYS, MIN_DELAY_DAYS, TEMPLATE_NAME_MAX, templateNameProblem, validateSequence } from "@/core/templates/steps";
import type { TemplateVariable } from "@/core/templates/variables";
import { cn } from "@/lib/utils";
import { saveTemplateAction } from "@/app/(app)/templates/actions";
import {
  addFollowUp,
  canAddFollowUp,
  firstErrorStep,
  firstSubjectError,
  removeFollowUp,
  snapshot,
  subjectHint,
  tabLabel,
  toEditorSteps,
  toSequence,
  type EditorStep,
} from "./editor-state";
import { useLeaveGuard } from "./leave-guard";
import type { PreviewPersonOption } from "./person-picker";
import { TemplatePreviewPanel } from "./preview-panel";
import { StepEditor } from "./step-editor";

const OFFLINE = "Couldn't reach the app, so nothing was saved. Check your connection and click Save again.";

export type TemplateEditorProps = {
  template: {
    id: number;
    name: string;
    isMaster: boolean;
    /** "Changed 3 days ago by Ali". */
    changed: string;
    /** ISO time of the last save: sent back with Save, so a save over a teammate's newer changes is refused. */
    updatedAt: string;
    steps: Array<{ step: number; enabled: boolean; subject: string | null; body: string; delayDays: number }>;
  };
  variables: TemplateVariable[];
  senders: Array<{ id: number; name: string }>;
  defaultSenderId: number | null;
  defaultPerson: PreviewPersonOption | null;
};

type FieldErrors = Record<string, string[] | undefined>;

/**
 * The template editor: name, tabs "First email / Follow-up 1 / 2 / 3 / + Add follow-up", the
 * per-email editor (variables, cheat-sheet, live warnings), each follow-up's timing and on/off
 * switch, and a live preview for any real contact and sender. Save is the one primary action
 * (Ctrl+S works too); leaving with unsaved changes asks first.
 */
export function TemplateEditor({ template, variables, senders, defaultSenderId, defaultPerson }: TemplateEditorProps) {
  const router = useRouter();
  const [name, setName] = useState(template.name);
  const [steps, setSteps] = useState<EditorStep[]>(() => toEditorSteps(template.steps));
  const [active, setActive] = useState(0);
  const [saved, setSaved] = useState(() => snapshot(template.name, toEditorSteps(template.steps)));
  // The version this editor is based on: what it opened, then what it last saved itself.
  const [baseUpdatedAt, setBaseUpdatedAt] = useState(template.updatedAt);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const tabRefs = useRef(new Map<number, HTMLButtonElement>());
  const saveRef = useRef<() => void>(() => undefined);

  const dirty = snapshot(name, steps) !== saved;
  const { dialog } = useLeaveGuard(dirty);
  const index = Math.min(active, steps.length - 1);
  const current = steps[index]!;
  const first = steps[0]!;

  function clearErrors(keys: string[]) {
    if (!keys.some((k) => fieldErrors[k])) return;
    setFieldErrors((prev) => {
      const next = { ...prev };
      for (const k of keys) delete next[k];
      return next;
    });
  }

  function updateStep(step: number, patch: Partial<EditorStep>) {
    setSteps((prev) => prev.map((s) => (s.step === step ? { ...s, ...patch } : s)));
    clearErrors(Object.keys(patch).map((k) => `step${step}.${k}`));
  }

  function selectTab(i: number, focus = false) {
    const target = steps[i];
    if (!target) return;
    setActive(i);
    if (focus) tabRefs.current.get(target.key)?.focus();
  }

  function onTabKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, i: number) {
    const last = steps.length - 1;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = i === last ? 0 : i + 1;
    else if (e.key === "ArrowLeft") next = i === 0 ? last : i - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next === null) return;
    e.preventDefault();
    selectTab(next, true);
  }

  function add() {
    if (!canAddFollowUp(steps)) return;
    const next = addFollowUp(steps);
    setSteps(next);
    setActive(next.length - 1);
  }

  function remove(step: number) {
    const next = removeFollowUp(steps, step);
    setSteps(next);
    setActive(Math.max(0, Math.min(step - 1, next.length - 1)));
    // Errors are keyed by step number, which just changed: check again on the next Save.
    setFieldErrors((prev) => (prev.name ? { name: prev.name } : {}));
    toast.info(`Follow-up ${step} removed. Save to keep this change.`);
  }

  function showProblems(errors: FieldErrors, message: string) {
    setFieldErrors(errors);
    setFormError(message);
    const step = firstErrorStep(errors);
    if (step !== null) setActive(step);
  }

  function save() {
    if (saving) return;
    const sequence = toSequence(steps);
    const nameProblem = templateNameProblem(name);
    const checked = validateSequence(sequence);
    const subjectError = firstSubjectError(first.subject);
    if (nameProblem || !checked.ok || subjectError) {
      const errors: FieldErrors = {
        ...(subjectError ? { "step0.subject": [subjectError] } : {}),
        ...(checked.ok ? {} : checked.fieldErrors),
        ...(nameProblem ? { name: [nameProblem] } : {}),
      };
      const message = !checked.ok ? checked.error : nameProblem ? "Give the template a name." : (subjectError ?? "");
      showProblems(errors, message);
      return;
    }
    const submitted = snapshot(name, steps);
    startSaving(async () => {
      try {
        const res = await saveTemplateAction({ id: template.id, name, steps: sequence, updatedAt: baseUpdatedAt });
        if (!res.ok) {
          showProblems(res.fieldErrors ?? {}, res.error);
          toast.error(res.error);
          return;
        }
        setBaseUpdatedAt(res.data.updatedAt);
        setSaved(submitted);
        setFieldErrors({});
        setFormError(null);
        toast.success(res.message ?? "Template saved.");
        router.refresh();
      } catch {
        setFormError(OFFLINE);
        toast.error(OFFLINE);
      }
    });
  }

  useEffect(() => {
    saveRef.current = save;
  });

  // Ctrl+S / Cmd+S saves (a modifier shortcut, so it's fine while typing).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const stepErrors = (step: number) => Object.keys(fieldErrors).some((k) => k.startsWith(`step${step}.`) && fieldErrors[k]?.length);
  const err = (key: string) => fieldErrors[key]?.[0] ?? null;
  const shownName = name.trim() || "Untitled template";

  const followUpControls =
    current.step > 0 ? (
      <FollowUpControls
        step={current}
        delayError={err(`step${current.step}.delayDays`)}
        onDelay={(delayDays) => updateStep(current.step, { delayDays })}
        onEnabled={(enabled) => updateStep(current.step, { enabled })}
        onRemove={() => remove(current.step)}
      />
    ) : null;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-6 pb-4 md:px-6">
        <div className="min-w-0">
          <Link
            href="/templates"
            className="inline-flex items-center gap-1 rounded-sm text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            Templates
          </Link>
          <h1 className="mt-1 flex min-w-0 items-center gap-2 text-xl font-semibold tracking-tight">
            {template.isMaster ? <Star className="size-4 shrink-0 fill-brand text-brand" aria-hidden /> : null}
            <span className="truncate">{shownName}</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {template.isMaster ? "The master template: new campaigns start from it. " : ""}
            {template.changed}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {saving ? "Saving…" : dirty ? "Unsaved changes" : "All changes saved"}
          </span>
          <Button onClick={save} disabled={saving} aria-keyshortcuts="Control+S">
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      <div className="grid gap-6 px-4 pb-12 md:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="grid min-w-0 content-start gap-5">
          <FormError message={formError} />
          <Field label="Template name" htmlFor="template-name" error={fieldErrors.name} className="max-w-md">
            <Input
              id="template-name"
              value={name}
              maxLength={TEMPLATE_NAME_MAX + 20}
              autoComplete="off"
              aria-invalid={fieldErrors.name ? true : undefined}
              aria-describedby={fieldErrors.name ? "template-name-error" : undefined}
              onChange={(e) => {
                setName(e.target.value);
                clearErrors(["name"]);
              }}
            />
          </Field>

          <div className="grid gap-4">
            <div className="flex flex-wrap items-end gap-1 border-b border-border">
              <div role="tablist" aria-label="Emails in this sequence" className="-mb-px flex flex-wrap gap-1">
                {steps.map((s, i) => {
                  const selected = i === index;
                  const problem = stepErrors(s.step);
                  return (
                    <button
                      key={s.key}
                      ref={(el) => {
                        if (el) tabRefs.current.set(s.key, el);
                        else tabRefs.current.delete(s.key);
                      }}
                      type="button"
                      role="tab"
                      id={`template-tab-${s.key}`}
                      aria-selected={selected}
                      aria-controls="template-step-panel"
                      tabIndex={selected ? 0 : -1}
                      onClick={() => selectTab(i)}
                      onKeyDown={(e) => onTabKeyDown(e, i)}
                      className={cn(
                        "relative inline-flex h-10 items-center gap-1.5 rounded-t-md px-3 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground",
                        selected && "font-medium text-foreground",
                        s.step > 0 && !s.enabled && "italic",
                      )}
                    >
                      {tabLabel(s)}
                      {problem ? (
                        <>
                          <span aria-hidden className="size-1.5 rounded-full bg-destructive" />
                          <span className="sr-only">(needs fixing)</span>
                        </>
                      ) : null}
                      {/* Orange underline = selected. */}
                      {selected ? <span aria-hidden className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand" /> : null}
                    </button>
                  );
                })}
              </div>
              {canAddFollowUp(steps) ? (
                <Button type="button" variant="ghost" size="sm" className="mb-1.5 text-muted-foreground" onClick={add}>
                  <Plus className="size-3.5" aria-hidden />
                  Add follow-up
                </Button>
              ) : null}
            </div>

            <div role="tabpanel" id="template-step-panel" aria-labelledby={`template-tab-${current.key}`}>
              <StepEditor
                key={current.key}
                id={`template-step-${current.key}`}
                value={{ subject: current.step === 0 ? current.subject : null, body: current.body }}
                onChange={(v) => {
                  const patch: Partial<EditorStep> = {};
                  if (v.body !== current.body) patch.body = v.body;
                  if (current.step === 0 && (v.subject ?? "") !== current.subject) patch.subject = v.subject ?? "";
                  if (Object.keys(patch).length > 0) updateStep(current.step, patch);
                }}
                variables={variables}
                showSubject={current.step === 0}
                subjectError={err("step0.subject")}
                subjectProblem={current.step === 0 ? subjectHint(first.subject) : null}
                bodyError={err(`step${current.step}.body`)}
                bodyLabel={current.step === 0 ? "First email" : `Follow-up ${current.step}`}
                controls={followUpControls}
              />
            </div>
          </div>
        </div>

        <aside className="min-w-0 lg:sticky lg:top-20 lg:self-start">
          <TemplatePreviewPanel
            templateId={template.id}
            step={current.step}
            subject={first.subject}
            body={current.body}
            firstSubject={first.subject}
            senders={senders}
            defaultSenderId={defaultSenderId}
            defaultPerson={defaultPerson}
          />
        </aside>
      </div>
      {dialog}
    </div>
  );
}

function FollowUpControls({
  step,
  delayError,
  onDelay,
  onEnabled,
  onRemove,
}: {
  step: EditorStep;
  delayError: string | null;
  onDelay: (days: number) => void;
  onEnabled: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const delayId = `template-delay-${step.key}`;
  const switchId = `template-enabled-${step.key}`;
  return (
    <div className="grid gap-3 rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span id={`${delayId}-before`}>Send</span>
        <Input
          id={delayId}
          type="number"
          inputMode="numeric"
          min={MIN_DELAY_DAYS}
          max={MAX_DELAY_DAYS}
          step={1}
          className="h-8 w-20"
          value={Number.isFinite(step.delayDays) ? String(step.delayDays) : ""}
          aria-labelledby={`${delayId}-before ${delayId} ${delayId}-after`}
          aria-invalid={delayError ? true : undefined}
          aria-describedby={delayError ? `${delayId}-error` : undefined}
          onChange={(e) => onDelay(e.target.value === "" ? Number.NaN : Number(e.target.value))}
        />
        <span id={`${delayId}-after`}>
          {step.delayDays === 1 ? "day" : "days"} after the previous step if there&apos;s no reply
        </span>
      </div>
      {delayError ? (
        <p id={`${delayId}-error`} role="alert" className="text-sm text-destructive">
          {delayError}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Switch
            id={switchId}
            checked={step.enabled}
            onCheckedChange={onEnabled}
            aria-describedby={`${switchId}-hint`}
            // Switches stay neutral (orange only means "primary" or "selected").
            className="data-checked:bg-foreground"
          />
          <Label htmlFor={switchId} className="font-normal">
            {step.enabled ? "Switched on" : "Switched off"}
          </Label>
        </div>
        <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={onRemove}>
          <Trash2 className="size-3.5" aria-hidden />
          Remove follow-up {step.step}
        </Button>
      </div>
      <p id={`${switchId}-hint`} className="text-xs text-muted-foreground">
        {step.enabled
          ? "New campaigns include this follow-up. It stops as soon as the person replies."
          : "New campaigns leave this follow-up out. You can still switch it on in a campaign."}
      </p>
    </div>
  );
}
