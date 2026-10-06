"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Field, FormError } from "@/components/forms/field";
import { OFFLINE_TEXT } from "@/components/ai/phone-dialog";
import { saveAiModelAction } from "@/app/(app)/settings/ai/actions";
import type { AiModelChoice, AiSettingsView } from "@/server/services/ai/settings";
import { AI_SETTINGS_PAGE, parseAmount } from "./texts";

type FieldErrors = Record<string, string[] | undefined>;

/**
 * Settings › AI › Model (docs/dev/M5-DESIGN.md §6.9): Claude Haiku 4.5 (recommended), Claude Sonnet 5, or another Claude
 * model with its ID and prices. The radios say what 300 companies cost with this app's own estimate. "Save model"
 * (outline) checks another model with Anthropic first; the built-in ones are saved at once.
 */
export function AiModelForm({
  choice: initialChoice,
  radios,
  custom,
}: {
  choice: AiModelChoice;
  radios: AiSettingsView["radios"];
  custom: AiSettingsView["custom"];
}) {
  const router = useRouter();
  const [choice, setChoice] = useState<AiModelChoice>(initialChoice);
  const [id, setId] = useState(custom?.id ?? "");
  const [inputPrice, setInputPrice] = useState(custom?.inputPerMTok != null ? String(custom.inputPerMTok) : "");
  const [outputPrice, setOutputPrice] = useState(custom?.outputPerMTok != null ? String(custom.outputPerMTok) : "");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [checking, setChecking] = useState(false);

  function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({});
    setFormError(null);
    setDetail(null);
    setChecking(choice === "custom");
    startTransition(async () => {
      try {
        const res = await saveAiModelAction(
          choice === "custom"
            ? { choice, id, inputPerMTok: parseAmount(inputPrice), outputPerMTok: parseAmount(outputPrice) }
            : { choice },
        );
        if (!res.ok) {
          const fe = res.fieldErrors ?? {};
          setErrors(fe);
          setDetail(fe.detail?.[0] ?? null);
          // A message on a field is shown there only; anything else (no key yet, Anthropic unreachable) above the form.
          const onField = Boolean(fe.id || fe.inputPerMTok || fe.outputPerMTok);
          setFormError(onField ? null : res.error);
          return;
        }
        toast.success(res.message ?? "Model saved.");
        router.refresh();
      } catch {
        setFormError(OFFLINE_TEXT);
      } finally {
        setChecking(false);
      }
    });
  }

  const options: Array<{ value: AiModelChoice; label: string }> = [
    { value: "haiku", label: radios.haiku },
    { value: "sonnet", label: radios.sonnet },
    { value: "custom", label: AI_SETTINGS_PAGE.customLabel },
  ];

  return (
    <form onSubmit={save} className="grid gap-4" noValidate>
      <FormError message={formError} />
      <fieldset className="grid gap-2">
        <legend className="sr-only">Model</legend>
        <RadioGroup value={choice} onValueChange={(v) => setChoice(v === "sonnet" || v === "custom" ? v : "haiku")} className="grid gap-3">
          {options.map((o) => (
            <div key={o.value} className="flex items-start gap-2">
              <RadioGroupItem id={`ai-model-${o.value}`} value={o.value} className="mt-0.5" />
              <Label htmlFor={`ai-model-${o.value}`} className="font-normal leading-snug">
                {o.label}
              </Label>
            </div>
          ))}
        </RadioGroup>
      </fieldset>

      {choice === "custom" ? (
        <div className="grid gap-4 rounded-md border border-border p-3 sm:grid-cols-3">
          <Field label="Model ID" htmlFor="ai-custom-id" error={errors.id} className="sm:col-span-3">
            <Input
              id="ai-custom-id"
              value={id}
              onChange={(e) => setId(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="claude-…"
              maxLength={100}
              aria-invalid={errors.id ? true : undefined}
            />
          </Field>
          <Field label="Input price ($ per million tokens)" htmlFor="ai-custom-input" error={errors.inputPerMTok}>
            <Input
              id="ai-custom-input"
              inputMode="decimal"
              value={inputPrice}
              onChange={(e) => setInputPrice(e.target.value)}
              aria-invalid={errors.inputPerMTok ? true : undefined}
            />
          </Field>
          <Field label="Output price ($ per million tokens)" htmlFor="ai-custom-output" error={errors.outputPerMTok}>
            <Input
              id="ai-custom-output"
              inputMode="decimal"
              value={outputPrice}
              onChange={(e) => setOutputPrice(e.target.value)}
              aria-invalid={errors.outputPerMTok ? true : undefined}
            />
          </Field>
        </div>
      ) : null}

      {detail ? (
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer">Details</summary>
          <p className="mt-1 font-mono text-xs break-words">{detail}</p>
        </details>
      ) : null}
      {checking ? (
        <p className="text-sm text-muted-foreground" role="status">
          {AI_SETTINGS_PAGE.modelChecking}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">{AI_SETTINGS_PAGE.modelHint}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="outline" disabled={pending}>
          Save model
        </Button>
      </div>
    </form>
  );
}
