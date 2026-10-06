"use client";

import { useState, useTransition } from "react";
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
import { Field, FormError } from "@/components/forms/field";
import { OFFLINE_TEXT } from "@/components/ai/phone-dialog";
import { removeAnthropicKeyAction, saveAnthropicKeyAction } from "@/app/(app)/settings/ai/actions";
import type { AiSettingsView } from "@/server/services/ai/settings";
import { AI_SETTINGS_PAGE } from "./texts";
import { SETTINGS_DIALOG_CLASS } from "../dialog-classes";

/**
 * Settings › AI › Anthropic API key (docs/dev/M5-DESIGN.md §6.9): the saved key's last four characters, who saved it
 * and when; "Save key" checks the key with Anthropic first ("Checking the key with Anthropic…") and is the page's
 * primary action unless drafting is paused; "Remove key" asks first. Anthropic's own words only behind "Details".
 */
export function AnthropicKeyForm({
  keyView,
  practiceLine,
  primary,
}: {
  keyView: AiSettingsView["key"];
  /** The practice copy's sentence, shown instead of the key's line. */
  practiceLine: string | null;
  primary: boolean;
}) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [pending, startTransition] = useTransition();
  const [checking, setChecking] = useState(false);

  function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setFormError(null);
    setDetail(null);
    setChecking(true);
    startTransition(async () => {
      try {
        const res = await saveAnthropicKeyAction({ key });
        if (!res.ok) {
          const fe = res.fieldErrors ?? {};
          if (fe.key?.[0]) setError(fe.key[0]);
          else setFormError(res.error);
          setDetail(fe.detail?.[0] ?? null);
          return;
        }
        setKey("");
        if (res.data.warning) toast.warning(res.message ?? "Key saved.");
        else toast.success(res.message ?? "Key saved.");
        router.refresh();
      } catch {
        setFormError(OFFLINE_TEXT);
      } finally {
        setChecking(false);
      }
    });
  }

  function remove() {
    startTransition(async () => {
      try {
        const res = await removeAnthropicKeyAction();
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(res.message ?? "The Anthropic key is removed.");
        setConfirmRemove(false);
        router.refresh();
      } catch {
        toast.error(OFFLINE_TEXT);
      }
    });
  }

  return (
    <form onSubmit={save} className="grid gap-4" noValidate>
      <p className="text-sm font-medium" role="status">
        {practiceLine ?? keyView.line}
      </p>
      {keyView.problem ? <p className="text-sm text-destructive">{keyView.problem}</p> : null}
      <FormError message={formError} />
      <Field label="API key" htmlFor="ai-key" error={error ?? undefined}>
        <Input
          id="ai-key"
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-ant-…"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "ai-key-error" : undefined}
        />
      </Field>
      {detail ? (
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer">Details</summary>
          <p className="mt-1 font-mono text-xs break-words">{detail}</p>
        </details>
      ) : null}
      {checking ? (
        <p className="text-sm text-muted-foreground" role="status">
          {AI_SETTINGS_PAGE.keyChecking}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant={primary ? "default" : "outline"} disabled={pending}>
          Save key
        </Button>
        {keyView.set ? (
          <Button type="button" variant="destructive" onClick={() => setConfirmRemove(true)} disabled={pending}>
            Remove key
          </Button>
        ) : null}
      </div>

      <AlertDialog open={confirmRemove} onOpenChange={(o) => (!pending ? setConfirmRemove(o) : undefined)}>
        <AlertDialogContent className={SETTINGS_DIALOG_CLASS}>
          <AlertDialogHeader>
            <AlertDialogTitle>{AI_SETTINGS_PAGE.removeTitle}</AlertDialogTitle>
            <AlertDialogDescription>{AI_SETTINGS_PAGE.removeText}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                remove();
              }}
            >
              Remove key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
