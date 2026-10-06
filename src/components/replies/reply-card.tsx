"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/action";
import type { WaitingReplyView } from "@/server/services/replies/waiting";
import {
  addReplySenderAction,
  confirmReplyAction,
  markReplyAnsweredAction,
  markReplyNotNeededAction,
  reopenReplyAction,
} from "@/app/(app)/notifications/reply-actions";
import { addSenderText, replyBadgeText, replyMetaParts, replySenderText } from "./format";
import { LinkReplyDialog } from "./link-reply-dialog";
import { tellBell } from "./tell-bell";

const OFFLINE = "Couldn't reach the app. Check your connection and try again.";

type Outcome = ActionResult<{ message: string }>;

/**
 * One reply waiting for an answer (M4-DESIGN §9.1): who wrote, the kind badge (and "Dry run" / "Test"), when and about
 * what, the first lines as plain text, and the actions for its kind:
 *  - Reply: Answered, No answer needed (both with Undo), and "Add jonas@firma.de to Firma GmbH" when the sender isn't a
 *    contact;
 *  - Real reply?: why the app isn't sure, then Real reply / It was an auto-reply (the second asks first);
 *  - Reply we couldn't link to a company: the hints, then Link to a company, Answered, No answer needed.
 * On a phone the card is one column and its actions wrap onto the next line.
 */
export function ReplyCard({
  reply,
  showAssignee,
  highlighted = false,
}: {
  reply: WaitingReplyView;
  /** Everyone's view: "· waiting for Ali". */
  showAssignee: boolean;
  /** The reply the page was opened for (`?reply=`). */
  highlighted?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmAuto, setConfirmAuto] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const headingId = `reply-${reply.id}-from`;
  const companyName = reply.company?.name ?? "this company";

  function done(res: Outcome, opts: { undo?: boolean } = {}) {
    if (!res.ok) {
      toast.error(res.error);
      return false;
    }
    toast.success(
      res.data.message,
      opts.undo ? { duration: 10_000, action: { label: "Undo", onClick: () => undo() } } : undefined,
    );
    tellBell();
    router.refresh();
    return true;
  }

  function run(fn: () => Promise<Outcome>, opts: { undo?: boolean; onSuccess?: () => void } = {}) {
    startTransition(async () => {
      try {
        if (done(await fn(), opts)) opts.onSuccess?.();
      } catch {
        toast.error(OFFLINE);
      }
    });
  }

  function undo() {
    run(() => reopenReplyAction({ id: reply.id }));
  }

  const answerButtons = (
    <>
      <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => markReplyAnsweredAction({ id: reply.id }), { undo: true })}>
        Answered
      </Button>
      <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => markReplyNotNeededAction({ id: reply.id }), { undo: true })}>
        No answer needed
      </Button>
    </>
  );
  const addButton = reply.canAddPerson ? (
    <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => addReplySenderAction({ id: reply.id }))}>
      {addSenderText(reply)}
    </Button>
  ) : null;

  return (
    <article
      aria-labelledby={headingId}
      className={cn(
        "grid min-w-0 gap-2 rounded-xl bg-card p-4 ring-1 ring-foreground/10",
        highlighted && "ring-2 ring-brand",
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h3 id={headingId} className="min-w-0 text-sm font-semibold break-words">
          {replySenderText(reply)}
          {reply.company ? (
            <>
              {" · "}
              <Link href={`/contacts?company=${reply.company.id}`} className="underline underline-offset-4 hover:no-underline">
                {reply.company.name}
              </Link>
            </>
          ) : null}
        </h3>
        <Badge variant="outline">{replyBadgeText(reply.kind)}</Badge>
        {reply.label ? <Badge variant="secondary">{reply.label}</Badge> : null}
      </div>

      <p className="text-xs text-muted-foreground break-words">
        <time dateTime={reply.receivedIso} title={reply.receivedExact}>
          {replyMetaParts(reply, { showAssignee }).join(" · ")}
        </time>
      </p>
      {reply.quietLine ? <p className="text-xs text-muted-foreground">{reply.quietLine}</p> : null}

      {reply.firstLines ? (
        <blockquote className="rounded-md border-l-2 border-border bg-muted/40 px-3 py-2 text-sm whitespace-pre-wrap text-muted-foreground break-words">
          {reply.firstLines}
        </blockquote>
      ) : null}

      {reply.whyLines.length > 0 ? (
        <div className="grid gap-1 text-sm">
          <p>The app isn&apos;t sure this is a real reply:</p>
          <ul className="grid list-disc gap-0.5 pl-5 text-muted-foreground">
            {reply.whyLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {reply.hints.length > 0 ? (
        <ul className="grid gap-0.5 text-sm text-muted-foreground">
          {reply.hints.map((hint) => (
            <li key={hint}>{hint}</li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap gap-2 pt-1">
        {reply.kind === "REPLY" ? (
          <>
            {answerButtons}
            {addButton}
          </>
        ) : reply.kind === "POSSIBLE_REPLY" ? (
          <>
            <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => confirmReplyAction({ id: reply.id, real: true }))}>
              Real reply
            </Button>
            <Button variant="outline" size="sm" disabled={pending} onClick={() => setConfirmAuto(true)}>
              It was an auto-reply
            </Button>
            {addButton}
          </>
        ) : (
          <>
            <Button variant="outline" size="sm" disabled={pending} onClick={() => setLinkOpen(true)}>
              Link to a company
            </Button>
            {answerButtons}
          </>
        )}
      </div>

      <AlertDialog open={confirmAuto} onOpenChange={(open) => !pending && setConfirmAuto(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark as automatic?</AlertDialogTitle>
            <AlertDialogDescription>
              Follow-ups to {companyName} will continue. Only do this if the message really was automatic.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                run(() => confirmReplyAction({ id: reply.id, real: false }), { onSuccess: () => setConfirmAuto(false) });
              }}
            >
              {pending ? "Marking…" : "Mark as automatic"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {reply.kind === "UNLINKED" ? <LinkReplyDialog reply={reply} open={linkOpen} onOpenChange={setLinkOpen} /> : null}
    </article>
  );
}
