"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FormError } from "@/components/forms/field";
import { MAILGUN_LIMITS } from "@/core/sending/health";
import { saveHealthThresholdsAction } from "@/app/(app)/settings/deliverability/actions";

export type ThresholdFormValues = {
  bounceWindow: number;
  bouncePercent: number;
  complaintWindow: number;
  complaintPercent: number;
  healthyBouncePercent: number;
  healthyComplaintPercent: number;
};

type Key = keyof ThresholdFormValues;

const FIELDS: ReadonlyArray<{ key: Key; label: string; hint: string; step: string }> = [
  { key: "bounceWindow", label: "Bounces are counted among the last … emails", hint: "From 50 to 5,000. Default 200.", step: "1" },
  { key: "bouncePercent", label: "Pause when bounces pass (%)", hint: "From 0.5 to 10. Default 3.", step: "0.1" },
  { key: "complaintWindow", label: "Spam complaints are counted among the last … emails", hint: "From 200 to 20,000. Default 1,000.", step: "1" },
  { key: "complaintPercent", label: "Pause when spam complaints pass (%)", hint: "From 0.01 to 1. Default 0.1.", step: "0.01" },
  {
    key: "healthyBouncePercent",
    label: "Warm-up: the daily limit rises while bounces stay below (%)",
    hint: "From 0.1 to 10. Default 2.",
    step: "0.1",
  },
  {
    key: "healthyComplaintPercent",
    label: "Warm-up: the daily limit rises while spam complaints stay below (%)",
    hint: "From 0.01 to 1. Default 0.05.",
    step: "0.01",
  },
];

const OFFLINE = "Couldn't reach the app. Check your connection and try again.";

function above(value: string, limit: number): boolean {
  const n = Number(value);
  return Number.isFinite(n) && n > limit;
}

/**
 * Settings › Deliverability › Thresholds (Owner, §5.5). Amber hints appear while a limit is above Mailgun's own
 * (the Owner may still save it). "Save thresholds" is the page's primary action, except while address checks are
 * paused: then "Resume checks" is (M5-DESIGN §6.6), and `primary` is false so the page keeps one orange button.
 */
export function ThresholdsForm({ initial, primary = true }: { initial: ThresholdFormValues; primary?: boolean }) {
  const router = useRouter();
  const [values, setValues] = useState<Record<Key, string>>(
    Object.fromEntries(FIELDS.map((f) => [f.key, String(initial[f.key])])) as Record<Key, string>,
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[] | undefined>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      try {
        const res = await saveHealthThresholdsAction(values);
        if (!res.ok) {
          setError(res.error);
          setFieldErrors(res.fieldErrors ?? {});
          return;
        }
        toast.success(res.data.changed ? (res.message ?? "Thresholds saved.") : "Nothing changed.");
        router.refresh();
      } catch {
        setError(OFFLINE);
      }
    });
  }

  const warnings: Partial<Record<Key, string>> = {};
  if (above(values.bouncePercent, MAILGUN_LIMITS.bouncePercent)) {
    warnings.bouncePercent = `Above Mailgun's own limit of ${MAILGUN_LIMITS.bouncePercent}%: Mailgun may suspend your account before the app pauses.`;
  }
  if (above(values.complaintPercent, MAILGUN_LIMITS.complaintPercent)) {
    warnings.complaintPercent = `Above Mailgun's own limit of ${MAILGUN_LIMITS.complaintPercent}%: Mailgun may suspend your account before the app pauses.`;
  }

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <div className="grid gap-4 md:grid-cols-2">
        {FIELDS.map((f) => {
          const id = `threshold-${f.key}`;
          const err = fieldErrors[f.key];
          return (
            <Field key={f.key} label={f.label} htmlFor={id} hint={f.hint} error={err}>
              <Input
                id={id}
                name={f.key}
                type="number"
                inputMode="decimal"
                step={f.step}
                value={values[f.key]}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                aria-invalid={err ? true : undefined}
                aria-describedby={err ? `${id}-error` : `${id}-hint`}
                className="max-w-40"
              />
              {warnings[f.key] ? (
                <p className="text-sm text-warning" role="status">
                  {warnings[f.key]}
                </p>
              ) : null}
            </Field>
          );
        })}
      </div>
      <FormError message={error} />
      <div>
        <Button type="submit" variant={primary ? "default" : "outline"} disabled={pending}>
          {pending ? "Saving…" : "Save thresholds"}
        </Button>
      </div>
    </form>
  );
}
