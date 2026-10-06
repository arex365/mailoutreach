/**
 * Rules for a sequence's steps (PLAN.md B4, B6.4), shared by the template editor (instant
 * feedback), the templates service (the real check) and the campaign wizard.
 *   - step 0 = the first email: subject and body required;
 *   - steps 1..3 = follow-ups, in order without gaps: body required, enabled on/off,
 *     "send N days after the previous step if there's no reply" with N ≥ 1;
 *   - only the first email has a subject (follow-ups reply in the same thread: "Re: …").
 */

export const MAX_FOLLOW_UPS = 3;
export const MAX_SUBJECT_CHARS = 200;
export const MAX_BODY_CHARS = 20_000;
export const MIN_DELAY_DAYS = 1;
export const MAX_DELAY_DAYS = 90;
export const TEMPLATE_NAME_MAX = 80;

export type SequenceStep = {
  step: number;
  enabled: boolean;
  /** First email only; ignored (stored as null) for follow-ups. */
  subject?: string | null;
  body: string;
  /** Follow-ups: days after the previous step. The first email: 0. */
  delayDays: number;
};

/** Field errors keyed "name", "step0.subject", "step2.body", "step1.delayDays" … */
export type StepFieldErrors = Record<string, string[]>;

/** "First email", "Follow-up 1" … */
export function stepLabel(step: number): string {
  return step === 0 ? "First email" : `Follow-up ${step}`;
}

export function cleanTemplateName(name: string): string {
  return (name ?? "").replace(/\s+/g, " ").trim();
}

export function templateNameProblem(name: string): string | null {
  const clean = cleanTemplateName(name);
  if (!clean) return "Give the template a name.";
  if (clean.length > TEMPLATE_NAME_MAX) return `Keep the name under ${TEMPLATE_NAME_MAX} characters.`;
  return null;
}

function normalizeNewlines(text: string): string {
  return (text ?? "").replace(/\r\n?/g, "\n");
}

/**
 * Checks and tidies a sequence. Returns the cleaned steps (sorted, subject only on step 0,
 * trailing spaces trimmed) or the problems keyed by field.
 */
export function validateSequence(
  steps: readonly SequenceStep[],
): { ok: true; steps: SequenceStep[] } | { ok: false; error: string; fieldErrors: StepFieldErrors } {
  const fieldErrors: StepFieldErrors = {};
  const add = (key: string, message: string) => {
    (fieldErrors[key] ??= []).push(message);
  };
  const sorted = [...steps].sort((a, b) => a.step - b.step);

  if (sorted.length === 0 || sorted[0]!.step !== 0) {
    return { ok: false, error: "The first email is missing. Reload the page and try again.", fieldErrors };
  }
  if (sorted.length > MAX_FOLLOW_UPS + 1) {
    return { ok: false, error: `A sequence can have up to ${MAX_FOLLOW_UPS} follow-ups.`, fieldErrors };
  }
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i]!.step !== i) {
      return {
        ok: false,
        error: "The follow-ups are out of order. Reload the page and try again.",
        fieldErrors,
      };
    }
  }

  const cleaned: SequenceStep[] = sorted.map((s) => {
    const body = normalizeNewlines(s.body).replace(/[ \t]+$/gm, "").replace(/\s+$/, "");
    const subject = s.step === 0 ? normalizeNewlines(s.subject ?? "").replace(/\s+/g, " ").trim() : null;
    const delayDays = s.step === 0 ? 0 : Number(s.delayDays);
    return { step: s.step, enabled: s.step === 0 ? true : Boolean(s.enabled), subject, body, delayDays };
  });

  for (const s of cleaned) {
    const label = stepLabel(s.step);
    if (s.step === 0) {
      if (!s.subject) add("step0.subject", "Write a subject for the first email.");
      else if (s.subject.length > MAX_SUBJECT_CHARS) add("step0.subject", `Keep the subject under ${MAX_SUBJECT_CHARS} characters.`);
    }
    if (!s.body.trim()) add(`step${s.step}.body`, s.step === 0 ? "Write the first email." : `Write ${label.toLowerCase()}, or remove it.`);
    else if (s.body.length > MAX_BODY_CHARS) {
      add(`step${s.step}.body`, `Keep ${label.toLowerCase()} under ${MAX_BODY_CHARS.toLocaleString("en-US")} characters.`);
    }
    if (s.step > 0 && (!Number.isInteger(s.delayDays) || s.delayDays < MIN_DELAY_DAYS || s.delayDays > MAX_DELAY_DAYS)) {
      add(`step${s.step}.delayDays`, `Pick a whole number of days from ${MIN_DELAY_DAYS} to ${MAX_DELAY_DAYS}.`);
    }
  }

  const keys = Object.keys(fieldErrors);
  if (keys.length > 0) {
    const first = keys[0]!;
    const step = Number(first.match(/^step(\d)/)?.[1] ?? 0);
    const where = keys.every((k) => k.startsWith(`step${step}.`)) ? ` in ${stepLabel(step).toLowerCase()}` : "";
    return { ok: false, error: `Some details need fixing${where}. Check the highlighted fields.`, fieldErrors };
  }
  return { ok: true, steps: cleaned };
}
