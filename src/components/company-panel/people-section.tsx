"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Check, Copy, Ellipsis, MailMinus, Pencil, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field } from "@/components/forms/field";
import { FlagBadge, VerificationBadge } from "@/components/badges";
import { copyText } from "@/components/copy-text";
import { PersonCheckButton } from "@/components/checks/person-check";
import { checkReasonLine, didYouMeanConfirm, didYouMeanText } from "@/components/checks/panel-check";
import type { PersonChecker } from "@/components/checks/types";
import {
  addPersonAction,
  markPersonUnsubscribedAction,
  removePersonAction,
  setPersonNotesAction,
  setPersonPersonalLineAction,
  updatePersonAction,
} from "./actions";
import { ConfirmDialog, InlineError, PanelSection, usePanelAction } from "./panel-ui";
import { LineEditor, ToggleNotes } from "./text-editors";
import type { PanelResult, PersonView } from "./types";

/** The address with a small copy button (works on the plain-http office address too). */
function EmailLine({ email }: { email: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  async function onCopy() {
    const ok = await copyText(email);
    if (ok) {
      setCopied(true);
      return;
    }
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (ref.current && sel) sel.selectAllChildren(ref.current);
    toast.message("Your browser blocked copying. The address is selected: press Ctrl+C.");
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <span ref={ref} className="min-w-0 truncate font-mono text-[13px]" title={email}>
        {email}
      </span>
      <Button type="button" variant="ghost" size="icon-xs" aria-label={`Copy ${email}`} onClick={() => void onCopy()}>
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </Button>
      {copied ? (
        <span className="text-xs text-muted-foreground" role="status">
          Copied
        </span>
      ) : null}
    </div>
  );
}

function PersonFormDialog({
  open,
  onOpenChange,
  companyId,
  person,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Needed when adding. */
  companyId?: number;
  /** Present when editing; absent when adding. */
  person?: PersonView;
}) {
  const uid = useId();
  const formId = `${uid}-form`;
  const { pending, error, setError, run } = usePanelAction();
  const editing = Boolean(person);
  const fe = error?.fieldErrors;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const values = {
      name: String(fd.get("name") ?? ""),
      email: String(fd.get("email") ?? ""),
      role: String(fd.get("role") ?? ""),
    };
    const call = (): Promise<PanelResult<unknown>> =>
      person
        ? updatePersonAction({ personId: person.id, ...values })
        : addPersonAction({ companyId: companyId ?? 0, ...values });
    run(call, { onSuccess: () => onOpenChange(false) });
  }

  const emailFieldError = error?.link ? undefined : fe?.email;
  const formLevel = error && !fe ? error : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setError(null);
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{person ? `Edit ${person.displayName}` : "Add a person"}</DialogTitle>
          <DialogDescription>
            {person
              ? "Changing the email address clears its check result."
              : "Shared inboxes such as info@ or kontakt@ can be added without a name: they become General inbox."}
          </DialogDescription>
        </DialogHeader>
        <form id={formId} className="grid gap-4" onSubmit={onSubmit} noValidate>
          <Field label="Name" htmlFor={`${uid}-name`} error={fe?.name}>
            <Input
              id={`${uid}-name`}
              name="name"
              defaultValue={person && !person.isGeneric ? person.name : ""}
              placeholder={person?.isGeneric ? "General inbox" : "Anna Schmidt"}
              autoComplete="off"
              maxLength={200}
              autoFocus
            />
          </Field>
          <div className="grid gap-1.5">
            <Field label="Email" htmlFor={`${uid}-email`} error={emailFieldError}>
              <Input
                id={`${uid}-email`}
                name="email"
                type="text"
                inputMode="email"
                autoComplete="off"
                spellCheck={false}
                defaultValue={person?.email ?? ""}
                placeholder="anna@studio.de"
                aria-invalid={fe?.email ? true : undefined}
              />
            </Field>
            {error?.link ? <InlineError error={error} /> : null}
          </div>
          <Field label="Role" htmlFor={`${uid}-role`} error={fe?.role} hint="For example Owner, Head of product or Buyer.">
            <Input id={`${uid}-role`} name="role" defaultValue={person?.role ?? ""} autoComplete="off" maxLength={200} />
          </Field>
          <InlineError error={formLevel} />
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={pending}>
            {pending ? "Saving…" : editing ? "Save changes" : "Add person"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PersonalLineOverride({ person, readOnly }: { person: PersonView; readOnly: boolean }) {
  const [editing, setEditing] = useState(false);
  const id = `person-${person.id}-line`;
  if (editing) {
    return (
      <LineEditor
        id={id}
        label={`Personal line for ${person.displayName}`}
        value={person.personalLineOverride}
        hint="Used instead of the company's line in emails to this person."
        onSave={(value) => setPersonPersonalLineAction({ personId: person.id, value })}
        onDone={() => setEditing(false)}
      />
    );
  }
  if (!person.personalLineOverride) {
    return readOnly ? null : (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="justify-self-start text-muted-foreground"
        onClick={() => setEditing(true)}
      >
        Add a personal line for this person
      </Button>
    );
  }
  return (
    <div className="grid gap-1 rounded-md bg-muted/60 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Personal line for this person</span>
        {!readOnly ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setEditing(true)}
            aria-label={`Edit the personal line for ${person.displayName}`}
          >
            Edit
          </Button>
        ) : null}
      </div>
      <p className="text-sm break-words">“{person.personalLineOverride}”</p>
    </div>
  );
}

/**
 * "Did you mean anna@yahoo.com?" under an address the check thinks is mistyped (M5-DESIGN §6.5): never applied by
 * itself; [Use this address] asks first, then changes the address with the usual person update (which clears the
 * check, so the new address needs a new one).
 */
function DidYouMean({ person, suggestion }: { person: PersonView; suggestion: string }) {
  const [confirm, setConfirm] = useState(false);
  const { pending, error, run } = usePanelAction();
  const texts = didYouMeanConfirm(suggestion);
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="break-words">{didYouMeanText(suggestion)}</span>
        <Button type="button" variant="outline" size="xs" onClick={() => setConfirm(true)} disabled={pending}>
          Use this address
        </Button>
      </div>
      <InlineError error={error} className="text-xs" />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={texts.title}
        description={texts.description}
        confirmLabel="Change address"
        onConfirm={() =>
          run(() =>
            updatePersonAction({
              personId: person.id,
              name: person.isGeneric ? "" : person.name,
              email: suggestion,
              role: person.role ?? "",
            }),
          )
        }
      />
    </div>
  );
}

function PersonCard({ person, readOnly, checker }: { person: PersonView; readOnly: boolean; checker: PersonChecker }) {
  const [editOpen, setEditOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmUnsub, setConfirmUnsub] = useState(false);
  const { run } = usePanelAction();
  const headingId = `person-${person.id}-name`;
  const showMenu = !readOnly || person.canUnsubscribe;
  const lastCheck = person.lastCheck ?? null;
  const reasonLine = person.email ? checkReasonLine(person.verificationStatus, lastCheck?.reasons) : null;
  const suggestion = !readOnly && person.email && lastCheck?.didYouMean ? lastCheck.didYouMean : null;

  return (
    <article aria-labelledby={headingId} className="grid gap-2 rounded-lg border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 id={headingId} className="font-medium break-words">
            {person.displayName}
          </h4>
          {person.role ? <p className="text-sm break-words text-muted-foreground">{person.role}</p> : null}
        </div>
        {showMenu ? (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Actions for ${person.displayName}`}>
                <Ellipsis aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {!readOnly ? (
                <DropdownMenuItem onSelect={() => setEditOpen(true)}>
                  <Pencil aria-hidden />
                  Edit
                </DropdownMenuItem>
              ) : null}
              {person.canUnsubscribe ? (
                <DropdownMenuItem onSelect={() => setConfirmUnsub(true)}>
                  <MailMinus aria-hidden />
                  Mark unsubscribed
                </DropdownMenuItem>
              ) : null}
              {!readOnly ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => setConfirmRemove(true)}>
                    <Trash2 aria-hidden />
                    Remove
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {person.email ? (
        <EmailLine email={person.email} />
      ) : (
        <p className="text-sm text-muted-foreground">No email address yet</p>
      )}

      {person.email || person.flags.length ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {person.email ? <VerificationBadge status={person.verificationStatus} /> : null}
          {person.checkedText ? <span>{person.checkedText}</span> : null}
          {person.flags.map((f) => (
            // The tooltip ("Replied on 3 Oct") is also read out, since a title alone never reaches the keyboard.
            <span key={f.label} title={f.title}>
              <FlagBadge tone={f.tone}>{f.label}</FlagBadge>
              <span className="sr-only"> ({f.title})</span>
            </span>
          ))}
          {person.email && !readOnly ? (
            <PersonCheckButton
              personId={person.id}
              email={person.email}
              checkedToday={lastCheck?.checkedWithin24h === true}
              checker={checker}
            />
          ) : null}
        </div>
      ) : null}

      {reasonLine ? <p className="text-xs text-muted-foreground">{reasonLine}</p> : null}
      {suggestion ? <DidYouMean person={person} suggestion={suggestion} /> : null}

      <p className="text-xs text-muted-foreground">{person.emailedText}</p>

      <PersonalLineOverride person={person} readOnly={readOnly} />
      <ToggleNotes
        key={person.notes}
        id={`person-${person.id}-notes`}
        label={`Notes about ${person.displayName}`}
        value={person.notes}
        readOnly={readOnly}
        addLabel="Add notes"
        onSave={(value) => setPersonNotesAction({ personId: person.id, value })}
      />

      {editOpen ? (
        <PersonFormDialog open={editOpen} onOpenChange={setEditOpen} person={person} />
      ) : null}
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove ${person.displayName}?`}
        description="They disappear from this company. Their email history is kept, and adding the same address again brings them back."
        confirmLabel="Remove"
        destructive
        onConfirm={() => run(() => removePersonAction({ personId: person.id }), { toastError: true })}
      />
      <ConfirmDialog
        open={confirmUnsub}
        onOpenChange={setConfirmUnsub}
        title={`Mark ${person.email ?? "this address"} as unsubscribed?`}
        description="Nobody will be able to email this address again, from any campaign or sender. This can't be undone here."
        confirmLabel="Mark unsubscribed"
        destructive
        onConfirm={() => run(() => markPersonUnsubscribedAction({ personId: person.id }), { toastError: true })}
      />
    </article>
  );
}

/** The checker when the panel doesn't say (real data, the default price). */
const DEFAULT_CHECKER: PersonChecker = { practiceCopy: false, pricePerCheck: 0.012 };

export function PeopleSection({
  companyId,
  people,
  readOnly,
  checker = DEFAULT_CHECKER,
}: {
  companyId: number;
  people: PersonView[];
  readOnly: boolean;
  /** Who checks addresses and at what price (the Check button's tooltip and confirmation, M5-DESIGN §6.5). */
  checker?: PersonChecker;
}) {
  const [adding, setAdding] = useState(false);
  const addButton = !readOnly ? (
    <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
      <UserPlus aria-hidden />
      Add a person
    </Button>
  ) : null;

  return (
    <PanelSection
      title={people.length ? `People (${people.length})` : "People"}
      id="company-panel-people"
      actions={people.length ? addButton : null}
    >
      {people.length === 0 ? (
        <div className="grid justify-items-center gap-3 rounded-lg border border-dashed border-border px-4 py-6 text-center">
          <p className="max-w-sm text-sm text-muted-foreground">
            No contacts yet. Add a person, or use Export for Claude on the{" "}
            <Link
              href="/contacts?view=missing-email"
              className="text-foreground underline underline-offset-2 hover:no-underline"
            >
              Missing email view
            </Link>
            .
          </p>
          {addButton}
        </div>
      ) : (
        <ul className="grid gap-3">
          {people.map((p) => (
            <li key={p.id}>
              <PersonCard person={p} readOnly={readOnly} checker={checker} />
            </li>
          ))}
        </ul>
      )}
      {adding ? <PersonFormDialog open={adding} onOpenChange={setAdding} companyId={companyId} /> : null}
    </PanelSection>
  );
}
