"use client";

import { useId, useRef, useState } from "react";
import { MailCheck, Pencil, RotateCcw, SkipForward } from "lucide-react";
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useNavigationGuard } from "@/components/navigation/nav-guard";
import { StepEditor, type StepEditorValue } from "@/components/templates/step-editor";
import { SubjectWarning, liveSubjectProblem } from "@/components/campaign-wizard/subject-warning";
import type { TemplateVariable } from "@/core/templates/variables";
import type { CompanyStatusValue } from "@/core/labels";
import { THEY_REPLIED_TEXTS } from "@/core/sending/own-mailbox";
import type { ActionResult } from "@/lib/action";
import { theyRepliedConfirm } from "@/components/company-panel/types";
import { SETTINGS_DIALOG_CLASS } from "@/components/settings/dialog-classes";
import {
  discardUnsentEditAction,
  editUnsentEmailAction,
  retryEmailAction,
  skipRecipientAction,
} from "@/app/(app)/campaigns/[id]/actions";
import { theStep } from "./format";
import { useHoldLiveRefresh } from "./live-refresh";
import { useCampaignAction } from "./use-campaign-action";

/**
 * The recipient panel's buttons: Skip (with a confirmation), Try again (an email that didn't
 * send), "Retry or Skip?" (an email we couldn't confirm with Mailgun), and "Edit this email" for an
 * email that hasn't been sent (this person only). The engine has the final word: an email the
 * background sender already picked up is refused politely.
 */

export function SkipRecipientButton({ campaignId, recipientId, who }: { campaignId: number; recipientId: number; who: string }) {
  const { pending, run } = useCampaignAction();
  const [open, setOpen] = useState(false);
  useHoldLiveRefresh(open);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={pending}>
        <SkipForward aria-hidden />
        Skip
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          if (!pending) setOpen(o);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Skip {who}?</AlertDialogTitle>
            <AlertDialogDescription>
              Their emails that are waiting won&apos;t be sent, and they get nothing more from this campaign. Emails
              already sent stay as they are. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep them</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                run(() => skipRecipientAction({ campaignId, recipientId }), { toastError: true, onSuccess: () => setOpen(false) });
              }}
            >
              {pending ? "Skipping…" : `Skip ${who}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** The They replied Server Action (`markRepliedAction` of the company panel), handed down by the server-rendered panel. */
export type MarkRepliedCall = (input: { companyId: number; personId?: number }) => Promise<ActionResult<unknown>>;

/**
 * "They replied" for this person (MAIN-DOMAIN-DESIGN O17, §3.8): after a confirmation that says whether the company's
 * status changes, every follow-up to the company stops in every campaign, this person as the one who replied. The panel
 * passes the Server Action in (`markReplied`), so this file loads no Server Action module of its own for it.
 */
export function MarkRepliedButton({
  companyId,
  companyName,
  personId,
  personName,
  status,
  countsAsReply,
  markReplied,
}: {
  companyId: number;
  companyName: string;
  /** Null when the person was removed from the company: then the whole company is marked. */
  personId: number | null;
  personName: string;
  status: CompanyStatusValue;
  countsAsReply: boolean;
  markReplied: MarkRepliedCall;
}) {
  const { pending, run } = useCampaignAction();
  const [open, setOpen] = useState(false);
  const descriptionId = useId();
  useHoldLiveRefresh(open);
  const t = theyRepliedConfirm({ company: companyName, person: personId ? personName : null, countsAsReply, status });
  return (
    <>
      {/* Review SCREENS-09 (WCAG 2.5.3 Label in Name): the name is the visible "They replied"; what it does is its description. */}
      <Button variant="outline" size="sm" aria-describedby={descriptionId} onClick={() => setOpen(true)} disabled={pending}>
        <MailCheck aria-hidden />
        {THEY_REPLIED_TEXTS.button}
      </Button>
      <span id={descriptionId} className="sr-only">
        {THEY_REPLIED_TEXTS.ariaLabel}
      </span>
      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          if (!pending) setOpen(o);
        }}
      >
        <AlertDialogContent className={SETTINGS_DIALOG_CLASS}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.title}</AlertDialogTitle>
            <AlertDialogDescription>{t.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>{THEY_REPLIED_TEXTS.cancel}</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                run(() => markReplied(personId ? { companyId, personId } : { companyId }), {
                  toastError: true,
                  onSuccess: () => setOpen(false),
                });
              }}
            >
              {THEY_REPLIED_TEXTS.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function RetryEmailButton({ campaignId, emailId, label = "Try again" }: { campaignId: number; emailId: number; label?: string }) {
  const { pending, error, run } = useCampaignAction();
  return (
    <div className="grid justify-items-start gap-1">
      <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => retryEmailAction({ campaignId, emailId }))}>
        <RotateCcw aria-hidden />
        {pending ? "Trying again…" : label}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * "Retry or Skip?" for an email we couldn't confirm with Mailgun (M3-DESIGN §5.8, B6.7). Retry sends
 * it again with the same Message-ID, so the person may get it twice; Skip sends nothing more to them
 * in this campaign. For a live campaign Skip is the main choice and Retry needs the explicit "anyway";
 * in test mode (nothing is delivered) Retry is the main choice.
 */
export function RetryOrSkipButton({
  campaignId,
  emailId,
  recipientId,
  who,
  address,
  mode,
}: {
  campaignId: number;
  emailId: number;
  recipientId: number;
  /** "Anna" / "Anna Berg". */
  who: string;
  /** anna@studio.de */
  address: string;
  mode: "TEST" | "LIVE" | "DRY_RUN" | null;
}) {
  const { pending, error, run, setError } = useCampaignAction();
  const [open, setOpen] = useState(false);
  useHoldLiveRefresh(open);
  const live = mode === "LIVE";
  const retry = () =>
    run(() => retryEmailAction({ campaignId, emailId, confirmDuplicateRisk: live }), { onSuccess: () => setOpen(false) });
  const skip = () => run(() => skipRecipientAction({ campaignId, recipientId }), { onSuccess: () => setOpen(false) });
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        disabled={pending}
      >
        <RotateCcw aria-hidden />
        Retry or skip
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          if (!pending) setOpen(o);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retry or Skip?</AlertDialogTitle>
            <AlertDialogDescription>
              We couldn&apos;t confirm with Mailgun whether this email reached {address}. Retry sends it again. If the first one
              did arrive, {who} gets it twice. Skip sends nothing more to {who} in this campaign.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Decide later</AlertDialogCancel>
            {live ? (
              <>
                <Button type="button" variant="outline" disabled={pending} onClick={retry}>
                  Retry anyway
                </Button>
                <AlertDialogAction
                  disabled={pending}
                  onClick={(e) => {
                    e.preventDefault();
                    skip();
                  }}
                >
                  {pending ? "Saving…" : "Skip"}
                </AlertDialogAction>
              </>
            ) : (
              <>
                <Button type="button" variant="outline" disabled={pending} onClick={skip}>
                  Skip
                </Button>
                <AlertDialogAction
                  disabled={pending}
                  onClick={(e) => {
                    e.preventDefault();
                    retry();
                  }}
                >
                  {pending ? "Saving…" : "Retry"}
                </AlertDialogAction>
              </>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export type EditEmailProps = {
  campaignId: number;
  recipientId: number;
  step: number;
  /** Who gets it: "Anna Berg". */
  who: string;
  /** The text the editor starts with: this person's own version, or the campaign's. */
  initial: { subject: string | null; body: string };
  /** The campaign's text for this step (a subject left equal to it keeps following the campaign). */
  campaignText: { subject: string | null; body: string };
  /** This person already has their own version of this email. */
  hasEdit: boolean;
  variables: TemplateVariable[];
};

/** True when a key press came from a text field: Esc there must not close an editor and lose the text. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  return typeof el?.closest === "function" && el.closest("input, textarea, select, [contenteditable='true']") != null;
}

/** "Discard your changes?": closing the editor, or leaving the page, while the text differs from what's saved. */
type DiscardQuestion = { leaving: boolean; discard: () => void; keep: () => void };

export function EditEmailButton(props: EditEmailProps) {
  const { campaignId, recipientId, step, who, initial, campaignText, hasEdit, variables } = props;
  const showSubject = step === 0;
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<StepEditorValue>({ subject: initial.subject ?? "", body: initial.body });
  const [question, setQuestion] = useState<DiscardQuestion | null>(null);
  const questionRef = useRef<DiscardQuestion | null>(null);
  const save = useCampaignAction();
  const discard = useCampaignAction();
  const pending = save.pending || discard.pending;
  const dirty = value.body !== initial.body || (showSubject && (value.subject ?? "") !== (initial.subject ?? ""));
  useHoldLiveRefresh(open);

  function ask(next: DiscardQuestion | null) {
    questionRef.current?.keep(); // a newer question replaces an unanswered one
    questionRef.current = next;
    setQuestion(next);
  }

  function answer(discardChanges: boolean) {
    const current = questionRef.current;
    questionRef.current = null;
    setQuestion(null);
    if (discardChanges) current?.discard();
    else current?.keep();
  }

  // Leaving the page with typed text (a link, the search menu, the bell, Back) asks first too.
  useNavigationGuard({
    active: open && dirty,
    protectBack: true,
    onLeave: (request) => ask({ leaving: true, discard: request.proceed, keep: request.cancel }),
  });

  /** Esc (outside a text field), a click outside, the close button or Cancel: only asks when the text changed. */
  function requestClose() {
    if (pending) return;
    if (!dirty) {
      setOpen(false);
      return;
    }
    ask({ leaving: false, discard: () => setOpen(false), keep: () => undefined });
  }

  function openEditor() {
    setValue({ subject: initial.subject ?? "", body: initial.body });
    save.setError(null);
    discard.setError(null);
    setOpen(true);
  }

  function onSave() {
    const subject = (value.subject ?? "").trim();
    const sameAsCampaign = subject.replace(/\s+/g, " ") === (campaignText.subject ?? "").trim().replace(/\s+/g, " ");
    save.run(
      () =>
        editUnsentEmailAction({
          campaignId,
          recipientId,
          step,
          subject: showSubject && !sameAsCampaign ? subject : null,
          body: value.body,
        }),
      { onSuccess: () => setOpen(false) },
    );
  }

  function onDiscard() {
    discard.run(() => discardUnsentEditAction({ campaignId, recipientId, step }), { onSuccess: () => setOpen(false) });
  }

  const error = save.error ?? discard.error;
  // A first subject may not start with "Re:" or "Fwd:"; "Art: …" only warns (M4-DESIGN §2.13).
  const subjectProblem = showSubject ? liveSubjectProblem(value.subject) : { error: null, warning: null };

  return (
    <>
      <Button variant="outline" size="sm" onClick={openEditor}>
        <Pencil aria-hidden />
        Edit this email
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (o) setOpen(true);
          else requestClose();
        }}
      >
        <DialogContent
          className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl"
          onEscapeKeyDown={(e) => {
            // Esc while typing (a spell-check popup, a stray key) keeps the editor open.
            if (isTypingTarget(e.target)) e.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              Edit {theStep(step)} for {who}
            </DialogTitle>
            <DialogDescription>
              Only {who} gets this version. Everyone else keeps the campaign&apos;s text.
              {step > 0 ? " Follow-ups keep the “Re:” subject of the first email." : ""}
            </DialogDescription>
          </DialogHeader>
          <StepEditor
            id={`recipient-${recipientId}-step-${step}`}
            value={value}
            onChange={setValue}
            variables={variables}
            showSubject={showSubject}
            subjectError={subjectProblem.error}
            controls={subjectProblem.warning ? <SubjectWarning text={subjectProblem.warning} /> : null}
            disabled={pending}
            showCheatSheet
          />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter className="flex-wrap gap-2 sm:justify-between">
            <div>
              {hasEdit ? (
                <Button type="button" variant="ghost" onClick={onDiscard} disabled={pending}>
                  {discard.pending ? "Going back…" : "Use the campaign's text again"}
                </Button>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={requestClose} disabled={pending}>
                Cancel
              </Button>
              <Button type="button" onClick={onSave} disabled={pending || !value.body.trim() || !dirty || Boolean(subjectProblem.error)}>
                {save.pending ? "Saving…" : `Save for ${who}`}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={question !== null}
        onOpenChange={(o) => {
          if (!o) answer(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your changes to {who}&apos;s email aren&apos;t saved. If you {question?.leaving ? "leave this page" : "close the editor"} now,
              they&apos;re lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => answer(true)}>
              {question?.leaving ? "Discard and leave" : "Discard and close"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
