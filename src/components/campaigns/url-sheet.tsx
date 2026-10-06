"use client";

import { useOptimistic, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";

/**
 * A side panel that is open while the page's address says so (?recipient=12, ?open=345), so the
 * panel can be shared and the Back button closes it. Opening is a normal link; closing (Esc, the
 * close button, clicking outside) goes to `closeHref` and hides the panel at once. `children` is
 * the server-rendered panel. Full screen on phones.
 */
export function UrlSheet({
  openKey,
  closeHref,
  title,
  description,
  children,
}: {
  /** Anything non-null opens the panel (usually the id in the address). */
  openKey: string | null;
  closeHref: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [shownKey, setShownKey] = useOptimistic<string | null>(openKey);

  function close() {
    startTransition(() => {
      setShownKey(null);
      router.replace(closeHref, { scroll: false });
    });
  }

  return (
    <Sheet
      open={shownKey !== null}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <SheetContent
        side="right"
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:max-w-none data-[side=right]:sm:max-w-xl data-[side=right]:lg:max-w-2xl"
        onEscapeKeyDown={(e) => {
          // Esc inside a text field (or an open editor dialog) must not close the panel.
          const t = e.target as HTMLElement | null;
          if (t?.closest("input, textarea, select, [contenteditable='true']")) e.preventDefault();
        }}
      >
        <SheetTitle className="sr-only">{title}</SheetTitle>
        <SheetDescription className="sr-only">{description}</SheetDescription>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
