"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/forms/field";
import { saveDomainAgeAction } from "@/app/(app)/settings/domain/actions";

const OFFLINE = "Couldn't reach the app, so nothing changed. Check your connection and try again.";

/** The optional "When did you buy <domain>?" date for the Domain age row (M3-DESIGN §5.3, §9.2 item 16). */
export function DomainAgeForm({ domain, value }: { domain: string; value: string | null }) {
  const router = useRouter();
  const [date, setDate] = useState(value ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const res = await saveDomainAgeAction({ date: date || null });
        if (!res.ok) {
          setError(res.fieldErrors?.date?.[0] ?? res.error);
          return;
        }
        toast.success(res.message ?? "Saved.");
        router.refresh();
      } catch {
        setError(OFFLINE);
      }
    });
  }

  return (
    <form onSubmit={save} className="grid justify-items-start gap-2" noValidate>
      <Field label={`When did you buy ${domain}?`} htmlFor="domain-age" error={error ?? undefined} hint="Optional. Leave it empty if you don't know.">
        <Input
          id="domain-age"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="w-44"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "domain-age-error" : "domain-age-hint"}
        />
      </Field>
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save date"}
      </Button>
    </form>
  );
}
