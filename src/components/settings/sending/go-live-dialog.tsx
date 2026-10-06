"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { GO_LIVE_COPY } from "@/core/sending/go-live-copy";
import { goLiveAction } from "@/app/(app)/settings/sending/actions";

const OFFLINE = "Couldn't reach the app, so nothing changed. Check your connection and try again.";

/** Dialogs open full screen on a phone (below 640 px). */
const PHONE_DIALOG =
  "max-h-dvh overflow-y-auto sm:max-w-lg max-sm:inset-0 max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none";

/** One required tick box of the dialog: a checkbox and its label (the error, when any, is described by `errorId`). */
export function DialogTick({
  id,
  label,
  checked,
  onChange,
  disabled,
  errorId,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  errorId?: string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        disabled={disabled}
        className="mt-0.5"
        aria-describedby={errorId}
      />
      <Label htmlFor={id} className="leading-snug font-normal [overflow-wrap:anywhere]">
        {label}
      </Label>
    </div>
  );
}

/**
 * "Go live?" (M6-DESIGN §2.5): what going live does (the list comes worded from the server, incl. today's hand-set
 * limit and the drafts that would send real email), a required tick "I understand that real prospects will get emails
 * from now on.", then **Go live** (the page's one orange button while the dialog is open, off until ticked) or **Not
 * yet**. A refusal shows its sentences under the tick box and keeps the dialog open; Escape and Not yet close it
 * without change. SHARED-FROM-DESIGN F12: while the reply test recorded a spam placement (`spamPlacementTick`), a second
 * required tick ("I know the reply test's email landed in spam at …"), sent as `confirmSpamPlacement` (the server checks
 * it too). MAIN-DOMAIN-DESIGN O14, O20 (own-mailbox mode): the replies tick (`ownMailboxTick`, always there) and, while
 * unsubscribe links use http, the http-links tick (`httpLinksTick`), sent as `confirmOwnMailbox` and `confirmHttpLinks`
 * with the existing confirm and checked in that order, before the spam tick (the server checks them too). Without them
 * the dialog sends exactly what it sent before.
 */
export function GoLiveDialog({
  open,
  onOpenChange,
  items,
  spamPlacementTick = null,
  ownMailboxTick = null,
  httpLinksTick = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: string[];
  spamPlacementTick?: string | null;
  ownMailboxTick?: string | null;
  httpLinksTick?: string | null;
}) {
  const router = useRouter();
  const id = useId();
  const [confirmed, setConfirmed] = useState(false);
  const [spamConfirmed, setSpamConfirmed] = useState(false);
  const [ownConfirmed, setOwnConfirmed] = useState(false);
  const [httpConfirmed, setHttpConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const needsSpamTick = Boolean(spamPlacementTick);
  const needsOwnTick = Boolean(ownMailboxTick);
  const needsHttpTick = Boolean(httpLinksTick);

  function clearTicks() {
    setConfirmed(false);
    setSpamConfirmed(false);
    setOwnConfirmed(false);
    setHttpConfirmed(false);
  }

  function setOpen(next: boolean) {
    if (pending) return;
    onOpenChange(next);
    if (!next) {
      clearTicks();
      setError(null);
    }
  }

  function go() {
    setError(null);
    if (needsOwnTick && !ownConfirmed) {
      setError(GO_LIVE_COPY.ownMailboxRequired);
      return;
    }
    if (needsHttpTick && !httpConfirmed) {
      setError(GO_LIVE_COPY.httpLinksRequired);
      return;
    }
    if (needsSpamTick && !spamConfirmed) {
      setError(GO_LIVE_COPY.spamPlacementRequired);
      return;
    }
    startTransition(async () => {
      try {
        const res = await goLiveAction({
          confirm: true,
          ...(needsSpamTick ? { confirmSpamPlacement: spamConfirmed } : {}),
          ...(needsOwnTick ? { confirmOwnMailbox: ownConfirmed } : {}),
          ...(needsHttpTick ? { confirmHttpLinks: httpConfirmed } : {}),
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        toast.success(res.message ?? GO_LIVE_COPY.toast);
        onOpenChange(false);
        clearTicks();
        router.refresh();
      } catch {
        setError(OFFLINE);
      }
    });
  }

  const errorId = error ? `${id}-error` : undefined;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className={PHONE_DIALOG}>
        <DialogHeader>
          <DialogTitle>{GO_LIVE_COPY.dialogTitle}</DialogTitle>
          <DialogDescription asChild>
            <ul className="grid list-disc gap-1.5 pl-5">
              {items.map((item) => (
                <li key={item} className="[overflow-wrap:anywhere]">
                  {item}
                </li>
              ))}
            </ul>
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {ownMailboxTick ? (
            <DialogTick
              id={`${id}-own`}
              label={ownMailboxTick}
              checked={ownConfirmed}
              onChange={setOwnConfirmed}
              disabled={pending}
              errorId={errorId}
            />
          ) : null}
          {httpLinksTick ? (
            <DialogTick
              id={`${id}-http`}
              label={httpLinksTick}
              checked={httpConfirmed}
              onChange={setHttpConfirmed}
              disabled={pending}
              errorId={errorId}
            />
          ) : null}
          {spamPlacementTick ? (
            <DialogTick
              id={`${id}-spam`}
              label={spamPlacementTick}
              checked={spamConfirmed}
              onChange={setSpamConfirmed}
              disabled={pending}
              errorId={errorId}
            />
          ) : null}
          <DialogTick
            id={`${id}-confirm`}
            label={GO_LIVE_COPY.confirmLabel}
            checked={confirmed}
            onChange={setConfirmed}
            disabled={pending}
            errorId={errorId}
          />
          {error ? (
            <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            {GO_LIVE_COPY.cancelButton}
          </Button>
          <Button onClick={go} disabled={!confirmed || pending}>
            {pending ? GO_LIVE_COPY.savingLabel : GO_LIVE_COPY.confirmButton}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
