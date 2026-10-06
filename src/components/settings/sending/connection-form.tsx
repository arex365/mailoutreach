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
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, FormError } from "@/components/forms/field";
import { MAILGUN_PLANS, MAILGUN_PLAN_FACTS, PLAN_TEXTS, planOf, type MailgunPlan } from "@/core/mailgun/plan";
import { WEBSITE_DOMAINS, validateSendingDomain } from "@/core/sender-address";
import { OWN_MAILBOX_TEXTS, type RepliesMode } from "@/core/sending/own-mailbox";
import {
  connectMailgunAction,
  forgetMailgunKeysAction,
  removeSendingKeyAction,
  saveRetentionAction,
} from "@/app/(app)/settings/sending/actions";
import type { ConnectionView } from "../types";

type FieldErrors = Record<string, string[] | undefined>;

const OFFLINE = "Couldn't reach the app, so nothing changed. Check your connection and try again.";

/** The Select's value for "Not sure" (Radix refuses an empty value). */
const NOT_SURE = "not-sure";

/** "How the app sends" (MAIN-DOMAIN-DESIGN §3.1): the subdomain option first, as the default. */
const REPLIES_OPTIONS: ReadonlyArray<{ value: RepliesMode; label: string; hint: string }> = [
  { value: "app", label: OWN_MAILBOX_TEXTS.repliesAppLabel, hint: OWN_MAILBOX_TEXTS.repliesAppHint },
  { value: "own-mailbox", label: OWN_MAILBOX_TEXTS.repliesOwnLabel, hint: OWN_MAILBOX_TEXTS.repliesOwnHint },
];

/** The typed domain as validateSendingDomain reads it (trimmed, lowercase, without https:// or trailing / and dots). */
function typedDomain(v: string): string {
  return v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/\.+$/, "");
}

/**
 * What the domain field shows for what is typed and chosen right now (MAIN-DOMAIN-DESIGN §2.2, §3.1), with the server's
 * own rules for the chosen mode: the check's sentence (shown once the field was left or Save and connect was clicked),
 * except that the website domain typed under "Through a sending subdomain" shows its sentence at once, with the one-click
 * switch; the hint and placeholder of the chosen mode.
 */
export function connectionDomainState(
  typed: string,
  replies: RepliesMode,
  touched: boolean,
): { valid: boolean; error: string | null; websiteSwitch: boolean; hint: string; placeholder: string } {
  const check = validateSendingDomain(typed, { replies });
  const d = typedDomain(typed);
  const websiteSwitch = replies === "app" && WEBSITE_DOMAINS.has(d) && !d.startsWith("www.");
  const own = replies === "own-mailbox";
  return {
    valid: check.ok,
    error: !check.ok && (touched || websiteSwitch) ? check.error : null,
    websiteSwitch,
    hint: own ? OWN_MAILBOX_TEXTS.domainHint : "Exactly as Mailgun shows it, for example mail.polygonparadise.com.",
    placeholder: own ? OWN_MAILBOX_TEXTS.domainPlaceholder : "mail.polygonparadise.com",
  };
}

/** The Advanced numbers as typed: the plan and the two retention fields. */
export type AdvancedValues = { plan: MailgunPlan | null; logDays: string; messageDays: string };

/** What the Advanced numbers were typed over: the saved plan and retention (they change after a save or a connect). */
export function advancedSavedKey(view: Pick<ConnectionView, "plan" | "logRetentionDays" | "messageRetentionDays">): string {
  return `${view.plan ?? ""}|${view.logRetentionDays}|${view.messageRetentionDays}`;
}

/**
 * The Advanced numbers shown (review SCREENS-05): what the Owner typed, while the saved values are still the ones they
 * typed over; otherwise the saved values. So right after the first own-mailbox connect writes the Free plan with 1 and 1
 * days (O22), and after Save these numbers, Advanced shows what is saved, not what the page first loaded with.
 */
export function advancedShown(
  view: Pick<ConnectionView, "plan" | "logRetentionDays" | "messageRetentionDays">,
  edits: (AdvancedValues & { over: string }) | null,
): AdvancedValues {
  if (edits && edits.over === advancedSavedKey(view)) return { plan: edits.plan, logDays: edits.logDays, messageDays: edits.messageDays };
  return { plan: view.plan ?? null, logDays: String(view.logRetentionDays), messageDays: String(view.messageRetentionDays) };
}

/**
 * Settings › Sending & Mailgun › Mailgun connection (M3-DESIGN §5.2): region, "How the app sends" (MAIN-DOMAIN-DESIGN
 * §3.1: through a sending subdomain, or from polygonparadise.com itself with replies to the Owner's own inbox), sending
 * domain and API key, "Save and connect" (tests with Mailgun before saving anything), and under Advanced "Your Mailgun
 * plan" (it fills the retention numbers), the optional domain sending key (with "Remove the sending key" while one is
 * saved, review SCREENS-01) and the plan's retention, and "Remove saved keys". The domain is checked as you type with
 * the chosen mode's rules. Mailgun's own answer is only shown behind "Details".
 */
export function ConnectionForm({ view }: { view: ConnectionView }) {
  const router = useRouter();
  const savedReplies: RepliesMode = view.replies ?? "app";
  const [region, setRegion] = useState<"EU" | "US">(view.region);
  const [replies, setReplies] = useState<RepliesMode>(savedReplies);
  const [domain, setDomain] = useState(view.domain);
  const [domainTouched, setDomainTouched] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [sendingKey, setSendingKey] = useState("");
  // Review SCREENS-05: the Advanced numbers follow the saved ones (a connect or a save changes them on the server, and a
  // refresh keeps client state), unless the Owner typed over the values saved now.
  const [edits, setEdits] = useState<(AdvancedValues & { over: string }) | null>(null);
  const { plan, logDays, messageDays } = advancedShown(view, edits);
  const editAdvanced = (change: Partial<AdvancedValues>) =>
    setEdits({ plan, logDays, messageDays, ...change, over: advancedSavedKey(view) });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [retentionError, setRetentionError] = useState<string | null>(null);
  const [sendingKeyError, setSendingKeyError] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);
  const [pending, startTransition] = useTransition();

  const domainState = connectionDomainState(domain, replies, domainTouched);
  const domainError = errors.domain?.[0] ?? domainState.error;
  // Switching the mode of a saved connection is a domain change (O2): say so before Save and connect.
  const switchNote = view.domain !== "" && replies !== savedReplies;
  // O22: no plan chosen in own-mailbox mode → the Free plan's limits are kept.
  const planAssumedLine = plan === null && savedReplies === "own-mailbox";

  function chooseReplies(next: RepliesMode) {
    setReplies(next);
    setErrors((e) => ({ ...e, domain: undefined }));
  }

  function choosePlan(value: string) {
    const next = planOf(value);
    // Choosing a plan fills the two numbers with the plan's; "Not sure" leaves them.
    editAdvanced(
      next
        ? { plan: next, logDays: String(MAILGUN_PLAN_FACTS[next].logDays), messageDays: String(MAILGUN_PLAN_FACTS[next].messageDays) }
        : { plan: null },
    );
  }

  function connect(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    setDetail(null);
    setDomainTouched(true);
    if (!domainState.valid) {
      // The same sentence the server would answer, under the field (nothing is sent).
      setErrors((fe) => ({ ...fe, domain: undefined }));
      return;
    }
    startTransition(async () => {
      try {
        const res = await connectMailgunAction({ region, domain, apiKey: apiKey || null, sendingKey: sendingKey || null, replies });
        if (!res.ok) {
          const fe = res.fieldErrors ?? {};
          setErrors(fe);
          setDetail(fe.detail?.[0] ?? null);
          const onField = Boolean(fe.domain || fe.apiKey || fe.region);
          setFormError(onField ? null : res.error);
          return;
        }
        setErrors({});
        setApiKey("");
        setSendingKey("");
        toast.success(res.message ?? "Mailgun is connected.");
        router.refresh();
      } catch {
        setFormError(OFFLINE);
      }
    });
  }

  function saveRetention() {
    setRetentionError(null);
    startTransition(async () => {
      try {
        const res = await saveRetentionAction({ logRetentionDays: Number(logDays), messageRetentionDays: Number(messageDays), plan });
        if (!res.ok) {
          const fe = res.fieldErrors ?? {};
          setRetentionError(fe.logRetentionDays?.[0] ?? fe.messageRetentionDays?.[0] ?? res.error);
          return;
        }
        toast.success(res.message ?? "Saved.");
        router.refresh();
      } catch {
        setRetentionError(OFFLINE);
      }
    });
  }

  /** "Remove the sending key" (review SCREENS-01): only the domain sending key goes; the API key sends from then on. */
  function removeSendingKey() {
    setSendingKeyError(null);
    startTransition(async () => {
      try {
        const res = await removeSendingKeyAction({});
        if (!res.ok) {
          setSendingKeyError(res.error);
          return;
        }
        setSendingKey("");
        toast.success(res.message ?? "The domain sending key is removed.");
        router.refresh();
      } catch {
        setSendingKeyError(OFFLINE);
      }
    });
  }

  function forget() {
    startTransition(async () => {
      try {
        const res = await forgetMailgunKeysAction();
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(res.message ?? "The saved keys are removed.");
        router.refresh();
      } catch {
        toast.error(OFFLINE);
      }
    });
  }

  const domainField = (
    <Field label="Sending domain" htmlFor="mg-domain" hint={domainState.hint} error={domainError ?? undefined}>
      <Input
        id="mg-domain"
        value={domain}
        onChange={(e) => {
          setDomain(e.target.value);
          setErrors((fe) => ({ ...fe, domain: undefined }));
        }}
        onBlur={() => setDomainTouched(true)}
        autoComplete="off"
        spellCheck={false}
        placeholder={domainState.placeholder}
        maxLength={253}
        aria-invalid={domainError ? true : undefined}
        aria-describedby={domainError ? "mg-domain-error" : "mg-domain-hint"}
      />
    </Field>
  );

  return (
    <form onSubmit={connect} className="grid gap-5" noValidate>
      <p className="text-sm font-medium" role="status">
        {view.statusLine}
      </p>
      <FormError message={formError} />

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Region</legend>
        <RadioGroup
          value={region}
          onValueChange={(v) => setRegion(v === "US" ? "US" : "EU")}
          className="flex flex-wrap gap-5"
          aria-describedby="region-hint"
          aria-invalid={errors.region ? true : undefined}
        >
          {(["EU", "US"] as const).map((r) => (
            <div key={r} className="flex items-center gap-2">
              <RadioGroupItem id={`region-${r}`} value={r} />
              <Label htmlFor={`region-${r}`} className="font-normal">
                {r}
              </Label>
            </div>
          ))}
        </RadioGroup>
        {errors.region?.[0] ? (
          <p className="text-sm text-destructive" role="alert">
            {errors.region[0]}
          </p>
        ) : (
          <p id="region-hint" className="text-sm text-muted-foreground">
            The region you chose when you added the domain in Mailgun. It can&apos;t be changed there later.
          </p>
        )}
      </fieldset>

      {/* MAIN-DOMAIN-DESIGN §3.1: how the app sends; the two options stack in one column at every width. */}
      <fieldset className="grid grid-cols-1 gap-2" data-part="replies">
        <legend className="mb-1 text-sm font-medium">{OWN_MAILBOX_TEXTS.repliesLegend}</legend>
        <RadioGroup
          value={replies}
          onValueChange={(v) => chooseReplies(v === "own-mailbox" ? "own-mailbox" : "app")}
          className="grid grid-cols-1 gap-3"
        >
          {REPLIES_OPTIONS.map((o) => (
            <div key={o.value} className="flex min-w-0 items-start gap-2">
              <RadioGroupItem id={`replies-${o.value}`} value={o.value} className="mt-0.5" aria-describedby={`replies-${o.value}-hint`} />
              <div className="grid min-w-0 grid-cols-1 gap-0.5">
                <Label htmlFor={`replies-${o.value}`}>{o.label}</Label>
                <p id={`replies-${o.value}-hint`} className="text-sm text-muted-foreground">
                  {o.hint}
                </p>
              </div>
            </div>
          ))}
        </RadioGroup>
        {switchNote ? (
          <p className="text-sm" role="status" data-part="replies-note">
            {OWN_MAILBOX_TEXTS.switchNote}
          </p>
        ) : null}
      </fieldset>

      {domainState.websiteSwitch ? (
        <div className="grid grid-cols-1 gap-2">
          {domainField}
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => chooseReplies("own-mailbox")} data-part="website-switch">
              {OWN_MAILBOX_TEXTS.websiteSwitch}
            </Button>
          </div>
        </div>
      ) : (
        domainField
      )}

      <Field
        label="API key"
        htmlFor="mg-key"
        hint={`A key with the Developer role, from Mailgun › API Security. Stored encrypted and never shown again.${view.keyLast4 ? " Leave empty to keep the saved key." : ""}`}
        error={errors.apiKey}
      >
        <Input
          id="mg-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder={view.keyLast4 ? `Saved key ending …${view.keyLast4}` : "Paste the key here"}
          aria-invalid={errors.apiKey ? true : undefined}
          aria-describedby={errors.apiKey ? "mg-key-error" : "mg-key-hint"}
        />
      </Field>

      <details className="rounded-md border border-border px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
        <div className="mt-3 grid gap-4">
          {/* MAIN-DOMAIN-DESIGN O22: the plan the app keeps to; saved with the numbers below ("Save these numbers"). */}
          <div className="grid grid-cols-1 gap-1.5" data-part="plan">
            <Label htmlFor="mg-plan">{PLAN_TEXTS.planLabel}</Label>
            <Select value={plan ?? NOT_SURE} onValueChange={choosePlan}>
              <SelectTrigger id="mg-plan" className="w-full sm:w-64" aria-describedby="mg-plan-hint">
                <SelectValue>{plan ? MAILGUN_PLAN_FACTS[plan].label : PLAN_TEXTS.planNotSure}</SelectValue>
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value={NOT_SURE}>{PLAN_TEXTS.planNotSure}</SelectItem>
                {MAILGUN_PLANS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {MAILGUN_PLAN_FACTS[p].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p id="mg-plan-hint" className="text-sm text-muted-foreground">
              {PLAN_TEXTS.planHint}
            </p>
            {planAssumedLine ? (
              <p className="text-sm" data-part="plan-assumed">
                {PLAN_TEXTS.assumedFree}
              </p>
            ) : null}
          </div>
          <Field
            label="Domain sending key (optional)"
            htmlFor="mg-sending-key"
            hint={
              view.hasSendingKey
                ? "A sending key is saved; it's used only to send emails. Leave empty to keep it. It works for one domain only, so changing the sending domain removes it. To send with the API key instead, click Remove the sending key."
                : "Only used to send emails. Leave empty to send with the API key above."
            }
          >
            <Input
              id="mg-sending-key"
              type="password"
              value={sendingKey}
              onChange={(e) => setSendingKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          {view.hasSendingKey ? (
            <div className="grid gap-1">
              <div>
                <Button type="button" variant="outline" size="sm" onClick={removeSendingKey} disabled={pending}>
                  Remove the sending key
                </Button>
              </div>
              {sendingKeyError ? (
                <p className="text-sm text-destructive" role="alert">
                  {sendingKeyError}
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="grid gap-2">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
              <span>Your Mailgun plan keeps event logs for</span>
              <Input
                aria-label="Days of event logs"
                type="number"
                min={1}
                max={30}
                value={logDays}
                onChange={(e) => editAdvanced({ logDays: e.target.value })}
                className="h-8 w-16"
              />
              <span>days and stored replies for</span>
              <Input
                aria-label="Days of stored replies"
                type="number"
                min={1}
                max={7}
                value={messageDays}
                onChange={(e) => editAdvanced({ messageDays: e.target.value })}
                className="h-8 w-16"
              />
              <span>{messageDays === "1" ? "day." : "days."}</span>
            </p>
            {retentionError ? (
              <p className="text-sm text-destructive" role="alert">
                {retentionError}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">{PLAN_TEXTS.retentionHint}</p>
            )}
            <div>
              <Button type="button" variant="outline" size="sm" onClick={saveRetention} disabled={pending}>
                Save these numbers
              </Button>
            </div>
          </div>
        </div>
      </details>

      {detail ? (
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer">Details</summary>
          <p className="mt-1 break-words font-mono text-xs">{detail}</p>
        </details>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant={view.primary ? "default" : "outline"} disabled={pending}>
          {pending ? "Checking with Mailgun…" : "Save and connect"}
        </Button>
        {view.keyLast4 ? (
          <Button type="button" variant="ghost" onClick={() => setConfirmForget(true)} disabled={pending}>
            Remove saved keys
          </Button>
        ) : null}
      </div>

      <AlertDialog open={confirmForget} onOpenChange={setConfirmForget}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the saved Mailgun keys?</AlertDialogTitle>
            <AlertDialogDescription>
              The app stops talking to Mailgun until you paste a key again. Emails through Mailgun wait; dry runs carry on.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the keys</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={forget}>
              Remove saved keys
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
