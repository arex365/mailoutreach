import { DEFAULT_FOLLOW_UP_DELAYS, NEW_FOLLOW_UP_BODY } from "@/core/templates/defaults";
import { cleanTemplateName, MAX_FOLLOW_UPS, stepLabel, type SequenceStep } from "@/core/templates/steps";
import { firstSubjectProblem } from "@/core/templates/subject-rules";

/**
 * The template editor's state helpers (pure, unit-tested): the tabs are the first email plus
 * up to three follow-ups; adding and removing follow-ups renumbers them; "dirty" compares a
 * snapshot of what's on screen with what was last saved.
 */

export type EditorStep = {
  /** Stable React key (survives renumbering). */
  key: number;
  step: number;
  enabled: boolean;
  subject: string;
  body: string;
  /** Kept as typed (may be empty or out of range until saved). */
  delayDays: number;
};

export function toEditorSteps(
  steps: ReadonlyArray<{ step: number; enabled: boolean; subject: string | null; body: string; delayDays: number }>,
): EditorStep[] {
  return [...steps]
    .sort((a, b) => a.step - b.step)
    .map((s, i) => ({ key: i + 1, step: i, enabled: s.step === 0 ? true : s.enabled, subject: s.subject ?? "", body: s.body, delayDays: s.delayDays }));
}

export function canAddFollowUp(steps: readonly EditorStep[]): boolean {
  return steps.length < MAX_FOLLOW_UPS + 1;
}

/** Adds the next follow-up (switched on, the usual wait for its position, a short starting text). */
export function addFollowUp(steps: readonly EditorStep[]): EditorStep[] {
  if (!canAddFollowUp(steps)) return [...steps];
  const step = steps.length;
  const key = Math.max(0, ...steps.map((s) => s.key)) + 1;
  return [
    ...steps,
    { key, step, enabled: true, subject: "", body: NEW_FOLLOW_UP_BODY, delayDays: DEFAULT_FOLLOW_UP_DELAYS[step - 1] ?? 3 },
  ];
}

/** Removes one follow-up; the later ones move up (follow-up 3 becomes follow-up 2 …). The first email stays. */
export function removeFollowUp(steps: readonly EditorStep[], step: number): EditorStep[] {
  if (step <= 0) return [...steps];
  return steps.filter((s) => s.step !== step).map((s, i) => ({ ...s, step: i }));
}

/** What the server saves. */
export function toSequence(steps: readonly EditorStep[]): SequenceStep[] {
  return steps.map((s) => ({
    step: s.step,
    enabled: s.step === 0 ? true : s.enabled,
    subject: s.step === 0 ? s.subject : null,
    body: s.body,
    delayDays: s.step === 0 ? 0 : Number.isFinite(s.delayDays) ? s.delayDays : 0,
  }));
}

/**
 * A comparable picture of the editor (name + steps, without React keys), tidied the way saving
 * tidies it (extra spaces at line ends don't count as a change).
 */
export function snapshot(name: string, steps: readonly EditorStep[]): string {
  return JSON.stringify({
    name: cleanTemplateName(name),
    steps: toSequence(steps).map((s) => ({
      ...s,
      subject: s.subject === null || s.subject === undefined ? null : s.subject.replace(/\s+/g, " ").trim(),
      body: s.body.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\s+$/, ""),
    })),
  });
}

/** "First email", "Follow-up 2", "Follow-up 3 (off)". */
export function tabLabel(s: Pick<EditorStep, "step" | "enabled">): string {
  return s.step > 0 && !s.enabled ? `${stepLabel(s.step)} (off)` : stepLabel(s.step);
}

/**
 * The first-subject rule (M4-DESIGN §2.13) as a Save error: the rule's sentence when the first subject starts with
 * "Re:" or "Fwd:", else null. The server refuses the same subjects (saveTemplate).
 */
export function firstSubjectError(subject: string): string | null {
  const problem = firstSubjectProblem(subject);
  return problem?.level === "error" ? problem.text : null;
}

/**
 * The line under the subject while typing: the "Re:"/"Fwd:" error or the Outlook warning ("Art: …", "FYI: …"),
 * so the person sees it before saving; null for a fine subject.
 */
export function subjectHint(subject: string): { level: "error" | "warning"; text: string } | null {
  return firstSubjectProblem(subject);
}

/** The first step with a field error ("step2.body" → 2), or null. */
export function firstErrorStep(fieldErrors: Record<string, string[] | undefined>): number | null {
  const steps = Object.keys(fieldErrors)
    .filter((k) => fieldErrors[k]?.length)
    .map((k) => /^step(\d+)\./.exec(k)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number);
  return steps.length ? Math.min(...steps) : null;
}
