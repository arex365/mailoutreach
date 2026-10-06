"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { FormError } from "@/components/forms/field";
import { EmailPreview } from "@/components/templates/email-preview";
import {
  addFollowUp,
  canAddFollowUp,
  firstErrorStep,
  removeFollowUp,
  snapshot,
  tabLabel,
  toEditorSteps,
  toSequence,
  type EditorStep,
} from "@/components/templates/editor-state";
import { StepEditor } from "@/components/templates/step-editor";
import { MAX_DELAY_DAYS, MIN_DELAY_DAYS } from "@/core/templates/steps";
import type { TemplateVariable } from "@/core/templates/variables";
import { cn } from "@/lib/utils";
import {
  applyTemplateAction,
  previewStepAction,
  saveBackToTemplateAction,
  saveStepsAction,
} from "@/app/(app)/campaigns/[id]/setup/actions";
import type { DraftPreview, DraftStep, RecipientOption } from "@/server/services/campaigns/draft";
import { useSaveBeforeLeaving } from "./autosave-guard";
import { isEmptyRenumber, renumberMap, type KeyedStep } from "./message-state";
import { RecipientPicker } from "./recipient-picker";
import { SAVED, SerialQueue, retryDelayMs, type SaveResult } from "./save-queue";
import { StepFooter, type ContinueProblem } from "./step-footer";
import { SubjectWarning, liveSubjectProblem } from "./subject-warning";
import { StepIntro } from "./wizard-frame";

export const OFFLINE =
  "Couldn't reach the app, so your latest changes aren't saved yet. We'll keep trying every few seconds; keep this page open until it says “All changes saved”.";
const SAVE_DELAY_MS = 800;

type FieldErrors = Record<string, string[] | undefined>;
type SaveState = "saved" | "unsaved" | "saving" | "error";
type TemplateOption = { id: number; name: string; isMaster: boolean };

function keyed(steps: readonly EditorStep[]): KeyedStep[] {
  return steps.map((s) => ({ key: s.key, step: s.step }));
}

/**
 * Step 3, Message and sequence: the first email and 0–3 follow-ups ("send N days after the
 * previous step if there's no reply"), copied from a template (the master to start with). Uses
 * the templates' step editor (variables, cheat-sheet, live warnings) and shows a live preview for
 * one of the campaign's people. Everything saves by itself; "Save back to template" is optional.
 */
export function MessageStep({
  campaignId,
  initialSteps,
  templates,
  sourceTemplateId,
  variables,
  senderName,
  defaultRecipient,
}: {
  campaignId: number;
  initialSteps: DraftStep[];
  templates: TemplateOption[];
  sourceTemplateId: number | null;
  variables: TemplateVariable[];
  senderName: string | null;
  defaultRecipient: RecipientOption | null;
}) {
  // A draft always has a first email; an empty one (made outside the wizard) starts blank.
  const [steps, setSteps] = useState<EditorStep[]>(() =>
    toEditorSteps(initialSteps.length > 0 ? initialSteps : [{ step: 0, enabled: true, subject: "", body: "", delayDays: 0 }]),
  );
  const [active, setActive] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [sourceId, setSourceId] = useState<number | null>(sourceTemplateId);
  const [templateChoice, setTemplateChoice] = useState<string>(sourceTemplateId ? String(sourceTemplateId) : "");
  const [applyOpen, setApplyOpen] = useState(false);
  const [saveBackOpen, setSaveBackOpen] = useState(false);
  const [busy, startBusy] = useTransition();
  const [recipient, setRecipient] = useState<RecipientOption | null>(defaultRecipient);
  const tabRefs = useRef(new Map<number, HTMLButtonElement>());

  // What was last saved, and the saves (one at a time; read by async code).
  const stepsRef = useRef(steps);
  const savedRef = useRef({ snapshot: snapshot("", steps), keys: keyed(steps) });
  const [saves] = useState(() => new SerialQueue<SaveResult>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Failed saves in a row because the app couldn't be reached (0 = none): saving is retried.
  const [offlineFailures, setOfflineFailures] = useState(0);
  // The last save failed (for any reason) and none has worked since; stays true while a retry runs.
  const [saveFailed, setSaveFailed] = useState(false);
  useEffect(() => {
    stepsRef.current = steps;
  });

  function markSaved() {
    setFormError(null);
    setOfflineFailures(0);
    setSaveFailed(false);
  }

  function saveNow(): Promise<SaveResult> {
    // The queue starts this only after every earlier save has finished, so the renumbering below is
    // worked out from what was really saved last (never sent twice).
    return saves.run(async () => {
      const current = stepsRef.current;
      const snap = snapshot("", current);
      const keys = keyed(current);
      const renumber = renumberMap(savedRef.current.keys, keys);
      if (snap === savedRef.current.snapshot && isEmptyRenumber(renumber)) {
        markSaved();
        setSaveState("saved");
        return SAVED;
      }
      setSaveState("saving");
      try {
        const res = await saveStepsAction({ campaignId, steps: toSequence(current), renumber });
        if (!res.ok) {
          setSaveState("error");
          setFormError(res.error);
          setOfflineFailures(0);
          setSaveFailed(true);
          return { ok: false, retryable: false, error: res.error };
        }
        savedRef.current = { snapshot: snap, keys };
        markSaved();
        setSaveState(snapshot("", stepsRef.current) === snap ? "saved" : "unsaved");
        return SAVED;
      } catch {
        setSaveState("error");
        setFormError(OFFLINE);
        setOfflineFailures((n) => n + 1);
        setSaveFailed(true);
        return { ok: false, retryable: true, error: OFFLINE };
      }
    });
  }

  function scheduleSave() {
    setSaveState("unsaved");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void saveNow();
    }, SAVE_DELAY_MS);
  }

  function flush(): Promise<SaveResult> {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    return saveNow();
  }

  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  });

  // Save what's waiting when the step goes away (browser Back, the search menu, a notification…;
  // the request still finishes after the page has moved on), when the tab is hidden, and when the
  // page is closed or reloaded.
  useEffect(() => {
    const flushQuietly = () => void flushRef.current();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushQuietly();
    };
    window.addEventListener("pagehide", flushQuietly);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flushQuietly);
      document.removeEventListener("visibilitychange", onVisibility);
      flushQuietly();
    };
  }, []);

  // The app couldn't be reached: try again after a pause that grows (2 s, 5 s, 10 s, 30 s, then every
  // minute), and at once when the browser says the connection is back.
  useEffect(() => {
    if (offlineFailures === 0) return;
    const retry = () => {
      if (!timer.current) void flushRef.current(); // a pending autosave covers it otherwise
    };
    const wait = window.setTimeout(retry, retryDelayMs(offlineFailures));
    window.addEventListener("online", retry);
    return () => {
      window.clearTimeout(wait);
      window.removeEventListener("online", retry);
    };
  }, [offlineFailures]);

  const dirty = saveState !== "saved";
  const { dialog: leaveDialog } = useSaveBeforeLeaving({ campaignId, dirty, failed: dirty && saveFailed, flush });

  function changeSteps(next: EditorStep[]) {
    setSteps(next);
    stepsRef.current = next;
    scheduleSave();
  }

  function clearErrors(keys: string[]) {
    if (!keys.some((k) => fieldErrors[k])) return;
    setFieldErrors((prev) => {
      const next = { ...prev };
      for (const k of keys) delete next[k];
      return next;
    });
  }

  function updateStep(step: number, patch: Partial<EditorStep>) {
    changeSteps(steps.map((s) => (s.step === step ? { ...s, ...patch } : s)));
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
    changeSteps(next);
    setActive(next.length - 1);
  }

  function remove(step: number) {
    const next = removeFollowUp(steps, step);
    changeSteps(next);
    setActive(Math.max(0, Math.min(step - 1, next.length - 1)));
    // Errors are keyed by step number, which just changed: Continue checks again.
    setFieldErrors({});
  }

  function showProblem(problem: ContinueProblem) {
    const errors = problem.fieldErrors ?? {};
    setFieldErrors(errors);
    const step = firstErrorStep(errors);
    if (step !== null) setActive(step);
  }

  function applyTemplate() {
    const templateId = Number(templateChoice);
    if (!Number.isInteger(templateId) || templateId <= 0) return;
    startBusy(async () => {
      const hadPendingSave = timer.current !== null;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      // In the save queue: a save typed meanwhile waits and then compares with the template's text.
      const applied = await saves.run(async (): Promise<SaveResult> => {
        try {
          const res = await applyTemplateAction({ campaignId, templateId });
          if (!res.ok) {
            toast.error(res.error);
            return { ok: false, retryable: false, error: res.error };
          }
          const fresh = toEditorSteps(res.data.steps);
          setSteps(fresh);
          stepsRef.current = fresh;
          savedRef.current = { snapshot: snapshot("", fresh), keys: keyed(fresh) };
          markSaved();
          setSaveState("saved");
          setSourceId(res.data.templateId);
          setActive(0);
          setFieldErrors({});
          setApplyOpen(false);
          toast.success(res.message ?? "Template applied.");
          return SAVED;
        } catch {
          const error = "Couldn't reach the app, so the template wasn't applied. Check your connection and try again.";
          toast.error(error);
          return { ok: false, retryable: true, error };
        }
      });
      // Not applied: the text typed before still needs its autosave.
      if (!applied.ok && hadPendingSave) scheduleSave();
    });
  }

  function saveBack() {
    startBusy(async () => {
      const saved = await flush();
      if (!saved.ok) {
        toast.error(
          saved.retryable
            ? "Your latest changes couldn't be saved, so nothing was saved to the template. Try again in a moment."
            : `Nothing was saved to the template. ${saved.error}`,
        );
        return;
      }
      try {
        const res = await saveBackToTemplateAction({ campaignId });
        if (!res.ok) {
          setSaveBackOpen(false);
          if (res.fieldErrors) showProblem({ error: res.error, fieldErrors: res.fieldErrors });
          toast.error(res.error);
          return;
        }
        setSaveBackOpen(false);
        toast.success(res.message ?? "Saved to the template.");
      } catch {
        toast.error("Couldn't reach the app, so the template wasn't changed. Check your connection and try again.");
      }
    });
  }

  const index = Math.min(active, steps.length - 1);
  const current = steps[index]!;
  const first = steps[0]!;
  const err = (key: string) => fieldErrors[key]?.[0] ?? null;
  // The first-subject rules (M4-DESIGN §2.13), as you type: "Re:"/"Fwd:" is an error, "Art: …" a warning.
  const subjectProblem = liveSubjectProblem(first.subject);
  const stepHasError = (step: number) => Object.keys(fieldErrors).some((k) => k.startsWith(`step${step}.`) && fieldErrors[k]?.length);
  const sourceName = templates.find((t) => t.id === sourceId)?.name ?? null;
  const choiceName = templates.find((t) => String(t.id) === templateChoice)?.name ?? "this template";

  return (
    <div className="flex flex-1 flex-col">
      <StepIntro title="Message and follow-ups">
        Write the first email and up to 3 follow-ups. Changes here are for this campaign only; the template stays as it is unless you
        save back to it.
      </StepIntro>

      <section aria-label="Template" className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor="message-template">Start from a template</Label>
          <Select value={templateChoice} onValueChange={setTemplateChoice}>
            <SelectTrigger id="message-template" className="w-64 max-w-full">
              <SelectValue placeholder="Choose a template" />
            </SelectTrigger>
            <SelectContent position="popper">
              {templates.map((t) => (
                <SelectItem key={t.id} value={String(t.id)}>
                  {t.name}
                  {t.isMaster ? " (master)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" onClick={() => setApplyOpen(true)} disabled={busy || !templateChoice}>
          Use this template
        </Button>
        <Button variant="ghost" onClick={() => setSaveBackOpen(true)} disabled={busy || !sourceName}>
          Save back to template
        </Button>
        <p className="w-full text-xs text-muted-foreground">
          {sourceName ? `This campaign's emails came from "${sourceName}".` : "The template this campaign came from was deleted."}
        </p>
      </section>

      <div className="grid gap-4">
        <FormError message={formError} />
        <div className="flex flex-wrap items-end gap-1 border-b border-border">
          <div role="tablist" aria-label="Emails in this campaign" className="-mb-px flex flex-wrap gap-1">
            {steps.map((s, i) => {
              const selected = i === index;
              return (
                <button
                  key={s.key}
                  ref={(el) => {
                    if (el) tabRefs.current.set(s.key, el);
                    else tabRefs.current.delete(s.key);
                  }}
                  type="button"
                  role="tab"
                  id={`message-tab-${s.key}`}
                  aria-selected={selected}
                  aria-controls="message-step-panel"
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
                  {stepHasError(s.step) ? (
                    <>
                      <span aria-hidden className="size-1.5 rounded-full bg-destructive" />
                      <span className="sr-only">(needs fixing)</span>
                    </>
                  ) : null}
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
          <span className="mb-2 ml-auto text-xs text-muted-foreground" aria-live="polite">
            {saveState === "saving"
              ? "Saving…"
              : saveState === "unsaved"
                ? "Unsaved changes"
                : saveState === "error"
                  ? "Not saved yet"
                  : "All changes saved"}
          </span>
        </div>

        <div role="tabpanel" id="message-step-panel" aria-labelledby={`message-tab-${current.key}`}>
          <StepEditor
            key={current.key}
            id={`message-step-${current.key}`}
            value={{ subject: current.step === 0 ? current.subject : null, body: current.body }}
            onChange={(v) => {
              const patch: Partial<EditorStep> = {};
              if (v.body !== current.body) patch.body = v.body;
              if (current.step === 0 && (v.subject ?? "") !== current.subject) patch.subject = v.subject ?? "";
              if (Object.keys(patch).length > 0) updateStep(current.step, patch);
            }}
            variables={variables}
            showSubject={current.step === 0}
            subjectError={err("step0.subject") ?? subjectProblem.error}
            bodyError={err(`step${current.step}.body`)}
            bodyLabel={current.step === 0 ? "First email" : `Follow-up ${current.step}`}
            controls={
              current.step > 0 ? (
                <FollowUpControls
                  step={current}
                  delayError={err(`step${current.step}.delayDays`)}
                  onDelay={(delayDays) => updateStep(current.step, { delayDays })}
                  onEnabled={(enabled) => updateStep(current.step, { enabled })}
                  onRemove={() => remove(current.step)}
                />
              ) : subjectProblem.warning ? (
                <SubjectWarning text={subjectProblem.warning} />
              ) : null
            }
            preview={
              <MessagePreview
                campaignId={campaignId}
                step={current.step}
                firstSubject={first.subject}
                body={current.body}
                senderName={senderName}
                recipient={recipient}
                onRecipient={setRecipient}
              />
            }
          />
        </div>
      </div>

      <StepFooter campaignId={campaignId} current="message" beforeContinue={flush} onProblem={showProblem} />
      {leaveDialog}

      <AlertDialog open={applyOpen} onOpenChange={(open) => !busy && setApplyOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Use &ldquo;{choiceName}&rdquo; for this campaign?</AlertDialogTitle>
            <AlertDialogDescription>
              Its emails replace this campaign&apos;s first email and follow-ups, including your changes here. Emails you edited for single
              people in Review are reset too. The template itself doesn&apos;t change.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep this text</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                applyTemplate();
              }}
            >
              {busy ? "Replacing…" : "Use this template"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={saveBackOpen} onOpenChange={(open) => !busy && setSaveBackOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save this text to &ldquo;{sourceName}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              The template&apos;s first email and follow-ups are replaced with this campaign&apos;s. New campaigns that start from it use this
              text; campaigns already made keep their own copy.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                saveBack();
              }}
            >
              {busy ? "Saving…" : "Save to template"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  const delayId = `message-delay-${step.key}`;
  const switchId = `message-enabled-${step.key}`;
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
        <span id={`${delayId}-after`}>{step.delayDays === 1 ? "day" : "days"} after the previous step if there&apos;s no reply</span>
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
          ? "This campaign sends this follow-up unless the person replies first."
          : "Switched off: this campaign leaves this follow-up out. Switch it on to use it."}
      </p>
    </div>
  );
}

const PREVIEW_OFFLINE = "Couldn't reach the preview. Check your connection; it updates again when you type.";

type OwnVersion = DraftPreview["ownVersion"];

/** The line under "Preview". */
export function previewIntro(senderName: string | null, ownVersion: OwnVersion): string {
  const from = senderName ? ` from ${senderName}` : "";
  return ownVersion === "email"
    ? `What this person would get${from} with the campaign's text, including changes you haven't saved.`
    : `Exactly what this person gets${from}, including changes you haven't saved.`;
}

/** Says when the picked person has their own version (edited in Review), so the preview isn't mistaken for their email. */
export function ownVersionNote(name: string, ownVersion: OwnVersion): string | null {
  if (ownVersion === "email") {
    return `${name} has their own version of this email, edited in Review, so they won't get the changes you make here. To change it, open ${name} in Review.`;
  }
  if (ownVersion === "subject") {
    return `${name} has their own subject for the first email, edited in Review, so this follow-up's “Re:” line uses it.`;
  }
  return null;
}

/**
 * One of the campaign's people, with the email (unsaved text included) as it would go out, and a
 * note when that person has their own version of it from Review.
 */
function MessagePreview({
  campaignId,
  step,
  firstSubject,
  body,
  senderName,
  recipient,
  onRecipient,
}: {
  campaignId: number;
  step: number;
  /** The first email's subject (a follow-up's subject is "Re: " + it). */
  firstSubject: string;
  body: string;
  senderName: string | null;
  recipient: RecipientOption | null;
  onRecipient: (r: RecipientOption) => void;
}) {
  const [email, setEmail] = useState<{ personId: number; step: number; preview: DraftPreview } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    if (!recipient) return;
    const rid = ++requestId.current;
    const timer = setTimeout(async () => {
      setPending(true);
      try {
        const res = await previewStepAction({ campaignId, personId: recipient.personId, step, subject: firstSubject, body });
        if (rid !== requestId.current) return;
        if (res.ok) {
          setEmail({ personId: recipient.personId, step, preview: res.data });
          setError(null);
        } else {
          setError(res.error);
        }
      } catch {
        if (rid === requestId.current) setError(PREVIEW_OFFLINE);
      } finally {
        if (rid === requestId.current) setPending(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [campaignId, step, firstSubject, body, recipient]);

  // Only trust the "own version" answer for the person and email it was asked about.
  const ownVersion = recipient && email && email.personId === recipient.personId && email.step === step ? email.preview.ownVersion : null;
  const note = recipient ? ownVersionNote(recipient.name, ownVersion) : null;

  return (
    <section aria-labelledby="message-preview-title" className="grid gap-3 rounded-lg border border-border bg-card p-4 lg:sticky lg:top-20">
      <div>
        <h3 id="message-preview-title" className="text-sm font-medium">
          Preview
        </h3>
        <p className="text-xs text-muted-foreground">{previewIntro(senderName, ownVersion)}</p>
      </div>
      <div className="grid min-w-0 gap-1.5">
        <Label htmlFor="message-preview-person">Preview for</Label>
        <RecipientPicker campaignId={campaignId} id="message-preview-person" value={recipient} onChange={onRecipient} />
      </div>
      {note ? (
        <p role="note" className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          {note}
        </p>
      ) : null}
      <EmailPreview
        email={recipient && email ? email.preview : null}
        pending={pending}
        error={recipient ? error : null}
        emptyText="Nobody in this campaign yet. Add companies in the Audience step to preview their emails."
      />
    </section>
  );
}
