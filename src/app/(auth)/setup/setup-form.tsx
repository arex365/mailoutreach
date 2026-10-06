"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FormError } from "@/components/forms/field";
import { useKeepValuesSubmit } from "@/components/forms/use-keep-values-submit";
import { setupAction } from "../actions";

export function SetupForm() {
  const [state, formAction, pending] = useActionState(setupAction, null);
  const onSubmit = useKeepValuesSubmit(formAction);
  const fe = state && !state.ok ? state.fieldErrors : undefined;
  const error = state && !state.ok ? state.error : null;
  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <FormError message={error} />
      <Field label="Setup code" htmlFor="code" hint="It's in the setup.bat window, for example ABCDE-FGHJK-…" error={fe?.code}>
        <Input
          id="code"
          name="code"
          autoComplete="off"
          spellCheck={false}
          required
          autoFocus
          className="font-mono uppercase"
          aria-invalid={fe?.code ? true : undefined}
        />
      </Field>
      <Field label="Your name" htmlFor="name" error={fe?.name}>
        <Input id="name" name="name" autoComplete="name" required aria-invalid={fe?.name ? true : undefined} />
      </Field>
      <Field label="Your email" htmlFor="email" hint="You'll use it to sign in." error={fe?.email}>
        <Input id="email" name="email" type="email" autoComplete="email" required aria-invalid={fe?.email ? true : undefined} />
      </Field>
      <Field label="Password" htmlFor="password" hint="At least 10 characters." error={fe?.password}>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          aria-invalid={fe?.password ? true : undefined}
        />
      </Field>
      <Field label="Password again" htmlFor="confirm" error={fe?.confirm}>
        <Input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          aria-invalid={fe?.confirm ? true : undefined}
        />
      </Field>
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Creating your account…" : "Create Owner account"}
      </Button>
    </form>
  );
}
