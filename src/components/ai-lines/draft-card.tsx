"use client";

import { useEffect, useId, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ExternalLink, Info, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useHoldLiveRefresh } from "@/components/campaigns/live-refresh";
import { OFFLINE_TEXT } from "@/components/ai/phone-dialog";
import { PERSONAL_LINE_MAX_CHARS, PERSONAL_LINE_GOOD_WORDS, wordCount } from "@/components/company-panel/emailed-text";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/action";
import {
  approveDraftAction,
  regenerateDraftAction,
  rejectDraftAction,
  retryDraftAction,
  undoDraftAction,
} from "@/app/(app)/ai-lines/actions";
import { EDIT_TOO_LONG_TEXT, editCounterText, type DraftCardDisplay } from "./format";

/** Undo is offered this long after Approve or Reject (the server allows 60 s, D20). */
const UNDO_TOAST_MS = 10_000;

function oneLine(s: string): string {
  return s.replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
}

/** The quote in its place on the saved page, with the quote itself marked (neutral, never orange). */
function Snippet({ card }: { card: DraftCardDisplay }) {
  if (!card.snippet && !card.quote) return null;
  return (
    <div className="grid gap-1.5">
      <p className="text-xs text-muted-foreground">Based on this on their website:</p>
      {card.snippet ? (
        <blockquote className="rounded-md border-l-2 border-border bg-muted/40 px-3 py-2 text-sm break-words whitespace-pre-line">
          {card.snippet.before}
          <mark className="rounded-sm bg-foreground/15 px-0.5 text-foreground">{card.snippet.match}</mark>
          {card.snippet.after}
        </blockquote>
      ) : (
        <>
          {card.quote ? (
            <blockquote className="rounded-md border-l-2 border-border bg-muted/40 px-3 py-2 text-sm break-words">“{card.quote}”</blockquote>
          ) : null}
          {card.snippetNote ? <p className="text-xs text-muted-foreground">{card.snippetNote}</p> : null}
        </>
      )}
      {card.pageHref ? (
        <a
          href={card.pageHref}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="inline-flex w-fit items-center gap-1 text-sm underline underline-offset-4 hover:no-underline"
        >
          Open the page
          <ExternalLink className="size-3.5" aria-hidden />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : null}
    </div>
  );
}

/** The automatic checks' warnings (a warning icon) and notes about how the line was made (an info icon). */
function Flags({ flags }: { flags: DraftCardDisplay["flags"] }) {
  if (flags.length === 0) return null;
  return (
    <ul className="grid gap-1" aria-label="Warnings">
      {flags.map((f) => (
        <li key={`${f.code}:${f.text}`} className="flex items-start gap-1.5 text-sm">
          {f.note ? (
            <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
          )}
          <span className={cn("min-w-0 break-words", f.note && "text-muted-foreground")}>{f.text}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One card on the AI lines page (docs/dev/M5-DESIGN.md §6.7), by status:
 *  - Waiting: the line and its word count, the quote in its place on the website, warnings, the line it replaces, the
 *    cost; Approve, Edit then approve, Reject, Regenerate (write a new line, or read the website again first);
 *  - Approved / Rejected: who decided and when; Regenerate (and Approve on a rejected line); Undo for the reviewer for
 *    10 seconds (the server allows 60);
 *  - No line: why, when it was checked; Try again, Write one yourself;
 *  - Failed: the sentence, the request id under "Details"; Try again.
 * Website text and Claude's lines are plain text (React escapes them). Buttons wrap on a phone; nothing here is orange.
 */
export function DraftCard({ card }: { card: DraftCardDisplay }) {
  const router = useRouter();
  const editId = useId();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(card.line ?? "");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [undoVisible, setUndoVisible] = useState(card.canUndoUntil !== null);
  useHoldLiveRefresh(editing);

  useEffect(() => {
    if (!card.canUndoUntil) return;
    const ms = Date.parse(card.canUndoUntil) - Date.now();
    const timer = window.setTimeout(() => setUndoVisible(false), Math.max(0, ms));
    return () => window.clearTimeout(timer);
  }, [card.canUndoUntil]);

  function run<T>(fn: () => Promise<ActionResult<T>>, opts: { undo?: boolean; onSuccess?: () => void; onError?: (res: ActionResult<T> & { ok: false }) => boolean } = {}) {
    startTransition(async () => {
      try {
        const res = await fn();
        if (!res.ok) {
          if (!opts.onError?.(res)) toast.error(res.error);
          return;
        }
        toast.success(
          res.message ?? "Done.",
          opts.undo ? { duration: UNDO_TOAST_MS, action: { label: "Undo", onClick: () => undo() } } : undefined,
        );
        opts.onSuccess?.();
        router.refresh();
      } catch {
        toast.error(OFFLINE_TEXT);
      }
    });
  }

  function undo() {
    run(() => undoDraftAction({ draftId: card.id }));
  }

  function approve(line?: string) {
    setFieldError(null);
    run(() => approveDraftAction(line === undefined ? { draftId: card.id } : { draftId: card.id, line }), {
      undo: true,
      onSuccess: () => setEditing(false),
      onError: (res) => {
        const msg = res.fieldErrors?.line?.[0];
        if (!msg || !editing) return false;
        setFieldError(msg);
        return true;
      },
    });
  }

  const regenerate = (refetch: boolean) => run(() => regenerateDraftAction({ draftId: card.id, refetch }));
  const retry = () => run(() => retryDraftAction({ draftId: card.id }));

  const headingId = `draft-${card.id}-company`;
  const chars = oneLine(draft).length;
  const words = wordCount(draft);
  const tooLong = chars > PERSONAL_LINE_MAX_CHARS;
  const status = card.status;

  const regenerateMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" disabled={pending}>
          Regenerate <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-1rem)]">
        <DropdownMenuItem onSelect={() => regenerate(false)}>Write a new line</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => regenerate(true)}>Read the website again and write a new line</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const undoButton =
    undoVisible && card.canUndoUntil ? (
      <Button type="button" variant="outline" size="sm" disabled={pending} onClick={undo}>
        Undo
      </Button>
    ) : null;

  return (
    <article aria-labelledby={headingId} className="grid min-w-0 gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <h3 id={headingId} className="min-w-0 font-semibold break-words">
          <Link href={`/contacts?company=${card.companyId}`} className="underline-offset-4 hover:underline">
            {card.companyName}
          </Link>
        </h3>
        {card.host ? (
          // A long host breaks anywhere rather than pushing the card past a phone's width.
          <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">
            {"· "}
            {status === "NO_LINE" && card.websiteHref ? (
              <a href={card.websiteHref} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-4 hover:no-underline">
                {card.host}
              </a>
            ) : (
              card.host
            )}
          </span>
        ) : null}
        {card.metaLine ? <span className="text-muted-foreground">· {card.metaLine}</span> : null}
      </div>

      {status === "NO_LINE" ? <p className="text-sm">{card.noLineText ?? "No line was drafted."}</p> : null}
      {status === "FAILED" ? (
        <div className="grid gap-1">
          <p className="text-sm">{card.error ?? "Claude couldn't write a line for this company. Click Try again later."}</p>
          {card.requestId ? (
            <details className="text-sm text-muted-foreground">
              <summary className="cursor-pointer">Details</summary>
              <p className="mt-1 font-mono text-xs break-all">Request id {card.requestId}</p>
            </details>
          ) : null}
        </div>
      ) : null}

      {status === "READY" || status === "APPROVED" || status === "REJECTED" ? (
        editing ? (
          <form
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!tooLong) approve(draft);
            }}
          >
            <Label htmlFor={editId} className="sr-only">
              The personal line
            </Label>
            <Textarea
              id={editId}
              value={draft}
              rows={3}
              autoFocus
              aria-describedby={`${editId}-counter`}
              aria-invalid={tooLong || fieldError ? true : undefined}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(false);
                }
              }}
            />
            <p id={`${editId}-counter`} className={cn("text-xs tabular-nums", words > PERSONAL_LINE_GOOD_WORDS ? "text-warning" : "text-muted-foreground")}>
              {editCounterText(words)}
            </p>
            {tooLong ? (
              <p className="text-sm text-destructive" role="alert">
                {EDIT_TOO_LONG_TEXT}
              </p>
            ) : null}
            {fieldError && !tooLong ? (
              <p className="text-sm text-destructive" role="alert">
                {fieldError}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="outline" size="sm" disabled={pending || tooLong}>
                {pending ? "Approving…" : "Approve this line"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => {
                  setEditing(false);
                  setFieldError(null);
                  setDraft(card.line ?? "");
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : card.line ? (
          <div className="grid gap-1">
            <p className="text-base leading-relaxed break-words">{card.line}</p>
            {card.wordsText ? <p className="text-xs text-muted-foreground">{card.wordsText}</p> : null}
          </div>
        ) : null
      ) : null}

      {status === "READY" || status === "REJECTED" || status === "APPROVED" ? <Snippet card={card} /> : null}
      <Flags flags={card.flags} />
      {card.currentLineText && (status === "READY" || status === "REJECTED") ? (
        <p className="text-sm text-muted-foreground break-words">{card.currentLineText}</p>
      ) : null}
      {card.reviewedText ? <p className="text-sm text-muted-foreground">{card.reviewedText}</p> : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {status === "READY" && !editing ? (
            <>
              <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => approve()}>
                Approve
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => {
                  setDraft(card.line ?? "");
                  setEditing(true);
                }}
              >
                Edit then approve
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => run(() => rejectDraftAction({ draftId: card.id }), { undo: true })}
              >
                Reject
              </Button>
              {regenerateMenu}
            </>
          ) : null}
          {status === "REJECTED" && !editing ? (
            <>
              <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => approve()}>
                Approve
              </Button>
              {regenerateMenu}
              {undoButton}
            </>
          ) : null}
          {status === "APPROVED" ? (
            <>
              {regenerateMenu}
              {undoButton}
            </>
          ) : null}
          {status === "NO_LINE" ? (
            <>
              <Button type="button" variant="outline" size="sm" disabled={pending} onClick={retry}>
                Try again
              </Button>
              <Button asChild variant="ghost" size="sm">
                <Link href={`/contacts?company=${card.companyId}#company-panel-line`}>Write one yourself</Link>
              </Button>
            </>
          ) : null}
          {status === "FAILED" ? (
            <Button type="button" variant="outline" size="sm" disabled={pending} onClick={retry}>
              Try again
            </Button>
          ) : null}
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          <span className="sr-only">Cost </span>
          {card.costText}
        </span>
      </div>
    </article>
  );
}
