"use client";

import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FormError } from "@/components/forms/field";
import { changePasswordAction } from "@/app/(app)/settings/profile/actions";

type FieldErrors = Record<string, string[] | undefined>;

/** Change your own password; your other devices are signed out, this one stays signed in. */
export function ChangePasswordForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const input = {
      current: String(fd.get("current") ?? ""),
      password: String(fd.get("password") ?? ""),
      confirm: String(fd.get("confirm") ?? ""),
    };
    startTransition(async () => {
      const res = await changePasswordAction(input);
      if (res.ok) {
        setFieldErrors({});
        setFormError(null);
        formRef.current?.reset();
        toast.success(res.message ?? "Password changed. You've been signed out on other devices.");
      } else {
        setFieldErrors(res.fieldErrors ?? {});
        setFormError(res.error);
      }
    });
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="grid gap-4" noValidate>
      <FormError message={formError} />
      <Field label="Current password" htmlFor="current" error={fieldErrors.current}>
        <Input
          id="current"
          name="current"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={fieldErrors.current ? true : undefined}
          aria-describedby={fieldErrors.current ? "current-error" : undefined}
        />
      </Field>
      <Field label="New password" htmlFor="password" hint="At least 10 characters." error={fieldErrors.password}>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          aria-invalid={fieldErrors.password ? true : undefined}
          aria-describedby={fieldErrors.password ? "password-error" : "password-hint"}
        />
      </Field>
      <Field label="New password again" htmlFor="confirm" error={fieldErrors.confirm}>
        <Input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          aria-invalid={fieldErrors.confirm ? true : undefined}
          aria-describedby={fieldErrors.confirm ? "confirm-error" : undefined}
        />
      </Field>
      <div>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? "Changing password…" : "Change password"}
        </Button>
      </div>
    </form>
  );
}
