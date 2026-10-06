"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Field, FormError } from "@/components/forms/field";
import { addSuppressionAction } from "@/app/(app)/settings/deliverability/actions";
import { SETTINGS_DIALOG_CLASS } from "../dialog-classes";

const OFFLINE = "Couldn't reach the app. Check your connection and try again.";

/**
 * "Add an address" (Settings › Deliverability, §5.5): puts one address on the do-not-email list for every sender, as
 * "Unsubscribed" or "Do not email", and stops any emails waiting for it.
 */
export function AddSuppressionDialog() {
  const router = useRouter();
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState<"UNSUBSCRIBED" | "MANUAL">("UNSUBSCRIBED");
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [pending, startTransition] = useTransition();

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setFieldError(undefined);
    startTransition(async () => {
      try {
        const res = await addSuppressionAction({ email, reason });
        if (!res.ok) {
          setFieldError(res.fieldErrors?.email?.[0]);
          setError(res.fieldErrors?.email?.[0] ? null : res.error);
          return;
        }
        const stopped = res.data.stopped;
        toast.success(
          stopped > 0
            ? `${res.message ?? "Added."} ${stopped} waiting ${stopped === 1 ? "email was" : "emails were"} stopped.`
            : (res.message ?? "Added."),
        );
        setOpen(false);
        setEmail("");
        router.refresh();
      } catch {
        setError(OFFLINE);
      }
    });
  }

  const who = email.trim() || "this address";
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <Plus aria-hidden />
        Add an address
      </Button>
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent className={`sm:max-w-md ${SETTINGS_DIALOG_CLASS}`}>
          <form onSubmit={submit} className="grid gap-4" noValidate>
            <DialogHeader>
              <DialogTitle>Add an address to the do-not-email list</DialogTitle>
              <DialogDescription>
                Adds {who} to the do-not-email list for every sender, and stops any emails waiting for it.
              </DialogDescription>
            </DialogHeader>
            <Field label="Email address" htmlFor={`${ids}-email`} error={fieldError}>
              <Input
                id={`${ids}-email`}
                type="email"
                autoComplete="off"
                spellCheck={false}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="anna@studio.de"
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={fieldError ? `${ids}-email-error` : undefined}
              />
            </Field>
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">Why</legend>
              <RadioGroup value={reason} onValueChange={(v) => setReason(v === "MANUAL" ? "MANUAL" : "UNSUBSCRIBED")}>
                <div className="flex items-center gap-2">
                  <RadioGroupItem id={`${ids}-unsub`} value="UNSUBSCRIBED" />
                  <Label htmlFor={`${ids}-unsub`} className="font-normal">
                    Unsubscribed
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem id={`${ids}-manual`} value="MANUAL" />
                  <Label htmlFor={`${ids}-manual`} className="font-normal">
                    Do not email
                  </Label>
                </div>
              </RadioGroup>
            </fieldset>
            <FormError message={error} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending || !email.trim()}>
                {pending ? "Adding…" : "Add to the list"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
