"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FormError } from "@/components/forms/field";
import { useKeepValuesSubmit } from "@/components/forms/use-keep-values-submit";
import { acceptInviteAction } from "./actions";
import { resetPasswordAction } from "../reset/actions";

/** Choose a password from an invite or reset link. */
export function AcceptLinkForm({ token, email, mode }: { token: string; email: string; mode: "invite" | "reset" }) {
  const [state, formAction, pending] = useActionState(mode === "invite" ? acceptInviteAction : resetPasswordAction, null);
  const onSubmit = useKeepValuesSubmit(formAction);
  const fe = state && !state.ok ? state.fieldErrors : undefined;
  const error = state && !state.ok ? state.error : null;
  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <input type="hidden" name="token" value={token} />
      {/* Lets password managers save the new password under the right account. */}
      <input type="email" name="username" value={email} autoComplete="username" readOnly hidden />
      <FormError message={error} />
      <Field
        label={mode === "invite" ? "Choose a password" : "New password"}
        htmlFor="password"
        hint="At least 10 characters. A short sentence you'll remember works well."
        error={fe?.password}
      >
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          autoFocus
          aria-invalid={fe?.password ? true : undefined}
          aria-describedby={fe?.password ? "password-error" : "password-hint"}
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
          aria-describedby={fe?.confirm ? "confirm-error" : undefined}
        />
      </Field>
      <Button type="submit" size="lg" disabled={pending}>
        {pending
          ? mode === "invite"
            ? "Setting up your account…"
            : "Saving your new password…"
          : mode === "invite"
            ? "Set password and sign in"
            : "Save password and sign in"}
      </Button>
    </form>
  );
}
