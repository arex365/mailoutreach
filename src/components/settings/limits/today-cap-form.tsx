"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/forms/field";
import { clearTodayCapAction, setTodayCapAction } from "@/app/(app)/settings/limits/actions";
import { todayCapQuestion, validateTodayCap } from "./limits-format";
import { SETTINGS_DIALOG_CLASS } from "../dialog-classes";

const OFFLINE = "Couldn't reach the app, so nothing changed. Check your connection and try again.";

/**
 * "Change today's limit" (M3-DESIGN §5.4): a number for today only, confirmed in a dialog that warns
 * when it goes above the warm-up schedule. Tomorrow the schedule applies again.
 */
export function TodayCapForm({ current, warmupCap, maxCap }: { current: number; warmupCap: number; maxCap: number }) {
  const id = useId();
  const router = useRouter();
  const [value, setValue] = useState(String(current));
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState<ReturnType<typeof todayCapQuestion> | null>(null);
  const [cap, setCap] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  function ask(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const checked = validateTodayCap(value, maxCap);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setError(null);
    setCap(checked.value);
    setQuestion(todayCapQuestion(checked.value, warmupCap));
  }

  function confirm() {
    if (cap === null) return;
    startTransition(async () => {
      try {
        const res = await setTodayCapAction({ cap, confirmed: true });
        if (!res.ok) {
          setQuestion(null);
          setError(res.fieldErrors?.cap?.[0] ?? res.error);
          return;
        }
        setQuestion(null);
        toast.success(res.message ?? "Today's limit changed.");
        router.refresh();
      } catch {
        setQuestion(null);
        setError(OFFLINE);
      }
    });
  }

  return (
    <form onSubmit={ask} className="grid gap-3" noValidate>
      <Field
        label="Change today's limit"
        htmlFor={`${id}-cap`}
        hint={`For today only, from 0 to ${maxCap.toLocaleString("en-US")}. The warm-up schedule says ${warmupCap.toLocaleString("en-US")}.`}
        error={error ?? undefined}
      >
        <Input
          id={`${id}-cap`}
          inputMode="numeric"
          className="w-32"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-cap-error` : `${id}-cap-hint`}
        />
      </Field>
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          Change today&apos;s limit
        </Button>
      </div>
      <AlertDialog open={question !== null} onOpenChange={(o) => !pending && !o && setQuestion(null)}>
        <AlertDialogContent className={SETTINGS_DIALOG_CLASS}>
          <AlertDialogHeader>
            <AlertDialogTitle>{question?.title}</AlertDialogTitle>
            <AlertDialogDescription>{question?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep the current limit</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                confirm();
              }}
            >
              {pending ? "Changing…" : "Change today's limit"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}

/** "Go back to the schedule": drops today's change. */
export function ClearTodayCapButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          try {
            const res = await clearTodayCapAction();
            if (!res.ok) {
              toast.error(res.error);
              return;
            }
            toast.success(res.message ?? "Back to the warm-up schedule.");
            router.refresh();
          } catch {
            toast.error(OFFLINE);
          }
        })
      }
    >
      {pending ? "Going back…" : "Go back to the schedule"}
    </Button>
  );
}
