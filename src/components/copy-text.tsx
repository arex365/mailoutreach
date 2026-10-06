"use client";

import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Open dialogs (Radix Dialog, Sheet, AlertDialog) trap focus inside themselves. */
const DIALOG_SELECTOR = '[role="dialog"],[role="alertdialog"]';
const OPEN_DIALOG_SELECTOR = '[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"]';

/**
 * Where the temporary copy box goes: inside the dialog that has focus, if any. A modal dialog sends
 * focus straight back when it moves outside, so a box on <body> would never really be selected and
 * the copy would silently copy nothing.
 */
export function copyHost(doc: Document = document): HTMLElement {
  const active = doc.activeElement as HTMLElement | null;
  const focused = typeof active?.closest === "function" ? active.closest<HTMLElement>(DIALOG_SELECTOR) : null;
  if (focused) return focused;
  // Some browsers (Safari) don't focus a button when it's clicked: use the top-most open dialog.
  const open = doc.querySelectorAll<HTMLElement>(OPEN_DIALOG_SELECTOR);
  return open.length > 0 ? open[open.length - 1]! : doc.body;
}

/** True when `el` holds focus and its whole value is selected (so execCommand copies exactly it). */
function isFullySelected(el: HTMLTextAreaElement | HTMLInputElement): boolean {
  if (el.ownerDocument.activeElement !== el) return false;
  try {
    return el.selectionStart === 0 && el.selectionEnd === el.value.length;
  } catch {
    return true; // inputs that don't expose a selection range (rare): trust the focus check
  }
}

/**
 * Copy-to-clipboard that also works on the plain-http office address, where
 * navigator.clipboard doesn't exist: falls back to selecting a textarea + execCommand.
 * Returns true only when the text really was selected and copied; on false, callers show
 * the text selected with "press Ctrl+C".
 */
export async function copyText(text: string, fallbackEl?: HTMLTextAreaElement | HTMLInputElement | null): Promise<boolean> {
  try {
    if (typeof window !== "undefined" && window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  if (typeof document === "undefined") return false;
  const previous = document.activeElement as HTMLElement | null;
  const temp = !fallbackEl;
  const el = fallbackEl ?? document.createElement("textarea");
  if (temp) {
    (el as HTMLTextAreaElement).value = text;
    el.setAttribute("readonly", "");
    el.tabIndex = -1;
    Object.assign(el.style, { position: "fixed", top: "0", left: "0", width: "1px", height: "1px", opacity: "0", pointerEvents: "none" });
    copyHost().appendChild(el);
  }
  let ok = false;
  try {
    el.focus({ preventScroll: true });
    el.select();
    ok = isFullySelected(el) && document.execCommand("copy");
  } catch {
    ok = false;
  }
  if (temp) {
    el.remove();
    // Give focus back to the copy button (keyboard users keep their place).
    if (previous && previous !== document.body && previous.isConnected && typeof previous.focus === "function") {
      previous.focus({ preventScroll: true });
    }
  }
  return ok;
}

/** A read-only text box with a Copy button. If copying fails the text stays selected for Ctrl+C. */
export function CopyField({ value, label, multiline, className }: { value: string; label: string; multiline?: boolean; className?: string }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  async function onCopy() {
    const ok = await copyText(value, ref.current);
    setState(ok ? "copied" : "manual");
    if (!ok) ref.current?.select();
    setTimeout(() => setState("idle"), 2500);
  }
  return (
    <div className={cn("grid gap-1.5", className)}>
      <div className="flex items-start gap-2">
        <textarea
          ref={ref}
          aria-label={label}
          readOnly
          value={value}
          rows={multiline ? 6 : 1}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 resize-none rounded-md border border-input bg-muted px-2.5 py-1.5 font-mono text-xs"
        />
        <Button type="button" variant="outline" size="sm" onClick={onCopy} aria-label={`Copy ${label}`}>
          {state === "copied" ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          {state === "copied" ? "Copied" : "Copy"}
        </Button>
      </div>
      {state === "manual" ? (
        <p className="text-xs text-muted-foreground">Your browser blocked copying here. The text is selected: press Ctrl+C.</p>
      ) : null}
    </div>
  );
}
