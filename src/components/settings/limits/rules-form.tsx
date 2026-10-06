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
import { Textarea } from "@/components/ui/textarea";
import { Field, FormError } from "@/components/forms/field";
import { saveRulesAction } from "@/app/(app)/settings/limits/actions";
import type { RulesView } from "@/server/services/settings/rules";
import { SETTINGS_DIALOG_CLASS } from "../dialog-classes";
import { RULES_CARD, builtInSummary } from "./rules-text";

type FieldErrors = Record<string, string[] | undefined>;
type Draft = { teamRuleDays: string; pausedExpiryDays: string; sharedDomains: string };

/** A day box as the action takes it: an empty box is NaN, which the server refuses with the field's sentence. */
function dayValue(v: string): number {
  return v.trim() === "" ? Number.NaN : Number(v.trim());
}

/**
 * "The 30-day rule" card body (M6-DESIGN §5.3): the rule's length, how long a paused campaign keeps its companies, and
 * the Owner's shared email domains (one per line, with the built-in list collapsed underneath). "Save rules" is outline
 * (the page's primary is Save limits). When the change affects campaigns, the server sends back what it does; the
 * confirm dialog lists it and "Save anyway" saves with `confirmed`. The form keeps its values after an error.
 */
export function RulesForm({ view }: { view: RulesView }) {
  const id = useId();
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>({
    teamRuleDays: String(view.teamRuleDays),
    pausedExpiryDays: String(view.pausedExpiryDays),
    sharedDomains: view.sharedDomains.join("\n"),
  });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmLines, setConfirmLines] = useState<string[] | null>(null);
  const [pending, startTransition] = useTransition();

  function set<K extends keyof Draft>(key: K, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function save(confirmed: boolean) {
    setFormError(null);
    startTransition(async () => {
      try {
        const res = await saveRulesAction({
          teamRuleDays: dayValue(draft.teamRuleDays),
          pausedExpiryDays: dayValue(draft.pausedExpiryDays),
          sharedDomains: draft.sharedDomains,
          confirmed,
        });
        if (!res.ok) {
          setConfirmLines(null);
          setFieldErrors(res.fieldErrors ?? {});
          setFormError(res.error);
          return;
        }
        setFieldErrors({});
        if (res.data.needsConfirm) {
          setConfirmLines(res.data.needsConfirm.lines);
          return;
        }
        setConfirmLines(null);
        toast.success(res.message ?? "Rules saved.");
        router.refresh();
      } catch {
        setConfirmLines(null);
        setFormError(RULES_CARD.offline);
      }
    });
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    save(false);
  }

  const idOf = (key: keyof Draft) => `${id}-${key}`;
  const describe = (key: keyof Draft) => (fieldErrors[key]?.length ? `${idOf(key)}-error` : `${idOf(key)}-hint`);
  const invalid = (key: keyof Draft) => (fieldErrors[key]?.length ? true : undefined);

  return (
    <form onSubmit={onSubmit} className="grid gap-5" noValidate>
      <FormError message={formError} />
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label={RULES_CARD.daysLabel} htmlFor={idOf("teamRuleDays")} hint={RULES_CARD.daysHint} error={fieldErrors.teamRuleDays}>
          <Input
            id={idOf("teamRuleDays")}
            inputMode="numeric"
            className="w-28"
            value={draft.teamRuleDays}
            onChange={(e) => set("teamRuleDays", e.target.value)}
            aria-invalid={invalid("teamRuleDays")}
            aria-describedby={describe("teamRuleDays")}
          />
        </Field>
        <Field
          label={RULES_CARD.expiryLabel}
          htmlFor={idOf("pausedExpiryDays")}
          hint={RULES_CARD.expiryHint}
          error={fieldErrors.pausedExpiryDays}
        >
          <Input
            id={idOf("pausedExpiryDays")}
            inputMode="numeric"
            className="w-28"
            value={draft.pausedExpiryDays}
            onChange={(e) => set("pausedExpiryDays", e.target.value)}
            aria-invalid={invalid("pausedExpiryDays")}
            aria-describedby={describe("pausedExpiryDays")}
          />
        </Field>
      </div>
      <div className="grid gap-2">
        <Field label={RULES_CARD.domainsLabel} htmlFor={idOf("sharedDomains")} hint={RULES_CARD.domainsHint} error={fieldErrors.sharedDomains}>
          <Textarea
            id={idOf("sharedDomains")}
            rows={4}
            spellCheck={false}
            autoComplete="off"
            placeholder={RULES_CARD.domainsPlaceholder}
            className="min-h-24 font-mono text-sm"
            value={draft.sharedDomains}
            onChange={(e) => set("sharedDomains", e.target.value)}
            aria-invalid={invalid("sharedDomains")}
            aria-describedby={describe("sharedDomains")}
          />
        </Field>
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">{builtInSummary(view.builtIn)}</summary>
          <p className="mt-1 break-words font-mono text-xs">{view.builtIn.join(", ")}</p>
        </details>
      </div>
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending && confirmLines === null ? RULES_CARD.saving : RULES_CARD.save}
        </Button>
      </div>

      <AlertDialog open={confirmLines !== null} onOpenChange={(open) => !pending && !open && setConfirmLines(null)}>
        <AlertDialogContent className={SETTINGS_DIALOG_CLASS}>
          <AlertDialogHeader>
            <AlertDialogTitle>{RULES_CARD.confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <ul className="grid list-disc gap-1.5 pl-5 text-left">
                {(confirmLines ?? []).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>{RULES_CARD.cancel}</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault(); // keep the dialog open until the rules are saved
                save(true);
              }}
            >
              {pending ? RULES_CARD.saving : RULES_CARD.confirmButton}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
