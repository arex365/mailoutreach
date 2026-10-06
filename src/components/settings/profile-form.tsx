"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, FormError } from "@/components/forms/field";
import { senderAddressWords } from "@/core/sending/from-address";
import { OWN_MAILBOX_TEXTS } from "@/core/sending/own-mailbox";
import { firstNameFrom } from "@/core/text";
import { cn } from "@/lib/utils";
import { updateProfileAction } from "@/app/(app)/settings/profile/actions";
import { signInEmailHelp } from "./profile-text";
import type { ProfileValues, SenderAddressView, TimeZoneOption } from "./types";

type FieldErrors = Record<string, string[] | undefined>;

/** The save never reached the app (no connection, the office PC restarting): the same words as the other settings. */
export const PROFILE_OFFLINE = "Couldn't reach the app, so nothing was saved. Check your connection and try again.";

/** Same rule as suggestedSenderName() in src/server/services/users.ts. */
function suggestSenderName(name: string): string {
  const first = firstNameFrom(name) || name.trim();
  return first ? `${first} from Polygon Paradise` : "";
}

function describedBy(id: string, errors: FieldErrors, hasHint = true): string | undefined {
  if (errors[id]?.length) return `${id}-error`;
  return hasHint ? `${id}-hint` : undefined;
}

const SIGNATURE_HINT = "Plain text. It's added where a template says {{sender_signature}}.";

/**
 * The address field's words (SHARED-FROM-DESIGN §3.6, F19): "Sending address" in per-person mode (unchanged), "Reply
 * address" while a shared From address is set (`teamFrom`): people then see that address as the sender, and this one
 * is where their replies go.
 */
export function senderAddressFieldTexts(teamFrom: string | null | undefined): { label: string; hint: string; noneYet: string } {
  const words = senderAddressWords(Boolean(teamFrom));
  return {
    label: words.label,
    hint: teamFrom
      ? `People see ${teamFrom} as the sender, with your display name. When they press Reply, their answer goes to this address: the app records it, and Mailgun forwards it to your reply inbox.`
      : "People see this address in their inbox. Replies to it are forwarded to your reply inbox.",
    noneYet: `${words.noneYet}. Type the name before the @ and save your profile.`,
  };
}

/**
 * The signature's hint; in shared-From mode it adds which address a signature should show, so answers reach the app
 * (`address`: the person's reply address, left out while they have none yet). In own-mailbox mode (`ownFrom`,
 * MAIN-DOMAIN-DESIGN §3.7) it names the own From instead; absent or null = today's hint.
 */
export function signatureHintText(
  teamFrom: string | null | undefined,
  address: string | null | undefined,
  ownFrom?: string | null,
): string {
  if (ownFrom) return `${SIGNATURE_HINT}${OWN_MAILBOX_TEXTS.signatureHint(ownFrom)}`;
  if (!teamFrom) return SIGNATURE_HINT;
  const which = address ? `your reply address (${address})` : "your reply address";
  return `${SIGNATURE_HINT} If your signature shows an email address, use ${which}, so answers reach the app.`;
}

/**
 * The reply inbox field's words. App mode: "Reply inbox", where replies are forwarded (unchanged). Own-mailbox mode
 * (MAIN-DOMAIN-DESIGN §3.7, `ownFrom` a string or null): the inbox only receives "Send me a test", because replies go
 * straight to the own From (`undefined` = app mode).
 */
export function replyInboxFieldTexts(ownFrom: string | null | undefined): { label: string; hint: string } {
  if (ownFrom === undefined) return { label: "Reply inbox", hint: "Replies to your campaigns are forwarded here." };
  return {
    label: OWN_MAILBOX_TEXTS.testInboxLabel,
    hint: ownFrom ? OWN_MAILBOX_TEXTS.testInboxHint(ownFrom) : "Send me a test sends your test emails here.",
  };
}

/** Own-mailbox mode's line instead of the address field (MAIN-DOMAIN-DESIGN §3.7): the From line people see. */
export function profileFromLineText(displayName: string, ownFrom: string | null): string {
  return ownFrom ? OWN_MAILBOX_TEXTS.profileFromLine(displayName, ownFrom) : OWN_MAILBOX_TEXTS.profileFromMissing;
}

/**
 * My profile (everyone): name, sender display name, the sending address (the name before the @ on the Owner's sending
 * domain, with its reply route status; "Reply address" in shared-From mode), reply inbox, signature with a preview,
 * and time zone. Own-mailbox mode (`sender.ownFrom` set, a string or null; MAIN-DOMAIN-DESIGN §3.7): no address field,
 * the From line people see instead, the inbox for test emails, and the signature hint naming the own From.
 */
export function ProfileForm({
  initial,
  zones,
  isOwner = false,
  sender,
}: {
  initial: ProfileValues;
  zones: TimeZoneOption[];
  isOwner?: boolean;
  sender?: SenderAddressView;
}) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const suggestion = suggestSenderName(values.name);
  const showSuggestion = Boolean(suggestion) && values.senderDisplayName.trim() !== suggestion;
  // Own-mailbox mode: the page sets `ownFrom` (null while no From fits); app mode never does.
  const ownMailbox = sender?.ownFrom !== undefined;
  const ownFrom = sender?.ownFrom ?? null;
  const inboxTexts = replyInboxFieldTexts(sender?.ownFrom);

  function set<K extends keyof ProfileValues>(key: K, value: ProfileValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    startTransition(async () => {
      try {
        const res = await updateProfileAction({
          name: values.name,
          senderDisplayName: values.senderDisplayName,
          replyInbox: values.replyInbox,
          signature: values.signature,
          timeZone: values.timeZone,
          // Only sent when the sending address can be edited here (a sending domain exists and nothing blocks it); never
          // in own-mailbox mode, where nobody has one.
          ...(sender?.domain && !sender.blockedText && !ownMailbox ? { senderLocalPart: values.senderLocalPart } : {}),
        });
        if (res.ok) {
          setFieldErrors({});
          setFormError(null);
          toast.success(res.message ?? "Profile saved.");
          router.refresh();
        } else {
          setFieldErrors(res.fieldErrors ?? {});
          setFormError(res.error);
        }
      } catch {
        // A thrown call would reach the error screen and lose what was typed (a long signature): say so and keep it.
        setFormError(PROFILE_OFFLINE);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-5" noValidate>
      <FormError message={formError} />

      <Field label="Name" htmlFor="name" hint="Your full name, as your teammates know you." error={fieldErrors.name}>
        <Input
          id="name"
          value={values.name}
          onChange={(e) => set("name", e.target.value)}
          autoComplete="name"
          required
          maxLength={100}
          aria-invalid={fieldErrors.name ? true : undefined}
          aria-describedby={describedBy("name", fieldErrors)}
        />
      </Field>

      <div className="grid gap-1.5">
        <p className="text-sm font-medium">Sign-in email</p>
        <p className="text-sm text-foreground">{values.email}</p>
        <p className="text-sm text-muted-foreground">{signInEmailHelp(isOwner)}</p>
      </div>

      <Field
        label="Sender display name"
        htmlFor="senderDisplayName"
        hint="The name people see in their inbox when your campaigns arrive."
        error={fieldErrors.senderDisplayName}
      >
        <Input
          id="senderDisplayName"
          value={values.senderDisplayName}
          onChange={(e) => set("senderDisplayName", e.target.value)}
          placeholder={suggestion || "Ali from Polygon Paradise"}
          maxLength={100}
          aria-invalid={fieldErrors.senderDisplayName ? true : undefined}
          aria-describedby={describedBy("senderDisplayName", fieldErrors)}
        />
        {showSuggestion ? (
          <div>
            <Button type="button" variant="ghost" size="xs" onClick={() => set("senderDisplayName", suggestion)}>
              Use &ldquo;{suggestion}&rdquo;
            </Button>
          </div>
        ) : null}
      </Field>

      {ownMailbox ? (
        <div className="grid gap-1.5">
          <p className="text-sm font-medium">{OWN_MAILBOX_TEXTS.fieldLabel}</p>
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {profileFromLineText(values.senderDisplayName.trim() || suggestion || values.name.trim(), ownFrom)}
          </p>
        </div>
      ) : (
        <SendingAddressField
          sender={sender}
          value={values.senderLocalPart}
          onChange={(v) => set("senderLocalPart", v)}
          error={fieldErrors.senderLocalPart}
        />
      )}

      <Field label={inboxTexts.label} htmlFor="replyInbox" hint={inboxTexts.hint} error={fieldErrors.replyInbox}>
        <Input
          id="replyInbox"
          type="email"
          value={values.replyInbox}
          onChange={(e) => set("replyInbox", e.target.value)}
          autoComplete="email"
          required
          aria-invalid={fieldErrors.replyInbox ? true : undefined}
          aria-describedby={describedBy("replyInbox", fieldErrors)}
        />
      </Field>

      <Field
        label="Signature"
        htmlFor="signature"
        hint={signatureHintText(sender?.teamFrom, sender?.current, ownFrom)}
        error={fieldErrors.signature}
      >
        <Textarea
          id="signature"
          value={values.signature}
          onChange={(e) => set("signature", e.target.value)}
          rows={4}
          maxLength={2000}
          className="min-h-24 font-mono text-sm"
          aria-invalid={fieldErrors.signature ? true : undefined}
          aria-describedby={describedBy("signature", fieldErrors)}
        />
      </Field>
      <div className="grid gap-1.5">
        <p className="text-sm font-medium">Preview</p>
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5 text-sm">
          <p className="text-muted-foreground">…and that&apos;s the end of the email.</p>
          <div className="mt-3 whitespace-pre-wrap break-words">
            {values.signature.trim() ? (
              values.signature.trimEnd()
            ) : (
              <span className="text-muted-foreground">No signature yet. The email ends after your last line.</span>
            )}
          </div>
        </div>
      </div>

      <Field label="Time zone" htmlFor="timeZone" hint="Times in the app are shown in this zone." error={fieldErrors.timeZone}>
        <Select value={values.timeZone} onValueChange={(v) => set("timeZone", v)}>
          <SelectTrigger
            id="timeZone"
            className="w-full sm:w-80"
            aria-invalid={fieldErrors.timeZone ? true : undefined}
            aria-describedby={describedBy("timeZone", fieldErrors)}
          >
            <SelectValue placeholder="Pick a time zone" />
          </SelectTrigger>
          <SelectContent position="popper" className="max-h-72">
            {zones.map((z) => (
              <SelectItem key={z.value} value={z.value}>
                {z.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save profile"}
        </Button>
      </div>
    </form>
  );
}

/**
 * "Sending address": `[ ali ] @send.example.com` with its reply route status (M3-DESIGN §5.7). Before the Owner connects a
 * sending domain there is nothing to type; while this person's test or live campaigns run it can't change. In
 * shared-From mode it is the "Reply address" (`senderAddressFieldTexts`).
 */
function SendingAddressField({
  sender,
  value,
  onChange,
  error,
}: {
  sender: SenderAddressView | undefined;
  value: string;
  onChange: (v: string) => void;
  error: string[] | undefined;
}) {
  const texts = senderAddressFieldTexts(sender?.teamFrom);
  if (!sender?.domain) {
    return (
      <div className="grid gap-1.5">
        <p className="text-sm font-medium">{texts.label}</p>
        <p className="text-sm text-muted-foreground">
          Your sending address is set up once the Owner connects the sending domain in Settings › Sending &amp; Mailgun.
        </p>
      </div>
    );
  }
  const message = error?.[0];
  const locked = Boolean(sender.blockedText);
  return (
    <div className="grid gap-1.5">
      <label htmlFor="senderLocalPart" className="text-sm font-medium">
        {texts.label}
      </label>
      {/* Locked is read-only, not disabled: a disabled group fades to 25%, and the address must stay readable. */}
      <InputGroup className="sm:w-96">
        <InputGroupInput
          id="senderLocalPart"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={sender.suggestion}
          autoComplete="off"
          spellCheck={false}
          maxLength={64}
          readOnly={locked}
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? "senderLocalPart-error" : "senderLocalPart-hint senderLocalPart-status"}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupText>@{sender.domain}</InputGroupText>
        </InputGroupAddon>
      </InputGroup>
      {message ? (
        <p id="senderLocalPart-error" className="text-sm text-destructive" role="alert">
          {message}
        </p>
      ) : (
        <p id="senderLocalPart-hint" className="text-sm text-muted-foreground">
          {locked ? sender.blockedText : texts.hint}
        </p>
      )}
      {sender.statusLine ? (
        <p
          id="senderLocalPart-status"
          className={cn(
            "text-sm",
            sender.statusTone === "ok" && "text-success",
            sender.statusTone === "bad" && "text-destructive",
            sender.statusTone === "pending" && "text-muted-foreground",
          )}
        >
          {sender.statusLine}
        </p>
      ) : !sender.current ? (
        <p id="senderLocalPart-status" className="text-sm text-muted-foreground">
          {texts.noneYet}
        </p>
      ) : null}
    </div>
  );
}
