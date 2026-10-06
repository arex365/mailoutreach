"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import { MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FormError } from "@/components/forms/field";
import { cn } from "@/lib/utils";
import { useJobPoll, type PolledJob } from "@/components/settings/domain/use-job-poll";
import { checkRunViewAction } from "@/app/(app)/contacts/check-actions";
import { testCheckAction } from "@/app/(app)/settings/deliverability/check-actions";
import { testCheckResultView, testChecksIntro, type TestChecksView } from "./check-settings";

const OFFLINE = "Couldn't reach the app, so nothing was checked. Check your connection and try again.";
const LOST_TRACK = "Couldn't follow the test from here. Try again in a minute.";

type Result = { tone: "good" | "info" | "error"; text: string; detail: string | null };

/**
 * Settings › Deliverability › "Test address checks" (M5-DESIGN §6.6): checks one typed address (default: the Owner's
 * reply inbox) through the check job, so the Owner sees that checks work on this Mailgun plan and how long one takes.
 * The result is stored as a check row only: never on a person, never on the do-not-email list.
 */
export function TestChecksCard({ view }: { view: TestChecksView }) {
  const uid = useId();
  const [email, setEmail] = useState(view.defaultEmail);
  const [jobId, setJobId] = useState<number | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [pending, startTransition] = useTransition();

  useJobPoll(jobId, {
    onDone: (job) => {
      if (jobId !== null) void finish(jobId, job);
    },
  });

  async function finish(id: number, job: PolledJob | null) {
    setJobId(null);
    if (!job) {
      setResult({ tone: "error", text: LOST_TRACK, detail: null });
      return;
    }
    try {
      const res = await checkRunViewAction({ jobId: id });
      setResult(res.ok ? testCheckResultView(res.data, { practiceCopy: view.practiceCopy }) : { tone: "error", text: res.error, detail: null });
    } catch {
      setResult({ tone: "error", text: OFFLINE, detail: null });
    }
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setFieldError(null);
    setResult(null);
    startTransition(async () => {
      try {
        const res = await testCheckAction({ email });
        if (!res.ok) {
          const onField = res.fieldErrors?.email?.[0] ?? null;
          setFieldError(onField);
          setError(onField ? null : res.error);
          return;
        }
        setJobId(res.data.jobId);
      } catch {
        setError(OFFLINE);
      }
    });
  }

  const inputId = `${uid}-email`;
  const checking = pending || jobId !== null;
  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <p className="text-sm text-muted-foreground">{testChecksIntro(view)}</p>
      <Field label="Email address" htmlFor={inputId} error={fieldError ?? undefined}>
        <Input
          id={inputId}
          type="text"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? `${inputId}-error` : undefined}
          className="sm:w-96"
        />
      </Field>
      <div>
        <Button type="submit" variant="outline" disabled={checking}>
          <MailCheck aria-hidden />
          {checking ? "Checking…" : "Check it"}
        </Button>
      </div>
      <FormError message={error} />
      {result ? (
        <div role="status" className="grid gap-1 text-sm">
          <p className={cn(result.tone === "error" && "text-destructive", result.tone === "good" && "text-success")}>{result.text}</p>
          {result.detail ? (
            <details className="text-muted-foreground">
              <summary className="cursor-pointer">Details</summary>
              <p className="mt-1 font-mono text-xs break-words">{result.detail}</p>
            </details>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
