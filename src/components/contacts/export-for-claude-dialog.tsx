"use client";

import { useId, useRef, useState } from "react";
import Link from "next/link";
import { Copy, Download } from "lucide-react";
import { toast } from "sonner";
import { copyText } from "@/components/copy-text";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CLAUDE_MISSING_EMAILS_INSTRUCTION } from "@/core/import/round-trip";
import type { CompanyFilters } from "@/server/services/companies/filters";
import { missingEmailsExportHref } from "./url";

/**
 * "Export for Claude" on the Missing email view (SPEC §4, PLAN.md B6.13, M5-DESIGN §4.1): three steps in a
 * dialog instead of a plain download: 1. download the CSV of the companies in this view (with their
 * company_id), 2. paste the ready-made instruction into Claude (Copy, or on the plain-http office address a
 * selected box and "Press Ctrl+C"), 3. import Claude's CSV on the Import page, which recognises company_id.
 */

/** The dialog's words (M5-DESIGN §4.1). */
export const EXPORT_FOR_CLAUDE_COPY = {
  title: "Find missing emails with Claude",
  keepFile: "Keep the file as it is: the company_id column tells the app where each email belongs.",
  paste: "2. Open Claude, attach the file and paste this instruction:",
  copied: "Instruction copied.",
  selectAll: "Press Ctrl+C to copy the selected text.",
  importIt:
    "3. When Claude sends back a CSV, import it on the Import page. The app sees the company_id column and adds the people to the right companies. It never creates companies.",
} as const;

/** "1. Download the list of the 42 companies in this view." */
export function downloadStepText(total: number): string {
  return total === 1
    ? "1. Download the list of the company in this view."
    : `1. Download the list of the ${total.toLocaleString("en-US")} companies in this view.`;
}

/** "copied": in the clipboard (toast shown); "manual": the box is selected for Ctrl+C (plain http). */
export type CopyState = "idle" | "copied" | "manual";

/**
 * Copies the instruction. When the browser can't (the office address is plain http, so there is no
 * clipboard API, and the fallback may be blocked), the instruction box is selected instead so Ctrl+C copies it.
 */
export async function copyInstruction(
  box: HTMLTextAreaElement | null,
  copy: (text: string, fallbackEl?: HTMLTextAreaElement | null) => Promise<boolean> = copyText,
): Promise<CopyState> {
  const ok = await copy(CLAUDE_MISSING_EMAILS_INSTRUCTION, box);
  if (ok) {
    toast.success(EXPORT_FOR_CLAUDE_COPY.copied);
    return "copied";
  }
  if (box) {
    box.focus({ preventScroll: true });
    box.select();
  }
  return "manual";
}

/** The three steps (the dialog's body), without the dialog around them. */
export function ExportForClaudeSteps({
  total,
  downloadHref,
  copyState,
  onCopy,
  boxRef,
}: {
  total: number;
  downloadHref: string;
  copyState: CopyState;
  onCopy: () => void;
  boxRef?: React.Ref<HTMLTextAreaElement>;
}) {
  const id = useId();
  return (
    <div className="grid gap-5 text-sm">
      <section aria-labelledby={`${id}-download`} className="grid gap-2">
        <p id={`${id}-download`} className="font-medium">
          {downloadStepText(total)}
        </p>
        <div>
          <Button asChild>
            {/* No `download` attribute: an error comes back as a page with a way back, not as a saved file. */}
            <a href={downloadHref}>
              <Download aria-hidden />
              Download CSV
            </a>
          </Button>
        </div>
        <p className="text-muted-foreground">{EXPORT_FOR_CLAUDE_COPY.keepFile}</p>
      </section>

      <section aria-labelledby={`${id}-paste`} className="grid gap-2">
        <p id={`${id}-paste`} className="font-medium">
          {EXPORT_FOR_CLAUDE_COPY.paste}
        </p>
        <textarea
          ref={boxRef}
          readOnly
          rows={8}
          value={CLAUDE_MISSING_EMAILS_INSTRUCTION}
          aria-labelledby={`${id}-paste`}
          aria-describedby={copyState === "manual" ? `${id}-manual` : undefined}
          onFocus={(e) => e.currentTarget.select()}
          className="w-full resize-none rounded-md border border-input bg-muted px-2.5 py-2 text-sm leading-relaxed"
        />
        {copyState === "manual" ? (
          <p id={`${id}-manual`} role="status" className="text-muted-foreground">
            {EXPORT_FOR_CLAUDE_COPY.selectAll}
          </p>
        ) : null}
        <div>
          <Button type="button" variant="outline" onClick={onCopy}>
            <Copy aria-hidden />
            Copy instruction
          </Button>
        </div>
      </section>

      <section aria-labelledby={`${id}-import`} className="grid gap-2">
        <p id={`${id}-import`} className="font-medium">
          {EXPORT_FOR_CLAUDE_COPY.importIt}
        </p>
        <div>
          <Button asChild variant="ghost">
            <Link href="/import">Open Import</Link>
          </Button>
        </div>
      </section>
    </div>
  );
}

/** The dialog, opened from the Missing email view's Export menu (disabled while the view is empty). */
export function ExportForClaudeDialog({
  open,
  onOpenChange,
  filters,
  total,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: CompanyFilters;
  total: number;
}) {
  const box = useRef<HTMLTextAreaElement | null>(null);
  const [copyState, setCopyState] = useState<CopyState>("idle");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setCopyState("idle");
        onOpenChange(next);
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="max-h-dvh overflow-y-auto sm:max-w-xl max-sm:inset-0 max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none"
      >
        <DialogHeader>
          <DialogTitle>{EXPORT_FOR_CLAUDE_COPY.title}</DialogTitle>
        </DialogHeader>
        <ExportForClaudeSteps
          total={total}
          downloadHref={missingEmailsExportHref(filters)}
          copyState={copyState}
          boxRef={box}
          onCopy={() => {
            void copyInstruction(box.current).then(setCopyState);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
