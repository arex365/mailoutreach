"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormError } from "@/components/forms/field";
import { CHECK_CONCURRENCY_MAX } from "@/core/verification/types";
import { saveCheckSettingsAction } from "@/app/(app)/settings/deliverability/check-actions";
import {
  POLICY_ROWS,
  SEND_OR_SKIP_LABELS,
  UNKNOWN_LABELS,
  type CheckSettingsValues,
  type CheckSettingsView,
  type SendOrSkip,
} from "./check-settings";

const OFFLINE = "Couldn't reach the app, so nothing was saved. Check your connection and try again.";

/** The read-only provider line of "Address checks" (M6-DESIGN §5.2 "Deliverability"). */
export const ADDRESS_CHECKS_PROVIDER_TEXT = "Address checks by Mailgun.";

type Numbers = Record<"pricePerCheck" | "includedPerMonth" | "maxAgeDays" | "monthlyLimitUsd" | "concurrency", string>;
type Policy = Pick<CheckSettingsValues, "deliverableHighRisk" | "catchAllLow" | "catchAllMedium" | "catchAllHigh" | "disposable" | "unknown">;
type FieldErrors = Record<string, string[] | undefined>;

/** One row of the card: the label (and a hint) on the left, the control or fixed text on the right. */
function Row({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string[];
  children: React.ReactNode;
}) {
  const message = error?.[0];
  return (
    <div className="grid gap-1.5 border-b border-border py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] sm:items-start sm:gap-4">
      <div className="grid gap-0.5">
        {htmlFor ? (
          <Label htmlFor={htmlFor} className="leading-snug">
            {label}
          </Label>
        ) : (
          <span className="text-sm font-medium leading-snug">{label}</span>
        )}
        {hint && !message ? (
          <p id={htmlFor ? `${htmlFor}-hint` : undefined} className="text-sm text-muted-foreground">
            {hint}
          </p>
        ) : null}
        {message ? (
          <p id={htmlFor ? `${htmlFor}-error` : undefined} role="alert" className="text-sm text-destructive">
            {message}
          </p>
        ) : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * Settings › Deliverability › "Address checks" (M5-DESIGN §6.6): which results are emailed (Send / Skip per result,
 * "No answer" checked again after 24 hours or skipped), the price per check and the plan's included checks (for
 * estimates), how long results count, the monthly limit, the checks at the same time, this month's use, and
 * "Save check settings" (outline: the Thresholds card has the page's primary action).
 */
export function CheckSettingsForm({ view }: { view: CheckSettingsView }) {
  const router = useRouter();
  const uid = useId();
  const [policy, setPolicy] = useState<Policy>({
    deliverableHighRisk: view.values.deliverableHighRisk,
    catchAllLow: view.values.catchAllLow,
    catchAllMedium: view.values.catchAllMedium,
    catchAllHigh: view.values.catchAllHigh,
    disposable: view.values.disposable,
    unknown: view.values.unknown,
  });
  const [numbers, setNumbers] = useState<Numbers>({
    pricePerCheck: String(view.values.pricePerCheck),
    includedPerMonth: String(view.values.includedPerMonth),
    maxAgeDays: String(view.values.maxAgeDays),
    monthlyLimitUsd: String(view.values.monthlyLimitUsd),
    concurrency: String(view.values.concurrency),
  });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      try {
        const res = await saveCheckSettingsAction({ ...policy, ...numbers, provider: "mailgun" });
        if (!res.ok) {
          setFieldErrors(res.fieldErrors ?? {});
          setError(res.fieldErrors ? null : res.error);
          return;
        }
        toast.success(res.message ?? "Check settings saved.");
        router.refresh();
      } catch {
        setError(OFFLINE);
      }
    });
  }

  const idOf = (key: string) => `${uid}-${key}`;
  const describedBy = (key: string, hint = false) =>
    fieldErrors[key] ? `${idOf(key)}-error` : hint ? `${idOf(key)}-hint` : undefined;

  function numberInput(key: keyof Numbers, opts: { prefix?: string; suffix?: string; step: string; inputMode: "decimal" | "numeric"; hint?: boolean }) {
    const input = (
      <InputGroupInput
        id={idOf(key)}
        name={key}
        type="number"
        inputMode={opts.inputMode}
        step={opts.step}
        value={numbers[key]}
        onChange={(e) => setNumbers((n) => ({ ...n, [key]: e.target.value }))}
        aria-invalid={fieldErrors[key] ? true : undefined}
        aria-describedby={describedBy(key, opts.hint)}
      />
    );
    return (
      <InputGroup className="w-full sm:w-56">
        {opts.prefix ? (
          <InputGroupAddon align="inline-start">
            <InputGroupText>{opts.prefix}</InputGroupText>
          </InputGroupAddon>
        ) : null}
        {input}
        {opts.suffix ? (
          <InputGroupAddon align="inline-end">
            <InputGroupText>{opts.suffix}</InputGroupText>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
    );
  }

  function choice<K extends keyof Policy>(key: K, labels: Readonly<Record<string, string>>, label: string) {
    return (
      <Select value={policy[key]} onValueChange={(v) => setPolicy((p) => ({ ...p, [key]: v as Policy[K] }))}>
        <SelectTrigger
          id={idOf(key)}
          className="w-full sm:w-56"
          aria-label={label}
          aria-invalid={fieldErrors[key] ? true : undefined}
          aria-describedby={describedBy(key)}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          {Object.entries(labels).map(([value, text]) => (
            <SelectItem key={value} value={value}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-2" noValidate>
      {/* Setting "verification.provider" (read-only until another provider exists, M6-DESIGN §5.2). */}
      <p className="text-sm">{ADDRESS_CHECKS_PROVIDER_TEXT}</p>
      <div>
        <Row label="Deliverable, low or medium risk">
          <p className="text-sm">Always emailed</p>
        </Row>
        {POLICY_ROWS.map((row) => (
          <Row key={row.key} label={row.label} htmlFor={idOf(row.key)} hint={row.hint} error={fieldErrors[row.key]}>
            {choice(row.key, SEND_OR_SKIP_LABELS as Record<SendOrSkip, string>, row.label)}
          </Row>
        ))}
        <Row label="No answer (“unknown”)" htmlFor={idOf("unknown")} error={fieldErrors.unknown}>
          {choice("unknown", UNKNOWN_LABELS, "No answer")}
        </Row>
        <Row label="Doesn't exist, or “don't email”">
          <p className="text-sm">Never emailed, and put on the do-not-email list</p>
        </Row>
        <Row
          label="Price per check"
          htmlFor={idOf("pricePerCheck")}
          hint="Used for cost estimates. Mailgun's Foundation plan charges about $0.012 per check; Scale includes 5,000 a month."
          error={fieldErrors.pricePerCheck}
        >
          {numberInput("pricePerCheck", { prefix: "$", step: "0.001", inputMode: "decimal", hint: true })}
        </Row>
        <Row
          label="Checks included in your plan each month"
          htmlFor={idOf("includedPerMonth")}
          hint="0 on Foundation, 5,000 on Scale."
          error={fieldErrors.includedPerMonth}
        >
          {numberInput("includedPerMonth", { step: "1", inputMode: "numeric", hint: true })}
        </Row>
        <Row label="Results count for" htmlFor={idOf("maxAgeDays")} error={fieldErrors.maxAgeDays}>
          {numberInput("maxAgeDays", { suffix: "days", step: "1", inputMode: "numeric" })}
        </Row>
        <Row
          label="Monthly limit for checks"
          htmlFor={idOf("monthlyLimitUsd")}
          hint="Checks stop when this month's checks have cost this much, and start again on the 1st. Mailgun itself never stops extra checks."
          error={fieldErrors.monthlyLimitUsd}
        >
          {numberInput("monthlyLimitUsd", { prefix: "$", suffix: "per month", step: "1", inputMode: "decimal", hint: true })}
        </Row>
      </div>

      <details className="rounded-md border border-border px-3 py-2" open={fieldErrors.concurrency ? true : undefined}>
        <summary className="cursor-pointer text-sm font-medium">More settings</summary>
        <div className="mt-3 grid gap-1.5">
          <Label htmlFor={idOf("concurrency")}>Checks at the same time</Label>
          <Input
            id={idOf("concurrency")}
            name="concurrency"
            type="number"
            inputMode="numeric"
            min={1}
            max={CHECK_CONCURRENCY_MAX}
            step={1}
            value={numbers.concurrency}
            onChange={(e) => setNumbers((n) => ({ ...n, concurrency: e.target.value }))}
            aria-invalid={fieldErrors.concurrency ? true : undefined}
            aria-describedby={fieldErrors.concurrency ? `${idOf("concurrency")}-error` : `${idOf("concurrency")}-hint`}
            className="w-24"
          />
          {fieldErrors.concurrency?.[0] ? (
            <p id={`${idOf("concurrency")}-error`} role="alert" className="text-sm text-destructive">
              {fieldErrors.concurrency[0]}
            </p>
          ) : (
            <p id={`${idOf("concurrency")}-hint`} className="text-sm text-muted-foreground">
              From 1 to {CHECK_CONCURRENCY_MAX}. The checks slow down by themselves when Mailgun asks them to.
            </p>
          )}
        </div>
      </details>

      <p className="text-sm">{view.thisMonth}</p>
      <p className="text-sm text-muted-foreground">
        Changes apply from now on, also to emails of running campaigns that haven&apos;t gone out yet. People already left out of a campaign
        stay left out.
      </p>
      <FormError message={error} />
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Saving…" : "Save check settings"}
        </Button>
      </div>
    </form>
  );
}
