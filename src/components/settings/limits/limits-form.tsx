"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, FormError } from "@/components/forms/field";
import { windowSentence } from "@/core/sending/window";
import { saveLimitsAction } from "@/app/(app)/settings/limits/actions";
import { WEEKDAY_CHOICES, quarterHours, validateLimits, type LimitsFieldErrors, type LimitsValues } from "./limits-format";

const OFFLINE = "Couldn't reach the app, so nothing was saved. Check your connection and try again.";
const TIMES = quarterHours();

type Draft = Omit<LimitsValues, "maxDailyCap" | "minGapSeconds" | "warmupStartCap" | "warmupSteps" | "warmupMinUsePercent"> & {
  maxDailyCap: string;
  minGapSeconds: string;
  warmupStartCap: string;
  warmupSteps: string;
  warmupMinUsePercent: string;
};

function toDraft(v: LimitsValues): Draft {
  return {
    ...v,
    window: { ...v.window, days: [...v.window.days] },
    maxDailyCap: String(v.maxDailyCap),
    minGapSeconds: String(v.minGapSeconds),
    warmupStartCap: String(v.warmupStartCap),
    warmupSteps: String(v.warmupSteps),
    warmupMinUsePercent: String(v.warmupMinUsePercent),
  };
}

function ZoneSelect({
  id,
  value,
  zones,
  onChange,
  invalid,
  describedBy,
}: {
  id: string;
  value: string;
  zones: string[];
  onChange: (v: string) => void;
  invalid: boolean;
  describedBy: string;
}) {
  const options = zones.includes(value) ? zones : [value, ...zones];
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full sm:w-80" aria-invalid={invalid ? true : undefined} aria-describedby={describedBy}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((z) => (
          <SelectItem key={z} value={z}>
            {z}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * "Save limits" (the page's primary action, M3-DESIGN §5.4): the sending days and hours (15-minute
 * steps), the default time zone for companies without one, and the advanced settings (maximum daily
 * limit, smallest gap, the sending day's time zone, the warm-up start, steps and use rule).
 */
export function LimitsForm({ initial, zones }: { initial: LimitsValues; zones: string[] }) {
  const id = useId();
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [errors, setErrors] = useState<LimitsFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function toggleDay(day: number, on: boolean) {
    setDraft((d) => {
      const days = new Set(d.window.days);
      if (on) days.add(day);
      else days.delete(day);
      return { ...d, window: { ...d.window, days: [...days].sort((a, b) => a - b) } };
    });
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const checked = validateLimits(draft);
    if (!checked.ok) {
      setErrors(checked.errors);
      setFormError("Some limits need fixing. Check the highlighted fields.");
      return;
    }
    setErrors({});
    setFormError(null);
    startTransition(async () => {
      try {
        const res = await saveLimitsAction(checked.value);
        if (!res.ok) {
          const fe = res.fieldErrors ?? {};
          setErrors(Object.fromEntries(Object.entries(fe).map(([k, v]) => [k, v?.[0]])) as LimitsFieldErrors);
          setFormError(res.error);
          return;
        }
        toast.success(res.message ?? "Limits saved.");
        router.refresh();
      } catch {
        setFormError(OFFLINE);
      }
    });
  }

  const sentenceWindow = { ...draft.window, days: draft.window.days.length ? draft.window.days : [] };
  const describe = (key: keyof LimitsFieldErrors) => (errors[key] ? `${id}-${key}-error` : `${id}-${key}-hint`);

  return (
    <form onSubmit={onSubmit} className="grid gap-6" noValidate>
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium">Sending days</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {WEEKDAY_CHOICES.map((d) => (
            <label key={d.day} className="flex items-center gap-2 text-sm" title={d.long}>
              <Checkbox checked={draft.window.days.includes(d.day)} onCheckedChange={(on) => toggleDay(d.day, on === true)} aria-label={d.long} />
              {d.short}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-start`}>From</Label>
            <Select value={draft.window.start} onValueChange={(v) => set("window", { ...draft.window, start: v })}>
              <SelectTrigger id={`${id}-start`} className="w-28" aria-invalid={errors.window ? true : undefined}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-end`}>To</Label>
            <Select value={draft.window.end} onValueChange={(v) => set("window", { ...draft.window, end: v })}>
              <SelectTrigger id={`${id}-end`} className="w-28" aria-invalid={errors.window ? true : undefined}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {errors.window ? (
          <p role="alert" className="text-sm text-destructive">
            {errors.window}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {sentenceWindow.days.length
              ? `Emails go out ${windowSentence(sentenceWindow)} in each recipient's time zone, spaced out with random gaps.`
              : "Pick at least one sending day."}
          </p>
        )}
      </fieldset>

      <Field
        label="Time zone for companies without one"
        htmlFor={`${id}-defaultTimeZone`}
        hint="Used for the sending hours of companies whose time zone isn't known."
        error={errors.defaultTimeZone}
      >
        <ZoneSelect
          id={`${id}-defaultTimeZone`}
          value={draft.defaultTimeZone}
          zones={zones}
          onChange={(v) => set("defaultTimeZone", v)}
          invalid={Boolean(errors.defaultTimeZone)}
          describedBy={describe("defaultTimeZone")}
        />
      </Field>

      <details className="group grid gap-4 rounded-lg border border-border p-4">
        <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
        <div className="mt-4 grid gap-4">
          <Field
            label="Maximum daily limit (warm-up target)"
            htmlFor={`${id}-maxDailyCap`}
            hint="Where the warm-up ends. From 50 to 10,000."
            error={errors.maxDailyCap}
          >
            <Input
              id={`${id}-maxDailyCap`}
              inputMode="numeric"
              className="w-32"
              value={draft.maxDailyCap}
              onChange={(e) => set("maxDailyCap", e.target.value)}
              aria-invalid={errors.maxDailyCap ? true : undefined}
              aria-describedby={describe("maxDailyCap")}
            />
          </Field>
          <Field
            label="Smallest gap between emails (seconds)"
            htmlFor={`${id}-minGapSeconds`}
            hint="Emails are never closer together than this. From 20 to 3,600."
            error={errors.minGapSeconds}
          >
            <Input
              id={`${id}-minGapSeconds`}
              inputMode="numeric"
              className="w-32"
              value={draft.minGapSeconds}
              onChange={(e) => set("minGapSeconds", e.target.value)}
              aria-invalid={errors.minGapSeconds ? true : undefined}
              aria-describedby={describe("minGapSeconds")}
            />
          </Field>
          <Field
            label="Time zone of the sending day"
            htmlFor={`${id}-capDayTimeZone`}
            hint="The daily limit resets at midnight in this zone."
            error={errors.capDayTimeZone}
          >
            <ZoneSelect
              id={`${id}-capDayTimeZone`}
              value={draft.capDayTimeZone}
              zones={zones}
              onChange={(v) => set("capDayTimeZone", v)}
              invalid={Boolean(errors.capDayTimeZone)}
              describedBy={describe("capDayTimeZone")}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Warm-up starts at" htmlFor={`${id}-warmupStartCap`} hint="10 to 500 a day." error={errors.warmupStartCap}>
              <Input
                id={`${id}-warmupStartCap`}
                inputMode="numeric"
                value={draft.warmupStartCap}
                onChange={(e) => set("warmupStartCap", e.target.value)}
                aria-invalid={errors.warmupStartCap ? true : undefined}
                aria-describedby={describe("warmupStartCap")}
              />
            </Field>
            <Field label="Warm-up steps" htmlFor={`${id}-warmupSteps`} hint="5 to 60 steps." error={errors.warmupSteps}>
              <Input
                id={`${id}-warmupSteps`}
                inputMode="numeric"
                value={draft.warmupSteps}
                onChange={(e) => set("warmupSteps", e.target.value)}
                aria-invalid={errors.warmupSteps ? true : undefined}
                aria-describedby={describe("warmupSteps")}
              />
            </Field>
            <Field
              label="Rises after using (%)"
              htmlFor={`${id}-warmupMinUsePercent`}
              hint="Of the day's limit, 10 to 100."
              error={errors.warmupMinUsePercent}
            >
              <Input
                id={`${id}-warmupMinUsePercent`}
                inputMode="numeric"
                value={draft.warmupMinUsePercent}
                onChange={(e) => set("warmupMinUsePercent", e.target.value)}
                aria-invalid={errors.warmupMinUsePercent ? true : undefined}
                aria-describedby={describe("warmupMinUsePercent")}
              />
            </Field>
          </div>
        </div>
      </details>

      <FormError message={formError} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save limits"}
        </Button>
      </div>
    </form>
  );
}
