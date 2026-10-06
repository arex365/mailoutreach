"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FormError } from "@/components/forms/field";
import { removeVerificationKeyAction, saveVerificationKeyAction } from "@/app/(app)/settings/deliverability/check-actions";
import type { CheckKeyView } from "./check-settings";

const OFFLINE = "Couldn't reach the app, so nothing changed. Check your connection and try again.";

/**
 * Settings › Deliverability › "Address check key" (M5-DESIGN §6.6): address checks use the Mailgun key unless a
 * separate one is saved here. Saved without a test call (a test costs money: "Test address checks" is for that);
 * saving it lifts a pause for a refused key. "Use the Mailgun key instead" removes it.
 */
export function CheckKeyCard({ view }: { view: CheckKeyView }) {
  const router = useRouter();
  const uid = useId();
  const [key, setKey] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setFieldError(null);
    startTransition(async () => {
      try {
        const res = await saveVerificationKeyAction({ key });
        if (!res.ok) {
          const onField = res.fieldErrors?.key?.[0] ?? null;
          setFieldError(onField);
          setError(onField ? null : res.error);
          return;
        }
        setKey("");
        toast.success(res.message ?? "Key saved. It's used for the next check.");
        router.refresh();
      } catch {
        setError(OFFLINE);
      }
    });
  }

  function remove() {
    setError(null);
    setFieldError(null);
    startTransition(async () => {
      try {
        const res = await removeVerificationKeyAction();
        if (!res.ok) {
          setError(res.error);
          return;
        }
        toast.success(res.message ?? "Address checks use the Mailgun key again.");
        router.refresh();
      } catch {
        setError(OFFLINE);
      }
    });
  }

  const inputId = `${uid}-key`;
  return (
    <form onSubmit={save} className="grid gap-4" noValidate>
      <p className="text-sm font-medium" role="status">
        {view.statusLine}
      </p>
      <Field label="Separate key (optional)" htmlFor={inputId} error={fieldError ?? undefined}>
        <Input
          id={inputId}
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder="Leave empty to use the Mailgun key"
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? `${inputId}-error` : undefined}
          className="sm:w-96"
          disabled={view.practiceCopy}
        />
      </Field>
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="outline" disabled={pending || view.practiceCopy}>
          {pending ? "Saving…" : "Save key"}
        </Button>
        {view.hasOwnKey ? (
          <Button type="button" variant="ghost" onClick={remove} disabled={pending}>
            Use the Mailgun key instead
          </Button>
        ) : null}
      </div>
      {view.practiceCopy ? <p className="text-sm text-muted-foreground">The practice copy never talks to Mailgun.</p> : null}
    </form>
  );
}
