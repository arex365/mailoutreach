/**
 * The six wizard steps (PLAN.md B6.4, SPEC §7). Pure and browser-safe: used by the pages, the
 * stepper and the server actions. The wizard lives at /campaigns/<id>/setup/<step>;
 * Campaign.wizardStep stores the furthest step reached (1 = Audience … 6 = Schedule).
 */

export const WIZARD_STEPS = [
  { key: "audience", n: 1, label: "Audience" },
  { key: "sender", n: 2, label: "Sender" },
  { key: "message", n: 3, label: "Message" },
  { key: "verify", n: 4, label: "Verify" },
  { key: "review", n: 5, label: "Review" },
  { key: "schedule", n: 6, label: "Schedule" },
] as const;

export type WizardStepKey = (typeof WIZARD_STEPS)[number]["key"];

export const WIZARD_STEP_COUNT = WIZARD_STEPS.length;

export function isWizardStepKey(value: unknown): value is WizardStepKey {
  return typeof value === "string" && WIZARD_STEPS.some((s) => s.key === value);
}

/** 1 … 6. */
export function stepNumber(key: WizardStepKey): number {
  return WIZARD_STEPS.find((s) => s.key === key)?.n ?? 1;
}

/** The step for a stored Campaign.wizardStep (out-of-range values are clamped). */
export function stepKeyFor(n: number | null | undefined): WizardStepKey {
  const i = Math.min(Math.max(Math.floor(Number(n) || 1), 1), WIZARD_STEP_COUNT) - 1;
  return WIZARD_STEPS[i]!.key;
}

export function stepLabelFor(key: WizardStepKey): string {
  return WIZARD_STEPS.find((s) => s.key === key)?.label ?? "Audience";
}

export function nextStepKey(key: WizardStepKey): WizardStepKey | null {
  const n = stepNumber(key);
  return n >= WIZARD_STEP_COUNT ? null : WIZARD_STEPS[n]!.key;
}

export function previousStepKey(key: WizardStepKey): WizardStepKey | null {
  const n = stepNumber(key);
  return n <= 1 ? null : WIZARD_STEPS[n - 2]!.key;
}

/** Steps up to the furthest one reached can be opened from the stepper (you can always go back). */
export function canOpenStep(target: WizardStepKey, furthest: number): boolean {
  return stepNumber(target) <= Math.max(1, Math.min(WIZARD_STEP_COUNT, Math.floor(furthest) || 1));
}

/** "/campaigns/12/setup/review?filter=missing". */
export function wizardHref(campaignId: number, key: WizardStepKey, params?: Record<string, string | number | null | undefined>): string {
  const base = `/campaigns/${campaignId}/setup/${key}`;
  if (!params) return base;
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "") continue;
    search.set(k, String(v));
  }
  const qs = search.toString();
  return qs ? `${base}?${qs}` : base;
}
