"use client";

import { Loader2 } from "lucide-react";
import { footerStart } from "@/core/templates/email";
import type { RenderedEmail } from "@/core/templates/types";
import { cn } from "@/lib/utils";
import { TemplateWarningList } from "./warnings";

/**
 * One rendered email, as the recipient will read it: subject, text, then the footer (muted).
 * "Missing details" for this person are listed under it. Reused by the campaign screens.
 */
export function EmailPreview({
  email,
  pending,
  error,
  emptyText = "Pick a contact to see the email.",
  className,
}: {
  email: RenderedEmail | null;
  pending?: boolean;
  error?: string | null;
  emptyText?: string;
  className?: string;
}) {
  const cut = email ? footerStart(email.text) : -1;
  const main = email ? (cut >= 0 ? email.text.slice(0, cut).trimEnd() : email.text) : "";
  const footer = email && cut >= 0 ? email.text.slice(cut) : "";
  const missing = email?.warnings.filter((w) => w.kind === "missing") ?? [];

  return (
    <div className={cn("grid gap-3", className)} aria-busy={pending ? true : undefined}>
      <div className="flex min-h-5 items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
        {pending ? (
          <>
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> Updating the preview…
          </>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {email ? (
        <div className={cn("grid gap-3 rounded-lg border border-border bg-background p-4", pending && "opacity-70")}>
          <div className="grid gap-0.5 border-b border-border pb-3">
            <span className="text-xs text-muted-foreground">Subject</span>
            <span className="font-medium break-words">{email.subject || <span className="text-warning">No subject</span>}</span>
          </div>
          <div className="text-sm leading-relaxed break-words whitespace-pre-wrap">{main}</div>
          {footer ? <div className="text-xs break-words whitespace-pre-wrap text-muted-foreground">{footer}</div> : null}
        </div>
      ) : !error ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">{emptyText}</p>
      ) : null}
      <TemplateWarningList warnings={missing} title="Missing for this contact" />
    </div>
  );
}
