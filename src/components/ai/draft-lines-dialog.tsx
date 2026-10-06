"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { FormError } from "@/components/forms/field";
import { Notice } from "@/components/campaigns/notice";
import type { ActionResult } from "@/lib/action";
import { estimateDraftLinesAction, startDraftLinesAction } from "@/app/(app)/contacts/ai-actions";
import {
  DRAFT_DIALOG_INTRO,
  DRAFT_DIALOG_LOADING,
  draftDialogTexts,
  type DraftDialogFacts,
  type DraftLinesTarget,
  type StartDraftLinesInput,
} from "./draft-lines-text";
import { OFFLINE_TEXT, PHONE_FULL_SCREEN_DIALOG } from "./phone-dialog";

const START_OFFLINE = "Couldn't reach the app, so no drafting was started. Check your connection and try again.";

/** The start input for a target, with "Draft new lines for these too" and the "at most" the dialog showed. */
function startInput(target: DraftLinesTarget, redraft: boolean, atMostUsd: number): StartDraftLinesInput {
  if ("companyIds" in target) return { companyIds: target.companyIds, redraft, confirmedAtMostUsd: atMostUsd };
  if ("listId" in target) return { listId: target.listId, redraft, confirmedAtMostUsd: atMostUsd };
  return { companyId: target.companyId, redraft: true, confirmedAtMostUsd: atMostUsd };
}

/**
 * The dialog's inside, mounted while it is open: asks the server who can be drafted and what it costs (again when
 * "Draft new lines for these too" changes), shows the §6.8 lines, and starts the run with the "at most" it showed. The
 * server re-checks everything; a refusal (the estimate grew, the queue was paused meanwhile…) shows here.
 */
function DraftLinesBody({
  target,
  context,
  onClose,
  onStarted,
}: {
  target: DraftLinesTarget;
  context?: string;
  onClose: () => void;
  onStarted?: (run: { jobId: number; count: number }) => void;
}) {
  const router = useRouter();
  const checkboxId = useId();
  const [redraft, setRedraft] = useState(false);
  const [facts, setFacts] = useState<DraftDialogFacts | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const request = useRef(0);
  const targetKey = JSON.stringify(target);

  /** Shows an estimate's answer (null: the app couldn't be reached). */
  const receive = useCallback((res: ActionResult<DraftDialogFacts> | null) => {
    setLoading(false);
    if (!res) setLoadError(OFFLINE_TEXT);
    else if (res.ok) {
      setFacts(res.data);
      setLoadError(null);
    } else setLoadError(res.error);
  }, []);

  /** Asks the server; only the newest request's answer is shown (the checkbox may be clicked again meanwhile). */
  const ask = useCallback(
    (forTarget: DraftLinesTarget, redraftNow: boolean) => {
      const id = ++request.current;
      estimateDraftLinesAction(forTarget, { redraft: redraftNow }).then(
        (res) => (id === request.current ? receive(res) : undefined),
        () => (id === request.current ? receive(null) : undefined),
      );
    },
    [receive],
  );

  useEffect(() => {
    ask(JSON.parse(targetKey) as DraftLinesTarget, false);
  }, [targetKey, ask]);

  function toggleRedraft(next: boolean) {
    setRedraft(next);
    setLoading(true);
    setStartError(null);
    ask(target, next);
  }

  function start() {
    if (!facts) return;
    setStartError(null);
    startTransition(async () => {
      try {
        const res = await startDraftLinesAction(startInput(target, redraft, facts.estimate.atMostUsd));
        if (!res.ok) {
          setStartError(res.error);
          return;
        }
        toast.success(res.message ?? "Drafting started.", {
          action: { label: "Open AI lines", onClick: () => router.push("/ai-lines") },
        });
        onStarted?.(res.data);
        onClose();
        router.refresh();
      } catch {
        setStartError(START_OFFLINE);
      }
    });
  }

  const texts = facts ? draftDialogTexts(facts) : null;
  const single = "companyId" in target;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{texts?.title ?? (single ? "Draft a personal line" : "Draft personal lines")}</DialogTitle>
        <DialogDescription>{DRAFT_DIALOG_INTRO}</DialogDescription>
      </DialogHeader>
      {context ? <p className="text-sm text-muted-foreground">{context}</p> : null}
      {!texts && loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          {DRAFT_DIALOG_LOADING}
        </p>
      ) : null}
      <FormError message={loadError} />
      {texts ? (
        <div className="grid gap-3 text-sm" aria-busy={loading || undefined}>
          {texts.countLine ? <p className="font-medium">{texts.countLine}</p> : null}
          {texts.skipLines.length > 0 || texts.hasLineLine ? (
            <ul className="grid gap-1 text-muted-foreground">
              {texts.skipLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
              {texts.hasLineLine ? <li>{texts.hasLineLine}</li> : null}
            </ul>
          ) : null}
          {texts.redraftLabel ? (
            <div className="flex items-start gap-2">
              <Checkbox
                id={checkboxId}
                checked={redraft}
                onCheckedChange={(v) => toggleRedraft(v === true)}
                disabled={loading || pending}
                className="mt-0.5"
              />
              <Label htmlFor={checkboxId} className="font-normal leading-snug">
                {texts.redraftLabel}
              </Label>
            </div>
          ) : null}
          {texts.costLine ? <p>{texts.costLine}</p> : null}
          {texts.monthLine ? <p className="text-muted-foreground">{texts.monthLine}</p> : null}
          {texts.warning ? <Notice tone="warning">{texts.warning}</Notice> : null}
          <FormError message={texts.blocker} />
          {texts.showSettingsLink ? (
            <div>
              <Button asChild variant="outline" size="sm">
                <Link href="/settings/ai">Open Settings › AI</Link>
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      <FormError message={startError} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button type="button" onClick={start} disabled={!texts?.canStart || loading || pending}>
          {pending ? "Starting…" : (texts?.buttonLabel ?? (single ? "Draft line" : "Draft lines"))}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * "Draft personal lines" (docs/dev/M5-DESIGN.md §6.8): for ticked companies, a list or one company. Controlled: the
 * caller owns `open`. Its inside mounts only while open, so every opening shows fresh counts and cost. `context` is an
 * optional muted line under the intro (the list's name); `onStarted` hears the run's job id once it started.
 */
export function DraftLinesDialog({
  target,
  open,
  onOpenChange,
  context,
  onStarted,
}: {
  target: DraftLinesTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context?: string;
  onStarted?: (run: { jobId: number; count: number }) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={PHONE_FULL_SCREEN_DIALOG}>
        {open ? <DraftLinesBody target={target} context={context} onClose={() => onOpenChange(false)} onStarted={onStarted} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/** Contacts bulk bar › "Draft personal lines" (outline, Sparkles) for the ticked companies. */
export function DraftLinesButton({ companyIds, disabled }: { companyIds: readonly number[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const key = companyIds.join(",");
  const target = useMemo<DraftLinesTarget>(() => ({ companyIds: key ? key.split(",").map(Number) : [] }), [key]);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={disabled || companyIds.length === 0}>
        <Sparkles className="size-3.5" aria-hidden />
        Draft personal lines
      </Button>
      <DraftLinesDialog target={target} open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * A list's menu › "Draft personal lines". Render it inside the list's DropdownMenuContent: choosing it keeps the menu
 * open underneath and opens the dialog above it (the dialog lives in this item, so the menu must not unmount it).
 */
export function DraftListMenuItem({ listId, listName }: { listId: number; listName: string }) {
  const [open, setOpen] = useState(false);
  const target = useMemo<DraftLinesTarget>(() => ({ listId }), [listId]);
  return (
    <>
      <DropdownMenuItem
        onSelect={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
      >
        <Sparkles className="size-4" aria-hidden /> Draft personal lines
      </DropdownMenuItem>
      <DraftLinesDialog target={target} open={open} onOpenChange={setOpen} context={listName} />
    </>
  );
}
