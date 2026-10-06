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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormError } from "@/components/forms/field";
import { domainOfAddress, TEAM_FROM_TEXTS } from "@/core/sending/from-address";
import { OWN_MAILBOX_TEXTS, validateFromAddressFor } from "@/core/sending/own-mailbox";
import { saveFromAddressAction } from "@/app/(app)/settings/sending/actions";
import { SETTINGS_DIALOG_CLASS } from "../dialog-classes";
import type { FromAddressView } from "../types";

/** A lost connection (SCREENS-11): nothing was saved, and what was typed stays in the box. */
export const FROM_ADDRESS_OFFLINE = "Couldn't reach the app, so nothing was saved. Check your connection and try again.";

/**
 * What the form shows for what is typed right now (§3.1), with the server's own rules: the hint names the typed
 * address while it is valid, else the saved one, else contact@<main domain>; the check's sentence (or "on your test
 * list"); whether the risk note shows (the field or the saved value isn't empty) and which domain it names.
 *
 * Own-mailbox mode (`view.replies`, MAIN-DOMAIN-DESIGN §3.2): the own-mailbox rules (`validateFromAddressFor`: exactly on
 * the sending domain), the own hint ("…Replies go straight to this mailbox…"), `contact@<sending domain>` as the
 * fallback, and the risk note names the sending domain itself.
 */
export function fromAddressFormState(
  view: Pick<FromAddressView, "sendingDomain" | "mainDomain" | "saved" | "ownerDisplayName" | "testList" | "replies">,
  typedRaw: string,
): { next: string | null; error: string | null; hint: string; showRisk: boolean; riskOrg: string } {
  const d = view.sendingDomain ?? "";
  const own = view.replies === "own-mailbox";
  const org = view.mainDomain;
  const typed = typedRaw.trim();
  const check = validateFromAddressFor(typed, d, own ? "own-mailbox" : "app");
  const next = check.ok ? check.address : null;
  const onTestList = next !== null && view.testList.some((a) => a.trim().toLowerCase() === next);
  const error = !check.ok ? check.error : onTestList && next ? TEAM_FROM_TEXTS.onTestList(next) : null;
  const showRisk = typed !== "" || view.saved !== null;
  if (own) {
    const shown = next ?? view.saved ?? `contact@${d}`;
    return { next, error, hint: OWN_MAILBOX_TEXTS.hint(view.ownerDisplayName, shown, d), showRisk, riskOrg: d };
  }
  const shown = next ?? view.saved ?? `contact@${org ?? d}`;
  const hint = org ? TEAM_FROM_TEXTS.hint(view.ownerDisplayName, shown, org, d) : TEAM_FROM_TEXTS.noSubdomain(d);
  const riskOrg = org ?? domainOfAddress(view.saved ?? typed) ?? d;
  return { next, error, hint, showRisk, riskOrg };
}

/**
 * Settings › Sending & Mailgun › From address (SHARED-FROM-DESIGN §3.1, F2, F13): the shared address every campaign
 * email shows, or empty for each person's own address. Placed right after "Mailgun connection". Instead of the form:
 * the practice copy's sentence, or "Connect Mailgun first" while no sending domain is saved. In own-mailbox mode
 * (MAIN-DOMAIN-DESIGN §3.2) it is the own From: the address every email comes from, where replies go straight to.
 */
export function FromAddressCard({ view }: { view: FromAddressView }) {
  const own = view.replies === "own-mailbox";
  return (
    <Card id="from-address" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>{TEAM_FROM_TEXTS.cardTitle}</CardTitle>
        <CardDescription>{own ? OWN_MAILBOX_TEXTS.cardDescription : TEAM_FROM_TEXTS.cardDescription}</CardDescription>
      </CardHeader>
      <CardContent>
        {view.practiceCopy ? (
          <p className="text-sm">{TEAM_FROM_TEXTS.practiceCopy}</p>
        ) : !view.connected || !view.sendingDomain ? (
          <p className="text-sm">{TEAM_FROM_TEXTS.notConnected}</p>
        ) : (
          <FromAddressForm view={view} sendingDomain={view.sendingDomain} />
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The form, top to bottom in one `grid-cols-1` column (§3.1, C2-20): the misfit line (only while the saved address no
 * longer fits), the field, its hint, the outline Save button (the page keeps one orange button), the risk note (while
 * the field or the saved value isn't empty) and the closed "Good to know" list (while an address is saved). The field
 * is checked as you type with the server's own rules; the check shows once the field was left or Save was clicked.
 * While live, Save asks first (going live ends); errors and a lost connection keep what was typed.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §3.2): the same order, with "Type the address your emails come from…" above the
 * field while nothing is saved (test and live campaigns can't start without it), the field without "(optional)", the
 * own hint and "Good to know" list, and the risk note naming the sending domain.
 */
function FromAddressForm({ view, sendingDomain }: { view: FromAddressView; sendingDomain: string }) {
  const router = useRouter();
  const d = sendingDomain;
  const own = view.replies === "own-mailbox";
  const org = own ? d : view.mainDomain;
  // The line above the field: the saved address no longer fits (both modes), or none saved yet (own-mailbox mode).
  const topLine = view.problem ?? (own && !view.saved ? OWN_MAILBOX_TEXTS.missingHere(d) : null);
  const [value, setValue] = useState(view.saved ?? "");
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const { next, error: clientError, hint, showRisk, riskOrg } = fromAddressFormState(view, value);
  const fieldError = serverError ?? (touched ? clientError : null);
  const savedOrg = view.saved ? (domainOfAddress(view.saved) ?? riskOrg) : riskOrg;

  function save(confirmEndGoLive: boolean) {
    setFormError(null);
    setServerError(null);
    startTransition(async () => {
      try {
        const res = await saveFromAddressAction({ fromAddress: value, ...(confirmEndGoLive ? { confirmEndGoLive: true } : {}) });
        if (!res.ok) {
          const onField = res.fieldErrors?.fromAddress?.[0];
          if (onField) {
            setServerError(onField);
            setConfirmOpen(false);
          } else if (!confirmEndGoLive && res.error === TEAM_FROM_TEXTS.confirmBody) {
            // Went live meanwhile: ask first, like the page would have.
            setConfirmOpen(true);
          } else {
            setFormError(res.error);
            setConfirmOpen(false);
          }
          return;
        }
        setConfirmOpen(false);
        toast.success(res.message ?? TEAM_FROM_TEXTS.nothingChanged);
        router.refresh();
      } catch {
        setFormError(FROM_ADDRESS_OFFLINE);
        setConfirmOpen(false);
      }
    });
  }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTouched(true);
    setFormError(null);
    if (clientError) {
      setServerError(null);
      return;
    }
    // While live, a real change asks first; saving the same address again only says "Nothing changed."
    if (view.goLive && next !== view.saved) {
      setConfirmOpen(true);
      return;
    }
    save(false);
  }

  return (
    <form onSubmit={submit} className="grid grid-cols-1 gap-4" noValidate>
      {topLine ? (
        <p
          className="text-sm text-destructive [overflow-wrap:anywhere]"
          role="alert"
          data-part={view.problem ? "misfit" : "missing"}
        >
          {topLine}
        </p>
      ) : null}
      <FormError message={formError} />

      <div className="grid grid-cols-1 gap-1.5">
        <Label htmlFor="team-from-address">{own ? OWN_MAILBOX_TEXTS.fieldLabel : TEAM_FROM_TEXTS.fieldLabel}</Label>
        <Input
          id="team-from-address"
          type="email"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setServerError(null);
          }}
          onBlur={() => setTouched(true)}
          autoComplete="off"
          spellCheck={false}
          placeholder={`contact@${org ?? d}`}
          maxLength={320}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? "team-from-address-error team-from-address-hint" : "team-from-address-hint"}
          data-part="field"
        />
        {fieldError ? (
          <p id="team-from-address-error" className="text-sm text-destructive [overflow-wrap:anywhere]" role="alert">
            {fieldError}
          </p>
        ) : null}
        <p id="team-from-address-hint" className="text-sm text-muted-foreground [overflow-wrap:anywhere]" data-part="hint">
          {hint}
        </p>
      </div>

      <div>
        <Button type="submit" variant="outline" disabled={pending} data-part="save">
          {pending ? TEAM_FROM_TEXTS.saving : TEAM_FROM_TEXTS.saveButton}
        </Button>
      </div>

      {showRisk ? (
        <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]" data-part="risk">
          {TEAM_FROM_TEXTS.riskNote(riskOrg)}
        </p>
      ) : null}

      {view.saved ? (
        <details className="rounded-md border border-border px-3 py-2" data-part="good-to-know">
          <summary className="cursor-pointer text-sm font-medium">{TEAM_FROM_TEXTS.goodToKnowHeading}</summary>
          <ul className="mt-2 grid grid-cols-1 list-disc gap-1.5 pl-5 text-sm [overflow-wrap:anywhere]">
            {(own ? OWN_MAILBOX_TEXTS.goodToKnow(view.saved, d) : TEAM_FROM_TEXTS.goodToKnow(view.saved, savedOrg, d)).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      ) : null}

      <AlertDialog open={confirmOpen} onOpenChange={(open) => !pending && setConfirmOpen(open)}>
        <AlertDialogContent className={SETTINGS_DIALOG_CLASS}>
          <AlertDialogHeader>
            <AlertDialogTitle>{TEAM_FROM_TEXTS.confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>{TEAM_FROM_TEXTS.confirmBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>{TEAM_FROM_TEXTS.cancelButton}</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault(); // keep the dialog open until the change is saved
                save(true);
              }}
            >
              {pending ? TEAM_FROM_TEXTS.saving : TEAM_FROM_TEXTS.confirmButton}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
